import { FileSystemAdapter, Notice, Plugin, WorkspaceTabs, debounce, type Editor, type Menu, type TAbstractFile, type TFile, type WorkspaceLeaf } from "obsidian";
import { CommandCatalogue, type CatalogueCache } from "./catalogue";
import { CHAT_VIEW_TYPE, ChatView, userPrompt, type ChatViewState } from "./chat-view";
import type { ChatSession } from "./chat-session";
import { confirmAction, promptText } from "./modals";
import { formatSelection } from "./references";
import { SESSION_LIST_VIEW_TYPE, SessionListView } from "./session-list-view";
import { SessionStore, type SessionMeta } from "./sessions";
import { ApolloSettingTab, ApolloSettings, DEFAULT_SETTINGS, type ChatPlacement } from "./settings";

interface PluginData extends Partial<ApolloSettings> {
	sessionMeta?: Partial<SessionMeta>;
	catalogue?: CatalogueCache;
}

/** Where "Add to chat" puts references. */
type ChatTarget = "active" | "new";

/** A message to fork from: the fork keeps the conversation up to it. */
export interface ForkPoint {
	uuid: string;
	role: "user" | "assistant";
}

export default class ApolloPlugin extends Plugin {
	override settings: ApolloSettings = { ...DEFAULT_SETTINGS };
	store!: SessionStore;
	catalogue!: CommandCatalogue;

	/** Sessions with a running Claude Code process, so every process can be killed on unload. */
	readonly sessions = new Set<ChatSession>();

	/** The chat that last had focus, where "Add to chat" goes. */
	private lastChat: WorkspaceLeaf | null = null;

	private readonly requestSave = debounce(() => void this.save(), 1000, true);

