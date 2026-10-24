import { setIcon, setTooltip, type App } from "obsidian";
import { plural, truncate } from "./format";
import { createReferenceEl, linkifyPaths, resolveReference } from "./references";
import { VAULT_TOOL_PREFIX, type ToolName } from "./vault-tools";
import type { WorkSection } from "./work";

/** What a tool call does, for a group's summary and progress line. */
type Kind = "read" | "inspect" | "edit" | "move" | "trash" | "search" | "present" | "command" | "fetch" | "web" | "agent" | "other";

/** What an entry needs to word a progress line: the call's kind and its shortened input fields. */
type ProgressText = { kind: Kind; str(key: string): string };

/** "Moving notes/a.md": a verb, then its target if there is one. */
function target(verb: string, value: string): string {
	return value ? `${verb} ${value}` : verb;
}

interface VaultToolEntry {
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
function vaultTool(name: string): VaultToolEntry | undefined {
	if (!name.startsWith(VAULT_TOOL_PREFIX)) return undefined;
	const tool = name.slice(VAULT_TOOL_PREFIX.length);
	return Object.hasOwn(VAULT_TOOLS, tool) ? VAULT_TOOLS[tool as ToolName] : undefined;
}

type CallState = "pending" | "done" | "error" | "stopped";

export interface Call {
	kind: Kind;
	state: CallState;
	row: HTMLElement;
	/** Vault-relative or absolute path for file tools. */
	path: string | null;
	/** "Reading notes/a.md", shown while the call runs. */
	progress: string;
	/** The result describes a change (move, trash, property edit) to show under the group. */
	changes: boolean;
	/** One of Apollo's Obsidian tools, whose errors are short sentences worth showing. */
	vault: boolean;
	/** When the call started, for how long it has been running. */
	started: number;
	/** An agent that runs on in the background after its call returns; it ends when the agent does (RND-9). */
	background: boolean;
	/** An agent's progress or totals, after the summary. */
	detailEl: HTMLElement | null;
}

/** What Claude is doing right now, for the progress line (RND-8). */
export interface Step {
	/** "Reading notes/a.md", without a trailing ellipsis. */
	label: string;
	since: number;
	kind: Kind | "thinking" | "text";
}

const SUMMARY_LENGTH = 120;

/** A row header that expands and collapses `el` (its `is-open` class) on click, Enter or Space. */
export function createToggleHeader(el: HTMLElement): HTMLElement {
	const header = el.createDiv({ cls: "apollo-activity-header", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
	setIcon(header.createSpan({ cls: "apollo-activity-chevron" }), "chevron-right");
	const toggle = () => setOpen(el, !el.hasClass("is-open"));
	header.addEventListener("click", toggle);
	header.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault();
		toggle();
	});
	return header;
}

/** Expands or collapses a row made with `createToggleHeader`. */
export function setOpen(el: HTMLElement, open: boolean): void {
	el.toggleClass("is-open", open);
	el.querySelector(":scope > .apollo-activity-header")?.setAttr("aria-expanded", String(open));
}

/** Links to the files read and edited, one per file; an edit wins over a read. */
export class FileLinks {
	private readonly files = new Map<string, { el: HTMLElement; edited: boolean }>();

	constructor(
		private readonly el: HTMLElement,
		private readonly app: App,
		private readonly vaultPath: string,
	) {}

	add(path: string, edited: boolean): void {
		const existing = this.files.get(path);
		if (existing) {
			if (edited && !existing.edited) {
				existing.edited = true;
				existing.el.addClass("is-edited");
				setIcon(existing.el.querySelector<HTMLElement>(".apollo-ref-icon")!, "pencil");
			}
			return;
		}
		const name = path.split("/").pop() || path;
		const ref = resolveReference(path, this.app, this.vaultPath);
		let el: HTMLElement;
		if (ref) {
			el = createReferenceEl(this.el, "", ref);
		} else {
			// Outside the vault, or deleted since: shown, but not a link.
			el = this.el.createSpan();
			setTooltip(el, path);
		}
		el.addClass("apollo-activity-file");
		if (edited) el.addClass("is-edited");
		setIcon(el.createSpan({ cls: "apollo-ref-icon" }), edited ? "pencil" : "file-text");
		el.appendText(name);
		this.files.set(path, { el, edited });
	}
}

/** A before/after summary of a move, trash or property edit (OBS-13), with its paths as links. */
export function addChange(parent: HTMLElement, text: string, app: App, vaultPath: string): void {
	linkifyPaths(parent.createDiv({ cls: "apollo-activity-change", text }), app, vaultPath);
}

/** "3 tools", or "" for none. Failures aren't counted: Claude usually just tries something else. */
export function callsCount(calls: Call[]): string {
	return calls.length ? plural(calls.length, "tool") : "";
}

/**
 * A run of consecutive tool calls, collapsed to one row (RND-2). The header
 * is a summary of what the calls did so far; what is running now shows in
 * the status row at the end of the transcript (RND-8). Files read and edited
 * stay visible as links below it; the individual calls are listed when
 * expanded.
 */
export class ActivityGroup {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly files: FileLinks;
	private readonly changesEl: HTMLElement;
	private readonly callsEl: HTMLElement;
	private readonly callsById = new Map<string, Call>();

