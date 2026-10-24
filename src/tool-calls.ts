import { plural, truncate } from "./format";
import { VAULT_TOOL_PREFIX, type ToolName } from "./vault-tools";

/** What a tool call does, for a group's summary and progress line. */
export type Kind = "read" | "inspect" | "edit" | "move" | "trash" | "search" | "present" | "command" | "fetch" | "web" | "agent" | "other";

/** What an entry needs to word a progress line: the call's kind and its shortened input fields. */
type ProgressText = { kind: Kind; str(key: string): string };

/** "Moving notes/a.md": a verb, then its target if there is one. */
function target(verb: string, value: string): string {
	return value ? `${verb} ${value}` : verb;
}

export interface VaultToolEntry {
	/** The row's name. */
	label: string;
	kind: Kind;
	/** Whether a result describes a change to show (OBS-13). */
	changes?: boolean;
	/** True when this call only reads, though the tool can write. */
	readsOnly?(input: Record<string, unknown>): boolean;
	/** Replaces the row's one-line description of the input. */
	summary?(input: Record<string, unknown>, vaultPath: string): string;
	/** What a running call is doing. */
	progress(p: ProgressText): string;
}

/** Apollo's Obsidian tools (OBS-13). Keyed by `ToolName`, so adding a tool without an entry fails to compile. */
const VAULT_TOOLS: Record<ToolName, VaultToolEntry> = {
	vault_links: { label: "Links", kind: "inspect", progress: (p) => target("Reading links of", p.str("path")) },
	vault_outline: { label: "Outline", kind: "inspect", progress: (p) => target("Outlining", p.str("path")) },
	vault_frontmatter: {
		label: "Frontmatter",
		kind: "edit",
		changes: true,
		// With nothing to set or remove it only reads.
		readsOnly: (input) => !input.set && !(Array.isArray(input.remove) && input.remove.length),
		progress: (p) => target(p.kind === "inspect" ? "Reading properties of" : "Editing properties of", p.str("path")),
	},
	vault_tags: { label: "Tags", kind: "edit", changes: true, progress: (p) => target("Tagging", p.str("path")) },
	vault_query: { label: "Query", kind: "search", progress: () => "Querying notes" },
	vault_move: {
		label: "Move",
		kind: "move",
		changes: true,
		summary: (input, vaultPath) => `${shorten(String(input.from ?? ""), vaultPath, 55)} → ${shorten(String(input.to ?? ""), vaultPath, 55)}`,
		progress: (p) => target("Moving", p.str("from")),
	},
	vault_trash: { label: "Trash", kind: "trash", changes: true, progress: (p) => target("Trashing", p.str("path")) },
	workspace_context: { label: "Workspace", kind: "other", progress: () => "Checking open notes" },
	workspace_present: { label: "Show note", kind: "present", progress: (p) => target("Opening", p.str("path")) },
	dataview_query: { label: "Dataview", kind: "search", progress: () => "Running a Dataview query" },
	template_create: { label: "Template", kind: "edit", changes: true, progress: (p) => target("Creating", p.str("path")) },
	daily_note: { label: "Daily note", kind: "other", progress: () => "Finding the daily note" },
	bases_query: { label: "Bases", kind: "search", progress: () => "Querying bases" },
};

/** An Obsidian tool's entry, or undefined for any other tool. */
export function vaultTool(name: string): VaultToolEntry | undefined {
	if (!name.startsWith(VAULT_TOOL_PREFIX)) return undefined;
	const tool = name.slice(VAULT_TOOL_PREFIX.length);
	return Object.hasOwn(VAULT_TOOLS, tool) ? VAULT_TOOLS[tool as ToolName] : undefined;
}

/** What Claude is doing right now, for the progress line (RND-8). */
export interface Step {
	/** "Reading notes/a.md", without a trailing ellipsis. */
	label: string;
	since: number;
	kind: Kind | "thinking" | "text";
}

export const SUMMARY_LENGTH = 120;


/** The fields of a call that its summary reads. */
export interface CallSummary {
	kind: Kind;
	state: "pending" | "done" | "error" | "stopped";
	path: string | null;
}

/** "3 tools", or "" for none. Failures aren't counted: Claude usually just tries something else. */
export function callsCount(calls: readonly unknown[]): string {
	return calls.length ? plural(calls.length, "tool") : "";
}