	override async onload(): Promise<void> {
		const { sessionMeta, catalogue, ...settings }: PluginData = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.store = new SessionStore(
			() => this.vaultPath(),
			{ pinned: sessionMeta?.pinned ?? [], forkedFrom: sessionMeta?.forkedFrom ?? {} },
			() => this.save(),
		);
		// Served from the cache at once; re-scanned once the layout is ready, off the startup path (SLS-3).
		this.catalogue = new CommandCatalogue(() => this.vaultPath(), catalogue ?? {}, () => this.requestSave());
		this.app.workspace.onLayoutReady(() => void this.catalogue.scan());
		// ~/.claude isn't watched; check it when Obsidian regains focus (SLS-4).
		this.registerDomEvent(window, "focus", () => this.catalogue.scanIfStale());
		this.register(() => {
			this.catalogue.close();
			this.requestSave.run();
		});
		this.addSettingTab(new ApolloSettingTab(this.app, this));

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.registerView(SESSION_LIST_VIEW_TYPE, (leaf) => new SessionListView(leaf, this));

		// TAB-3.
		this.addCommand({
			id: "new-chat",
			name: "New chat",
			callback: () => void this.openChat(),
		});
		this.addCommand({
			id: "new-chat-in-split",
			name: "New chat in split",
			callback: () => void this.openChat({}, "split-right"),
		});
		// TAB-3a. Mod+Shift+N is core "New note in new pane", so the default is Mod+Alt+N.
		this.addCommand({
			id: "new-chat-in-current-pane",
			name: "New chat in current pane",
			hotkeys: [{ modifiers: ["Mod", "Alt"], key: "N" }],
			callback: () => this.newChatInCurrentPane(),
		});
		this.addCommand({
			id: "close-chat",
			name: "Close chat",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(ChatView);
				if (!view) return false;
				if (!checking) view.leaf.detach();
				return true;
			},
		});
		this.addCommand({
			id: "focus-next-chat",
			name: "Focus next chat",
			callback: () => void this.focusChat(1),
		});
		this.addCommand({
			id: "focus-previous-chat",
			name: "Focus previous chat",
			callback: () => void this.focusChat(-1),
		});
		this.addCommand({
			id: "open-chat-list",
			name: "Open chat list",
			callback: () => void this.openChatList(),
		});
		// CTX-4. Mod+Shift+L is free in a default Obsidian (M0 findings).
		this.addCommand({
			id: "add-current-note",
			name: "Add current note to chat",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "L" }],
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.addToChat([file], "active");
				return true;
			},
		});
		// CTX-5.
		this.addCommand({
			id: "add-selection",
			name: "Add selection to chat",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file || !editor.somethingSelected()) return false;
				if (!checking) void this.addSelection(editor, ctx.file);
				return true;
			},
		});
		// CTX-3.
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.addChatMenuItems(menu, [file])));
		this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => this.addChatMenuItems(menu, files)));
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				if (!info.file || !editor.somethingSelected()) return;
				// The editor menu's "action" group comes after the clipboard items and is unused for selections.
				menu.addItem((item) =>
					item
						.setSection("action")
						.setTitle("Add selection to chat")
						.setIcon("bot")
						.onClick(() => void this.addSelection(editor, info.file!)),
				);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof ChatView) this.lastChat = leaf;
			}),
		);

		this.addRibbonIcon("bot", "New Apollo chat", () => void this.openChat());
		this.addRibbonIcon("messages-square", "Open Apollo chat list", () => void this.openChatList());

		this.registerEvent(this.app.workspace.on("quit", () => this.closeAll()));
	}

	override onunload(): void {
		this.closeAll();
	}

	async save(): Promise<void> {
		const data: PluginData = { ...this.settings, sessionMeta: this.store.meta, catalogue: this.catalogue.toCache() };
		await this.saveData(data);
	}

	vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Apollo needs a desktop vault.");
		return adapter.getBasePath();
	}

	/**
	 * Opens a chat where the "Open new chats in" setting says. With a session
	 * ID, focuses the tab that already has it, or resumes it in a new one.
	 */
	async openChat(state: Partial<ChatViewState> = {}, placement: ChatPlacement = this.settings.openChatsIn): Promise<WorkspaceLeaf> {
		const existing = state.sessionId ? this.chatLeaves().find((leaf) => leafSessionId(leaf) === state.sessionId) : undefined;
		const leaf = existing ?? this.newLeaf(placement);
		if (!existing) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true, state: { ...state } });
		await this.focusLeaf(leaf);
		return leaf;
	}

	/** Adds file and folder references to a chat's input (CTX-3, CTX-4). */
	async addToChat(files: TAbstractFile[], target: ChatTarget): Promise<void> {
		await this.withChat(target, (view) => view.insertReferences(files));
	}

	/** Adds `path:L10-L24` and the selected text as a quote (CTX-5). */
	private async addSelection(editor: Editor, file: TFile): Promise<void> {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		// A selection ending at the start of a line doesn't include that line.
		const toLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
		const block = formatSelection(file, from.line + 1, toLine + 1, editor.getSelection());
		await this.withChat("active", (view) => view.insertBlock(block));
	}

	/**
	 * Focuses the chat that last had focus (or any open chat), or opens a new
	 * one, then hands it over.
	 */
	private async withChat(target: ChatTarget, use: (view: ChatView) => void): Promise<void> {
		const leaves = this.chatLeaves();
		// Before any chat has had focus (e.g. after a restart), prefer one that's on screen.
		const fallback = leaves.find((l) => !l.isDeferred) ?? leaves[0] ?? null;
		let leaf = target === "active" ? (this.lastChat && leaves.includes(this.lastChat) ? this.lastChat : fallback) : null;
		if (leaf) await this.focusLeaf(leaf);
		else leaf = await this.openChat();
		await leaf.loadIfDeferred();
		if (leaf.view instanceof ChatView) use(leaf.view);
	}

	/**
	 * "Add to chat" gets a group of its own in file menus. Each menu orders
	 * its sections (the file explorer: title, open, action-primary, action,
	 * info, view, system, danger; a note's More options: close, pane, open,
	 * action, …) and puts sections it doesn't list after Delete. Core fills
	 * different ones in each: action-primary is free on a file but holds New
	 * note on a folder, and info is shared with Copy path. So take the first
	 * preferred section the menu lists and hasn't used yet.
	 */
	private addChatMenuItems(menu: Menu, files: TAbstractFile[]): void {
		if (!files.length) return;
		const what = files.length > 1 ? `${files.length} items` : "";
		const { items, sections } = menu as Menu & MenuInternals;
		const used = new Set(items?.map((i) => i.section));
		const section = sections ? (["action-primary", "open", "close"].find((s) => sections.includes(s) && !used.has(s)) ?? "action") : "action";
		menu.addItem((item) =>
			item
				.setSection(section)
				.setTitle(what ? `Add ${what} to chat` : "Add to chat")
				.setIcon("bot")
				.onClick(() => void this.addToChat(files, "active")),
		);
		menu.addItem((item) =>
			item
				.setSection(section)
				.setTitle(what ? `Add ${what} to new chat` : "Add to new chat")
				.setIcon("message-square-plus")
				.onClick(() => void this.addToChat(files, "new")),
		);
	}

	/** Session IDs open in a chat, including tabs Obsidian hasn't loaded yet. */
	openSessionIds(): Set<string> {
		return new Set(this.chatLeaves().map(leafSessionId).filter((id): id is string => !!id));
	}

	/**
	 * Forks a session into a new chat (HIST-3, HIST-3a). From an assistant
	 * message, the fork keeps everything up to that message. From a user
	 * message, it keeps everything before it and puts the message in the
	 * input, so it can be edited and sent again.
	 */
	async forkChat(sessionId: string, at?: ForkPoint): Promise<void> {
		try {
			let upTo = at?.uuid;
			let draft = "";
			if (at?.role === "user") {
				const messages = await this.store.messages(sessionId);
				const index = messages.findIndex((m) => m.uuid === at.uuid);
				if (index === -1) throw new Error("That message isn't in the saved transcript yet.");
				draft = userPrompt(messages[index]!.message);
				// Forking before the first message is just a new chat.
				if (index === 0) {
					await this.openChat({ draft });
					return;
				}
				upTo = messages[index - 1]!.uuid;
			}
			const forkId = await this.store.fork(sessionId, upTo);
			await this.openChat({ sessionId: forkId, draft });
		} catch (err) {
			new Notice(`Couldn't fork this chat: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async renameChat(sessionId: string, current: string): Promise<void> {
		const title = await promptText(this.app, "Rename chat", current, "Rename");
		if (!title || title === current) return;
		try {
			await this.store.rename(sessionId, title);
		} catch (err) {
			new Notice(`Couldn't rename this chat: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async deleteChat(sessionId: string, title: string): Promise<void> {
		const ok = await confirmAction(
			this.app,
			"Delete chat",
			`Delete “${title}”? This deletes its transcript from ~/.claude, so neither Apollo nor claude --resume can open it again.`,
			"Delete",
		);
		if (!ok) return;
		for (const leaf of this.chatLeaves()) if (leafSessionId(leaf) === sessionId) leaf.detach();
		try {
			await this.store.delete(sessionId);
		} catch (err) {
			new Notice(`Couldn't delete this chat: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private newChatInCurrentPane(): void {
		const view = this.app.workspace.getActiveViewOfType(ChatView);
		if (view) view.newChat();
		else void this.openChat();
	}

	private newLeaf(placement: ChatPlacement): WorkspaceLeaf {
		const { workspace } = this.app;
		if (placement === "right-sidebar") return workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
		// New tabs and splits go next to the most recent leaf. Obsidian can leave a
		// leaf in the main area outside any tab group (e.g. one opened when the area
		// was empty); a "tab" beside it is another bare leaf with no tab bar. Splitting
		// from it instead puts the new leaf in a tab group of its own.
		const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
		if (recent && !(recent.parent instanceof WorkspaceTabs)) {
			return workspace.createLeafBySplit(recent, placement === "split-down" ? "horizontal" : "vertical");
		}
		switch (placement) {
			case "tab":
				return workspace.getLeaf("tab");
			case "split-right":
				return workspace.getLeaf("split", "vertical");
			case "split-down":
				return workspace.getLeaf("split", "horizontal");
		}
	}

	private chatLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
	}

	/** Cycles focus through open chats. From outside a chat, starts at the first or last. */
	private async focusChat(step: 1 | -1): Promise<void> {
		const leaves = this.chatLeaves();
		if (!leaves.length) return;
		const active = this.app.workspace.getActiveViewOfType(ChatView)?.leaf;
		const index = active ? leaves.indexOf(active) : -1;
		const next = index === -1 ? (step === 1 ? 0 : leaves.length - 1) : (index + step + leaves.length) % leaves.length;
		await this.focusLeaf(leaves[next]!);
	}

	private async focusLeaf(leaf: WorkspaceLeaf): Promise<void> {
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.view instanceof ChatView) leaf.view.focusInput();
	}

	private async openChatList(): Promise<void> {
		await this.app.workspace.ensureSideLeaf(SESSION_LIST_VIEW_TYPE, "left", { active: true, reveal: true });
	}

	private closeAll(): void {
		for (const session of [...this.sessions]) session.close();
	}
}

/** Obsidian internals the public API doesn't expose. May be missing. */
interface MenuInternals {
	items?: { section?: string }[];
	/** Section order, from `addSections`. */
	sections?: string[];
}

/** The session a chat leaf shows. Works for deferred tabs, whose saved state stands in for the view. */
function leafSessionId(leaf: WorkspaceLeaf): string | null {
	if (leaf.view instanceof ChatView) return leaf.view.sessionId;
	const id = leaf.getViewState().state?.sessionId;
	return typeof id === "string" ? id : null;
}
