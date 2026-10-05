import type { CanUseTool, EffortLevel, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ApolloSettings } from "./settings";
import type { ShellEnv } from "./cli";
import { VAULT_SERVER, type VaultServer } from "./vault-tools";

export interface ChatState {
	sessionId: string | null;
	permissionMode: PermissionMode;
	/** Model alias or ID. Null means Claude Code's default. */
	model: string | null;
	/** Effort level. Null means the model's default. */
	effort: EffortLevel | null;
	/** Output style layered on the claude_code preset. Empty leaves the prompt as the CLI's. */
	outputStyle: string;
	abort: AbortController;
	onPermissionRequest: CanUseTool;
	/** Called before each Write runs, while the file is still in its old state (OBS-19). */
	beforeWrite(toolUseId: string, input: Record<string, unknown>): void;
	/** Apollo's Obsidian tools for this process, or null when they're off (OBS-1). */
	vaultTools: VaultServer | null;
}

/**
 * Builds SDK options from plugin settings (spec §6). M1 covers the basics:
 * vault cwd, CLI path, login-shell PATH, settings sources and the chat's
 * permission mode. Obsidian tools come from M5. The prompt is always the
 * claude_code preset, optionally with an output style (M4, §4.4); custom and
 * appended prompts aren't offered.
 */
export function buildOptions(s: ApolloSettings, env: ShellEnv, vaultPath: string, chat: ChatState): Options {
	const cliPath = s.cliPath || env.claudePath;
	if (!cliPath) throw new Error("Claude CLI not found. Set its path in Apollo settings.");

	return {
		cwd: vaultPath,
		pathToClaudeCodeExecutable: cliPath,
		env: { ...process.env, PATH: env.path },
		systemPrompt: { type: "preset", preset: "claude_code" },
		// Inline settings sit above the settings files, so this wins over an outputStyle set there.
		...(chat.outputStyle ? { settings: { outputStyle: chat.outputStyle } } : {}),
		settingSources: ["user", "project", "local"],
		permissionMode: chat.permissionMode,
		...(chat.model ? { model: chat.model } : {}),
		...(chat.effort ? { effort: chat.effort } : {}),
		// Added to the servers from settings, not instead of them. Read-only tools
		// run without a prompt, like Read and Grep; the rest follow the permission mode.
		...(chat.vaultTools
			? { mcpServers: { [VAULT_SERVER]: chat.vaultTools.server }, allowedTools: chat.vaultTools.readOnlyTools }
			: {}),
		canUseTool: chat.onPermissionRequest,
		// The stream can show a tool call after it has already run, so whether a
		// Write creates a file is only knowable from a hook.
		hooks: {
			PreToolUse: [
				{
					matcher: "Write",
					hooks: [
						async (input) => {
							if (input.hook_event_name === "PreToolUse") chat.beforeWrite(input.tool_use_id, (input.tool_input ?? {}) as Record<string, unknown>);
							return {};
						},
					],
				},
			],
		},
		includePartialMessages: true,
		abortController: chat.abort,
		...(chat.sessionId ? { resume: chat.sessionId } : {}),
	};
}
