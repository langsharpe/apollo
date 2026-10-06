import type { CanUseTool, EffortLevel, PermissionMode, PermissionResult, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemView, Keymap, MarkdownRenderer, Menu, Notice, setIcon, setTooltip, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { ActivityGroup } from "./activity";
import { resolveShellEnv } from "./cli";
import { ChatInput } from "./chat-input";
import { ChatSession } from "./chat-session";
import type ApolloPlugin from "./main";
import { pickOne } from "./modals";
import { showPermissionCard } from "./permission-card";
import { Presenter } from "./presenter";
import { linkifyPaths, openReference, renderWithReferences, vaultRelative } from "./references";
import { sessionTitle } from "./sessions";
import { EFFORT_LEVELS, effortOptions, modelOptions, PERMISSION_MODES } from "./settings";
import { ThinkingBlock } from "./thinking";

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
	/** Model alias or ID, or null for Claude Code's default. */
	model: string | null;
	/** Effort level, or null for the model's default. */
	effort: EffortLevel | null;
	/** Output style the chat started with; empty for Claude Code's default prompt. */
	outputStyle: string;
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

/** Pixels from the bottom that still count as being at the end. */
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
	/** The model Claude Code reports using. */
	private model: string | null = null;
	/** The output style Claude Code reports using. */
	private outputStyle: string | null = null;
	private queued: { text: string; el: HTMLElement }[] = [];
	private pendingCards = 0;
	private stopping = false;
	/** New output keeps the end of the transcript in view. Only the user's own scrolling clears it. */
	private pinned = true;
	/** scrollTop at the last scroll event, to tell scrolling up from content growing. */
	private lastScrollTop = 0;

	private infoEl!: HTMLElement;
	private modelEl!: HTMLSelectElement;
	private effortEl!: HTMLSelectElement;
	private modeEl!: HTMLSelectElement;
	private transcriptEl!: HTMLElement;
	private workingLabelEl!: HTMLElement;
	private input!: ChatInput;
	private stopBtn!: HTMLButtonElement;

	// Streaming state for the current text block.
	private blockEl: HTMLElement | null = null;
	private blockText = "";
	/** The thinking block streaming now, if any. */
	private thinking: ThinkingBlock | null = null;
	/** Streamed text blocks waiting for their message UUID, which arrives with the assistant message. */
	private unidentified: HTMLElement[] = [];
	/** Marks a tool call done or failed, by tool_use id, with the result's text. */
	private toolResults = new Map<string, (isError: boolean, output: string) => void>();
	/** Write calls that will create a note, by tool_use id, for auto-present (OBS-19). */
	private newNotes = new Map<string, string>();
	/** Tool call groups in the transcript; the last one takes further calls while nothing follows it. */
	private activities: ActivityGroup[] = [];

	/** Opens notes for this chat: workspace_present and auto-present (OBS-14 to OBS-19). */
	private readonly presenter: Presenter;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ApolloPlugin,
	) {
		super(leaf);
		this.mode = plugin.settings.defaultPermissionMode;
		this.presenter = new Presenter(this.app, () => plugin.settings, leaf, () => this.title);
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
		this.registerDomEvent(this.transcriptEl, "scroll", () => this.onScroll());
		// Output often grows after it's added (Markdown rendering, tool results), so follow every change while pinned.
		const follow = () => this.pinned && this.scrollToEnd();
		const mutations = new MutationObserver(follow);
		mutations.observe(this.transcriptEl, { childList: true, subtree: true, characterData: true });
		// The working indicator, the input growing and pane resizes all shrink the transcript.
		const resizes = new ResizeObserver(follow);
		resizes.observe(this.transcriptEl);
		this.register(() => {
			mutations.disconnect();
			resizes.disconnect();
		});

		// References, wikilinks and skill rows open their file (CTX-9, CTX-10, SLS-8).
		this.registerDomEvent(this.transcriptEl, "click", (evt) => this.onTranscriptClick(evt));

		// Shown from send until the turn ends, including while a process starts.
		const working = root.createDiv({ cls: "apollo-working" });
		working.createDiv({ cls: "apollo-working-spinner" });
		this.workingLabelEl = working.createSpan();

		const form = root.createDiv({ cls: "apollo-input" });
		this.input = new ChatInput(form, this.plugin, this, {
			submit: () => this.submit(),
			escape: () => {
				if (!this.session.busy) return false;
				this.stop();
				return true;
			},
			changed: () => this.app.workspace.requestSaveLayout(),
		});
		const toolbar = form.createDiv({ cls: "apollo-toolbar" });
		// Status dot plus model and session details on hover.
		this.infoEl = toolbar.createDiv({ cls: "apollo-info clickable-icon" });
		setIcon(this.infoEl, "info");
		// The tooltip shows a short ID, but `claude --resume` needs the full one.
		this.registerDomEvent(this.infoEl, "click", () => this.copySessionId());
		this.modelEl = toolbar.createEl("select", { cls: "dropdown apollo-model", attr: { "aria-label": "Model" } });
		this.registerDomEvent(this.modelEl, "change", () => void this.changeModel(this.modelEl.value === "default" ? null : this.modelEl.value));
		this.effortEl = toolbar.createEl("select", { cls: "dropdown apollo-effort", attr: { "aria-label": "Effort" } });
		this.registerDomEvent(this.effortEl, "change", () => void this.changeEffort(this.effortEl.value === "default" ? null : (this.effortEl.value as EffortLevel)));
		// The first session reports the model list, with versions and effort levels.
		this.registerEvent(
			this.plugin.catalogue.onChanged(() => {
				this.renderModelOptions();
				this.renderEffortOptions();
			}),
		);
		this.modeEl = toolbar.createEl("select", { cls: "dropdown apollo-mode", attr: { "aria-label": "Permission mode" } });
		this.renderModeOptions();
		this.registerDomEvent(this.modeEl, "change", () => void this.changeMode(this.modeEl.value as PermissionMode));
		// CTX-7.
		const openNotes = toolbar.createDiv({ cls: "apollo-open-notes clickable-icon", attr: { "aria-label": "Add an open note" } });
		setIcon(openNotes, "files");
		this.registerDomEvent(openNotes, "click", (evt) => this.input.showOpenNotes(evt));
		const buttons = toolbar.createDiv({ cls: "apollo-buttons" });
		this.stopBtn = buttons.createEl("button", { text: "Stop" });
		const sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });

		this.registerDomEvent(sendBtn, "click", () => this.submit());
		this.registerDomEvent(this.stopBtn, "click", () => this.stop());
		// Double-click the view header's title to rename the chat in place.
		const titleEl = (this as ViewInternals).titleEl;
		if (titleEl) this.registerDomEvent(titleEl, "dblclick", () => this.editTitle(titleEl));
		// Renames, from here or the chat list, and Claude Code's own titles.
		this.registerEvent(this.plugin.store.onChanged(() => void this.refreshTitle()));

		this.reset(null);
		const { claudePath } = await resolveShellEnv();
		if (!this.plugin.settings.cliPath && !claudePath) this.note("Claude CLI not found. Set its path in settings.", "apollo-error");
	}

	override async onClose(): Promise<void> {
		this.session.close();
		this.presenter.close();
	}

	override getState(): Record<string, unknown> {
		const state: ChatViewState = {
			sessionId: this.sessionId,
			title: this.title,
			draft: this.input?.value ?? "",
			scroll: this.transcriptEl && !this.pinned ? this.transcriptEl.scrollTop : null,
			mode: this.mode,
			model: this.session?.model ?? null,
			effort: this.session?.effort ?? null,
			outputStyle: this.session?.outputStyle ?? "",
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
		if (s.model !== undefined && s.model !== this.session.model) {
			this.session.model = s.model;
			this.renderModelOptions();
			this.renderEffortOptions();
		}
		if (s.effort !== undefined && s.effort !== this.session.effort) {
			this.session.effort = s.effort;
			this.renderEffortOptions();
		}
		// Takes effect from the next process, which is always after a restore.
		if (s.outputStyle !== undefined && s.outputStyle !== this.session.outputStyle) {
			this.session.outputStyle = s.outputStyle;
			this.updateInfo();
		}
		if (s.draft && !this.input.value) this.input.value = s.draft;
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

	/** Focus is in this chat, or nowhere in particular. */
	private hasFocus(): boolean {
		const active = this.containerEl.doc.activeElement;
		return !active || active === this.containerEl.doc.body || this.containerEl.contains(active);
	}

	focusInput(): void {
		this.input.focus();
	}

	/** Starts a fresh session in this pane. The old one stays on disk for resume. */
	newChat(): void {
		this.reset(null);
		this.input.focus();
	}

	/** Adds file and folder references at the caret (CTX-2 to CTX-4). */
	insertReferences(files: TAbstractFile[]): void {
		this.input.insertReferences(files);
	}

	/** Adds a block of text, such as a quoted selection, on its own lines (CTX-5). */
	insertBlock(text: string): void {
		this.input.insertBlock(text);
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
		if (scroll == null) this.scrollToEnd();
		else {
			this.transcriptEl.scrollTop = scroll;
			this.pinned = this.isNearEnd();
		}
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
				beforeWrite: (id, input) => session === this.session && this.noteNewFile(id, input),
			},
			this.plugin.settings.defaultPermissionMode,
			this.presenter,
			this.plugin.settings.outputStyle,
			this.plugin.settings.defaultModel,
			this.plugin.settings.defaultEffort === "default" ? null : this.plugin.settings.defaultEffort,
		);
		session.sessionId = sessionId;
		this.session = session;
		this.mode = this.plugin.settings.defaultPermissionMode;
		this.model = null;
		this.outputStyle = null;
		this.renderModelOptions();
		this.renderEffortOptions();
		this.renderModeOptions();
		this.queued = [];
		this.pendingCards = 0;
		this.stopping = false;
		this.blockEl = null;
		this.thinking = null;
		this.unidentified = [];
		this.toolResults.clear();
		this.newNotes.clear();
		this.activities = [];
		this.transcriptEl.empty();
		this.pinned = true;
		this.lastScrollTop = 0;
		if (!sessionId) this.transcriptEl.createDiv({ cls: "apollo-empty", text: "New chat. Claude Code runs in this vault." });
		this.setTitle(title || NEW_CHAT_TITLE);
		this.updateInfo();
		this.setStatus("idle");
		// The chat list shows which sessions are open.
		this.plugin.store.changed();
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (!text) return;
		if (this.runApolloCommand(text)) return;
		this.input.value = "";
		this.app.workspace.requestSaveLayout();
		this.transcriptEl.querySelector(".apollo-empty")?.remove();
		const el = this.userBubble(text);
		this.skillRowForCommand(text);
		this.scrollToEnd();
		if (this.session.busy) {
			el.addClass("is-queued");
			this.queued.push({ text, el });
			return;
		}
		void this.send(text, [el]);
	}

	private async send(text: string, bubbles: HTMLElement[]): Promise<void> {
		this.stopping = false;
		this.presenter.newTurn();
		this.setStatus("running");
		// The first message, and the first after a resume or idle release, waits for a process.
		this.setWorking(this.session.running ? "Working…" : "Starting Claude Code…");
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
		this.setWorking("Stopping…");
		this.returnQueuedToInput();
		void this.session.interrupt().catch((err) => console.error("Apollo: interrupt failed", err));
	}

	private returnQueuedToInput(): void {
		if (!this.queued.length) return;
		for (const q of this.queued) q.el.remove();
		this.input.value = [...this.queued.map((q) => q.text), this.input.value].filter(Boolean).join("\n\n");
		this.queued = [];
	}

	private async onPermissionRequest(...[toolName, input, options]: Parameters<CanUseTool>): Promise<PermissionResult> {
		this.finishBlock();
		this.pendingCards++;
		this.setStatus("awaiting");
		try {
			const decision = showPermissionCard(
				this.transcriptEl,
				{ app: this.app, component: this, vaultPath: this.plugin.vaultPath(), takeFocus: this.hasFocus() },
				{ toolName, input, options, autoMode: this.mode === "auto" },
			);
			// A card needs an answer, so always bring it into view.
			this.scrollToEnd();
			const result = await decision;
			// The answered card dropped its buttons and fields; give the caret back to the input.
			if (this.hasFocus()) this.input.focus();
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

	private renderModelOptions(): void {
		const current = this.session.model;
		this.modelEl.empty();
		for (const [value, text] of Object.entries(modelOptions(this.plugin.catalogue.models, current))) this.modelEl.createEl("option", { value, text });
		this.modelEl.value = current ?? "default";
	}

	/** Hidden for a model without effort levels. */
	private renderEffortOptions(): void {
		const current = this.session.effort;
		const options = effortOptions(this.plugin.catalogue.models, this.session.model, current);
		this.effortEl.empty();
		for (const [value, text] of Object.entries(options)) this.effortEl.createEl("option", { value, text: `${text} effort` });
		this.effortEl.value = current ?? "default";
		this.effortEl.toggle(Object.keys(options).length > 0);
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
		this.settleActivities();
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
					if (!this.stopping) this.setWorking("Working…");
					this.model = msg.model;
					this.outputStyle = msg.output_style;
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
				else if (ev.type === "content_block_start" && ev.content_block.type === "thinking") this.startThinking();
				else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") this.appendBlock(ev.delta.text);
				else if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") this.thinking?.append(ev.delta.thinking);
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
						if (block.type === "tool_result") this.toolResults.get(block.tool_use_id)?.(block.is_error ?? false, resultText(block.content));
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
		this.settleActivities();
		this.unidentified = [];
		const secs = (durationMs / 1000).toFixed(1);
		if (this.stopping) this.note("Stopped.");
		else this.note(`${subtype === "success" ? "Done" : `Ended (${subtype})`} in ${secs}s`);
		this.stopping = false;
		// The chat list's "last updated", and Claude Code's generated title.
		this.plugin.store.changed();
		// The turn may have added skills or commands; the scan is cheap when nothing changed.
		this.plugin.catalogue.requestScan();

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

	/** Renders a saved transcript: user prompts, assistant text, thinking and tool rows. */
	private async renderHistory(messages: SessionMessage[]): Promise<void> {
		const renders: Promise<void>[] = [];
		for (const msg of messages) {
			if (msg.parent_tool_use_id) continue;
			const content = (msg.message as { content?: unknown } | null)?.content;
			const blocks: HistoryBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
			if (msg.type === "user") {
				const texts: string[] = [];
				for (const block of blocks) {
					if (block.type === "tool_result" && block.tool_use_id) this.toolResults.get(block.tool_use_id)?.(block.is_error ?? false, resultText(block.content));
					else if (block.type === "text" && block.text) texts.push(block.text);
					else if (block.type === "image") texts.push("[Image]");
				}
				const prompt = displayPrompt(texts.join("\n\n"));
				if (prompt === INTERRUPTED) this.note("Stopped.");
				else if (prompt) {
					this.addForkAction(this.userBubble(prompt), msg.uuid, "user");
					this.skillRowForCommand(prompt);
				}
			} else if (msg.type === "assistant") {
				for (const block of blocks) {
					if (block.type === "text" && block.text) {
						const el = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-assistant" });
						renders.push(this.renderMarkdown(block.text, el.createDiv()));
						this.addForkAction(el, msg.uuid, "assistant");
					} else if (block.type === "thinking" && block.thinking) {
						const thinking = new ThinkingBlock(this.transcriptEl, (text, el) => this.renderMarkdown(text, el));
						thinking.append(block.thinking);
						renders.push(thinking.finish());
					} else if (block.type === "tool_use" && block.id && block.name) {
						this.toolRow(block.id, block.name, block.input ?? {});
					}
				}
			}
		}
		// Calls cut off by an interrupted turn never got a result.
		this.settleActivities();
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
		if (name === "Skill" && typeof input.skill === "string") {
			// The model chose a skill (SLS-8).
			const row = this.skillRow(input.skill);
			this.toolResults.set(id, (isError) => row.addClass(isError ? "is-error" : "is-done"));
			return;
		}
		// Consecutive calls share a group; anything shown after it starts a new one.
		let group = this.activities[this.activities.length - 1];
		if (!group || group.el !== this.transcriptEl.lastElementChild) {
			group = new ActivityGroup(this.transcriptEl, this.app, this.plugin.vaultPath());
			this.activities.push(group);
		}
		const target = group;
		target.add(id, name, input);
		this.toolResults.set(id, (isError, output) => {
			target.finish(id, isError, output);
			const created = this.newNotes.get(id);
			this.newNotes.delete(id);
			if (created && !isError) void this.autoPresent(created);
		});
	}

	/** Remembers a Write that is about to create a note, when auto-present is on (OBS-19). */
	private noteNewFile(id: string, input: Record<string, unknown>): void {
		if (!this.plugin.settings.autoPresent || typeof input.file_path !== "string") return;
		const rel = vaultRelative(input.file_path, this.plugin.vaultPath());
		if (!rel || !rel.toLowerCase().endsWith(".md")) return;
		// The call hasn't run yet, so an existing file means an overwrite.
		if (!this.app.vault.getAbstractFileByPath(rel)) this.newNotes.set(id, rel);
	}

	private async autoPresent(path: string): Promise<void> {
		try {
			await this.presenter.presentNew(path);
		} catch (err) {
			console.warn("Apollo: couldn't present", path, err);
		}
	}

	private settleActivities(): void {
		for (const group of this.activities) group.settle();
	}

	/** A "Skill: name" row linking to its SKILL.md (SLS-8). */
	private skillRow(name: string): HTMLElement {
		const row = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-tool apollo-skill" });
		row.createSpan({ cls: "apollo-tool-name", text: "Skill" });
		const path = this.plugin.catalogue.get(name)?.path;
		const nameEl = row.createSpan({ cls: "apollo-tool-summary", text: name });
		if (path) {
			nameEl.addClass("apollo-ref");
			nameEl.dataset.skillPath = path;
			setTooltip(nameEl, path);
		}
		return row;
	}

	/** A skill row for a message that runs a skill as a slash command (SLS-8). */
	private skillRowForCommand(text: string): void {
		const name = /^\/(\S+)/.exec(text)?.[1];
		const entry = name ? this.plugin.catalogue.get(name) : undefined;
		if (entry?.kind === "skill") this.skillRow(entry.name).addClass("is-done");
	}

	private userBubble(text: string): HTMLElement {
		const el = this.transcriptEl.createDiv({ cls: "apollo-msg apollo-user" });
		renderWithReferences(el, text, this.app, this.plugin.vaultPath());
		return el;
	}

	/** Renders Markdown, then makes vault paths in it clickable (CTX-10). */
	private async renderMarkdown(text: string, el: HTMLElement): Promise<void> {
		await MarkdownRenderer.render(this.app, text, el, "", this);
		linkifyPaths(el, this.app, this.plugin.vaultPath());
	}

	private onTranscriptClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const ref = target?.closest<HTMLElement>(".apollo-ref");
		if (ref?.dataset.path) {
			evt.preventDefault();
			void openReference(this.app, ref.dataset.path, { line: Number(ref.dataset.line) || undefined, evt, from: this.leaf });
			return;
		}
		if (ref?.dataset.skillPath) {
			evt.preventDefault();
			this.openSkillFile(ref.dataset.skillPath, evt);
			return;
		}
		const link = target?.closest<HTMLAnchorElement>("a.internal-link");
		if (link) {
			evt.preventDefault();
			const href = link.dataset.href ?? link.getAttribute("href");
			if (href) void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(evt) || "tab");
		}
	}

	/** Opens a SKILL.md: as a note when Obsidian indexes it, otherwise in the system editor (dot-folders aren't indexed). */
	private openSkillFile(path: string, evt: MouseEvent): void {
		const rel = vaultRelative(path, this.plugin.vaultPath());
		if (rel && this.app.vault.getFileByPath(rel)) {
			void openReference(this.app, rel, { evt, from: this.leaf });
			return;
		}
		void (require("electron") as { shell: { openPath(path: string): Promise<string> } }).shell.openPath(path).then((error) => {
			if (error) new Notice(`Couldn't open ${path}: ${error}`);
		});
	}

	/**
	 * Commands Apollo handles itself (SLS-6): /new, /clear, /fork, /model,
	 * /effort and /mode. Returns true if the text was one of them.
	 */
	private runApolloCommand(text: string): boolean {
		const m = /^\/(new|clear|fork|model|effort|mode)(?:\s+([\s\S]*))?$/.exec(text);
		if (!m) return false;
		const arg = m[2]?.trim() ?? "";
		const clearInput = () => {
			this.input.value = "";
			this.app.workspace.requestSaveLayout();
		};
		switch (m[1]) {
			case "new":
			case "clear":
				if (arg) return false;
				clearInput();
				this.newChat();
				return true;
			case "fork": {
				if (arg) return false;
				const id = this.sessionId;
				if (!id) {
					new Notice("This chat has no session to fork yet.");
					return true;
				}
				clearInput();
				void this.plugin.forkChat(id);
				return true;
			}
			case "model":
				clearInput();
				if (arg) void this.changeModel(arg === "default" ? null : arg);
				else void this.pickModel();
				return true;
			case "effort": {
				clearInput();
				if (!arg) {
					void this.pickEffort();
					return true;
				}
				const level = arg.toLowerCase();
				if (level === "default" || level === "auto") void this.changeEffort(null);
				else if (level in EFFORT_LEVELS) void this.changeEffort(level as EffortLevel);
				else new Notice(`Unknown effort “${arg}”. Use low, medium, high, xhigh, max or default.`);
				return true;
			}
			case "mode": {
				clearInput();
				if (!arg) {
					void this.pickMode();
					return true;
				}
				const mode = modeFromArg(arg);
				if (mode) {
					this.modeEl.value = mode;
					void this.changeMode(mode);
				} else {
					new Notice(`Unknown mode “${arg}”. Use ask, accept-edits, plan or auto.`);
				}
				return true;
			}
		}
		return false;
	}

	private async pickModel(): Promise<void> {
		const models = this.plugin.catalogue.models;
		const options = models.length
			? models.map((m) => ({ value: m.value, label: m.displayName, note: m.description }))
			: [{ value: "default", label: "Default", note: "Claude Code's default model. The full list appears after a chat's first message." }];
		const choice = await pickOne(this.app, options, "Choose a model for this chat");
		if (choice) await this.changeModel(choice === "default" ? null : choice);
	}

	private async pickEffort(): Promise<void> {
		const levels = effortOptions(this.plugin.catalogue.models, this.session.model, this.session.effort);
		if (!Object.keys(levels).length) {
			new Notice("This chat's model has no effort levels.");
			return;
		}
		const options = Object.entries(levels).map(([value, label]) => ({ value, label, note: value === "default" ? "The model's own effort level." : undefined }));
		const choice = await pickOne(this.app, options, "Choose an effort level for this chat");
		if (choice) await this.changeEffort(choice === "default" ? null : (choice as EffortLevel));
	}

	private async pickMode(): Promise<void> {
		const options = Object.entries(PERMISSION_MODES).map(([value, label]) => ({ value, label }));
		const choice = (await pickOne(this.app, options, "Choose a permission mode")) as PermissionMode | null;
		if (!choice) return;
		this.modeEl.value = choice;
		await this.changeMode(choice);
	}

	private async changeModel(model: string | null): Promise<void> {
		try {
			await this.session.setModel(model);
			// Init reported the old model; show the new one until the next process reports.
			if (this.model) this.model = this.plugin.catalogue.models.find((m) => m.value === (model ?? "default"))?.resolvedModel ?? model ?? this.model;
			this.updateInfo();
			this.app.workspace.requestSaveLayout();
		} catch (err) {
			new Notice(`Couldn't switch model: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.renderModelOptions();
		// The new model may offer different levels, or none.
		this.renderEffortOptions();
	}

	private async changeEffort(effort: EffortLevel | null): Promise<void> {
		try {
			await this.session.setEffort(effort);
			this.app.workspace.requestSaveLayout();
		} catch (err) {
			new Notice(`Couldn't switch effort: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.renderEffortOptions();
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
	}

	private startThinking(): void {
		this.finishBlock();
		this.thinking = new ThinkingBlock(this.transcriptEl, (text, el) => this.renderMarkdown(text, el));
	}

	// Swap the plain streamed text for rendered Markdown once the block completes.
	private finishBlock(): void {
		void this.thinking?.finish();
		this.thinking = null;
		const el = this.blockEl;
		if (!el) return;
		this.blockEl = null;
		el.parentElement?.removeClass("is-streaming");
		el.empty();
		void this.renderMarkdown(this.blockText, el);
	}

	private note(text: string, cls = "apollo-note"): void {
		this.transcriptEl.createDiv({ cls: `apollo-msg ${cls}`, text });
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
		const titleEl = (this as ViewInternals).titleEl;
		// Leave a title being edited alone; it picks up the latest when editing ends.
		if (titleEl && !titleEl.isContentEditable) titleEl.setText(title);
		this.app.workspace.requestSaveLayout();
	}

	/** Makes the view header's title editable. Enter or clicking away saves; Escape cancels. */
	private editTitle(el: HTMLElement): void {
		const id = this.sessionId;
		if (!id || el.isContentEditable) return;
		let cancelled = false;
		const onKeydown = (evt: KeyboardEvent) => {
			if (evt.isComposing) return;
			if (evt.key === "Enter" || evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				cancelled = evt.key === "Escape";
				el.blur();
			}
		};
		const finish = () => {
			el.removeEventListener("keydown", onKeydown);
			el.removeAttribute("contenteditable");
			// Pasted text may span lines.
			const title = (el.textContent ?? "").replace(/\s+/g, " ").trim();
			el.setText(this.title);
			if (cancelled || !title || title === this.title || id !== this.sessionId) return;
			this.setTitle(title);
			// On failure, puts back the saved title.
			void this.plugin.saveChatTitle(id, title).then(() => this.refreshTitle());
		};
		el.addEventListener("keydown", onKeydown);
		el.addEventListener("blur", finish, { once: true });
		el.contentEditable = "plaintext-only";
		el.focus();
		window.getSelection()?.selectAllChildren(el);
	}

	private updateInfo(): void {
		const id = this.sessionId;
		const lines = id ? [] : ["New chat. No session yet."];
		if (this.model) lines.push(`Model: ${this.model}`);
		// PRM-1: what Claude Code reports once running, otherwise what the chat will ask for.
		const style = this.outputStyle ?? this.session.outputStyle;
		lines.push(`Output style: ${style && style !== "default" ? style : "none"}`);
		if (id) lines.push(`Session: ${id.slice(0, 8)}`, this.session.running ? "Claude Code is running." : "Claude Code starts on your next message.", "Click to copy the full session ID.");
		setTooltip(this.infoEl, lines.join("\n"), { placement: "top" });
	}

	private copySessionId(): void {
		const id = this.sessionId;
		if (!id) return;
		void navigator.clipboard.writeText(id).then(() => new Notice("Session ID copied."));
	}

	/** Status dot on the info icon and the tab header (TAB-4), and the working indicator. */
	private setStatus(status: Status): void {
		this.contentEl.dataset.status = status;
		(this.leaf as WorkspaceLeaf & LeafInternals).tabHeaderEl?.setAttr("data-apollo-status", status);
		this.stopBtn.disabled = status === "idle" || status === "error";
	}

	/** The working indicator's text. It shows while the status is running. */
	private setWorking(label: string): void {
		this.workingLabelEl.setText(label);
	}

	private isNearEnd(): boolean {
		const el = this.transcriptEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL;
	}

	/** Shows the end of the transcript and keeps it in view as output arrives. */
	private scrollToEnd(): void {
		this.pinned = true;
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	/**
	 * Scrolling up unpins; reaching the end pins again. Content growing below
	 * doesn't scroll, and content shrinking only moves the position to the end.
	 */
	private onScroll(): void {
		const top = this.transcriptEl.scrollTop;
		if (this.isNearEnd()) this.pinned = true;
		else if (top < this.lastScrollTop) this.pinned = false;
		this.lastScrollTop = top;
		this.app.workspace.requestSaveLayout();
	}
}

/** Content blocks as stored in transcripts, loosely typed. */
interface HistoryBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
}

/** A tool result's text, from either a string or text blocks. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text!)
		.join("\n");
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

/** A permission mode from a /mode argument: ask, accept-edits, plan or auto. */
function modeFromArg(arg: string): PermissionMode | null {
	const key = arg.toLowerCase().replace(/[\s_-]/g, "");
	const modes: Record<string, PermissionMode> = { ask: "default", default: "default", acceptedits: "acceptEdits", accept: "acceptEdits", plan: "plan", auto: "auto" };
	return modes[key] ?? null;
}