const TOOL_KINDS: Record<string, Kind> = {
	Read: "read",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "edit",
	NotebookEdit: "edit",
	Grep: "search",
	Glob: "search",
	LS: "search",
	Bash: "command",
	BashOutput: "command",
	WebFetch: "fetch",
	WebSearch: "web",
	Agent: "agent",
	Task: "agent",
};

/** What a Claude Code tool does, by name. Anything unlisted is "other". */
export function toolKind(name: string): Kind {
	return Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name]! : "other";
}

export function filePath(input: Record<string, unknown>): string | null {
	const value = input.file_path ?? input.notebook_path;
	return typeof value === "string" && value ? value : null;
}

/** "Read 3 files, ran 2 commands": what a group did so far, after "Thought" if it also thought. */
export function summariseCalls(calls: readonly CallSummary[], thought = false): string {
	const count = (kind: Kind) => calls.filter((c) => c.kind === kind).length;
	// File tools count distinct files, so reading a note twice is still one file.
	const files = (kind: Kind) => new Set(calls.filter((c) => c.kind === kind).map((c, i) => c.path ?? i)).size;
	const parts: string[] = [];
	const add = (n: number, text: (n: number) => string) => n && parts.push(text(n));
	add(files("read"), (n) => `read ${plural(n, "file")}`);
	add(files("edit"), (n) => `edited ${plural(n, "file")}`);
	add(files("inspect"), (n) => `looked at ${plural(n, "note")}`);
	add(count("move"), (n) => `moved ${plural(n, "item")}`);
	add(count("trash"), (n) => `trashed ${plural(n, "item")}`);
	add(count("search"), (n) => plural(n, "search", "searches"));
	add(count("present"), (n) => `showed ${plural(n, "note")}`);
	add(count("command"), (n) => `ran ${plural(n, "command")}`);
	add(count("fetch"), (n) => `fetched ${plural(n, "page")}`);
	add(count("web"), (n) => plural(n, "web search", "web searches"));
	// An agent can run on long after its turn, so the summary says so rather than "ran".
	const agents = calls.filter((c) => c.kind === "agent");
	const running = agents.filter((c) => c.state === "pending").length;
	add(agents.length - running, (n) => `ran ${plural(n, "agent")}`);
	add(running, (n) => `running ${plural(n, "agent")}`);
	add(count("other"), (n) => `used ${plural(n, parts.length ? "other tool" : "tool", parts.length ? "other tools" : "tools")}`);
	if (thought) parts.unshift("thought");
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A getter for string fields of a tool's input, shortened for a progress line. */
export function inputText(input: Record<string, unknown>, vaultPath: string): (key: string) => string {
	return (key) => (typeof input[key] === "string" ? shorten(input[key] as string, vaultPath, 60) : "");
}

/** "Reading notes/a.md": what a running call is doing. */
export function progressText(kind: Kind, name: string, input: Record<string, unknown>, vaultPath: string): string {
	const str = inputText(input, vaultPath);
	switch (kind) {
		case "read":
			return target("Reading", str("file_path"));
		case "edit":
			return target(name === "Write" ? "Writing" : "Editing", str("file_path") || str("notebook_path"));
		case "search":
			return name === "Grep" ? target("Searching for", str("pattern")) : target("Finding", str("pattern") || str("path"));
		case "command":
			return target("Running", str("description") || str("command"));
		case "fetch":
			return target("Fetching", str("url"));
		case "web":
			return target("Searching the web for", str("query"));
		case "agent":
			return target("Running agent:", str("description"));
		default:
			return `Using ${name}`;
	}
}

/** One-line description of a tool call's input. */
export function toolSummary(input: Record<string, unknown>, vaultPath: string, max = SUMMARY_LENGTH): string {
	const value = ["file_path", "notebook_path", "path", "command", "pattern", "url", "query", "description", "skill"]
		.map((key) => input[key])
		.find((v): v is string => typeof v === "string");
	return value ? shorten(value, vaultPath, max) : "";
}

/** A value with the vault prefix dropped, on one line and at most `max` characters. */
export function shorten(value: string, vaultPath: string, max: number): string {
	const prefix = vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
	const text = (value.startsWith(prefix) ? value.slice(prefix.length) : value).replace(/\s*\n\s*/g, " ");
	return truncate(text, max);
}