	constructor(
		parent: HTMLElement,
		private readonly app: App,
		private readonly vaultPath: string,
		/** The section the group sits in, which shows its progress, files and changes while collapsed. */
		private readonly section: WorkSection,
	) {
		this.el = parent.createDiv({ cls: "apollo-msg apollo-activity" });
		const header = createToggleHeader(this.el);
		this.labelEl = header.createSpan({ cls: "apollo-activity-label" });
		this.countEl = header.createSpan({ cls: "apollo-activity-count" });
		this.files = new FileLinks(this.el.createDiv({ cls: "apollo-activity-files" }), app, vaultPath);
		this.changesEl = this.el.createDiv({ cls: "apollo-activity-changes" });
		this.callsEl = this.el.createDiv({ cls: "apollo-activity-calls" });
	}

	get calls(): Call[] {
		return [...this.callsById.values()];
	}

	get pending(): boolean {
		return this.calls.some((c) => c.state === "pending");
	}

	/** The latest call the turn is waiting on, or null. Background agents don't hold up the turn. */
	current(): Step | null {
		const call = this.calls.filter((c) => c.state === "pending" && !c.background).pop();
		return call ? { label: call.progress, since: call.started, kind: call.kind } : null;
	}

	add(id: string, name: string, input: Record<string, unknown>): void {
		const vault = vaultTool(name);
		const readsOnly = vault?.readsOnly?.(input) ?? false;
		const kind = readsOnly ? "inspect" : (vault?.kind ?? toolKind(name));
		const summary = vault?.summary?.(input, this.vaultPath) ?? toolSummary(input, this.vaultPath);
		const row = this.callsEl.createDiv({ cls: "apollo-tool" });
		row.createSpan({ cls: "apollo-tool-name", text: vault?.label ?? name });
		const path = vault ? this.existingPath(input.path) : filePath(input);
		if (summary) {
			// File tools' paths open the file (CTX-10).
			const ref = resolveReference(summary, this.app, this.vaultPath);
			if (ref) createReferenceEl(row, summary, ref).addClass("apollo-tool-summary");
			else {
				const el = row.createSpan({ cls: "apollo-tool-summary", text: summary });
				const full = toolSummary(input, this.vaultPath, Infinity);
				if (full !== summary) setTooltip(el, full);
			}
		}
		const progress = vault ? vault.progress({ kind, str: inputText(input, this.vaultPath) }) : progressText(kind, name, input, this.vaultPath);
		this.callsById.set(id, { kind, state: "pending", row, path, progress, changes: !readsOnly && !!vault?.changes, vault: !!vault, started: Date.now(), background: false, detailEl: null });
		if (path && (kind === "read" || kind === "inspect" || kind === "edit")) this.addFile(path, kind === "edit");
		this.render();
	}

	/** Marks a call done or failed. `output` is the result's text. */
	finish(id: string, isError: boolean, output = ""): void {
		const call = this.callsById.get(id);
		if (!call || call.state !== "pending") return;
		this.end(call, isError ? "error" : "done");
		// Structural changes stay in view as a before/after summary (OBS-13).
		if (call.changes && !isError && output && !output.startsWith("No changes")) {
			addChange(this.changesEl, output, this.app, this.vaultPath);
			this.section.addChange(output);
		}
		// Obsidian tools say why they failed in a sentence; show it with the call.
		if (isError && output && call.vault) {
			call.row.createDiv({ cls: "apollo-tool-output", text: shorten(output, this.vaultPath, 300) });
		}
		this.render();
	}

