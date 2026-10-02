import { Plugin } from "obsidian";
import { ApolloSettingTab, ApolloSettings, DEFAULT_SETTINGS } from "./settings";

export default class ApolloPlugin extends Plugin {
	override settings: ApolloSettings = { ...DEFAULT_SETTINGS };

	override async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		this.addSettingTab(new ApolloSettingTab(this.app, this));
	}
}
