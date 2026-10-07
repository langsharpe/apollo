// Progress probe: what Claude Code streams while a turn waits on subagents.
//
//   node scripts/probe-progress.mts [foreground|background]
//
// Runs one Haiku turn in a throwaway "vault" in the temp dir, on a
// long-lived streaming-input query like the plugin's, with
// agentProgressSummaries on. Prints each message's type, subtype,
// parent_tool_use_id and the fields that matter for progress, with the
// time since send, so you can see:
// - which events arrive while a subagent runs (task_started,
//   task_progress, tool_progress, the subagent's own tool calls),
// - whether `result` waits for a background agent, and when
//   session_state_changed reports idle.
//
// STOP=interrupt or STOP=task stops the agent a few seconds after the first
// result, with interrupt() or stopTask(), to see what each does to it.
// SUMMARIES=0 turns agentProgressSummaries off.

import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] === "background" ? "background" : "foreground";
const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();
const vault = realpathSync(mkdtempSync(join(tmpdir(), "apollo-probe-")));
for (let i = 1; i <= 4; i++) writeFileSync(join(vault, `note${i}.md`), `Note ${i}. The codeword is ${["MANGO", "KIWI", "PEAR", "FIG"][i - 1]}.\n`);

const prompt =
	mode === "background"
		? "Use the Agent tool with run_in_background set to true to start one general-purpose subagent that reads note1.md to note4.md one at a time with the Read tool, then runs `sleep 20` with Bash, and reports the four codewords. Don't wait for it or read the files yourself: say 'Started.' and end your turn. When it reports back, list the codewords."
		: "Use the Agent tool to start one general-purpose subagent that reads note1.md to note4.md one at a time with the Read tool, then runs `sleep 20` with Bash, and reports the four codewords. Don't read the files yourself. Then list the codewords.";

class Queue implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;
	push(m: SDKUserMessage) {
		this.items.push(m);
		this.wake?.();
	}
	close() {
		this.closed = true;
		this.wake?.();
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			const next = this.items.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.closed) return;
			await new Promise<void>((r) => (this.wake = r));
		}
	}
}

const input = new Queue();
const q = query({
	prompt: input,
	options: {
		cwd: vault,
		pathToClaudeCodeExecutable: cliPath,
		settingSources: [],
		systemPrompt: { type: "preset", preset: "claude_code" },
		model: "haiku",
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		includePartialMessages: true,
		agentProgressSummaries: process.env.SUMMARIES !== "0",
	},
});

const start = Date.now();
input.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, uuid: randomUUID() } as SDKUserMessage);
const t = () => `${((Date.now() - start) / 1000).toFixed(1).padStart(5)}s`;

function describe(m: SDKMessage): string | null {
	const parent = "parent_tool_use_id" in m && m.parent_tool_use_id ? ` [sub ${m.parent_tool_use_id.slice(-6)}]` : "";
	switch (m.type) {
		case "stream_event":
			return null;
		case "assistant": {
			const blocks = m.message.content.map((b) => (b.type === "tool_use" ? `tool_use:${b.name}#${b.id.slice(-6)} ${JSON.stringify(b.input).slice(0, 80)}` : b.type === "text" ? `text:${b.text.slice(0, 60)}` : b.type));
			return `assistant${parent} ${blocks.join(" | ")}`;
		}
		case "user": {
			const c = m.message.content;
			const blocks = Array.isArray(c) ? c.map((b) => (b.type === "tool_result" ? `tool_result#${b.tool_use_id.slice(-6)}${b.is_error ? " ERR" : ""} ${JSON.stringify(b.content).slice(0, 80)}` : b.type)) : [`text:${String(c).slice(0, 60)}`];
			return `user${parent} ${blocks.join(" | ")}`;
		}
		case "tool_progress":
			return `tool_progress${parent} ${m.tool_name}#${m.tool_use_id.slice(-6)} ${m.elapsed_time_seconds}s task=${m.task_id ?? ""} heartbeat=${m.heartbeat ?? ""}`;
		case "system": {
			const { type, subtype, uuid, session_id, ...rest } = m as Record<string, unknown>;
			if (subtype === "init") return "system init";
			if (subtype === "thinking_tokens") return null;
			return `system ${subtype} ${JSON.stringify(rest).slice(0, 300)}`;
		}
		case "result":
			return `result ${m.subtype}`;
		default:
			return `${m.type} ${JSON.stringify(m).slice(0, 200)}`;
	}
}

let results = 0;
let taskId = "";
const stop = process.env.STOP;
const timer = setTimeout(() => {
	console.log(`${t()} timeout`);
	input.close();
	q.close();
}, 240_000);
try {
	for await (const m of q) {
		const line = describe(m);
		if (line) console.log(`${t()} ${line}`);
		if (m.type === "system" && m.subtype === "task_started" && m.task_type === "local_agent") taskId = m.task_id;
		if (m.type === "result" && ++results === 1 && stop) {
			setTimeout(() => {
				console.log(`${t()} ${stop === "task" ? `stopTask(${taskId})` : "interrupt()"}`);
				void (stop === "task" ? q.stopTask(taskId) : q.interrupt()).catch((err: unknown) => console.log(`${t()} ${stop} failed: ${String(err)}`));
			}, 4000);
		}
		// session_state_changed goes idle only once background agents have finished too.
		if (m.type === "system" && m.subtype === "session_state_changed" && m.state === "idle") break;
	}
} finally {
	clearTimeout(timer);
	input.close();
	q.close();
	rmSync(vault, { recursive: true, force: true });
}
