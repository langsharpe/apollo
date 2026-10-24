import type { CanUseTool, EffortLevel, PermissionMode, PermissionResult, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemView, Menu, Notice, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { resolveShellEnv } from "./cli";
import { ChatInput } from "./chat-input";
import { ChatToolbar } from "./chat-toolbar";
import { ChatSession } from "./chat-session";
import { agentTotals, errorMessage, formatDuration, truncate } from "./format";
import type ApolloPlugin from "./main";
import { pickOne } from "./modals";
import { onVaultConfigChanged, refreshTabHeader, tabHeaderEl, vaultConfig, viewTitleEl } from "./obsidian-internals";
import { showPermissionCard } from "./permission-card";
import { Presenter } from "./presenter";
import { ProgressLine } from "./progress";
import { sessionTitle } from "./sessions";
import { parseApolloCommand } from "./apollo-commands";
import { newChatConfig, type ChatConfig, effortOptions, nullIfDefault, parseEffortArg, parseModeArg, PERMISSION_MODES, resolvedModelName } from "./chat-options";
import { Transcript } from "./transcript";
import { TranscriptScroller } from "./transcript-scroll";

export const CHAT_VIEW_TYPE = "apollo-chat";

type Status = "idle" | "running" | "awaiting" | "error";

/**
 * What Obsidian saves for an open chat, so it comes back on restart (TAB-5).
 * The config fields are those of `ChatConfig`, except that the permission mode
 * is saved as `mode`, the key saved layouts already use.
 */
export interface ChatViewState extends Omit<ChatConfig, "permissionMode"> {
	sessionId: string | null;
	title: string;
	draft: string;
	/** Transcript scroll position, or null when scrolled to the end. */
	scroll: number | null;
	mode: PermissionMode;
	/** Thinking and tool calls show in the transcript, or null to follow the setting. */
	showWork: boolean | null;
}

export const NEW_CHAT_TITLE = "New chat";
const TITLE_LENGTH = 50;

/**
 * One chat per leaf. Messages go to a long-lived Claude Code process; while a
 * turn runs, further messages queue here and go out together when it ends.
 * A chat can start fresh or show a saved session and resume it.
 */
export class ChatView extends ItemView {
	private session!: ChatSession;
	private title = NEW_CHAT_TITLE;
	/** The model Claude Code reports using. */
	private reportedModel: string | null = null;
	/** The output style Claude Code reports using. */
	private reportedOutputStyle: string | null = null;
	private queued: { text: string; el: HTMLElement }[] = [];
	private pendingCards = 0;
	private stopping = false;
	private status: Status = "idle";
	/** The chat finished while you were looking elsewhere; its tab shows a dot until you look. */
	private unseen = false;
	/** This chat shows or hides thinking and tool calls regardless of the setting, or null to follow it. */
	private workOverride: boolean | null = null;

	private toolbar!: ChatToolbar;
	/** Scrolls the transcript and the status row after it. */
	private scrollEl!: HTMLElement;
	private scroller!: TranscriptScroller;
	private transcript!: Transcript;
	private progress!: ProgressLine;
	private input!: ChatInput;

	/** Opens notes for this chat: workspace_present and auto-present (OBS-14 to OBS-19). */
	private readonly presenter: Presenter;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ApolloPlugin,
	) {
		super(leaf);
		this.presenter = new Presenter(this.app, () => plugin.settings, leaf, () => this.title);
	}

	override getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return this.title;
	}

	override getIcon(): string {
		return this.plugin.settings.icon;
	}

	/** Shows the icon setting's new value on the tab and the presentation pane's marker. */
	applyIcon(): void {
		refreshTabHeader(this.leaf);
		this.presenter.applyIcon();
	}

	get sessionId(): string | null {
		return this.session?.sessionId ?? null;
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("apollo-chat");
		root.toggleClass("apollo-hide-work", !this.showWork);
		this.applyReadableWidth();
		// Notes follow the setting as soon as it changes, so chats do too.
		this.registerEvent(
			onVaultConfigChanged(this.app, (key) => {
				if (key !== "readableLineLength") return;
				this.applyReadableWidth();
				this.scroller.follow();
			}),
		);

		this.scrollEl = root.createDiv({ cls: "apollo-scroll" });
		this.transcript = new Transcript(this.scrollEl.createDiv({ cls: "apollo-transcript" }), {
			app: this.app,
			plugin: this.plugin,
			component: this,
			leaf: this.leaf,
			presenter: this.presenter,
			tasks: () => this.session.tasks,
			showWork: () => this.showWork,
			toggleWork: (anchor) => this.setShowWork(!this.showWork, anchor, true),
			fork: (uuid, role) => this.forkFrom(uuid, role),
		});
		// Shown at the end of the transcript from send until the turn and its agents end, including while a process starts (RND-8).
		this.progress = new ProgressLine(this.scrollEl, this, {
			step: () => this.transcript.currentStep(),
			tasks: () => this.session.tasks.list,
			awaiting: () => this.pendingCards > 0,
		});
		// Double-clicking it shows or hides thinking and tool calls, expanded, like a message's brain icon (RND-10).
		this.registerDomEvent(this.progress.el, "dblclick", () => this.setShowWork(!this.showWork, this.progress.el, true));
		this.scroller = new TranscriptScroller(this.scrollEl, () => this.app.workspace.requestSaveLayout());
		this.registerDomEvent(this.scrollEl, "scroll", () => this.scroller.onScroll());
		this.register(() => this.scroller.dispose());

		const form = root.createDiv({ cls: "apollo-input" });
		this.input = new ChatInput(form, this.plugin, this, {
			submit: () => this.submit(),
			escape: () => {
				if (!this.session.working) return false;
				this.stop();
				return true;
			},
			changed: () => this.app.workspace.requestSaveLayout(),
		});
		this.toolbar = new ChatToolbar(form, this, {
			copySessionId: () => this.sessionId && this.plugin.copySessionId(this.sessionId),
			changeModel: (model) => void this.changeModel(model),
			changeEffort: (effort) => void this.changeEffort(effort),
			changeMode: (mode) => void this.changeMode(mode),
			showOpenNotes: (evt) => this.input.showOpenNotes(evt),
			send: () => this.submit(),
			stop: () => this.stop(),
		});
		// The first session reports the model list, with versions and effort levels.
		this.registerEvent(
			this.plugin.catalogue.onChanged(() => {
				this.renderModelOptions();
				this.renderEffortOptions();
			}),
		);
		// Double-click the view header's title to rename the chat in place.
		const titleEl = viewTitleEl(this);
		if (titleEl) this.registerDomEvent(titleEl, "dblclick", () => this.editTitle(titleEl));
		// Renames, from here or the chat list, and Claude Code's own titles.
		this.registerEvent(this.plugin.store.onChanged(() => void this.refreshTitle()));
		// Looking at the chat clears its "finished while you were away" dot.
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.markSeen()));
		this.registerDomEvent(this.containerEl.win, "focus", () => this.markSeen());

		this.reset(null);
		const { claudePath } = await resolveShellEnv();
		if (!this.plugin.settings.cliPath && !claudePath) this.transcript.note("Claude CLI not found. Set its path in settings.", "apollo-error");
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
			scroll: this.scroller?.position ?? null,
			mode: this.session?.permissionMode ?? this.plugin.settings.defaultPermissionMode,
			model: this.session?.model ?? null,
			effort: this.session?.effort ?? null,
			outputStyle: this.session?.outputStyle ?? "",
			showWork: this.workOverride,
		};
		return { ...super.getState(), ...state };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as Partial<ChatViewState>;
		if (s.sessionId && s.sessionId !== this.sessionId) await this.loadSession(s.sessionId, s.title, s.scroll);
		if (s.mode && s.mode !== this.session.permissionMode) {
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
		if (s.showWork !== undefined && s.showWork !== this.workOverride) {
			this.workOverride = s.showWork;
			this.applyShowWork();
		}
		if (s.draft && !this.input.value) this.input.value = s.draft;
		await super.setState(state, result);
	}

	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		menu.addItem((item) =>
			item
				.setSection("view")
				.setTitle("Show thinking and tool calls")
				.setIcon("brain")
				.setChecked(this.showWork)
				.onClick(() => this.setShowWork(!this.showWork)),
		);
		const id = this.sessionId;
		if (!id) return;
		menu.addItem((item) => item.setSection("action").setTitle("Rename chat").setIcon("pencil").onClick(() => void this.plugin.renameChat(id, this.title)));
		menu.addItem((item) => item.setSection("action").setTitle("Fork chat").setIcon("git-branch").onClick(() => void this.plugin.forkChat(id)));
		menu.addItem((item) => item.setSection("action").setTitle("Copy session ID").setIcon("copy").onClick(() => this.sessionId && this.plugin.copySessionId(this.sessionId)));
	}

	/** Focus is in this chat, or nowhere in particular. */
	private hasFocus(): boolean {
		const active = this.containerEl.doc.activeElement;
		return !active || active === this.containerEl.doc.body || this.containerEl.contains(active);
	}

	/**
	 * Thinking and tool calls show in the transcript. Otherwise they're hidden,
	 * and the status row still says what Claude is doing (RND-8, RND-10).
	 */
	private get showWork(): boolean {
		return this.workOverride ?? this.plugin.settings.showWork;
	}

	/**
	 * Shows or hides thinking and tool calls in this chat. Matching the setting
	 * goes back to following it. `expand` opens each section one level, to its
	 * thinking rows and groups of tool calls; hiding closes them again.
	 */
	setShowWork(show: boolean, anchor?: HTMLElement, expand = false): void {
		this.workOverride = show === this.plugin.settings.showWork ? null : show;
		this.transcript.setWorkOpen(show, expand);
		this.applyShowWork(anchor);
		this.app.workspace.requestSaveLayout();
	}

	/**
	 * Caps the transcript and input at the theme's `--file-line-width` when
	 * "Readable line length" is on, like a note. It only shows in panes wider
	 * than that, such as a chat tab in the main area.
	 */
	private applyReadableWidth(): void {
		const readable = vaultConfig(this.app, "readableLineLength");
		this.contentEl.toggleClass("apollo-readable-width", readable !== false);
	}

	/**
	 * Updates the transcript and toggles after the chat or the setting changes.
	 * `anchor` stays where it is on screen, so the message you clicked doesn't
	 * jump; otherwise a pinned transcript stays at its end.
	 */
	applyShowWork(anchor?: HTMLElement): void {
		const change = () => {
			this.contentEl.toggleClass("apollo-hide-work", !this.showWork);
			this.transcript.renderWorkToggles();
		};
		if (anchor) {
			this.scroller.keepInPlace(anchor, change);
		} else {
			change();
			this.scroller.follow();
		}
	}

	toggleWork(): void {
		this.setShowWork(!this.showWork);
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
		this.transcript.reset();
		const loading = this.transcript.placeholder("Loading chat…");
		let messages: SessionMessage[];
		try {
			messages = await this.plugin.store.messages(sessionId);
		} catch (err) {
			if (session !== this.session) return;
			loading.remove();
			this.transcript.note(`Couldn't load this chat: ${errorMessage(err)}`, "apollo-error");
			return;
		}
		if (session !== this.session) return;
		loading.remove();
		if (!messages.length) this.transcript.note("No messages found for this session. It may have been deleted.");
		await this.transcript.renderHistory(messages);
		if (session !== this.session) return;
		this.scroller.restore(scroll);
		void this.refreshTitle();
	}

	/** Swaps in a new ChatSession, resuming `sessionId` if given, and clears the transcript. */
	private reset(sessionId: string | null, title?: string): void {
		this.session?.close();
		// Late callbacks from a closed session must not touch the new chat.
		const session: ChatSession = new ChatSession(
			this.plugin,
			this.presenter,
			{
				message: (msg) => session === this.session && this.handle(msg),
				permission: (toolName, input, options) =>
					session === this.session
						? this.onPermissionRequest(toolName, input, options)
						: Promise.resolve({ behavior: "deny", message: "Chat closed." }),
				ended: (err) => session === this.session && this.onSessionError(err),
				released: () => session === this.session && this.updateInfo(),
				beforeWrite: (id, input) => session === this.session && this.transcript.noteNewFile(id, input),
			},
			newChatConfig(this.plugin.settings),
		);
		session.sessionId = sessionId;
		this.session = session;
		this.reportedModel = null;
		this.reportedOutputStyle = null;
		this.renderModelOptions();
		this.renderEffortOptions();
		this.renderModeOptions();
		this.queued = [];
		this.pendingCards = 0;
		this.stopping = false;
		this.progress.idle();
		this.transcript.reset();
		this.scroller.reset();
		if (!sessionId) this.transcript.placeholder("New chat. Claude Code runs in this vault.");
		this.setTitle(title || NEW_CHAT_TITLE);
		this.updateInfo();
		this.setStatus("idle");
		this.setUnseen(false);
		// The chat list shows which sessions are open.
		this.plugin.store.changed();
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (!text) return;
		if (this.runApolloCommand(text)) return;
		this.input.value = "";
		this.app.workspace.requestSaveLayout();
		this.transcript.clearPlaceholder();
		const el = this.transcript.userBubble(text);
		this.transcript.skillRowForCommand(text);
		// A queued message moves to the top when it goes out.
		if (this.session.busy) {
			el.addClass("is-queued");
			this.queued.push({ text, el });
			return;
		}
		this.scroller.anchorAtTop(el);
		void this.send(text, [el]);
	}

	private async send(text: string, bubbles: HTMLElement[]): Promise<void> {
		this.stopping = false;
		this.presenter.newTurn();
		// The first message, and the first after a resume or idle release, waits for a process.
		this.progress.begin(this.session.running ? null : "starting");
		this.refreshStatus();
		// Until Claude Code names the session, the first prompt is the title.
		if (!this.sessionId && this.title === NEW_CHAT_TITLE) this.setTitle(titleFromPrompt(text));
		try {
			const uuid = await this.session.send(text);
			for (const el of bubbles) this.transcript.addMessageActions(el, uuid, "user");
			this.updateInfo();
		} catch (err) {
			this.onSessionError(err);
		}
	}

	/** Stops the current turn and any agents still running (PRM-T4). Queued messages go back to the input. */
	stop(): void {
		if (!this.session.working) return;
		this.stopping = true;
		this.progress.setPhase("stopping");
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
		this.transcript.finishStreaming();
		this.pendingCards++;
		this.refreshStatus();
		try {
			const decision = showPermissionCard(
				this.transcript.el,
				{ app: this.app, component: this, vaultPath: this.plugin.vaultPath(), takeFocus: this.hasFocus() },
				{ toolName, input, options, autoMode: this.session.permissionMode === "auto" },
			);
			// A card needs an answer, so always bring it into view, without following the output after it.
			this.scroller.revealEnd();
			const result = await decision;
			// The answered card dropped its buttons and fields; give the caret back to the input.
			if (this.hasFocus()) this.input.focus();
			// A bare deny ends the turn, the same as Stop.
			if (result.behavior === "deny" && result.interrupt) this.stopping = true;
			return result;
		} finally {
			this.pendingCards = Math.max(0, this.pendingCards - 1);
			// Time spent waiting for you isn't Claude going quiet.
			this.progress.heartbeat();
			this.refreshStatus();
		}
	}

	private async changeMode(mode: PermissionMode): Promise<void> {
		// The session records the mode at once, so the dropdown can show it while the switch is pending.
		const switching = this.session.setPermissionMode(mode);
		this.renderModeOptions();
		try {
			await switching;
			this.app.workspace.requestSaveLayout();
		} catch (err) {
			new Notice(`Couldn't switch permission mode: ${errorMessage(err)}`);
		}
		this.renderModeOptions();
	}

	/** Reflects the mode Claude Code reports, which can differ from the one asked for. */
	private syncMode(actual: PermissionMode): void {
		if (actual === this.session.permissionMode) return;
		if (this.session.permissionMode === "auto" && actual === "default") {
			this.transcript.note("Auto mode isn't available for this model, so this chat uses Ask.");
		} else {
			this.transcript.note(`Permission mode: ${PERMISSION_MODES[actual as keyof typeof PERMISSION_MODES] ?? actual}`);
		}
		this.session.permissionMode = actual;
		this.renderModeOptions();
	}

	private renderModelOptions(): void {
		this.toolbar.renderModel(this.plugin.catalogue.models, this.session.model);
	}

	private renderEffortOptions(): void {
		this.toolbar.renderEffort(this.plugin.catalogue.models, this.session.model, this.session.effort);
	}

	private renderModeOptions(): void {
		this.toolbar.renderMode(this.session.permissionMode);
	}

	private onSessionError(err: unknown): void {
		this.transcript.finishStreaming();
		// Background agents went with the process.
		this.transcript.settleActivities(true);
		console.error("Apollo: Claude Code ended", err);
		this.transcript.note(`Error: ${errorMessage(err)}`, "apollo-error");
		this.returnQueuedToInput();
		this.stopping = false;
		this.progress.idle();
		this.setStatus("error");
		this.updateInfo();
	}

	private handle(msg: SDKMessage): void {
		// Anything from Claude Code, from the main thread or a subagent, shows it's alive (RND-8).
		this.progress.heartbeat();
		if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) {
			// Subagent output isn't shown; the files it edits are listed with its call (RND-9).
			if (msg.type === "assistant") this.transcript.agentEdits(msg.parent_tool_use_id, msg.message.content);
			return;
		}
		switch (msg.type) {
			case "system":
				this.handleSystem(msg);
				break;
			case "stream_event": {
				const ev = msg.event;
				this.progress.setRetry(null);
				if (ev.type === "content_block_start" && ev.content_block.type === "text") this.transcript.startText();
				else if (ev.type === "content_block_start" && ev.content_block.type === "thinking") this.transcript.startThinking();
				else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") this.transcript.appendText(ev.delta.text);
				else if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") this.transcript.appendThinking(ev.delta.thinking);
				else if (ev.type === "content_block_stop") this.transcript.finishStreaming();
				// Deltas don't change the step; the line's own timer keeps its times current.
				if (ev.type === "content_block_start" || ev.type === "content_block_stop") this.progress.refresh();
				return;
			}
			case "assistant":
				// Text arrives through stream events; tool calls are shown once their input is complete.
				for (const block of msg.message.content) {
					if (block.type === "tool_use") this.transcript.toolRow(block.id, block.name, block.input as Record<string, unknown>);
					else if (block.type === "text") {
						this.transcript.textMessage(msg.uuid);
					}
				}
				if (msg.error) this.transcript.note(`Error: ${msg.error}`, "apollo-error");
				break;
			case "user":
				if (Array.isArray(msg.message.content)) {
					for (const block of msg.message.content) {
						if (block.type !== "tool_result") continue;
						this.transcript.toolResult(block.tool_use_id, block.is_error ?? false, block.content);
					}
				}
				break;
			case "result":
				this.onTurnEnd(msg.subtype, msg.duration_ms);
				break;
		}
		this.progress.refresh();
	}

	/** An agent finished, failed or was stopped (RND-9). */
	private agentEnded(toolUseId: string, status: string, totals: string): void {
		this.transcript.agentEnded(toolUseId, status, totals);
		// Stop with only background agents running ends without a result.
		if (this.stopping && !this.progress.inTurn && !this.session.working) {
			this.stopping = false;
			this.transcript.note("Stopped.");
		}
	}

	/** Forks the chat at a message, from its hover action (HIST-3a). */
	private forkFrom(uuid: string, role: "user" | "assistant"): void {
		const id = this.sessionId;
		if (!id) {
			new Notice("This chat has no session yet.");
			return;
		}
		void this.plugin.forkChat(id, { uuid, role });
	}

	/** The `system` messages: session start, status, retries, agent tasks and denials. */
	private handleSystem(msg: Extract<SDKMessage, { type: "system" }>): void {
		if (msg.subtype === "init") {
			// Claude Code starts a turn itself when a background agent reports back.
			if (this.progress.inTurn) this.progress.setPhase(null);
			else this.progress.begin();
			this.reportedModel = msg.model;
			this.reportedOutputStyle = msg.output_style;
			this.updateInfo();
			this.syncMode(msg.permissionMode);
			// A new session now has an ID to save and list.
			this.app.workspace.requestSaveLayout();
			this.plugin.store.changed();
		} else if (msg.subtype === "status") {
			if (msg.permissionMode) this.syncMode(msg.permissionMode);
			this.progress.setPhase(msg.status === "compacting" ? "compacting" : null);
		} else if (msg.subtype === "api_retry") {
			this.progress.setRetry(msg);
		} else if (msg.subtype === "task_progress" && msg.tool_use_id) {
			const task = this.session.tasks.byToolUse(msg.tool_use_id);
			this.transcript.agentProgress(msg.tool_use_id, msg.summary || msg.description, msg.usage.tool_uses, task?.description ?? "");
		} else if (msg.subtype === "task_notification" && msg.tool_use_id) {
			this.agentEnded(msg.tool_use_id, msg.status, msg.usage ? agentTotals(msg.usage.tool_uses, msg.usage.duration_ms) : "");
		} else if (msg.subtype === "permission_denied") {
			const who = msg.decision_reason_type === "classifier" ? "Auto mode" : "Claude Code";
			this.transcript.note(`${who} denied ${msg.tool_name}${msg.decision_reason ? `: ${msg.decision_reason}` : ""}`);
		}
		// Agents starting and ending change whether the chat is working.
		this.refreshStatus();
	}

	private onTurnEnd(subtype: string, durationMs: number): void {
		this.transcript.endTurn();
		this.progress.end();
		const time = durationMs < 60_000 ? `${(durationMs / 1000).toFixed(1)}s` : formatDuration(durationMs);
		const agents = this.session.tasks.size;
		if (this.stopping) this.transcript.note("Stopped.");
		else {
			const outcome = `${subtype === "success" ? "Done" : `Ended (${subtype})`} in ${time}`;
			// Agents the turn started in the background carry on; Claude picks up when they report back (RND-9).
			this.transcript.note(agents ? `${outcome}. ${agents === 1 ? "An agent is" : `${agents} agents are`} still working.` : outcome);
		}
		this.stopping = false;
		// The chat list's "last updated", and Claude Code's generated title.
		this.plugin.store.changed();
		// The turn may have added skills or commands; the scan is cheap when nothing changed.
		this.plugin.catalogue.requestScan();

		// Messages typed during the turn go out together as the next one.
		if (this.queued.length) {
			const text = this.queued.map((q) => q.text).join("\n\n");
			// Move the bubbles below this turn's output, where the new turn starts.
			for (const q of this.queued) this.transcript.el.appendChild(q.el).removeClass("is-queued");
			const bubbles = this.queued.map((q) => q.el);
			this.queued = [];
			if (!this.scroller.following) this.scroller.anchorAtTop(bubbles[0]!);
			void this.send(text, bubbles);
		} else {
			this.refreshStatus();
		}
	}

	/**
	 * Commands Apollo handles itself (SLS-6): /new, /clear, /fork, /model,
	 * /effort and /mode. Returns true if the text was one of them.
	 */
	private runApolloCommand(text: string): boolean {
		const command = parseApolloCommand(text);
		if (!command) return false;
		const { arg } = command;
		const clearInput = () => {
			this.input.value = "";
			this.app.workspace.requestSaveLayout();
		};
		switch (command.name) {
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
				if (arg) void this.changeModel(nullIfDefault(arg));
				else void this.pickModel();
				return true;
			case "effort": {
				clearInput();
				const level = arg && parseEffortArg(arg);
				if (!arg) void this.pickEffort();
				else if (level) void this.changeEffort(nullIfDefault(level));
				else new Notice(`Unknown effort “${arg}”. Use low, medium, high, xhigh, max or default.`);
				return true;
			}
			case "mode": {
				clearInput();
				const mode = arg && parseModeArg(arg);
				if (!arg) void this.pickMode();
				else if (mode) void this.changeMode(mode);
				else new Notice(`Unknown mode “${arg}”. Use ask, accept-edits, plan or auto.`);
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
		if (choice) await this.changeModel(nullIfDefault(choice));
	}

	private async pickEffort(): Promise<void> {
		const levels = effortOptions(this.plugin.catalogue.models, this.session.model, this.session.effort);
		if (!Object.keys(levels).length) {
			new Notice("This chat's model has no effort levels.");
			return;
		}
		const options = Object.entries(levels).map(([value, label]) => ({ value, label, note: value === "default" ? "The model's own effort level." : undefined }));
		const choice = await pickOne(this.app, options, "Choose an effort level for this chat");
		if (choice) await this.changeEffort(nullIfDefault(choice as EffortLevel | "default"));
	}

	private async pickMode(): Promise<void> {
		const options = Object.entries(PERMISSION_MODES).map(([value, label]) => ({ value, label }));
		const choice = (await pickOne(this.app, options, "Choose a permission mode")) as PermissionMode | null;
		if (!choice) return;
		await this.changeMode(choice);
	}

	private async changeModel(model: string | null): Promise<void> {
		try {
			await this.session.setModel(model);
			// Init reported the old model; show the new one until the next process reports.
			if (this.reportedModel) this.reportedModel = resolvedModelName(this.plugin.catalogue.models, model) ?? this.reportedModel;
			this.updateInfo();
			this.app.workspace.requestSaveLayout();
		} catch (err) {
			new Notice(`Couldn't switch model: ${errorMessage(err)}`);
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
			new Notice(`Couldn't switch effort: ${errorMessage(err)}`);
		}
		this.renderEffortOptions();
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
		refreshTabHeader(this.leaf);
		const titleEl = viewTitleEl(this);
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
		if (this.reportedModel) lines.push(`Model: ${this.reportedModel}`);
		// PRM-1: what Claude Code reports once running, otherwise what the chat will ask for.
		const style = this.reportedOutputStyle ?? this.session.outputStyle;
		lines.push(`Output style: ${style && style !== "default" ? style : "none"}`);
		if (id) lines.push(`Session: ${id.slice(0, 8)}`, this.session.running ? "Claude Code is running." : "Claude Code starts on your next message.", "Click to copy the full session ID.");
		this.toolbar.setInfo(lines);
	}

	/**
	 * Running while a turn or an agent is working, awaiting while a card
	 * needs an answer, otherwise idle. An error stays until the next send.
	 */
	private refreshStatus(): void {
		if (this.pendingCards) this.setStatus("awaiting");
		else if (this.progress.inTurn || this.session.working) this.setStatus("running");
		else if (this.status !== "error") this.setStatus("idle");
	}

	/** Status dot on the info icon and the tab header (TAB-4), and the progress line (RND-8). */
	private setStatus(status: Status): void {
		const was = this.status;
		this.status = status;
		this.contentEl.dataset.status = status;
		tabHeaderEl(this.leaf)?.setAttr("data-apollo-status", status);
		this.toolbar.setStopEnabled(status !== "idle" && status !== "error");
		if (status === "idle" || status === "error") this.progress.idle();
		// Finished while you were looking elsewhere: the tab keeps a dot until you look.
		if (status === "running") this.setUnseen(false);
		else if (status === "idle" && (was === "running" || was === "awaiting") && !this.isSeen()) this.setUnseen(true);
	}

	/** The chat is on screen in the focused window. */
	private isSeen(): boolean {
		return this.containerEl.doc.hasFocus() && this.containerEl.isShown();
	}

	private markSeen(): void {
		if (this.unseen && this.isSeen()) this.setUnseen(false);
	}

	private setUnseen(unseen: boolean): void {
		this.unseen = unseen;
		tabHeaderEl(this.leaf)?.toggleAttribute("data-apollo-unseen", unseen);
	}
}

/** First line of a prompt, short enough for a tab title. */
function titleFromPrompt(text: string): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? text;
	return truncate(line, TITLE_LENGTH);
}
