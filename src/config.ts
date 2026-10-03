import type { CanUseTool, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ApolloSettings } from "./settings";
import type { ShellEnv } from "./cli";

export interface ChatState {
	sessionId: string | null;
	permissionMode: PermissionMode;
	/** Model alias or ID chosen with /model. Null means Claude Code's default. */
	model: string | null;
	abort: AbortController;
	onPermissionRequest: CanUseTool;
}

/**
 * Builds SDK options from plugin settings (spec §6). M1 covers the basics:
 * vault cwd, CLI path, login-shell PATH, CLI-default prompt and settings,
 * and the chat's permission mode.
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
		canUseTool: chat.onPermissionRequest,
		includePartialMessages: true,
		abortController: chat.abort,
		...(chat.sessionId ? { resume: chat.sessionId } : {}),
	};
}
