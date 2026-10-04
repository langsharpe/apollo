// M5 probe: checks what Apollo's Obsidian tools rely on (spec §9 Q15).
//
//   node scripts/probe-m5.mts           # server status only, no model calls
//   node scripts/probe-m5.mts --turns   # also runs short Haiku turns
//
// Builds a throwaway vault in the temp dir with a project `.mcp.json` stdio
// server (approved in settings.local.json), then starts queries that add an
// in-process `createSdkMcpServer` server named "apollo" with one alwaysLoad
// tool and one deferred tool. Then:
// - `mcpServerStatus()` and the init message's tools, with and without
//   `strict-mcp-config` (does the SDK server survive strict mode?),
// - whether `alwaysLoad` reaches Claude Code (the tool is in the init list
//   while the deferred one isn't, when tool search is on),
// - with --turns: the model calls the alwaysLoad tool and finds the deferred
//   one through tool search; whether `allowedTools` skips canUseTool for an
//   SDK tool and whether readOnlyHint alone does; what a handler's `extra`
//   argument carries; how a tool error reaches the transcript.

import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const turns = process.argv.includes("--turns");
const cliPath = process.env.CLAUDE_PATH ?? execFileSync("/bin/sh", ["-lc", "command -v claude"]).toString().trim();
const vault = realpathSync(mkdtempSync(join(tmpdir(), "apollo-probe-")));
const repo = join(import.meta.dirname, "..");

function write(path: string, text: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

// A minimal stdio MCP server standing in for one from the user's settings.
write(
	join(vault, "stdio-server.mjs"),
	`import { McpServer } from ${JSON.stringify(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};
const server = new McpServer({ name: "projectsrv", version: "1.0.0" });
server.registerTool("ping", { description: "Replies pong." }, async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
`,
);
write(join(vault, ".mcp.json"), JSON.stringify({ mcpServers: { projectsrv: { command: process.execPath, args: [join(vault, "stdio-server.mjs")] } } }));
write(join(vault, ".claude/settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));

const calls: { tool: string; extra: unknown }[] = [];
const permissionAsks: string[] = [];

function apolloServer() {
	return createSdkMcpServer({
		name: "apollo",
		version: "1.0.0",
		instructions: "Probe tools.",
		tools: [
			tool(
				"vault_links",
				"Returns the secret word for a note path.",
				{ path: z.string() },
				async ({ path }, extra) => {
					calls.push({ tool: "vault_links", extra });
					return { content: [{ type: "text", text: `Secret for ${path}: MANGO-41` }] };
				},
				{ alwaysLoad: true, annotations: { readOnlyHint: true } },
			),
			tool(
				"vault_outline",
				"Returns the outline code of a note. Always fails for paths containing 'bad'.",
				{ path: z.string() },
				async ({ path }, extra) => {
					calls.push({ tool: "vault_outline", extra });
					if (path.includes("bad")) return { content: [{ type: "text", text: `No note at ${path}.` }], isError: true };
					return { content: [{ type: "text", text: `Outline code for ${path}: KIWI-77` }] };
				},
				{ annotations: { readOnlyHint: true } },
			),
		],
	});
}

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
	mcpServers: { apollo: apolloServer() },
	canUseTool: async (name, input) => {
		permissionAsks.push(name);
		return { behavior: "allow", updatedInput: input };
	},
	...extra,
});

async function status(label: string, options: Options) {
	const input = new Queue();
	const q = query({ prompt: input, options });
	await q.initializationResult();
	// MCP servers connect in the background; give the stdio one a moment.
	await new Promise((r) => setTimeout(r, 3000));
	const servers = await q.mcpServerStatus();
	console.log(`\n${label}`);
	for (const s of servers) console.log(`  ${s.name}: ${s.status}${s.tools ? `, tools: ${s.tools.map((t) => t.name).join(" ")}` : ""}`);
	input.close();
	q.close();
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
	return { seen, init, result: result?.subtype === "success" ? result.result : result?.subtype };
}

function toolTraffic(seen: SDKMessage[]) {
	for (const m of seen) {
		if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") console.log("  tool_use:", b.name, JSON.stringify(b.input));
		if (m.type === "user" && Array.isArray(m.message.content)) {
			for (const b of m.message.content) if (b.type === "tool_result") console.log("  tool_result:", b.is_error ? "(error)" : "", JSON.stringify(b.content).slice(0, 200));
		}
	}
}

const projectsDir = join(homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"));
try {
	console.log(`claude: ${cliPath}\nvault:  ${vault}`);

	await status("1. SDK server next to a project .mcp.json server", base());
	await status("2. Same, with strict-mcp-config", base({ extraArgs: { "strict-mcp-config": null } }));

	if (turns) {
		console.log("\n3. Init tools (alwaysLoad vs deferred)");
		const t = await turn("Call mcp__apollo__vault_links with path a.md, then tell me the secret word only.");
		if (t.init?.type === "system" && t.init.subtype === "init") {
			console.log("  apollo tools in init:", t.init.tools.filter((n) => n.includes("apollo")).join(" ") || "(none)");
			console.log("  ToolSearch in init:", t.init.tools.includes("ToolSearch"));
			console.log("  mcp_servers:", JSON.stringify(t.init.mcp_servers));
		}
		console.log("  result:", t.result);
		toolTraffic(t.seen);
		console.log("  canUseTool asked for:", permissionAsks.splice(0).join(" ") || "(nothing)");
		console.log("  handler extra keys:", calls.map((c) => Object.keys(c.extra as object).join(",")).join(" | "));
		const meta = (calls[0]?.extra as { _meta?: unknown } | undefined)?._meta;
		console.log("  handler extra._meta:", JSON.stringify(meta));
		calls.length = 0;

		console.log("\n4. Same call with allowedTools");
		const a = await turn("Call mcp__apollo__vault_links with path b.md, then tell me the secret word only.", { allowedTools: ["mcp__apollo__vault_links"] });
		console.log("  result:", a.result);
		console.log("  canUseTool asked for:", permissionAsks.splice(0).join(" ") || "(nothing)");

		console.log("\n5. Deferred tool, found through tool search, with an error then success");
		const d = await turn("Use the apollo vault_outline tool on bad.md, then on good.md. Report both results briefly.");
		console.log("  result:", d.result);
		toolTraffic(d.seen);
		console.log("  canUseTool asked for:", permissionAsks.splice(0).join(" ") || "(nothing)");
	}
} finally {
	rmSync(vault, { recursive: true, force: true });
	rmSync(projectsDir, { recursive: true, force: true });
}
