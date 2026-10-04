import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Notice, PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import { resolveShellEnv } from "./cli";
import type ApolloPlugin from "./main";
import { OBSIDIAN_TOOLS } from "./vault-tools";

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

/** Where workspace_present opens a note when the agent gives no hint (OBS-14). */
export const PRESENT_PLACEMENTS = {
	auto: "Auto",
	beside: "Beside the chat",
	tab: "New tab",
} as const;

export type PresentPlacement = keyof typeof PRESENT_PLACEMENTS;

export interface ApolloSettings {
	/** Absolute path to the `claude` binary. Empty means auto-detect. */
	cliPath: string;
	/** Permission mode for new chats. */
	defaultPermissionMode: ChatPermissionMode;
	/** Output style for new chats, on top of Claude Code's preset prompt. Empty means the preset alone (§4.4). */
	outputStyle: string;
	openChatsIn: ChatPlacement;
	/** Minutes an idle chat keeps its Claude Code process. 0 keeps it until the chat closes. */
	idleTimeoutMinutes: number;
	referenceFormat: ReferenceFormat;
	/** Register Apollo's in-process MCP server of Obsidian tools (OBS-1). */
	obsidianTools: boolean;
	/** Obsidian tools turned off individually, by tool name. */
	disabledObsidianTools: string[];
	presentPlacement: PresentPlacement;
	/** Focus a presented note instead of leaving focus where it was (OBS-16). */
	presentFocus: boolean;
	/** Presents allowed per turn (OBS-18). */
	presentMaxPerTurn: number;
	/** Present notes the agent creates with Write (OBS-19). */
	autoPresent: boolean;
}

export const DEFAULT_SETTINGS: ApolloSettings = {
	cliPath: "",
	defaultPermissionMode: "default",
	outputStyle: "",
	openChatsIn: "split-right",
	idleTimeoutMinutes: 10,
	referenceFormat: "plain",
	obsidianTools: true,
	disabledObsidianTools: [],
	presentPlacement: "auto",
	presentFocus: false,
	presentMaxPerTurn: 3,
	autoPresent: false,
};

/** Control keys for per-tool toggles, which are stored in `disabledObsidianTools`. */
const TOOL_KEY = "obsidianTool:";

// The base PluginSettingTab reads `plugin.settings` by control key. Writes go
// through the plugin, because data.json also holds chat metadata.
export class ApolloSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: ApolloPlugin,
	) {
		super(app, plugin);
	}

	override getControlValue(key: string): unknown {
		if (key.startsWith(TOOL_KEY)) return !this.plugin.settings.disabledObsidianTools.includes(key.slice(TOOL_KEY.length));
		return super.getControlValue(key);
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		if (key.startsWith(TOOL_KEY)) {
			const name = key.slice(TOOL_KEY.length);
			const others = settings.disabledObsidianTools.filter((n) => n !== name);
			settings.disabledObsidianTools = value ? others : [...others, name];
		} else {
			(settings as unknown as Record<string, unknown>)[key] = value;
		}
		await this.plugin.save();
		// Tool toggles only show while the tools are on.
		if (key === "obsidianTools") this.update();
	}

	/** None, then each output style Claude Code last reported. */
	private outputStyles(): Record<string, string> {
		const options: Record<string, string> = { "": "None (Claude Code default)" };
		const current = this.plugin.settings.outputStyle;
		// "default" is Claude Code's prompt without a style, which None already covers.
		const styles = this.plugin.catalogue.outputStyles.filter((s) => s !== "default");
		if (current && !styles.includes(current)) styles.push(current);
		for (const style of styles) options[style] = style;
		return options;
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
				name: "Output style",
				desc: "Output style for new chats.",
				control: {
					type: "dropdown",
					key: "outputStyle" satisfies keyof ApolloSettings,
					options: this.outputStyles(),
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
			{
				type: "group",
				heading: "Obsidian tools",
				items: [
					{
						name: "Include Obsidian tools",
						desc: "Gives Claude tools that use Obsidian's own API: links and backlinks, outlines, frontmatter and tag edits, link-safe moves, trash, and opening notes for you to look at. They run inside Obsidian, so there's no extra process. Read-only tools run without asking; the rest follow the chat's permission mode. Applies from a chat's next Claude Code process.",
						control: { type: "toggle", key: "obsidianTools" satisfies keyof ApolloSettings },
					},
					{
						type: "page",
						name: "Choose tools",
						desc: "Turn individual Obsidian tools on or off.",
						displayValue: () => {
							const on = OBSIDIAN_TOOLS.filter((t) => !this.plugin.settings.disabledObsidianTools.includes(t.name)).length;
							return `${on} of ${OBSIDIAN_TOOLS.length} on`;
						},
						visible: () => this.plugin.settings.obsidianTools,
						items: OBSIDIAN_TOOLS.map((t) => ({
							name: t.name,
							desc: t.requires ? `${t.summary} Only offered when ${t.requires} is enabled.` : t.summary,
							control: { type: "toggle" as const, key: `${TOOL_KEY}${t.name}` },
						})),
					},
					{
						name: "Present: default placement",
						desc: "Where workspace_present opens a note when Claude doesn't say. Auto reuses a note already open, then this chat's presentation pane, then a tab beside your last note, and otherwise splits the chat.",
						control: { type: "dropdown", key: "presentPlacement" satisfies keyof ApolloSettings, options: PRESENT_PLACEMENTS },
					},
					{
						name: "Present: focus the note",
						desc: "Move the cursor to a presented note. Off keeps it where it was, usually the chat input.",
						control: { type: "toggle", key: "presentFocus" satisfies keyof ApolloSettings },
					},
					{
						name: "Present: max per turn",
						desc: "Notes Claude can open for you in one turn. Past the limit, it lists them as links instead.",
						control: { type: "number", key: "presentMaxPerTurn" satisfies keyof ApolloSettings, min: 1, step: 1 },
					},
					{
						name: "Auto-present new notes",
						desc: "Open notes Claude creates with Write, the same way as workspace_present, within the same limit.",
						control: { type: "toggle", key: "autoPresent" satisfies keyof ApolloSettings },
					},
				],
			},
		];
	}
}
