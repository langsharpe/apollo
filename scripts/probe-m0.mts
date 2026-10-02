// M0 probe: answers spec §9 open questions 1 to 4 against the installed Claude Code.
//
//   node scripts/probe-m0.mts            # config-only checks, no model calls
//   node scripts/probe-m0.mts --turns    # also run two short Haiku turns (Q3, Q4 end-to-end)
//
// Builds a throwaway "vault" in the temp dir with a project .mcp.json, an output
// style and a note, then inspects what Claude Code loads under various options.
// Sessions are not persisted.

import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runTurns = process.argv.includes("--turns");
const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();

const vault = mkdtempSync(join(tmpdir(), "apollo-probe-"));
const write = (rel: string, text: string) => {
	mkdirSync(join(vault, rel, ".."), { recursive: true });
	writeFileSync(join(vault, rel), text);
};
write(".mcp.json", JSON.stringify({ mcpServers: { "probe-a": { command: "false" }, "probe-b": { command: "false" } } }));
write(".claude/settings.json", JSON.stringify({ enableAllProjectMcpServers: true }));
write(
	".claude/output-styles/probe-style.md",
	"---\nname: Probe Style\ndescription: Apollo M0 probe\n---\n\nBegin every reply with the exact word PINEAPPLE, then answer normally.\n",
);
write("Notes/secret.md", "The codeword is ZEBRA-4417.\n");

const base: Options = {
	cwd: vault,
	pathToClaudeCodeExecutable: cliPath,
	settingSources: ["user", "project", "local"],
	systemPrompt: { type: "preset", preset: "claude_code" },
	persistSession: false,
};

/** Starts a session without sending a prompt, reads its config, then shuts it down. No model call. */
async function inspect(extra: Partial<Options>) {
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	async function* idle(): AsyncGenerator<SDKUserMessage> {
		await held;
	}
	const q = query({ prompt: idle(), options: { ...base, ...extra } });
	try {
		const init = await q.initializationResult();
		const servers = await q.mcpServerStatus();
		return { init, servers };
	} finally {
		release();
		q.close();
	}
}

/** Runs one short turn on Haiku with tools off and returns the final text. */
async function turn(prompt: string, extra: Partial<Options> = {}) {
	let text = "";
	let initStyle = "";
	for await (const msg of query({ prompt, options: { ...base, model: "haiku", tools: [], ...extra } })) {
		if (msg.type === "system" && msg.subtype === "init") initStyle = msg.output_style;
		if (msg.type === "result" && msg.subtype === "success") text = msg.result;
	}
	return { text: text.trim(), initStyle };
}

const fmt = (servers: { name: string; status: string; scope?: string }[]) =>
	servers.map((s) => `${s.name} [${s.scope ?? "?"}:${s.status}]`).join(", ") || "(none)";

try {
	console.log(`claude: ${cliPath}`);
	console.log(`vault:  ${vault}\n`);

	const baseline = await inspect({});
	console.log("Baseline MCP servers:", fmt(baseline.servers));
	const connector = baseline.servers.find((s) => s.name.startsWith("claude.ai "));

	console.log("\nQ1. deniedMcpServers via inline settings");
	const denied = [{ serverName: "probe-a" }, ...(connector ? [{ serverName: connector.name }] : [])];
	const q1 = await inspect({ settings: { deniedMcpServers: denied } });
	console.log("  denying:", denied.map((d) => d.serverName).join(", "));
	console.log("  servers:", fmt(q1.servers));
	const q1String = await inspect({ settings: { deniedMcpServers: ["probe-a"] } as never }).catch((e: Error) => e);
	console.log("  plain string entry:", q1String instanceof Error ? `error: ${q1String.message}` : fmt(q1String.servers));
	const q1b = await inspect({ settings: { disableClaudeAiConnectors: true } });
	console.log("  disableClaudeAiConnectors:", fmt(q1b.servers));

	console.log("\nQ2. Strict MCP config");
	console.log("  strictMcpConfig: true      ->", fmt((await inspect({ strictMcpConfig: true })).servers));
	console.log("  extraArgs strict-mcp-config ->", fmt((await inspect({ extraArgs: { "strict-mcp-config": null } })).servers));

	console.log("\nQ4. Custom output style via inline settings");
	const q4 = await inspect({ settings: { outputStyle: "Probe Style" } });
	console.log("  init output_style:", JSON.stringify((q4.init as { output_style?: string }).output_style));
	console.log("  available styles:", JSON.stringify((q4.init as { available_output_styles?: string[] }).available_output_styles));

	if (runTurns) {
		const styled = await turn("Say hello in five words.", { settings: { outputStyle: "Probe Style" } });
		console.log(`  turn: init style ${JSON.stringify(styled.initStyle)}, reply ${JSON.stringify(styled.text)}`);

		console.log("\nQ3. @path expansion in SDK prompts (tools disabled, so contents can only arrive by expansion)");
		const ask = "What is the codeword? Reply with only the codeword, or NONE if you don't know.";
		console.log("  with @Notes/secret.md:", JSON.stringify((await turn(`@Notes/secret.md ${ask}`)).text));
		console.log("  plain Notes/secret.md:", JSON.stringify((await turn(`Notes/secret.md ${ask}`)).text));
	} else {
		console.log("\nQ3 needs model turns: rerun with --turns.");
	}
} finally {
	rmSync(vault, { recursive: true, force: true });
}
