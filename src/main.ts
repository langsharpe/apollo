import { Plugin } from "obsidian";
import { ApolloSettingTab, ApolloSettings, DEFAULT_SETTINGS } from "./settings";
import { SPIKE_VIEW_TYPE, SpikeView } from "./spike-view";

export default class ApolloPlugin extends Plugin {
	override settings: ApolloSettings = { ...DEFAULT_SETTINGS };

	/** Abort controllers for in-flight queries, so every Claude Code process can be killed on unload. */
	readonly running = new Set<AbortController>();

	override async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		this.addSettingTab(new ApolloSettingTab(this.app, this));

		this.registerView(SPIKE_VIEW_TYPE, (leaf) => new SpikeView(leaf, this));
		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => void this.openChat(),
		});
		this.addRibbonIcon("bot", "Open Apollo chat", () => void this.openChat());

		this.registerEvent(this.app.workspace.on("quit", () => this.abortAll()));
	}

	override onunload(): void {
		this.abortAll();
	}

	private async openChat(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: SPIKE_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private abortAll(): void {
		for (const abort of this.running) abort.abort();
		this.running.clear();
	}
}
