// M3 probe: checks what the slash menu relies on.
//
//   node scripts/probe-m3.mts           # command lists only, no model calls
//   node scripts/probe-m3.mts --turns   # also runs short Haiku turns
//
// Builds a throwaway vault in the temp dir with a project skill, a project
// command and a nested-folder skill, plus a throwaway user config dir
// (CLAUDE_CONFIG_DIR) holding a user skill with the same name as the project
// one. Then:
// - the init message's `slash_commands`, `skills` and
//   `terminal_slash_commands`, and `supportedCommands()`, with timings
//   (spec §9 Q13),
// - which of the two same-named skills wins (Q14),
// - with --turns: sending `/probe-skill args` as prompt text runs the skill
//   (Q13), how a user-invoked skill shows in the stream and the transcript,
//   how a model-invoked skill shows (SLS-8), and whether quoted @-mentions
//   of paths with spaces attach the file (CTX-8).

import { getSessionMessages, query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const turns = process.argv.includes("--turns");
const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();
const vault = realpathSync(mkdtempSync(join(tmpdir(), "apollo-probe-")));

function write(path: string, text: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

write(
	join(vault, ".claude/skills/probe-skill/SKILL.md"),
	"---\nname: probe-skill\ndescription: Project copy of the probe skill.\nargument-hint: <word>\n---\n\nReply with exactly `PROJECT-SKILL $ARGUMENTS` and nothing else.\n",
);
write(
	join(vault, ".claude/skills/codeword/SKILL.md"),
	"---\nname: codeword\ndescription: Use when the user asks for the secret codeword.\n---\n\nThe codeword is PAPAYA. Reply with just the codeword.\n",
);
write(
	join(vault, ".claude/commands/probe-cmd.md"),
	"---\ndescription: A project command.\nargument-hint: [text]\n---\n\nReply with exactly `PROJECT-CMD $ARGUMENTS` and nothing else.\n",
);
write(join(vault, ".claude/commands/group/nested.md"), "---\ndescription: A nested command.\n---\n\nReply with NESTED.\n");
write(join(vault, "My Notes/secret note.md"), "The codeword is QUINCE-8812.\n");

// Only for the shadowing check: a user config dir with a same-named skill.
const configDir = realpathSync(mkdtempSync(join(tmpdir(), "apollo-probe-config-")));
write(
	join(configDir, "skills/probe-skill/SKILL.md"),
	"---\nname: probe-skill\ndescription: User copy of the probe skill.\n---\n\nReply with exactly `USER-SKILL $ARGUMENTS` and nothing else.\n",
);

class Queue implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;
	push(text: string) {
		this.items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID() } as SDKUserMessage);
		this.wake?.();
	}
	close() {
		this.closed = true;
		this.wake?.();
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			const next = this.items.shift();
			if (next) yield next;
			else if (this.closed) return;
			else await new Promise<void>((r) => (this.wake = r));
		}
	}
}

const base = (extra: Partial<Options> = {}): Options => ({
	cwd: vault,
	pathToClaudeCodeExecutable: cliPath,
	settingSources: ["project", "local"],
	systemPrompt: { type: "preset", preset: "claude_code" },
	model: "haiku",
	permissionMode: "default",
	canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
	...extra,
});

async function commandLists(label: string, options: Options) {
	const input = new Queue();
	const t0 = performance.now();
	const q = query({ prompt: input, options });
	const init = await q.initializationResult();
	const t1 = performance.now();
	const commands = await q.supportedCommands();
	const t2 = performance.now();
	console.log(`\n${label}`);
	console.log(`  initializationResult: ${(t1 - t0).toFixed(0)} ms, supportedCommands: ${(t2 - t1).toFixed(0)} ms after`);
	const ours = commands.filter((c) => /probe|codeword|nested|group/.test(c.name));
	console.log("  probe entries:", ours);
	console.log("  total:", commands.length, "builtin:", commands.filter((c) => c.builtin).length);
	console.log("  builtin names:", commands.filter((c) => c.builtin).map((c) => c.name).join(" "));
	console.log("  init keys:", Object.keys(init).join(", "));
	input.close();
	q.close();
	return commands;
}

