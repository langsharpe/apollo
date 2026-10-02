// M2 probe: checks the session APIs that tabs and history rely on.
//
//   node scripts/probe-m2.mts
//
// Runs short Haiku turns in a throwaway "vault" in the temp dir, with
// persisted sessions (cleaned up at the end):
// - streamed message UUIDs match the transcript (`getSessionMessages`),
// - `listSessions` titles (Claude Code's generated summary),
// - `forkSession({ upToMessageId })` at a user message's parent, at a
//   mid-turn assistant text block and at a tool_use entry, then resuming
//   the fork (spec §9 Q10),
// - resume with `resumeSessionAt` + `forkSession: true` for comparison,
// - `renameSession` and `deleteSession`.

import {
	deleteSession,
	forkSession,
	getSessionMessages,
	listSessions,
	query,
	renameSession,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();
// Real path, so the projects dir Claude Code picks matches `dir` below.
const vault = realpathSync(mkdtempSync(join(tmpdir(), "apollo-probe-")));
writeFileSync(join(vault, "note.md"), "The codeword is MANGO.\n");

/** One turn per call, each on a fresh process (the plugin's resume path). */
async function turn(text: string, extra: Partial<Options> = {}, uuid: string = randomUUID()) {
	const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid } as SDKUserMessage;
	async function* once() {
		yield msg;
	}
	const seen: SDKMessage[] = [];
	const q = query({
		prompt: once(),
		options: {
			cwd: vault,
			pathToClaudeCodeExecutable: cliPath,
			settingSources: ["project", "local"],
			systemPrompt: { type: "preset", preset: "claude_code" },
			model: "haiku",
			permissionMode: "default",
			canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
			...extra,
		},
	});
	for await (const m of q) {
		seen.push(m);
		if (m.type === "result") break;
	}
	q.close();
	const init = seen.find((m) => m.type === "system" && m.subtype === "init");
	const result = seen.find((m) => m.type === "result");
	return { seen, uuid, sessionId: init?.session_id ?? "", result: result?.subtype === "success" ? result.result : result?.subtype };
}

type Entry = { type: string; uuid: string; message: { content: unknown } };
const brief = (e: Entry) => {
	const c = e.message?.content;
	const parts = typeof c === "string" ? [`text:${c.slice(0, 30)}`] : (c as { type: string; text?: string; name?: string }[]).map((b) => b.type === "text" ? `text:${b.text?.slice(0, 30)}` : b.type === "tool_use" ? `tool_use:${b.name}` : b.type);
	return `${e.type} ${e.uuid.slice(0, 8)} ${parts.join(",")}`;
};

const projectsDir = join(homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"));
const created: string[] = [];
try {
	console.log(`claude: ${cliPath}\nvault:  ${vault}\n`);

	console.log("1. Streamed UUIDs vs transcript");
	const t1 = await turn("Read note.md with the Read tool, say 'Reading done.' and then tell me the codeword in one word.");
	created.push(t1.sessionId);
	console.log("  result:", t1.result);
	const t2 = await turn("Reply with just the word TWO.", { resume: t1.sessionId });
	console.log("  resumed turn:", t2.result, "same session:", t2.sessionId === t1.sessionId);
	const entries = (await getSessionMessages(t1.sessionId, { dir: vault })) as unknown as Entry[];
	console.log("  transcript:");
	for (const e of entries) console.log("   ", brief(e));
	const ids = new Set(entries.map((e) => e.uuid));
	const streamedAssistant = [...t1.seen, ...t2.seen].filter((m) => m.type === "assistant").map((m) => m.uuid);
	console.log("  supplied user uuids in transcript:", ids.has(t1.uuid), ids.has(t2.uuid));
	console.log("  streamed assistant uuids in transcript:", streamedAssistant.map((u) => ids.has(u)));

	console.log("\n2. Listing");
	const all = await listSessions({ dir: vault, includeWorktrees: false });
	console.log("  listed:", all.map((s) => `${s.sessionId.slice(0, 8)} "${s.summary}" first="${s.firstPrompt?.slice(0, 20)}"`));

	console.log("\n3. forkSession at various points (Q10)");
	const assistantEntries = entries.filter((e) => e.type === "assistant");
	const midText = assistantEntries.find((e) => Array.isArray(e.message.content) && (e.message.content as { type: string }[]).some((b) => b.type === "text"));
	const toolUse = assistantEntries.find((e) => Array.isArray(e.message.content) && (e.message.content as { type: string }[]).some((b) => b.type === "tool_use"));
	const userIdx = entries.findIndex((e) => e.uuid === t2.uuid);
	const points: [string, string | undefined][] = [
		["before second user message", entries[userIdx - 1]?.uuid],
		["first assistant text block", midText?.uuid],
		["tool_use entry (no result)", toolUse?.uuid],
	];
	for (const [label, at] of points) {
		if (!at) {
			console.log(`  ${label}: not found`);
			continue;
		}
		const fork = await forkSession(t1.sessionId, { dir: vault, upToMessageId: at });
		created.push(fork.sessionId);
		const forkEntries = (await getSessionMessages(fork.sessionId, { dir: vault })) as unknown as Entry[];
		const r = await turn("What was the last thing you said? Answer in under 15 words.", { resume: fork.sessionId });
		console.log(`  ${label}: fork has ${forkEntries.length} entries, resumed: ${r.result}, same id: ${r.sessionId === fork.sessionId}`);
	}
	const info = (await listSessions({ dir: vault, includeWorktrees: false })).find((s) => s.sessionId === created.at(-1));
	console.log("  fork title:", info?.summary, "custom:", info?.customTitle);

	console.log("\n4. resume + resumeSessionAt + forkSession: true");
	if (midText) {
		const r = await turn("What was the last thing you said? Answer in under 15 words.", { resume: t1.sessionId, resumeSessionAt: midText.uuid, forkSession: true });
		created.push(r.sessionId);
		console.log("  result:", r.result, "new id:", r.sessionId !== t1.sessionId);
	}

	console.log("\n5. renameSession");
	await renameSession(t1.sessionId, "Probe rename", { dir: vault });
	const renamed = (await listSessions({ dir: vault, includeWorktrees: false })).find((s) => s.sessionId === t1.sessionId);
	console.log("  summary:", renamed?.summary, "customTitle:", renamed?.customTitle);

	console.log("\n  projects dir:", projectsDir);
	if (process.argv.includes("--keep")) {
		console.log("  --keep: leaving sessions and vault in place");
		created.length = 0;
	}
} finally {
	for (const id of created) await deleteSession(id, { dir: vault }).catch((err) => console.log("  delete failed:", id, String(err)));
	if (created.length) {
		const left = await listSessions({ dir: vault, includeWorktrees: false });
		console.log(`\ndeleteSession: ${left.length} sessions left`);
		rmSync(vault, { recursive: true, force: true });
		rmSync(projectsDir, { recursive: true, force: true });
	}
}
