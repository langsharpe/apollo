import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Notice, PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import { resolveShellEnv } from "./cli";
import type ApolloPlugin from "./main";

/** Permission modes a chat can use (PRM-T1). Bypass is deliberately absent in v1. */
export const PERMISSION_MODES = {
	default: "Ask",
	acceptEdits: "Accept edits",
	plan: "Plan",
	auto: "Auto",
} as const satisfies Partial<Record<PermissionMode, string>>;

export type ChatPermissionMode = keyof typeof PERMISSION_MODES;

/** Where new chats open (TAB-2). */
export const CHAT_PLACEMENTS = {
	tab: "New tab",
	"split-right": "Split right",
	"split-down": "Split down",
	"right-sidebar": "Right sidebar",
} as const;

export type ChatPlacement = keyof typeof CHAT_PLACEMENTS;

/** How file and folder references are written into the input (CTX-8). */
export const REFERENCE_FORMATS = {
	plain: "Plain path (Claude reads it if needed)",
	mention: "@-mention (contents attached)",
} as const;

export type ReferenceFormat = keyof typeof REFERENCE_FORMATS;

export interface ApolloSettings {
	/** Absolute path to the `claude` binary. Empty means auto-detect. */
	cliPath: string;
	/** Permission mode for new chats. */
	defaultPermissionMode: ChatPermissionMode;
	openChatsIn: ChatPlacement;
	/** Minutes an idle chat keeps its Claude Code process. 0 keeps it until the chat closes. */
	idleTimeoutMinutes: number;
	referenceFormat: ReferenceFormat;
}

export const DEFAULT_SETTINGS: ApolloSettings = {
	cliPath: "",
	defaultPermissionMode: "default",
	openChatsIn: "split-right",
	idleTimeoutMinutes: 10,
	referenceFormat: "plain",
};

// The base PluginSettingTab reads `plugin.settings` by control key. Writes go
// through the plugin, because data.json also holds chat metadata.
export class ApolloSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: ApolloPlugin,
	) {
		super(app, plugin);
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.save();
	}

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
			{
				name: "Open new chats in",
				desc: "Where new chats, resumed chats and forks open.",
				control: {
					type: "dropdown",
					key: "openChatsIn" satisfies keyof ApolloSettings,
					options: CHAT_PLACEMENTS,
				},
			},
			{
				name: "Reference format",
				desc: "How files and folders are added to the input, from @, drag and drop, paste and commands. A plain path costs nothing until Claude decides to read it; an @-mention attaches the file's contents to the message.",
				control: {
					type: "dropdown",
					key: "referenceFormat" satisfies keyof ApolloSettings,
					options: REFERENCE_FORMATS,
				},
			},
			{
				name: "Idle process timeout",
				desc: "Minutes before an idle chat stops its Claude Code process. The chat resumes on your next message. 0 keeps the process until the chat closes.",
				control: {
					type: "number",
					key: "idleTimeoutMinutes" satisfies keyof ApolloSettings,
					min: 0,
					step: 1,
				},
			},
		];
	}
}
