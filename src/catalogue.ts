import type { ModelInfo, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { Events, debounce, parseYaml, type EventRef } from "obsidian";

/** Where an entry comes from. Shown as the badge in the slash menu. */
export type CommandSource = "apollo" | "project" | "user" | "plugin" | "claude-code" | "claude-ai" | "mcp" | "other";

/** One row of the slash menu (SLS-1, SLS-2). */
export interface CatalogueEntry {
	/** Without the leading slash, e.g. `brainstorming` or `superpowers:brainstorming`. */
	name: string;
	description: string;
	argumentHint: string;
	kind: "apollo" | "skill" | "command" | "mcp-prompt" | "builtin";
	source: CommandSource;
	/** Plugin name, for plugin entries. */
	plugin?: string;
	/** Absolute path of the SKILL.md or command file, for scanned entries. */
	path?: string;
	/** Set when Claude Code didn't load a scanned entry (SLS-5). */
	unavailable?: string;
	/** For scanned entries: file mtime, so entries added after the last session aren't marked unavailable. */
	mtime?: number;
}

/** What the last session reported, saved so the menu is complete from the first keystroke after a restart. */
interface Reported {
	commands: SlashCommand[];
	skills: string[];
	terminal: string[];
	/** When it was reported (ms). */
	at: number;
}

export interface CatalogueCache {
	scanned?: CatalogueEntry[];
	reported?: Reported | null;
	models?: ModelInfo[];
}

/** Commands Apollo handles itself and never sends (SLS-6). */
export const APOLLO_COMMANDS: CatalogueEntry[] = [
	{ name: "new", description: "Start a new chat in this pane. The current one stays in the chat list.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "clear", description: "Same as /new: a fresh session in this pane.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "fork", description: "Fork this chat into a new tab.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "model", description: "Set the model for this chat.", argumentHint: "[model]", kind: "apollo", source: "apollo" },
	{ name: "mode", description: "Set the permission mode for this chat.", argumentHint: "[ask|accept-edits|plan|auto]", kind: "apollo", source: "apollo" },
];

/**
 * Claude Code commands that only make sense in a terminal, or that Apollo
 * replaces (SLS-7). Claude Code tags some itself in `terminal_slash_commands`;
 * those are hidden too.
 */
const HIDDEN = new Set([
	"doctor",
	"terminal-setup",
	"color",
	"focus",
	"vim",
	"statusline",
	"ide",
	"exit",
	"quit",
	"theme",
	"login",
	"logout",
	"upgrade",
	"install-github-app",
	"resume",
	"heapdump",
	"keybindings",
	"reload-plugins",
	// Server-launched sessions only.
	"workflow-launch-exec",
	// Apollo's own versions.
	"new",
	"reset",
	"clear",
	"model",
]);

/** Directories scanned for skills and commands (SLS-3). */
interface ScanRoot {
	dir: string;
	kind: "skill" | "command";
	source: "project" | "user" | "plugin";
	plugin?: string;
}

/**
 * The slash menu's catalogue. Built on the plugin side so the menu opens
 * instantly (SLS-9): skills and commands are scanned from disk (SLS-3),
 * kept fresh by watchers and focus checks (SLS-4), and reconciled with what
 * Claude Code reports at session start (SLS-5). Everything is cached in
 * plugin data for the next launch.
 */
export class CommandCatalogue extends Events {
	private scanned: CatalogueEntry[];
	private reported: Reported | null;
	models: ModelInfo[];
	private merged: CatalogueEntry[] = [];
	private byName = new Map<string, CatalogueEntry>();
	/** Parsed files by path, reused while their mtime is unchanged. */
	private files = new Map<string, { mtime: number; entry: CatalogueEntry | null }>();
	private watcher: FSWatcher | null = null;
	private scanning: Promise<void> | null = null;
	private rescan = false;
	private lastScan = 0;

	readonly requestScan = debounce(() => void this.scan(), 300, true);

	constructor(
		private readonly vaultPath: () => string,
		cache: CatalogueCache,
		private readonly persist: () => void,
	) {
		super();
		this.scanned = cache.scanned ?? [];
		this.reported = cache.reported ?? null;
		this.models = cache.models ?? [];
		this.merge();
	}

	/** Everything the menu offers, terminal-only commands excluded (SLS-7). */
	entries(): readonly CatalogueEntry[] {
		return this.merged;
	}

	get(name: string): CatalogueEntry | undefined {
		return this.byName.get(name);
	}

	toCache(): CatalogueCache {
		return { scanned: this.scanned, reported: this.reported, models: this.models };
	}

	onChanged(callback: () => void): EventRef {
		return this.on("changed", callback);
	}

	/** Re-reads skill and command files. Unchanged files aren't re-parsed. */
	async scan(): Promise<void> {
		if (this.scanning) {
			this.rescan = true;
			return this.scanning;
		}
		this.scanning = (async () => {
			do {
				this.rescan = false;
				const entries: CatalogueEntry[] = [];
				const seen = new Set<string>();
				for (const root of await this.roots()) {
					for (const file of await listFiles(root)) {
						seen.add(file);
						const entry = await this.parse(root, file);
						if (entry) entries.push(entry);
					}
				}
				for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
				this.lastScan = Date.now();
				if (!sameEntries(entries, this.scanned)) {
					this.scanned = entries;
					this.merge();
					this.persist();
				}
				this.ensureWatcher();
			} while (this.rescan);
		})();
		try {
			await this.scanning;
		} finally {
			this.scanning = null;
		}
	}

	/** A cheap re-scan for window focus, at most every few seconds (SLS-4). */
	scanIfStale(): void {
		if (Date.now() - this.lastScan > 3000) this.requestScan();
	}

	/**
	 * Merges in what a session reports Claude Code loaded (SLS-5): managed,
	 * plugin and built-in skills and MCP prompts the scan can't see, and
	 * which scanned entries didn't load.
	 */
	reconcile(update: { commands: SlashCommand[]; skills?: string[]; terminal?: string[] }): void {
		this.reported = {
			commands: update.commands,
			skills: update.skills ?? this.reported?.skills ?? [],
			terminal: update.terminal ?? this.reported?.terminal ?? [],
			at: Date.now(),
		};
		this.merge();
		this.persist();
	}

	setModels(models: ModelInfo[]): void {
		if (JSON.stringify(models) === JSON.stringify(this.models)) return;
		this.models = models;
		this.persist();
	}

	close(): void {
		this.watcher?.close();
		this.watcher = null;
	}

	private merge(): void {
		const merged: CatalogueEntry[] = APOLLO_COMMANDS.map((e) => ({ ...e }));
		const reported = this.reported;
		const byName = new Map(reported?.commands.map((c) => [c.name, c] as const) ?? []);
		const claimed = new Set<string>();

		for (const entry of this.scanned) {
			const copy = { ...entry };
			delete copy.unavailable;
			const r = byName.get(entry.name);
			if (reported && !r) {
				// Files added since that session started load next time; don't flag them.
				if ((entry.mtime ?? 0) < reported.at) copy.unavailable = "Claude Code didn't load this";
			} else if (r) {
				const from = reportedSource(r);
				// Same name at user and project level: Claude Code loads the user one (Q14).
				if (from && from !== entry.source && (from === "user" || from === "project")) {
					copy.unavailable = `Shadowed by the ${from} ${entry.kind} of the same name`;
				} else {
					claimed.add(entry.name);
					if (!copy.argumentHint && r.argumentHint) copy.argumentHint = r.argumentHint;
				}
			}
			merged.push(copy);
		}

		const skills = new Set(reported?.skills ?? []);
		const terminal = new Set(reported?.terminal ?? []);
		for (const c of reported?.commands ?? []) {
			if (claimed.has(c.name)) continue;
			if (c.builtin && (HIDDEN.has(c.name) || terminal.has(c.name) || c.name.startsWith("__"))) continue;
			if (!c.builtin && terminal.has(c.name)) continue;
			// A same-named scanned entry that Claude Code shadowed is already listed; the winner may not have been scanned.
			merged.push(fromReported(c, skills));
		}

		// Apollo's commands win over anything else with their names.
		const seen = new Set<string>();
		this.merged = merged.filter((e) => {
			if (e.unavailable) return true;
			if (seen.has(e.name)) return false;
			seen.add(e.name);
			return true;
		});
		this.byName = new Map(this.merged.filter((e) => !e.unavailable).map((e) => [e.name, e]));
		this.trigger("changed");
	}

	private async roots(): Promise<ScanRoot[]> {
		const vault = this.vaultPath();
		const home = join(homedir(), ".claude");
		const roots: ScanRoot[] = [
			{ dir: join(vault, ".claude", "skills"), kind: "skill", source: "project" },
			{ dir: join(vault, ".claude", "commands"), kind: "command", source: "project" },
			{ dir: join(home, "skills"), kind: "skill", source: "user" },
			{ dir: join(home, "commands"), kind: "command", source: "user" },
		];
		for (const plugin of await enabledPlugins(vault, home)) {
			roots.push({ dir: join(plugin.path, "skills"), kind: "skill", source: "plugin", plugin: plugin.name });
			roots.push({ dir: join(plugin.path, "commands"), kind: "command", source: "plugin", plugin: plugin.name });
		}
		return roots;
	}

	private async parse(root: ScanRoot, file: string): Promise<CatalogueEntry | null> {
		const info = await stat(file).catch(() => null);
		if (!info) return null;
		const cached = this.files.get(file);
		if (cached && cached.mtime === info.mtimeMs) return cached.entry;
		const text = await readFile(file, "utf8").catch(() => null);
		const entry = text === null ? null : toEntry(root, file, text, info.mtimeMs);
		this.files.set(file, { mtime: info.mtimeMs, entry });
		return entry;
	}

	/**
	 * Obsidian doesn't index dot-folders, so vault events never fire for
	 * `.claude/`. Watch it directly once it exists (macOS supports recursive
	 * watches). `~/.claude` is checked on focus instead.
	 */
	private ensureWatcher(): void {
		if (this.watcher) return;
		try {
			this.watcher = watch(join(this.vaultPath(), ".claude"), { recursive: true }, (_event, name) => {
				if (!name || /^(skills|commands)([\\/]|$)/.test(name)) this.requestScan();
			});
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = null;
			});
		} catch {
			this.watcher = null;
		}
	}
}

