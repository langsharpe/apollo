import { FileSystemAdapter, Plugin } from "obsidian";
import { CHAT_VIEW_TYPE, ChatView } from "./chat-view";
import type { ChatSession } from "./chat-session";
import { ApolloSettingTab, ApolloSettings, DEFAULT_SETTINGS } from "./settings";

export default class ApolloPlugin extends Plugin {
	override settings: ApolloSettings = { ...DEFAULT_SETTINGS };

	/** Sessions with a running Claude Code process, so every process can be killed on unload. */
	readonly sessions = new Set<ChatSession>();

	override async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		this.addSettingTab(new ApolloSettingTab(this.app, this));

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => void this.openChat(),
		});
		// TAB-3a. Mod+Shift+N is core "New note in new pane", so the default is Mod+Alt+N.
		this.addCommand({
			id: "new-chat-in-current-pane",
			name: "New chat in current pane",
			hotkeys: [{ modifiers: ["Mod", "Alt"], key: "N" }],
			callback: () => this.newChatInCurrentPane(),
		});
		this.addRibbonIcon("bot", "Open Apollo chat", () => void this.openChat());

		this.registerEvent(this.app.workspace.on("quit", () => this.closeAll()));
	}

	override onunload(): void {
		this.closeAll();
	}

	vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Apollo needs a desktop vault.");
		return adapter.getBasePath();
	}

	private newChatInCurrentPane(): void {
		const view = this.app.workspace.getActiveViewOfType(ChatView);
		if (view) view.newChat();
		else void this.openChat();
	}

	private async openChat(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private closeAll(): void {
		for (const session of [...this.sessions]) session.close();
	}
}
