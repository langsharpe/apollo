import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { ExtraButtonComponent, ItemView, Menu, Notice, SearchComponent, debounce, prepareSimpleSearch, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type ApolloPlugin from "./main";
import { sessionTitle } from "./sessions";

export const SESSION_LIST_VIEW_TYPE = "apollo-sessions";

/**
 * Sidebar list of the vault's sessions, from the plugin and the CLI alike
 * (HIST-1 to HIST-4). Pinned chats come first, then the rest newest first,
 * with forks nested under the chat they came from.
 */
export class SessionListView extends ItemView {
	private sessions: SDKSessionInfo[] = [];
	private error: string | null = null;
	private loaded = false;
	private filter = "";
	private listEl!: HTMLElement;

	private readonly requestRefresh = debounce(() => void this.refresh(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: ApolloPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return SESSION_LIST_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Claude chats";
	}

	override getIcon(): string {
		return "messages-square";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("apollo-sessions");

		const header = root.createDiv({ cls: "apollo-sessions-header" });
		new SearchComponent(header).setPlaceholder("Search chats").onChange((value) => {
			this.filter = value;
			this.render();
		});
		new ExtraButtonComponent(header).setIcon("refresh-cw").setTooltip("Refresh").onClick(() => void this.refresh());
		new ExtraButtonComponent(header).setIcon("square-pen").setTooltip("New chat").onClick(() => void this.plugin.openChat());
		this.listEl = root.createDiv({ cls: "apollo-sessions-list" });

		this.registerEvent(this.plugin.store.onChanged(() => this.requestRefresh()));
		// Chats opening and closing change the "open" markers only.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.render()));
		// Sessions started in the terminal show up when you come back to Obsidian.
		this.registerDomEvent(window, "focus", () => this.requestRefresh());
		await this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			this.sessions = await this.plugin.store.list();
			this.error = null;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.loaded = true;
		this.render();
	}

	private render(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		if (this.error) {
			list.createDiv({ cls: "apollo-sessions-empty apollo-error", text: `Couldn't list chats: ${this.error}` });
			return;
		}
		if (!this.loaded) return;

		const match = this.filter.trim() ? prepareSimpleSearch(this.filter.trim()) : null;
		const shown = this.sessions.filter((s) => !match || match(sessionTitle(s)));
		if (!shown.length) {
			list.createDiv({ cls: "apollo-sessions-empty", text: this.sessions.length ? "No matching chats." : "No chats in this vault yet." });
			return;
		}

		const open = this.plugin.openSessionIds();
		const { store } = this.plugin;
		const pinned = shown.filter((s) => store.isPinned(s.sessionId));
		if (pinned.length) {
			list.createDiv({ cls: "apollo-sessions-heading", text: "Pinned" });
			for (const s of pinned) this.renderRow(list, s, 0, open);
			list.createDiv({ cls: "apollo-sessions-heading", text: "Recent" });
		}
		const rest = shown.filter((s) => !store.isPinned(s.sessionId));

		// Forks nest under their parent when it's listed here too.
		const ids = new Set(rest.map((s) => s.sessionId));
		const children = new Map<string, SDKSessionInfo[]>();
		const roots: SDKSessionInfo[] = [];
		for (const s of rest) {
			const parent = store.meta.forkedFrom[s.sessionId];
			if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), s]);
			else roots.push(s);
		}
		const renderTree = (s: SDKSessionInfo, depth: number) => {
			this.renderRow(list, s, depth, open);
			for (const child of children.get(s.sessionId) ?? []) renderTree(child, depth + 1);
		};
		for (const s of roots) renderTree(s, 0);
	}

	private renderRow(list: HTMLElement, s: SDKSessionInfo, depth: number, open: Set<string>): void {
		const { store } = this.plugin;
		const id = s.sessionId;
		const title = sessionTitle(s);
		const row = list.createDiv({ cls: "apollo-session" });
		row.setCssProps({ "--apollo-depth": String(depth) });
		if (open.has(id)) row.addClass("is-open");

		const main = row.createDiv({ cls: "apollo-session-main" });
		const titleEl = main.createDiv({ cls: "apollo-session-title" });
		if (store.meta.forkedFrom[id]) setIcon(titleEl.createSpan({ cls: "apollo-session-icon" }), "git-branch");
		if (store.isPinned(id)) setIcon(titleEl.createSpan({ cls: "apollo-session-icon" }), "pin");
		titleEl.createSpan({ text: title });
		setTooltip(row, title, { placement: "right" });

		const more = row.createDiv({ cls: "apollo-session-more clickable-icon" });
		setIcon(more, "more-horizontal");

		row.addEventListener("click", () => void this.plugin.openChat({ sessionId: id }));
		const showMenu = (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.menu(s, open.has(id)).showAtMouseEvent(evt);
		};
		row.addEventListener("contextmenu", showMenu);
		more.addEventListener("click", showMenu);
	}

	/** Open, Fork, Rename, Pin, Delete (HIST-3). */
	private menu(s: SDKSessionInfo, isOpen: boolean): Menu {
		const { plugin } = this;
		const id = s.sessionId;
		const title = sessionTitle(s);
		const pinned = plugin.store.isPinned(id);
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(isOpen ? "Go to chat" : "Open")
				.setIcon("message-square")
				.onClick(() => void plugin.openChat({ sessionId: id })),
		);
		menu.addItem((item) => item.setTitle("Fork").setIcon("git-branch").onClick(() => void plugin.forkChat(id)));
		menu.addItem((item) => item.setTitle("Rename…").setIcon("pencil").onClick(() => void plugin.renameChat(id, title)));
		menu.addItem((item) =>
			item
				.setTitle(pinned ? "Unpin" : "Pin")
				.setIcon(pinned ? "pin-off" : "pin")
				.onClick(() => void plugin.store.togglePin(id)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy session ID")
				.setIcon("copy")
				.onClick(() => void navigator.clipboard.writeText(id).then(() => new Notice("Session ID copied."))),
		);
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Delete…").setIcon("trash-2").setWarning(true).onClick(() => void plugin.deleteChat(id, title)));
		return menu;
	}
}
