import { Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { resolveShellEnv } from "./cli";

export interface ApolloSettings {
	/** Absolute path to the `claude` binary. Empty means auto-detect. */
	cliPath: string;
}

export const DEFAULT_SETTINGS: ApolloSettings = {
	cliPath: "",
};

// The base PluginSettingTab reads from and persists `plugin.settings` by control key.
export class ApolloSettingTab extends PluginSettingTab {
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Claude CLI path",
				desc: "Absolute path to the claude binary. Leave empty to auto-detect from your login shell.",
				control: {
					type: "text",
					key: "cliPath" satisfies keyof ApolloSettings,
					validate: (value) => (value && !value.startsWith("/") ? "Must be an absolute path." : undefined),
				},
			},
			{
				name: "Detect Claude CLI",
				desc: "Show the path auto-detection finds.",
				action: () => {
					void resolveShellEnv().then(({ claudePath }) => {
						new Notice(claudePath ? `Found claude at ${claudePath}` : "claude not found on login shell PATH.");
					});
				},
			},
		];
	}
}