	/** An agent call returned because the agent went to the background. It stays running until the agent ends. */
	background(id: string): void {
		const call = this.callsById.get(id);
		if (call?.state === "pending") call.background = true;
	}

	/** An agent's latest step, for the status row, and its tool count, from Claude Code's task progress (RND-9). */
	agentProgress(id: string, activity: string, toolUses: number, description: string): void {
		const call = this.callsById.get(id);
		// Between tool calls Claude Code repeats the task's description, which says nothing new.
		if (!call || call.state !== "pending" || !activity || activity === description) return;
		call.progress = `Agent: ${activity}`;
		if (toolUses) this.setDetail(call, plural(toolUses, "tool"));
	}

	/** An agent finished, failed or was stopped. `detail` is its totals: "5 tools · 30s". */
	endAgent(id: string, state: "done" | "error" | "stopped", detail: string): void {
		const call = this.callsById.get(id);
		if (!call) return;
		// A foreground agent's call has already finished with its result.
		if (call.state === "pending") this.end(call, state);
		this.setDetail(call, detail);
		this.render();
	}

	/** Files a subagent edits, listed with its call: what changed is worth seeing, what it read mostly isn't. */
	addAgentEdit(path: string): void {
		this.addFile(path, true);
	}

	/** Marks calls that will never get a result (the turn ended or was stopped) as stopped. Background agents carry on unless `all`. */
	settle(all = false): void {
		if (!this.pending) return;
		for (const call of this.callsById.values()) {
			if (call.state === "pending" && (all || !call.background)) this.end(call, "stopped");
		}
		this.render();
	}

	private end(call: Call, state: "done" | "error" | "stopped"): void {
		call.state = state;
		call.row.addClass(`is-${state}`);
	}

	private setDetail(call: Call, text: string): void {
		if (!text) return;
		call.detailEl ??= call.row.createSpan({ cls: "apollo-tool-detail" });
		call.detailEl.setText(text);
	}

	/** A path argument, if it names a file in the vault right now. */
	private existingPath(value: unknown): string | null {
		return typeof value === "string" && value && resolveReference(value, this.app, this.vaultPath) ? value : null;
	}

	private addFile(path: string, edited: boolean): void {
		this.files.add(path, edited);
		this.section.addFile(path, edited);
	}

	private render(): void {
		const calls = this.calls;
		this.labelEl.setText(summariseCalls(calls));
		this.countEl.setText(callsCount(calls));
		this.section.update();
	}
}

export function toolKind(name: string): Kind {
	switch (name) {
		case "Read":
			return "read";
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return "edit";
		case "Grep":
		case "Glob":
		case "LS":
			return "search";
		case "Bash":
		case "BashOutput":
			return "command";
		case "WebFetch":
			return "fetch";
		case "WebSearch":
			return "web";
		case "Agent":
		case "Task":
			return "agent";
		default:
			return "other";
	}
}

export function filePath(input: Record<string, unknown>): string | null {
	const value = input.file_path ?? input.notebook_path;
	return typeof value === "string" && value ? value : null;
}

/** "Read 3 files, ran 2 commands": what a group did so far, after "Thought" if it also thought. */
export function summariseCalls(calls: Call[], thought = false): string {
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
function inputText(input: Record<string, unknown>, vaultPath: string): (key: string) => string {
	return (key) => (typeof input[key] === "string" ? shorten(input[key] as string, vaultPath, 60) : "");
}

/** "Reading notes/a.md": what a running call is doing. */
function progressText(kind: Kind, name: string, input: Record<string, unknown>, vaultPath: string): string {
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
function toolSummary(input: Record<string, unknown>, vaultPath: string, max = SUMMARY_LENGTH): string {
	const value = ["file_path", "notebook_path", "path", "command", "pattern", "url", "query", "description", "skill"]
		.map((key) => input[key])
		.find((v): v is string => typeof v === "string");
	return value ? shorten(value, vaultPath, max) : "";
}

/** A value with the vault prefix dropped, on one line and at most `max` characters. */
function shorten(value: string, vaultPath: string, max: number): string {
	const prefix = vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
	const text = (value.startsWith(prefix) ? value.slice(prefix.length) : value).replace(/\s*\n\s*/g, " ");
	return truncate(text, max);
}
