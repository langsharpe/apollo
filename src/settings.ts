import { PluginSettingTab, SettingDefinitionItem } from "obsidian";

export interface ApolloSettings {
	testSetting: string;
}

export const DEFAULT_SETTINGS: ApolloSettings = {
	testSetting: "",
};

// The base PluginSettingTab reads from and persists `plugin.settings` by control key.
export class ApolloSettingTab extends PluginSettingTab {
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Test setting",
				desc: "Placeholder to verify settings load and save.",
				control: { type: "text", key: "testSetting" satisfies keyof ApolloSettings },
			},
		];
	}
}
