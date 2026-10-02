import type { CanUseTool, PermissionMode, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import { resolveShellEnv } from "./cli";
import { ChatSession } from "./chat-session";
import type ApolloPlugin from "./main";
import { showPermissionCard } from "./permission-card";
import { PERMISSION_MODES } from "./settings";

export const CHAT_VIEW_TYPE = "apollo-chat";

type Status = "idle" | "running" | "awaiting" | "error";

/** Pixels from the bottom within which new output keeps the transcript pinned to the end. */
const STICKY_SCROLL = 40;

/**
 * One chat (M1). Messages go to a long-lived Claude Code process; while a
 * turn runs, further messages queue here and go out together when it ends.
 */
export class ChatView extends ItemView {
	private session!: ChatSession;
	private mode: PermissionMode;
	private queued: { text: string; el: HTMLElement }[] = [];
	private pendingCards = 0;
	private stopping = false;

	private statusEl!: HTMLElement;
	private modeEl!: HTMLSelectElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private stopBtn!: HTMLButtonElement;

	// Streaming state for the current text block.
	private blockEl: HTMLElement | null = null;
	private blockText = "";
	/** Tool rows by tool_use id, so results can mark them. */
	private toolRows = new Map<string, HTMLElement>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ApolloPlugin,
	) {
		super(leaf);
		this.mode = plugin.settings.defaultPermissionMode;
	}

	override getViewType(): string {
		return CHAT_VIEW_TYPE;
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
		root.addClass("apollo-chat");

		const header = root.createDiv({ cls: "apollo-header" });
		this.statusEl = header.createDiv({ cls: "apollo-status" });
		this.modeEl = header.createEl("select", { cls: "dropdown apollo-mode", attr: { "aria-label": "Permission mode" } });
		this.renderModeOptions();
		this.registerDomEvent(this.modeEl, "change", () => void this.changeMode(this.modeEl.value as PermissionMode));

		this.transcriptEl = root.createDiv({ cls: "apollo-transcript" });

		const form = root.createDiv({ cls: "apollo-input" });
		this.inputEl = form.createEl("textarea", { attr: { placeholder: "Ask Claude…  (Enter to send, Esc to stop)", rows: "3" } });
		const buttons = form.createDiv({ cls: "apollo-buttons" });
		this.stopBtn = buttons.createEl("button", { text: "Stop" });
		const sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });

		this.registerDomEvent(sendBtn, "click", () => this.submit());
		this.registerDomEvent(this.stopBtn, "click", () => this.stop());
		this.registerDomEvent(this.inputEl, "keydown", (evt) => {
			if (evt.isComposing) return;
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				this.submit();
			} else if (evt.key === "Escape" && this.session.busy) {
				evt.preventDefault();
				this.stop();
			}
		});

		this.newChat();
		const { claudePath } = await resolveShellEnv();
		if (!this.plugin.settings.cliPath && !claudePath) this.statusEl.setText("Claude CLI not found. Set its path in settings.");
	}

	override async onClose(): Promise<void> {
		this.session.close();
	}

	/** Starts a fresh session in this pane. The old one stays on disk for resume. */
	newChat(): void {
		this.session?.close();
		// Late callbacks from a closed session must not touch the new chat.
		const session: ChatSession = new ChatSession(
			this.plugin,
			{
				message: (msg) => session === this.session && this.handle(msg),
				permission: (toolName, input, options) =>
					session === this.session
						? this.onPermissionRequest(toolName, input, options)
						: Promise.resolve({ behavior: "deny", message: "Chat closed." }),
				ended: (err) => session === this.session && this.onEnded(err),
			},
			this.plugin.settings.defaultPermissionMode,
		);
		this.session = session;
		this.mode = this.plugin.settings.defaultPermissionMode;
		this.renderModeOptions();
		this.queued = [];
		this.pendingCards = 0;
		this.stopping = false;
		this.blockEl = null;
		this.toolRows.clear();
		this.transcriptEl.empty();
		this.transcriptEl.createDiv({ cls: "apollo-empty", text: "New chat. Claude Code runs in this vault." });
		this.statusEl.setText("New chat");
		this.setStatus("idle");
		this.inputEl.focus();
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		if (text === "/new") {
			this.newChat();
			return;
		}
		this.transcriptEl.querySelector(".apollo-empty")?.remove();
		const el = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-user", text });
		this.scrollToEnd(true);
		if (this.session.busy) {
			el.addClass("is-queued");
			this.queued.push({ text, el });
			return;
		}
		void this.send(text);
	}

	private async send(text: string): Promise<void> {
		this.stopping = false;
		this.setStatus("running");
		try {
			await this.session.send(text);
		} catch (err) {
			this.onEnded(err);
		}
	}

	/** Stops the current turn (PRM-T4). Queued messages go back to the input. */
	stop(): void {
		if (!this.session.busy) return;
		this.stopping = true;
		this.returnQueuedToInput();
		void this.session.interrupt().catch((err) => console.error("Apollo: interrupt failed", err));
	}

	private returnQueuedToInput(): void {
		if (!this.queued.length) return;
		for (const q of this.queued) q.el.remove();
		this.inputEl.value = [...this.queued.map((q) => q.text), this.inputEl.value].filter(Boolean).join("\n\n");
		this.queued = [];
	}

	private async onPermissionRequest(...[toolName, input, options]: Parameters<CanUseTool>): Promise<PermissionResult> {
		this.finishBlock();
		this.pendingCards++;
		this.setStatus("awaiting");
		try {
			const decision = showPermissionCard(
				this.transcriptEl,
				{ app: this.app, component: this, vaultPath: this.plugin.vaultPath() },
				{ toolName, input, options, autoMode: this.mode === "auto" },
			);
			// A card needs an answer, so always bring it into view.
			this.scrollToEnd(true);
			const result = await decision;
			// A bare deny ends the turn, the same as Stop.
			if (result.behavior === "deny" && result.interrupt) this.stopping = true;
			return result;
		} finally {
			this.pendingCards = Math.max(0, this.pendingCards - 1);
			if (this.session.busy) this.setStatus(this.pendingCards ? "awaiting" : "running");
		}
	}

	private async changeMode(mode: PermissionMode): Promise<void> {
		const previous = this.mode;
		this.mode = mode;
		try {
			await this.session.setPermissionMode(mode);
		} catch (err) {
			new Notice(`Couldn't switch permission mode: ${err instanceof Error ? err.message : String(err)}`);
			this.mode = previous;
			this.renderModeOptions();
		}
	}

	/** Reflects the mode Claude Code reports, which can differ from the one asked for. */
	private syncMode(actual: PermissionMode): void {
		if (actual === this.mode) return;
		if (this.mode === "auto" && actual === "default") {
			this.note("Auto mode isn't available for this model, so this chat uses Ask.");
		} else {
			this.note(`Permission mode: ${PERMISSION_MODES[actual as keyof typeof PERMISSION_MODES] ?? actual}`);
		}
		this.mode = actual;
		this.session.permissionMode = actual;
		this.renderModeOptions();
	}

	private renderModeOptions(): void {
		this.modeEl.empty();
		const modes: Record<string, string> = { ...PERMISSION_MODES };
		// Show modes the plugin doesn't offer (e.g. from settings) rather than misreporting them.
		if (!(this.mode in modes)) modes[this.mode] = this.mode;
		for (const [value, text] of Object.entries(modes)) this.modeEl.createEl("option", { value, text });
		this.modeEl.value = this.mode;
	}

	private onEnded(err: unknown): void {
		this.finishBlock();
		console.error("Apollo: Claude Code ended", err);
		this.note(`Error: ${err instanceof Error ? err.message : String(err)}`, "apollo-error");
		this.returnQueuedToInput();
		this.setStatus("error");
	}

	private handle(msg: SDKMessage): void {
		// Subagent output streams too; M1 only shows the main thread.
		if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return;
		switch (msg.type) {
			case "system":
				if (msg.subtype === "init") {
					this.statusEl.setText(`${msg.model} · session ${msg.session_id.slice(0, 8)}`);
					this.syncMode(msg.permissionMode);
				} else if (msg.subtype === "status" && msg.permissionMode) {
					this.syncMode(msg.permissionMode);
				} else if (msg.subtype === "permission_denied") {
					const who = msg.decision_reason_type === "classifier" ? "Auto mode" : "Claude Code";
					this.note(`${who} denied ${msg.tool_name}${msg.decision_reason ? `: ${msg.decision_reason}` : ""}`);
				}
				break;
			case "stream_event": {
				const ev = msg.event;
				if (ev.type === "content_block_start" && ev.content_block.type === "text") this.startBlock();
				else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") this.appendBlock(ev.delta.text);
				else if (ev.type === "content_block_stop") this.finishBlock();
				break;
			}
			case "assistant":
				// Text arrives through stream events; tool calls are shown once their input is complete.
				for (const block of msg.message.content) {
					if (block.type === "tool_use") this.toolRow(block.id, block.name, block.input as Record<string, unknown>);
				}
				if (msg.error) this.note(`Error: ${msg.error}`, "apollo-error");
				break;
			case "user":
				if (Array.isArray(msg.message.content)) {
					for (const block of msg.message.content) {
						if (block.type === "tool_result") this.toolRows.get(block.tool_use_id)?.addClass(block.is_error ? "is-error" : "is-done");
					}
				}
				break;
			case "result":
				this.onTurnEnd(msg.subtype, msg.duration_ms, msg.total_cost_usd);
				break;
		}
	}

	private onTurnEnd(subtype: string, durationMs: number, costUsd: number): void {
		this.finishBlock();
		const secs = (durationMs / 1000).toFixed(1);
		if (this.stopping) this.note("Stopped.");
		else this.note(`${subtype === "success" ? "Done" : `Ended (${subtype})`} in ${secs}s · $${costUsd.toFixed(4)}`);
		this.stopping = false;

		// Messages typed during the turn go out together as the next one.
		if (this.queued.length) {
			const text = this.queued.map((q) => q.text).join("\n\n");
			// Move the bubbles below this turn's output, where the new turn starts.
			for (const q of this.queued) this.transcriptEl.appendChild(q.el).removeClass("is-queued");
			this.queued = [];
			void this.send(text);
		} else {
			this.setStatus("idle");
		}
	}

	private toolRow(id: string, name: string, input: Record<string, unknown>): void {
		this.finishBlock();
		const row = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-tool" });
		row.createSpan({ cls: "apollo-tool-name", text: name });
		const summary = toolSummary(input, this.plugin.vaultPath());
		if (summary) row.createSpan({ cls: "apollo-tool-summary", text: summary });
		this.toolRows.set(id, row);
		this.scrollToEnd();
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
		this.stopBtn.disabled = status === "idle" || status === "error";
	}

	private scrollToEnd(force = false): void {
		const el = this.transcriptEl;
		const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL;
		if (force || nearEnd) el.scrollTop = el.scrollHeight;
	}
}

/** One-line description of a tool call's input. */
function toolSummary(input: Record<string, unknown>, vaultPath: string): string {
	const value = ["file_path", "notebook_path", "command", "pattern", "url", "query", "description", "skill"]
		.map((key) => input[key])
		.find((v): v is string => typeof v === "string");
	if (!value) return "";
	const prefix = vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
	const text = value.startsWith(prefix) ? value.slice(prefix.length) : value;
	return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
