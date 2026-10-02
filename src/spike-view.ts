import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FileSystemAdapter, ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { resolveShellEnv } from "./cli";
import { buildOptions } from "./config";
import type ApolloPlugin from "./main";

export const SPIKE_VIEW_TYPE = "apollo-spike";

type Status = "idle" | "running" | "error";

/**
 * M0 spike: one prompt box, one transcript. Each send is a single `query()`
 * that resumes the previous session, so the conversation carries over.
 */
export class SpikeView extends ItemView {
	private sessionId: string | null = null;
	private abort: AbortController | null = null;
	private statusEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;

	// Streaming state for the current text block.
	private blockEl: HTMLElement | null = null;
	private blockText = "";

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ApolloPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return SPIKE_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Apollo";
	}

	override getIcon(): string {
		return "bot";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("apollo-spike");

		this.statusEl = root.createDiv({ cls: "apollo-status" });
		this.transcriptEl = root.createDiv({ cls: "apollo-transcript" });

		const form = root.createDiv({ cls: "apollo-input" });
		this.inputEl = form.createEl("textarea", { attr: { placeholder: "Ask Claude…", rows: "3" } });
		const buttons = form.createDiv({ cls: "apollo-buttons" });
		this.sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
		this.stopBtn = buttons.createEl("button", { text: "Stop" });

		this.registerDomEvent(this.sendBtn, "click", () => void this.send());
		this.registerDomEvent(this.stopBtn, "click", () => this.stop());
		this.registerDomEvent(this.inputEl, "keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
				evt.preventDefault();
				void this.send();
			}
		});

		this.setStatus("idle");
		const { claudePath } = await resolveShellEnv();
		const cliPath = this.plugin.settings.cliPath || claudePath;
		this.statusEl.setText(cliPath ? `Claude CLI: ${cliPath}` : "Claude CLI not found. Set its path in settings.");
	}

	override async onClose(): Promise<void> {
		this.stop();
	}

	stop(): void {
		this.abort?.abort();
	}

	private async send(): Promise<void> {
		const prompt = this.inputEl.value.trim();
		if (!prompt || this.abort) return;
		this.inputEl.value = "";
		this.transcriptEl.createDiv({ cls: "apollo-msg apollo-user", text: prompt });

		const abort = new AbortController();
		this.abort = abort;
		this.plugin.running.add(abort);
		this.setStatus("running");

		try {
			const env = await resolveShellEnv();
			const options = buildOptions(this.plugin.settings, env, this.vaultPath(), {
				sessionId: this.sessionId,
				abort,
				onPermissionRequest: this.denyTool,
			});
			for await (const msg of query({ prompt, options })) {
				this.handle(msg);
				// One prompt per query in the spike; leaving the loop closes the process.
				if (msg.type === "result") break;
			}
			this.setStatus("idle");
		} catch (err) {
			if (!abort.signal.aborted) {
				console.error("Apollo: query failed", err);
				this.note(`Error: ${err instanceof Error ? err.message : String(err)}`, "apollo-error");
				this.setStatus("error");
			}
		} finally {
			this.finishBlock();
			this.plugin.running.delete(abort);
			this.abort = null;
		}
		// Aborting can end the stream quietly or with an error, depending on timing.
		if (abort.signal.aborted) {
			this.note("Stopped.");
			this.setStatus("idle");
		}
	}

	// Tool approval cards arrive in M1. Until then, anything that would prompt is denied.
	private denyTool: CanUseTool = async (toolName) => {
		this.note(`Denied ${toolName}: tool approval is not implemented yet.`);
		return { behavior: "deny", message: "Tool approval is not available in this build of Apollo." };
	};

	private handle(msg: SDKMessage): void {
		switch (msg.type) {
			case "system":
				if (msg.subtype === "init") {
					this.sessionId = msg.session_id;
					this.statusEl.setText(`${msg.model} · ${msg.permissionMode} · session ${msg.session_id.slice(0, 8)}`);
				}
				break;
			case "stream_event": {
				// Subagent output streams too; the spike only shows the main thread.
				if (msg.parent_tool_use_id) break;
				const ev = msg.event;
				if (ev.type === "content_block_start") {
					if (ev.content_block.type === "text") this.startBlock();
					else if (ev.content_block.type === "tool_use") this.note(`Tool: ${ev.content_block.name}`);
				} else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
					this.appendBlock(ev.delta.text);
				} else if (ev.type === "content_block_stop") {
					this.finishBlock();
				}
				break;
			}
			case "assistant":
				if (msg.error) this.note(`Error: ${msg.error}`, "apollo-error");
				break;
			case "result": {
				const secs = (msg.duration_ms / 1000).toFixed(1);
				const outcome = msg.subtype === "success" ? "Done" : `Ended (${msg.subtype})`;
				this.note(`${outcome} in ${secs}s · $${msg.total_cost_usd.toFixed(4)}`);
				break;
			}
		}
	}

	private startBlock(): void {
		this.finishBlock();
		this.blockEl = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-assistant is-streaming" });
		this.blockText = "";
	}

	private appendBlock(text: string): void {
		if (!this.blockEl) this.startBlock();
		this.blockText += text;
		this.blockEl!.setText(this.blockText);
		this.scrollToEnd();
	}

	// Swap the plain streamed text for rendered Markdown once the block completes.
	private finishBlock(): void {
		const el = this.blockEl;
		if (!el) return;
		this.blockEl = null;
		el.removeClass("is-streaming");
		el.empty();
		void MarkdownRenderer.render(this.app, this.blockText, el, "", this);
	}

	private note(text: string, cls = "apollo-note"): void {
		this.transcriptEl.createDiv({ cls: `apollo-msg ${cls}`, text });
		this.scrollToEnd();
	}

	private setStatus(status: Status): void {
		this.contentEl.dataset.status = status;
		this.sendBtn.disabled = status === "running";
		this.stopBtn.disabled = status !== "running";
	}

	private scrollToEnd(): void {
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	private vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Apollo needs a desktop vault.");
		return adapter.getBasePath();
	}
}
