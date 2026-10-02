import type { CanUseTool, PermissionMode, PermissionResult, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { resolveShellEnv } from "./cli";
import { ChatSession } from "./chat-session";
import type ApolloPlugin from "./main";
import { showPermissionCard } from "./permission-card";
import { sessionTitle } from "./sessions";
import { PERMISSION_MODES } from "./settings";

export const CHAT_VIEW_TYPE = "apollo-chat";

type Status = "idle" | "running" | "awaiting" | "error";

/** What Obsidian saves for an open chat, so it comes back on restart (TAB-5). */
export interface ChatViewState {
	sessionId: string | null;
	title: string;
	draft: string;
	/** Transcript scroll position, or null when scrolled to the end. */
	scroll: number | null;
	mode: PermissionMode;
}

/** Obsidian internals the public API doesn't expose. All may be missing. */
interface LeafInternals {
	tabHeaderEl?: HTMLElement;
	/** Refreshes the tab's title, but not the view header's. */
	updateHeader?(): void;
}

interface ViewInternals {
	/** The view header's title. */
	titleEl?: HTMLElement;
}

const NEW_CHAT_TITLE = "New chat";
const TITLE_LENGTH = 50;

/** Pixels from the bottom within which new output keeps the transcript pinned to the end. */
const STICKY_SCROLL = 40;

/**
 * One chat per leaf. Messages go to a long-lived Claude Code process; while a
 * turn runs, further messages queue here and go out together when it ends.
 * A chat can start fresh or show a saved session and resume it.
 */
export class ChatView extends ItemView {
	private session!: ChatSession;
	private mode: PermissionMode;
	private title = NEW_CHAT_TITLE;
	private model: string | null = null;
	private queued: { text: string; el: HTMLElement }[] = [];
	private pendingCards = 0;
	private stopping = false;

	private infoEl!: HTMLElement;
	private modeEl!: HTMLSelectElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private stopBtn!: HTMLButtonElement;

	// Streaming state for the current text block.
	private blockEl: HTMLElement | null = null;
	private blockText = "";
	/** Streamed text blocks waiting for their message UUID, which arrives with the assistant message. */
	private unidentified: HTMLElement[] = [];
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
		return this.title;
	}

	override getIcon(): string {
		return "bot";
	}

	get sessionId(): string | null {
		return this.session?.sessionId ?? null;
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("apollo-chat");

		this.transcriptEl = root.createDiv({ cls: "apollo-transcript" });
		this.registerDomEvent(this.transcriptEl, "scroll", () => this.app.workspace.requestSaveLayout());

		const form = root.createDiv({ cls: "apollo-input" });
		this.inputEl = form.createEl("textarea", { attr: { placeholder: "Ask Claude…  (Enter to send, Esc to stop)", rows: "3" } });
		const toolbar = form.createDiv({ cls: "apollo-toolbar" });
		// Status dot plus model and session details on hover.
		this.infoEl = toolbar.createDiv({ cls: "apollo-info clickable-icon" });
		setIcon(this.infoEl, "info");
		// The tooltip shows a short ID, but `claude --resume` needs the full one.
		this.registerDomEvent(this.infoEl, "click", () => this.copySessionId());
		this.modeEl = toolbar.createEl("select", { cls: "dropdown apollo-mode", attr: { "aria-label": "Permission mode" } });
		this.renderModeOptions();
		this.registerDomEvent(this.modeEl, "change", () => void this.changeMode(this.modeEl.value as PermissionMode));
		const buttons = toolbar.createDiv({ cls: "apollo-buttons" });
		this.stopBtn = buttons.createEl("button", { text: "Stop" });
		const sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });

		this.registerDomEvent(sendBtn, "click", () => this.submit());
		this.registerDomEvent(this.stopBtn, "click", () => this.stop());
		this.registerDomEvent(this.inputEl, "input", () => this.app.workspace.requestSaveLayout());
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
		// Renames, from here or the chat list, and Claude Code's own titles.
		this.registerEvent(this.plugin.store.onChanged(() => void this.refreshTitle()));

		this.reset(null);
		const { claudePath } = await resolveShellEnv();
		if (!this.plugin.settings.cliPath && !claudePath) this.note("Claude CLI not found. Set its path in settings.", "apollo-error");
	}

	override async onClose(): Promise<void> {
		this.session.close();
	}

	override getState(): Record<string, unknown> {
		const state: ChatViewState = {
			sessionId: this.sessionId,
			title: this.title,
			draft: this.inputEl?.value ?? "",
			scroll: this.transcriptEl && !this.isNearEnd() ? this.transcriptEl.scrollTop : null,
			mode: this.mode,
		};
		return { ...super.getState(), ...state };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as Partial<ChatViewState>;
		if (s.sessionId && s.sessionId !== this.sessionId) await this.loadSession(s.sessionId, s.title, s.scroll);
		if (s.mode && s.mode !== this.mode) {
			this.mode = s.mode;
			this.session.permissionMode = s.mode;
			this.renderModeOptions();
		}
		if (s.draft && !this.inputEl.value) this.inputEl.value = s.draft;
		await super.setState(state, result);
	}

	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const id = this.sessionId;
		if (!id) return;
		menu.addItem((item) => item.setSection("action").setTitle("Rename chat").setIcon("pencil").onClick(() => void this.plugin.renameChat(id, this.title)));
		menu.addItem((item) => item.setSection("action").setTitle("Fork chat").setIcon("git-branch").onClick(() => void this.plugin.forkChat(id)));
		menu.addItem((item) => item.setSection("action").setTitle("Copy session ID").setIcon("copy").onClick(() => this.copySessionId()));
	}

	focusInput(): void {
		this.inputEl.focus();
	}

	/** Starts a fresh session in this pane. The old one stays on disk for resume. */
	newChat(): void {
		this.reset(null);
		this.inputEl.focus();
	}

	/** Shows a saved session's history; the next message resumes it (HIST-5). */
	async loadSession(sessionId: string, title?: string, scroll?: number | null): Promise<void> {
		this.reset(sessionId, title);
		const session = this.session;
		this.transcriptEl.empty();
		const loading = this.transcriptEl.createDiv({ cls: "apollo-empty", text: "Loading chat…" });
		let messages: SessionMessage[];
		try {
			messages = await this.plugin.store.messages(sessionId);
		} catch (err) {
			if (session !== this.session) return;
			loading.remove();
			this.note(`Couldn't load this chat: ${err instanceof Error ? err.message : String(err)}`, "apollo-error");
			return;
		}
		if (session !== this.session) return;
		loading.remove();
		if (!messages.length) this.note("No messages found for this session. It may have been deleted.");
		await this.renderHistory(messages);
		if (session !== this.session) return;
		if (scroll == null) this.scrollToEnd(true);
		else this.transcriptEl.scrollTop = scroll;
		void this.refreshTitle();
	}

	/** Swaps in a new ChatSession, resuming `sessionId` if given, and clears the transcript. */
	private reset(sessionId: string | null, title?: string): void {
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
				released: () => session === this.session && this.updateInfo(),
			},
			this.plugin.settings.defaultPermissionMode,
		);
		session.sessionId = sessionId;
		this.session = session;
		this.mode = this.plugin.settings.defaultPermissionMode;
		this.model = null;
		this.renderModeOptions();
		this.queued = [];
		this.pendingCards = 0;
		this.stopping = false;
		this.blockEl = null;
		this.unidentified = [];
		this.toolRows.clear();
		this.transcriptEl.empty();
		if (!sessionId) this.transcriptEl.createDiv({ cls: "apollo-empty", text: "New chat. Claude Code runs in this vault." });
		this.setTitle(title || NEW_CHAT_TITLE);
		this.updateInfo();
		this.setStatus("idle");
		// The chat list shows which sessions are open.
		this.plugin.store.changed();
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		this.app.workspace.requestSaveLayout();
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
		void this.send(text, [el]);
	}

	private async send(text: string, bubbles: HTMLElement[]): Promise<void> {
		this.stopping = false;
		this.setStatus("running");
		// Until Claude Code names the session, the first prompt is the title.
		if (!this.sessionId && this.title === NEW_CHAT_TITLE) this.setTitle(summarise(text));
		try {
			const uuid = await this.session.send(text);
			for (const el of bubbles) this.addForkAction(el, uuid, "user");
			this.updateInfo();
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
			this.app.workspace.requestSaveLayout();
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
		this.updateInfo();
	}

	private handle(msg: SDKMessage): void {
		// Subagent output streams too; only the main thread is shown.
		if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return;
		switch (msg.type) {
			case "system":
				if (msg.subtype === "init") {
					this.model = msg.model;
					this.updateInfo();
					this.syncMode(msg.permissionMode);
					// A new session now has an ID to save and list.
					this.app.workspace.requestSaveLayout();
					this.plugin.store.changed();
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
					else if (block.type === "text") {
						const el = this.unidentified.shift();
						if (el) this.addForkAction(el, msg.uuid, "assistant");
					}
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
				this.onTurnEnd(msg.subtype, msg.duration_ms);
				break;
		}
	}

	private onTurnEnd(subtype: string, durationMs: number): void {
		this.finishBlock();
		this.unidentified = [];
		const secs = (durationMs / 1000).toFixed(1);
		if (this.stopping) this.note("Stopped.");
		else this.note(`${subtype === "success" ? "Done" : `Ended (${subtype})`} in ${secs}s`);
		this.stopping = false;
		// The chat list's "last updated", and Claude Code's generated title.
		this.plugin.store.changed();

		// Messages typed during the turn go out together as the next one.
		if (this.queued.length) {
			const text = this.queued.map((q) => q.text).join("\n\n");
			// Move the bubbles below this turn's output, where the new turn starts.
			for (const q of this.queued) this.transcriptEl.appendChild(q.el).removeClass("is-queued");
			const bubbles = this.queued.map((q) => q.el);
			this.queued = [];
			void this.send(text, bubbles);
		} else {
			this.setStatus("idle");
		}
	}

	/** Renders a saved transcript: user prompts, assistant text and tool rows. */
	private async renderHistory(messages: SessionMessage[]): Promise<void> {
		const renders: Promise<void>[] = [];
		for (const msg of messages) {
			if (msg.parent_tool_use_id) continue;
			const content = (msg.message as { content?: unknown } | null)?.content;
			const blocks: HistoryBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
			if (msg.type === "user") {
				const texts: string[] = [];
				for (const block of blocks) {
					if (block.type === "tool_result" && block.tool_use_id) this.toolRows.get(block.tool_use_id)?.addClass(block.is_error ? "is-error" : "is-done");
					else if (block.type === "text" && block.text) texts.push(block.text);
					else if (block.type === "image") texts.push("[Image]");
				}
				const prompt = displayPrompt(texts.join("\n\n"));
				if (prompt === INTERRUPTED) this.note("Stopped.");
				else if (prompt) this.addForkAction(this.transcriptEl.createDiv({ cls: "apollo-msg apollo-user", text: prompt }), msg.uuid, "user");
			} else if (msg.type === "assistant") {
				for (const block of blocks) {
					if (block.type === "text" && block.text) {
						const el = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-assistant" });
						renders.push(MarkdownRenderer.render(this.app, block.text, el.createDiv(), "", this));
						this.addForkAction(el, msg.uuid, "assistant");
					} else if (block.type === "tool_use" && block.id && block.name) {
						this.toolRow(block.id, block.name, block.input ?? {});
					}
				}
			}
		}
		await Promise.all(renders);
	}

	/** "Fork from here" on a message (HIST-3a). */
	private addForkAction(el: HTMLElement, uuid: string, role: "user" | "assistant"): void {
		if (el.querySelector(":scope > .apollo-msg-actions")) return;
		const actions = el.createDiv({ cls: "apollo-msg-actions" });
		const fork = actions.createDiv({ cls: "clickable-icon" });
		setIcon(fork, "git-branch");
		setTooltip(fork, role === "user" ? "Fork from here, to edit and resend this message" : "Fork from here");
		this.registerDomEvent(fork, "click", (evt) => {
			evt.stopPropagation();
			const id = this.sessionId;
			if (!id) {
				new Notice("This chat has no session yet.");
				return;
			}
			void this.plugin.forkChat(id, { uuid, role });
		});
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
		const el = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-assistant is-streaming" });
		this.blockEl = el.createDiv();
		this.blockText = "";
		this.unidentified.push(el);
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
		el.parentElement?.removeClass("is-streaming");
		el.empty();
		void MarkdownRenderer.render(this.app, this.blockText, el, "", this);
	}

	private note(text: string, cls = "apollo-note"): void {
		this.transcriptEl.createDiv({ cls: `apollo-msg ${cls}`, text });
		this.scrollToEnd();
	}

	private async refreshTitle(): Promise<void> {
		const id = this.sessionId;
		if (!id) return;
		const info = await this.plugin.store.info(id).catch(() => undefined);
		if (info && id === this.sessionId) this.setTitle(sessionTitle(info));
	}

	/** Tab title (TAB-4). */
	private setTitle(title: string): void {
		if (title === this.title) return;
		this.title = title;
		(this.leaf as WorkspaceLeaf & LeafInternals).updateHeader?.();
		(this as ViewInternals).titleEl?.setText(title);
		this.app.workspace.requestSaveLayout();
	}

	private updateInfo(): void {
		const id = this.sessionId;
		const lines = id ? [] : ["New chat. No session yet."];
		if (this.model) lines.push(`Model: ${this.model}`);
		if (id) lines.push(`Session: ${id.slice(0, 8)}`, this.session.running ? "Claude Code is running." : "Claude Code starts on your next message.", "Click to copy the full session ID.");
		setTooltip(this.infoEl, lines.join("\n"), { placement: "top" });
	}

	private copySessionId(): void {
		const id = this.sessionId;
		if (!id) return;
		void navigator.clipboard.writeText(id).then(() => new Notice("Session ID copied."));
	}

	/** Status dot on the info icon and the tab header (TAB-4). */
	private setStatus(status: Status): void {
		this.contentEl.dataset.status = status;
		(this.leaf as WorkspaceLeaf & LeafInternals).tabHeaderEl?.setAttr("data-apollo-status", status);
		this.stopBtn.disabled = status === "idle" || status === "error";
	}

	private isNearEnd(): boolean {
		const el = this.transcriptEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL;
	}

	private scrollToEnd(force = false): void {
		if (force || this.isNearEnd()) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}
}

/** Content blocks as stored in transcripts, loosely typed. */
interface HistoryBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	is_error?: boolean;
}

const INTERRUPTED = "[Request interrupted by user]";

/**
 * A user entry's text as the user would recognise it. Claude Code stores
 * slash commands as tags and adds reminders and command output as user
 * entries; those aren't prompts, so they return "".
 */
function displayPrompt(text: string): string {
	const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	if (stripped.startsWith(INTERRUPTED)) return INTERRUPTED;
	const command = /<command-name>([^<]*)<\/command-name>/.exec(stripped);
	if (command) {
		const args = /<command-args>([^<]*)<\/command-args>/.exec(stripped)?.[1]?.trim();
		const name = command[1]!.trim();
		return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
	}
	if (/^<(local-command-\w+|command-message|bash-\w+)>/.test(stripped) || stripped.startsWith("Caveat: The messages below")) return "";
	return stripped;
}

/** A transcript user message's prompt text, or "" if it isn't a prompt. */
export function userPrompt(message: unknown): string {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return displayPrompt(content);
	if (!Array.isArray(content)) return "";
	const texts = (content as HistoryBlock[]).filter((b) => b.type === "text" && b.text).map((b) => b.text!);
	return displayPrompt(texts.join("\n\n"));
}

/** First line of a prompt, short enough for a tab title. */
function summarise(text: string): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? text;
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
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