/** Skill folders (`<name>/SKILL.md`) or command files (`**\/*.md`) under a root. */
async function listFiles(root: ScanRoot): Promise<string[]> {
	if (root.kind === "skill") {
		const dirs = await readdir(root.dir, { withFileTypes: true }).catch(() => []);
		const files: string[] = [];
		for (const d of dirs) {
			if (d.name.startsWith(".")) continue;
			// Symlinked skill folders count too.
			if (!d.isDirectory() && !d.isSymbolicLink()) continue;
			const file = join(root.dir, d.name, "SKILL.md");
			if (await stat(file).catch(() => null)) files.push(file);
		}
		return files;
	}
	const entries = await readdir(root.dir, { recursive: true, withFileTypes: true }).catch(() => []);
	return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => join(e.parentPath, e.name));
}

function toEntry(root: ScanRoot, file: string, text: string, mtime: number): CatalogueEntry | null {
	const { data, body } = frontmatter(text);
	const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string).trim() : "");
	let name: string;
	if (root.kind === "skill") {
		const dir = relative(root.dir, file).split(sep)[0]!;
		name = str("name") || dir;
	} else {
		// Nested folders become namespaces: commands/group/nested.md is /group:nested.
		name = relative(root.dir, file).replace(/\.md$/, "").split(sep).join(":");
	}
	if (!name) return null;
	if (root.plugin) name = `${root.plugin}:${name}`;
	// Like Claude Code, a command without a description uses its first line.
	const description = str("description") || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() || "";
	return {
		name,
		description,
		argumentHint: str("argument-hint"),
		kind: root.kind,
		source: root.source,
		...(root.plugin ? { plugin: root.plugin } : {}),
		path: file,
		mtime,
	};
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { data: {}, body: text };
	let data: unknown = null;
	try {
		data = parseYaml(m[1]!);
	} catch {
		// Malformed frontmatter: treat the file as having none.
	}
	return { data: data && typeof data === "object" ? (data as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

/**
 * Claude Code plugins that are enabled for this vault: `enabledPlugins` in
 * user, project and local settings (later wins), located through
 * `installed_plugins.json`.
 */
async function enabledPlugins(vault: string, home: string): Promise<{ name: string; path: string }[]> {
	const enabled = new Map<string, boolean>();
	for (const file of [join(home, "settings.json"), join(vault, ".claude", "settings.json"), join(vault, ".claude", "settings.local.json")]) {
		const settings = await readJson<{ enabledPlugins?: Record<string, boolean> }>(file);
		for (const [key, on] of Object.entries(settings?.enabledPlugins ?? {})) enabled.set(key, on === true);
	}
	const installed = await readJson<{ plugins?: Record<string, { installPath?: string; projectPath?: string }[]> }>(
		join(home, "plugins", "installed_plugins.json"),
	);
	const plugins: { name: string; path: string }[] = [];
	for (const [key, on] of enabled) {
		if (!on) continue;
		const installs = installed?.plugins?.[key] ?? [];
		const install = installs.find((i) => !i.projectPath || i.projectPath === vault) ?? installs[0];
		if (!install?.installPath) continue;
		const manifest = await readJson<{ name?: string }>(join(install.installPath, ".claude-plugin", "plugin.json"));
		plugins.push({ name: manifest?.name || key.split("@")[0]!, path: install.installPath });
	}
	return plugins;
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * Where Claude Code says a command came from. It tags descriptions:
 * "… (project)", "… (user)", "(plugin) …", "… (claude.ai sync)". MCP
 * prompts carry the tag in their name instead.
 */
function reportedSource(c: SlashCommand): CommandSource | null {
	if (c.builtin) return "claude-code";
	if (/\(project\)$/.test(c.description)) return "project";
	if (/\(user\)$/.test(c.description)) return "user";
	if (/\(claude\.ai sync\)$/.test(c.description)) return "claude-ai";
	// MCP prompts are named "<server>:<prompt> (MCP)", spaces and all, and run by that full name.
	if (/ \(MCP\)$/.test(c.name) || /\(MCP\)$/.test(c.description) || c.name.startsWith("mcp__")) return "mcp";
	if (/^\([^)]+\) /.test(c.description) && c.name.includes(":")) return "plugin";
	return null;
}

function fromReported(c: SlashCommand, skills: Set<string>): CatalogueEntry {
	const source = reportedSource(c) ?? "other";
	const description = c.description
		.replace(/\s*\((project|user|claude\.ai sync|MCP)\)$/, "")
		.replace(source === "plugin" ? /^\([^)]+\) / : /^$/, "")
		.trim();
	const kind: CatalogueEntry["kind"] = c.builtin ? "builtin" : source === "mcp" ? "mcp-prompt" : skills.has(c.name) || source === "claude-ai" ? "skill" : "command";
	return {
		name: c.name,
		description,
		argumentHint: c.argumentHint,
		kind,
		source,
		...(source === "plugin" ? { plugin: c.name.split(":")[0]! } : {}),
	};
}

function sameEntries(a: CatalogueEntry[], b: CatalogueEntry[]): boolean {
	return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** The badge text for an entry's source. */
export function sourceLabel(e: CatalogueEntry): string {
	switch (e.source) {
		case "apollo":
			return "Apollo";
		case "project":
			return "Vault";
		case "user":
			return "User";
		case "plugin":
			return e.plugin ?? "Plugin";
		case "claude-code":
			return "Claude Code";
		case "claude-ai":
			return "claude.ai";
		case "mcp":
			return "MCP";
		default:
			return "Other";
	}
}
