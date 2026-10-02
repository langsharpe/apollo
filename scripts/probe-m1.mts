// M1 probe: checks the streaming-input behaviour the chat view relies on.
//
//   node scripts/probe-m1.mts
//
// Runs short Haiku turns in a throwaway "vault" in the temp dir:
// - two turns through one long-lived query (streaming-input mode),
// - interrupt() mid-turn, then a further turn on the same process,
// - setPermissionMode() mid-session, and which calls reach canUseTool,
// - permissionMode 'auto' (spec §9 Q8), on Sonnet.
// Sessions are not persisted.

import { query, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();
const vault = mkdtempSync(join(tmpdir(), "apollo-probe-"));

/** A push-driven input stream for streaming-input mode. */
function inbox() {
	const queue: SDKUserMessage[] = [];
	let wake: (() => void) | null = null;
	let closed = false;
	return {
		push(text: string) {
			queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
			wake?.();
		},
		close() {
			closed = true;
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				while (queue.length) yield queue.shift()!;
				if (closed) return;
				await new Promise<void>((r) => (wake = r));
				wake = null;
			}
		},
	};
}

function session(extra: Partial<Options>, asks: string[]) {
	const input = inbox();
	const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
		asks.push(`${toolName}(${JSON.stringify(toolInput).slice(0, 60)}) reason=${JSON.stringify(opts.decisionReason ?? null)}`);
		return { behavior: "allow", updatedInput: toolInput };
	};
	const q = query({
		prompt: input,
		options: {
			cwd: vault,
			pathToClaudeCodeExecutable: cliPath,
			settingSources: ["project", "local"],
			systemPrompt: { type: "preset", preset: "claude_code" },
			persistSession: false,
			model: "haiku",
			canUseTool,
			includePartialMessages: true,
			...extra,
		},
	});
	const it = q[Symbol.asyncIterator]();
	/** Reads messages until the next result. */
	async function untilResult(onMsg?: (m: SDKMessage) => void) {
		const seen: SDKMessage[] = [];
		while (true) {
			const { value, done } = await it.next();
			if (done) return { seen, result: null };
			seen.push(value);
			onMsg?.(value);
			if (value.type === "result") return { seen, result: value };
		}
	}
	return { q, input, untilResult };
}

try {
	console.log(`claude: ${cliPath}\nvault:  ${vault}\n`);

	console.log("1. Two turns on one process");
	{
		const asks: string[] = [];
		const s = session({ permissionMode: "default" }, asks);
		s.input.push("Reply with just the word ONE.");
		const t1 = await s.untilResult();
		const init = t1.seen.find((m) => m.type === "system" && m.subtype === "init");
		console.log("  init arrives before first result:", !!init, "mode:", init && "permissionMode" in init ? init.permissionMode : "?");
		s.input.push("Reply with just the word TWO.");
		const t2 = await s.untilResult();
		const r1 = t1.result, r2 = t2.result;
		console.log("  turn results:", r1?.subtype === "success" && r1.result, "/", r2?.subtype === "success" && r2.result);
		console.log("  same session:", r1?.session_id === r2?.session_id);

		console.log("\n2. interrupt() mid-turn");
		s.input.push("Count from 1 to 200, one number per line.");
		let interrupted = false;
		const t3 = await s.untilResult((m) => {
			if (!interrupted && m.type === "stream_event" && m.event.type === "content_block_delta") {
				interrupted = true;
				void s.q.interrupt().then((receipt) => console.log("  receipt:", JSON.stringify(receipt)));
			}
		});
		const r3 = t3.result;
		console.log("  result after interrupt:", r3?.subtype, r3 && "is_error" in r3 ? `is_error=${r3.is_error}` : "");
		s.input.push("Reply with just the word THREE.");
		const t4 = await s.untilResult();
		console.log("  next turn on same process:", t4.result?.subtype === "success" && t4.result.result);

		console.log("\n3. setPermissionMode mid-session");
		const ask = `Use the Write tool to create notes/probe.txt containing "hi". Then reply DONE.`;
		s.input.push(ask);
		await s.untilResult();
		console.log("  default mode asks:", asks.splice(0));
		await s.q.setPermissionMode("acceptEdits");
		s.input.push(ask.replace("probe.txt", "probe2.txt"));
		const t6 = await s.untilResult();
		const status = t6.seen.filter((m) => m.type === "system" && m.subtype !== "init").map((m) => (m as { subtype: string }).subtype);
		console.log("  acceptEdits asks:", asks.splice(0), "system msgs:", status);
		s.input.close();
		s.q.close();
	}

	console.log("\n4. permissionMode 'auto' (Sonnet)");
	{
		const asks: string[] = [];
		// Haiku doesn't support auto mode and silently runs in default mode.
		const s = session({ permissionMode: "auto", model: "sonnet" }, asks);
		const denials: string[] = [];
		s.input.push(`Run this exact bash command: touch made-by-auto.txt. Then reply DONE.`);
		const t = await s.untilResult((m) => {
			if (m.type === "system" && m.subtype === "permission_denied") denials.push(`${m.tool_name}: ${m.decision_reason_type} ${m.message}`);
		});
		const init = t.seen.find((m) => m.type === "system" && m.subtype === "init");
		console.log("  init mode:", init && "permissionMode" in init ? init.permissionMode : "?");
		console.log("  result:", t.result?.subtype, t.result?.subtype === "success" ? t.result.result : "");
		console.log("  asks:", asks, "denials:", denials);
		s.input.close();
		s.q.close();
	}
} finally {
	rmSync(vault, { recursive: true, force: true });
}
