import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { resolveShellEnv } from "./cli";

/** Permission modes a chat can use (PRM-T1). Bypass is deliberately absent in v1. */
export const PERMISSION_MODES = {
	default: "Ask",
	acceptEdits: "Accept edits",
	plan: "Plan",
	auto: "Auto",
} as const satisfies Partial<Record<PermissionMode, string>>;

export type ChatPermissionMode = keyof typeof PERMISSION_MODES;

export interface ApolloSettings {
	/** Absolute path to the `claude` binary. Empty means auto-detect. */
	cliPath: string;
	/** Permission mode for new chats. */
	defaultPermissionMode: ChatPermissionMode;
}

export const DEFAULT_SETTINGS: ApolloSettings = {
	cliPath: "",
	defaultPermissionMode: "default",
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
			{
				name: "Default permission mode",
				desc: "Permission mode for new chats. Each chat can switch mode from its header. Auto needs a model that supports it; Haiku doesn't.",
				control: {
					type: "dropdown",
					key: "defaultPermissionMode" satisfies keyof ApolloSettings,
					options: PERMISSION_MODES,
				},
			},
		];
	}
}
