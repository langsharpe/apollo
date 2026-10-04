import { query, type CanUseTool, type PermissionMode, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveShellEnv } from "./cli";
import { buildOptions } from "./config";
import type ApolloPlugin from "./main";
import type { Presenter } from "./presenter";
import { createVaultServer } from "./vault-tools";

export interface ChatSessionHandlers {
	message(msg: SDKMessage): void;
	permission: CanUseTool;
	/** The Claude Code process ended. `error` is set unless the session was closed on purpose. */
	ended(error: unknown): void;
	/** The process was stopped after sitting idle. The next message resumes the session. */
	released(): void;
	/** A Write is about to run. */
	beforeWrite(toolUseId: string, input: Record<string, unknown>): void;
}

/**
 * One chat's connection to Claude Code. Holds a long-lived `query()` in
 * streaming-input mode, so the process stays warm between turns. The process
 * starts on the first message. If it exits, or sits idle past the timeout
 * (TAB-6), the next message starts a new one that resumes the same session.
 */
export class ChatSession {
	sessionId: string | null = null;
	/** True from send until the turn's result arrives. */
	busy = false;

	private query: Query | null = null;
	private input: MessageQueue | null = null;
	private abort: AbortController | null = null;
	private idleTimer: number | null = null;

	constructor(
		private readonly plugin: ApolloPlugin,
		private readonly handlers: ChatSessionHandlers,
		/** Mode for the next process start. Kept in step with what Claude Code reports. */
		public permissionMode: PermissionMode,
		/** Opens notes for workspace_present, in the chat's workspace. */
		private readonly presenter: Presenter,
		/** Output style for every process this chat starts. Empty means Claude Code's default prompt. */
		public outputStyle: string,
		/** Model for the next process start, from /model. Null means Claude Code's default. */
		public model: string | null = null,
	) {}

	/** Whether a Claude Code process is running for this chat. */
	get running(): boolean {
		return this.query !== null;
	}

	/** Sends a message. Returns its UUID, which is also its ID in the transcript. */
	async send(text: string): Promise<string> {
		this.clearIdleTimer();
		this.busy = true;
		try {
			if (!this.input) await this.start();
		} catch (err) {
			this.busy = false;
			throw err;
		}
		const uuid = crypto.randomUUID();
		this.input!.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			origin: { kind: "human" },
			uuid,
		});
		return uuid;
	}

	/** Stops the current turn. The process stays up for the next message. */
	async interrupt(): Promise<void> {
		await this.query?.interrupt();
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.permissionMode = mode;
		await this.query?.setPermissionMode(mode);
	}

	async setModel(model: string | null): Promise<void> {
		this.model = model;
		await this.query?.setModel(model ?? undefined);
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
		const { settings } = this.plugin;
		const vaultPath = this.plugin.vaultPath();
		// A fresh server per process: an MCP server instance serves one connection.
		const vaultTools = settings.obsidianTools
			? createVaultServer({
					app: this.plugin.app,
					vaultPath,
					disabled: settings.disabledObsidianTools,
					present: (path, req) => this.presenter.present(path, req),
					presentationPath: () => this.presenter.presentationPath(),
				})
			: null;
		const options = buildOptions(settings, env, vaultPath, {
			sessionId: this.sessionId,
			permissionMode: this.permissionMode,
			model: this.model,
			outputStyle: this.outputStyle,
			abort,
			onPermissionRequest: this.handlers.permission,
			beforeWrite: this.handlers.beforeWrite,
			vaultTools,
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
				if (msg.type === "system" && msg.subtype === "init") {
					this.sessionId = msg.session_id;
					void this.reportCommands(q, msg.skills, msg.terminal_slash_commands ?? []);
				}
				// Skills found mid-session (SLS-5).
				if (msg.type === "system" && msg.subtype === "commands_changed") this.plugin.catalogue.reconcile({ commands: msg.commands });
				if (msg.type === "result") {
					this.busy = false;
					this.startIdleTimer();
				}
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

	/**
	 * Tells the slash menu's catalogue what Claude Code actually loaded
	 * (SLS-5), and caches the model list for /model and the output styles for
	 * settings. All come from the init handshake, so they cost no extra round
	 * trip to the model.
	 */
	private async reportCommands(q: Query, skills: string[], terminal: string[]): Promise<void> {
		try {
			const [commands, models, init] = await Promise.all([q.supportedCommands(), q.supportedModels(), q.initializationResult()]);
			this.plugin.catalogue.reconcile({ commands, skills, terminal });
			this.plugin.catalogue.setModels(models);
			this.plugin.catalogue.setOutputStyles(init.available_output_styles);
		} catch (err) {
			// The process may have closed first; the next session reports again.
			if (this.query === q) console.warn("Apollo: couldn't read Claude Code's commands", err);
		}
	}

	private startIdleTimer(): void {
		this.clearIdleTimer();
		const minutes = this.plugin.settings.idleTimeoutMinutes;
		if (!(minutes > 0)) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			if (this.busy || !this.query) return;
			this.close();
			this.handlers.released();
		}, minutes * 60_000);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private reset(): void {
		this.clearIdleTimer();
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
