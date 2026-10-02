import {
	deleteSession,
	forkSession,
	getSessionInfo,
	getSessionMessages,
	listSessions,
	renameSession,
	type SDKSessionInfo,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Events, type EventRef } from "obsidian";

/** What the plugin stores about sessions. Transcripts and titles stay in Claude Code's files. */
export interface SessionMeta {
	pinned: string[];
	/** Fork's session ID to the session it was forked from. */
	forkedFrom: Record<string, string>;
}

export const DEFAULT_META: SessionMeta = { pinned: [], forkedFrom: {} };

/**
 * The vault's Claude Code sessions. Every read and write goes through the
 * SDK against Claude Code's own transcripts, so the CLI sees the same
 * sessions, titles and deletions (HIST-4).
 */
export class SessionStore extends Events {
	constructor(
		private readonly dir: () => string,
		readonly meta: SessionMeta,
		private readonly persist: () => Promise<void>,
	) {
		super();
	}

	/** Newest first. */
	list(): Promise<SDKSessionInfo[]> {
		return listSessions({ dir: this.dir(), includeWorktrees: false });
	}

	info(sessionId: string): Promise<SDKSessionInfo | undefined> {
		return getSessionInfo(sessionId, { dir: this.dir() });
	}

	/** The main thread's user and assistant messages, oldest first. */
	messages(sessionId: string): Promise<SessionMessage[]> {
		return getSessionMessages(sessionId, { dir: this.dir() });
	}

	/** Copies a session into a new one, up to and including `upToMessageId` if given. */
	async fork(sessionId: string, upToMessageId?: string): Promise<string> {
		// The SDK appends " (fork)" to the source title; a fork of a fork keeps just one.
		const source = await this.info(sessionId);
		const title = source ? `${sessionTitle(source).replace(/( \(fork\))+$/, "")} (fork)` : undefined;
		const fork = await forkSession(sessionId, { dir: this.dir(), ...(upToMessageId ? { upToMessageId } : {}), ...(title ? { title } : {}) });
		this.meta.forkedFrom[fork.sessionId] = sessionId;
		await this.persist();
		this.changed();
		return fork.sessionId;
	}

	async rename(sessionId: string, title: string): Promise<void> {
		await renameSession(sessionId, title, { dir: this.dir() });
		this.changed();
	}

	async delete(sessionId: string): Promise<void> {
		await deleteSession(sessionId, { dir: this.dir() });
		const { meta } = this;
		meta.pinned = meta.pinned.filter((id) => id !== sessionId);
		// Forks of the deleted session move up to its parent, or to the top level.
		const parent = meta.forkedFrom[sessionId];
		delete meta.forkedFrom[sessionId];
		for (const [child, from] of Object.entries(meta.forkedFrom)) {
			if (from !== sessionId) continue;
			if (parent) meta.forkedFrom[child] = parent;
			else delete meta.forkedFrom[child];
		}
		await this.persist();
		this.changed();
	}

	isPinned(sessionId: string): boolean {
		return this.meta.pinned.includes(sessionId);
	}

	async togglePin(sessionId: string): Promise<void> {
		const { meta } = this;
		meta.pinned = this.isPinned(sessionId) ? meta.pinned.filter((id) => id !== sessionId) : [...meta.pinned, sessionId];
		await this.persist();
		this.changed();
	}

	/** Tells views a session was created, changed or removed. */
	changed(): void {
		this.trigger("changed");
	}

	onChanged(callback: () => void): EventRef {
		return this.on("changed", callback);
	}
}

export function sessionTitle(info: SDKSessionInfo): string {
	return info.customTitle || info.summary || info.firstPrompt || "Untitled chat";
}