async function turn(text: string, extra: Partial<Options> = {}) {
	const input = new Queue();
	const q = query({ prompt: input, options: base(extra) });
	input.push(text);
	const seen: SDKMessage[] = [];
	for await (const m of q) {
		seen.push(m);
		if (m.type === "result") break;
	}
	input.close();
	q.close();
	const init = seen.find((m) => m.type === "system" && m.subtype === "init");
	const result = seen.find((m) => m.type === "result");
	return { seen, init, sessionId: init?.session_id ?? "", result: result?.subtype === "success" ? result.result : result?.subtype };
}

const projectsDir = join(homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"));
try {
	console.log(`claude: ${cliPath}\nvault:  ${vault}`);

	await commandLists("1. supportedCommands, project settings only", base());
	await commandLists("2. Same, with a user config dir holding a same-named skill (Q14)", base({
		settingSources: ["user", "project", "local"],
		env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
	}));

	if (turns) {
		console.log("\n3. Init message");
		const t = await turn("/probe-skill banana");
		if (t.init?.type === "system" && t.init.subtype === "init") {
			console.log("  slash_commands:", t.init.slash_commands.join(" "));
			console.log("  terminal_slash_commands:", t.init.terminal_slash_commands);
			console.log("  skills:", t.init.skills.join(" "));
		}
		console.log("\n4. `/probe-skill banana` as prompt text (Q13)");
		console.log("  result:", t.result);
		console.log("  stream:", t.seen.map((m) => `${m.type}${"subtype" in m ? `/${m.subtype}` : ""}`).filter((s) => s !== "stream_event").join(" "));
		for (const m of t.seen) {
			if (m.type === "user") console.log("  user msg:", JSON.stringify(m.message.content).slice(0, 300), "isReplay:", "isReplay" in m ? m.isReplay : undefined, "isSynthetic:", m.isSynthetic);
			if (m.type === "assistant") console.log("  assistant:", JSON.stringify(m.message.content).slice(0, 200));
		}
		const entries = await getSessionMessages(t.sessionId, { dir: vault });
		console.log("  transcript:");
		for (const e of entries) console.log("   ", e.type, JSON.stringify((e.message as { content: unknown }).content).slice(0, 200));

		console.log("\n5. `/probe-cmd kiwi` and `/group:nested`");
		console.log("  probe-cmd:", (await turn("/probe-cmd kiwi")).result);
		console.log("  group:nested:", (await turn("/group:nested")).result);

		console.log("\n6. Model-invoked skill (SLS-8)");
		const m = await turn("What is the secret codeword? Use your skills.");
		console.log("  result:", m.result);
		for (const msg of m.seen) {
			if (msg.type === "assistant") {
				for (const b of msg.message.content) if (b.type === "tool_use") console.log("  tool_use:", b.name, JSON.stringify(b.input));
			}
			if (msg.type === "user" && Array.isArray(msg.message.content)) {
				for (const b of msg.message.content) if (b.type === "tool_result") console.log("  tool_result:", JSON.stringify(b.content).slice(0, 200));
			}
		}

		console.log("\n7. @-mentions of a path with spaces (tools off, so contents only arrive by expansion)");
		const ask = "What is the codeword? Reply with just the codeword, or NONE if you can't see it.";
		console.log('  @"My Notes/secret note.md":', (await turn(`@"My Notes/secret note.md" ${ask}`, { tools: [] })).result);
		console.log("  @My\\ Notes/secret\\ note.md:", (await turn(`@My\\ Notes/secret\\ note.md ${ask}`, { tools: [] })).result);
		console.log('  @"My Notes/" (folder):', (await turn('@"My Notes/" List the file names you can see, or NONE.', { tools: [] })).result);
	}
} finally {
	rmSync(vault, { recursive: true, force: true });
	rmSync(configDir, { recursive: true, force: true });
	rmSync(projectsDir, { recursive: true, force: true });
}
