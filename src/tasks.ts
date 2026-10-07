import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** A subagent (or other task) Claude Code is running for a chat (RND-9). */
export interface AgentTask {
	id: string;
	/** The Agent tool call that started it, if known. */
	toolUseId: string | null;
	description: string;
	/** What it's doing now, as Claude Code reports it: "Reading notes/a.md". */
	activity: string;
	toolUses: number;
	started: number;
	/** When the task last reported progress or sent a message of its own. */
	lastEvent: number;
	/** Running in the background, so the turn that started it can end first. */
	background: boolean;
}

/**
 * The tasks a chat is waiting on, kept from Claude Code's task events. Shell
 * commands and ambient tasks (watchers, housekeeping) aren't counted: a
 * background dev server shouldn't keep a chat "working".
 */
export class AgentTasks {
	private readonly byId = new Map<string, AgentTask>();

	get size(): number {
		return this.byId.size;
	}

	get list(): AgentTask[] {
		return [...this.byId.values()];
	}

	byToolUse(toolUseId: string): AgentTask | undefined {
		return this.list.find((t) => t.toolUseId === toolUseId);
	}

	clear(): void {
		this.byId.clear();
	}

	/** Updates the tasks from one message. */
	ingest(msg: SDKMessage): void {
		const now = Date.now();
		// A subagent's own messages show it's alive.
		if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) {
			const task = this.byToolUse(msg.parent_tool_use_id);
			if (task) task.lastEvent = now;
		}
		if (msg.type !== "system") return;
		switch (msg.subtype) {
			case "task_started":
				if (msg.ambient || msg.skip_transcript || msg.task_type === "local_bash") return;
				this.byId.set(msg.task_id, {
					id: msg.task_id,
					toolUseId: msg.tool_use_id ?? null,
					description: msg.description,
					activity: "",
					toolUses: 0,
					started: now,
					lastEvent: now,
					background: msg.is_backgrounded ?? false,
				});
				return;
			case "task_progress": {
				const task = this.byId.get(msg.task_id);
				if (!task) return;
				// Claude Code's summary when it sends one; otherwise its "Reading a.md" for the latest tool call.
				// Between tool calls it repeats the task's description, which says nothing new.
				const activity = msg.summary || msg.description;
				if (activity !== task.description) task.activity = activity;
				task.toolUses = msg.usage.tool_uses;
				task.lastEvent = now;
				return;
			}
			case "task_updated": {
				const task = this.byId.get(msg.task_id);
				if (!task) return;
				const status = msg.patch.status;
				if (status === "completed" || status === "failed" || status === "killed") this.byId.delete(msg.task_id);
				else if (msg.patch.is_backgrounded !== undefined) task.background = msg.patch.is_backgrounded;
				return;
			}
			case "task_notification":
				this.byId.delete(msg.task_id);
				return;
			case "background_tasks_changed": {
				// The full set of background tasks, so a missed start or end can't leave a stale entry.
				const live = new Map(msg.tasks.filter((t) => !t.ambient && t.task_type !== "local_bash").map((t) => [t.task_id, t]));
				for (const task of this.list) if (task.background && !live.has(task.id)) this.byId.delete(task.id);
				for (const t of live.values()) {
					const task = this.byId.get(t.task_id);
					if (task) task.background = true;
					else this.byId.set(t.task_id, { id: t.task_id, toolUseId: null, description: t.description, activity: "", toolUses: 0, started: now, lastEvent: now, background: true });
				}
				return;
			}
			case "session_state_changed":
				// Idle comes only once every background agent has finished.
				if (msg.state === "idle") this.byId.clear();
				return;
		}
	}
}
