import type { CanUseTool, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ApolloSettings } from "./settings";
import type { ShellEnv } from "./cli";
import { VAULT_SERVER, type VaultServer } from "./vault-tools";

export interface ChatState {
	sessionId: string | null;
	permissionMode: PermissionMode;
	/** Model alias or ID chosen with /model. Null means Claude Code's default. */
	model: string | null;
	abort: AbortController;
	onPermissionRequest: CanUseTool;
	/** Called before each Write runs, while the file is still in its old state (OBS-19). */
	beforeWrite(toolUseId: string, input: Record<string, unknown>): void;
	/** Apollo's Obsidian tools for this process, or null when they're off (OBS-1). */
	vaultTools: VaultServer | null;
}

/**
 * Builds SDK options from plugin settings (spec §6). M1 covers the basics:
 * vault cwd, CLI path, login-shell PATH, CLI-default prompt and settings,
 * and the chat's permission mode. Obsidian tools come from M5.
 */
export function buildOptions(s: ApolloSettings, env: ShellEnv, vaultPath: string, chat: ChatState): Options {
	const cliPath = s.cliPath || env.claudePath;
	if (!cliPath) throw new Error("Claude CLI not found. Set its path in Apollo settings.");

	return {
		cwd: vaultPath,
		pathToClaudeCodeExecutable: cliPath,
		env: { ...process.env, PATH: env.path },
		systemPrompt: { type: "preset", preset: "claude_code" },
		settingSources: ["user", "project", "local"],
		permissionMode: chat.permissionMode,
		...(chat.model ? { model: chat.model } : {}),
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
