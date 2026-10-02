import { query, type CanUseTool, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveShellEnv } from "./cli";
import { buildOptions } from "./config";
import type ApolloPlugin from "./main";

export interface ChatSessionHandlers {
	message(msg: SDKMessage): void;
	permission: CanUseTool;
	/** The Claude Code process ended. `error` is set unless the session was closed on purpose. */
	ended(error: unknown): void;
}

/**
 * One chat's connection to Claude Code. Holds a long-lived `query()` in
 * streaming-input mode, so the process stays warm between turns. The process
 * starts on the first message. If it exits, the next message starts a new one
 * that resumes the same session.
 */
export class ChatSession {
	sessionId: string | null = null;
	/** True from send until the turn's result arrives. */
	busy = false;

	private query: Query | null = null;
	private input: MessageQueue | null = null;
	private abort: AbortController | null = null;

	constructor(
		private readonly plugin: ApolloPlugin,
		private readonly handlers: ChatSessionHandlers,
		/** Mode for the next process start. Kept in step with what Claude Code reports. */
		public permissionMode: PermissionMode,
	) {}

	async send(text: string): Promise<void> {
		this.busy = true;
		try {
			if (!this.input) await this.start();
		} catch (err) {
			this.busy = false;
			throw err;
		}
		this.input!.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			origin: { kind: "human" },
		});
	}

	/** Stops the current turn. The process stays up for the next message. */
	async interrupt(): Promise<void> {
		await this.query?.interrupt();
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.permissionMode = mode;
		await this.query?.setPermissionMode(mode);
	}

	/** Ends the Claude Code process. The session's transcript stays on disk. */
	close(): void {
		const abort = this.abort;
		this.input?.close();
		this.query?.close();
		abort?.abort();
		this.reset();
	}

	private async start(): Promise<void> {
		const env = await resolveShellEnv();
		const abort = new AbortController();
		const options = buildOptions(this.plugin.settings, env, this.plugin.vaultPath(), {
			sessionId: this.sessionId,
			permissionMode: this.permissionMode,
			abort,
			onPermissionRequest: this.handlers.permission,
		});
		this.abort = abort;
		this.input = new MessageQueue();
		this.query = query({ prompt: this.input, options });
		this.plugin.sessions.add(this);
		void this.read(this.query, abort);
	}

	private async read(q: Query, abort: AbortController): Promise<void> {
		let error: unknown = null;
		try {
			for await (const msg of q) {
				if (msg.type === "system" && msg.subtype === "init") this.sessionId = msg.session_id;
				if (msg.type === "result") this.busy = false;
				this.handlers.message(msg);
			}
		} catch (err) {
			error = err;
		}
		// close() already reset state and aborted; a replaced query must not clobber the new one.
		if (abort.signal.aborted || this.query !== q) return;
		this.input?.close();
		this.reset();
		this.handlers.ended(error ?? new Error("Claude Code exited."));
	}

	private reset(): void {
		this.plugin.sessions.delete(this);
		this.query = null;
		this.input = null;
		this.abort = null;
		this.busy = false;
	}
}

/** Async iterable of user messages that stays open until closed. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
	private readonly pending: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;

	push(msg: SDKUserMessage): void {
		this.pending.push(msg);
		this.wake?.();
	}

	close(): void {
		this.closed = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
		while (true) {
			const next = this.pending.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.closed) return;
			await new Promise<void>((resolve) => (this.wake = resolve));
			this.wake = null;
		}
	}
}
