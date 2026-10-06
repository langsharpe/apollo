import { setIcon, setTooltip, type App } from "obsidian";
import { createReferenceEl, linkifyPaths, resolve } from "./references";
import { VAULT_TOOL_PREFIX } from "./vault-tools";
import type { WorkSection } from "./work";

/** What a tool call does, for a group's summary and progress line. */
type Kind = "read" | "inspect" | "edit" | "move" | "trash" | "search" | "present" | "command" | "fetch" | "web" | "agent" | "other";

/** Apollo's Obsidian tools (OBS-13): the row's name, and whether a result describes a change to show. */
const VAULT_TOOLS: Record<string, { label: string; kind: Kind; changes?: boolean }> = {
	vault_links: { label: "Links", kind: "inspect" },
	vault_outline: { label: "Outline", kind: "inspect" },
	vault_frontmatter: { label: "Frontmatter", kind: "edit", changes: true },
	vault_tags: { label: "Tags", kind: "edit", changes: true },
	vault_query: { label: "Query", kind: "search" },
	vault_move: { label: "Move", kind: "move", changes: true },
	vault_trash: { label: "Trash", kind: "trash", changes: true },
	workspace_context: { label: "Workspace", kind: "other" },
	workspace_present: { label: "Show note", kind: "present" },
	dataview_query: { label: "Dataview", kind: "search" },
	template_create: { label: "Template", kind: "edit", changes: true },
	daily_note: { label: "Daily note", kind: "other" },
	bases_query: { label: "Bases", kind: "search" },
};

/** An Obsidian tool's entry, or undefined for any other tool. */
function vaultTool(name: string): (typeof VAULT_TOOLS)[string] | undefined {
	return name.startsWith(VAULT_TOOL_PREFIX) ? VAULT_TOOLS[name.slice(VAULT_TOOL_PREFIX.length)] : undefined;
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
}

const SUMMARY_LENGTH = 120;

/** A row header that expands and collapses `el` (its `is-open` class) on click, Enter or Space. */
export function createToggleHeader(el: HTMLElement): HTMLElement {
	const header = el.createDiv({ cls: "apollo-activity-header", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
	setIcon(header.createSpan({ cls: "apollo-activity-chevron" }), "chevron-right");
	const toggle = () => {
		const open = !el.hasClass("is-open");
		el.toggleClass("is-open", open);
		header.setAttr("aria-expanded", String(open));
	};
	header.addEventListener("click", toggle);
	header.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault();
		toggle();
	});
	return header;
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
		const ref = resolve(path, this.app, this.vaultPath);
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

/** "running", "error", "stopped" or "done", for a status dot. */
export function callsState(calls: Call[]): string {
	if (calls.some((c) => c.state === "pending")) return "running";
	if (calls.some((c) => c.state === "error")) return "error";
	return calls.some((c) => c.state === "stopped") ? "stopped" : "done";
}

/** "3 tools · 1 failed", or "" for none. */
export function callsCount(calls: Call[]): string {
	if (!calls.length) return "";
	const counts = [`${calls.length} ${calls.length === 1 ? "tool" : "tools"}`];
	const failed = calls.filter((c) => c.state === "error").length;
	if (failed) counts.push(`${failed} failed`);
	return counts.join(" · ");
}

/**
 * A run of consecutive tool calls, collapsed to one row (RND-2). The header
 * shows what is running now, or a summary once everything has finished.
 * Files read and edited stay visible as links below it; the individual calls
 * are listed when expanded.
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
		header.createSpan({ cls: "apollo-activity-status" });
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

	/** What the latest call still running is doing, or null when none is. */
	get progress(): string | null {
		const running = this.calls.filter((c) => c.state === "pending");
		return running.length ? `${running[running.length - 1]!.progress}…` : null;
	}

	add(id: string, name: string, input: Record<string, unknown>): void {
		const vault = vaultTool(name);
		// vault_frontmatter with nothing to set or remove only reads.
		const readsOnly = vault?.label === "Frontmatter" && !input.set && !(Array.isArray(input.remove) && input.remove.length);
		const kind = readsOnly ? "inspect" : (vault?.kind ?? toolKind(name));
		const summary = vault?.kind === "move" ? `${shorten(String(input.from ?? ""), this.vaultPath, 55)} → ${shorten(String(input.to ?? ""), this.vaultPath, 55)}` : toolSummary(input, this.vaultPath);
		const row = this.callsEl.createDiv({ cls: "apollo-tool" });
		row.createSpan({ cls: "apollo-tool-name", text: vault?.label ?? name });
		const path = vault ? this.existingPath(input.path) : filePath(input);
		if (summary) {
			// File tools' paths open the file (CTX-10).
			const ref = resolve(summary, this.app, this.vaultPath);
			if (ref) createReferenceEl(row, summary, ref).addClass("apollo-tool-summary");
			else {
				const el = row.createSpan({ cls: "apollo-tool-summary", text: summary });
				const full = toolSummary(input, this.vaultPath, Infinity);
				if (full !== summary) setTooltip(el, full);
			}
		}
		const progress = vault ? vaultProgress(name.slice(VAULT_TOOL_PREFIX.length), kind, input, this.vaultPath) : progressText(kind, name, input, this.vaultPath);
		this.callsById.set(id, { kind, state: "pending", row, path, progress, changes: !readsOnly && !!vault?.changes, vault: !!vault });
		if (path && (kind === "read" || kind === "inspect" || kind === "edit")) this.addFile(path, kind === "edit");
		this.render();
	}

	/** Marks a call done or failed. `output` is the result's text. */
	finish(id: string, isError: boolean, output = ""): void {
		const call = this.callsById.get(id);
		if (!call || call.state !== "pending") return;
		call.state = isError ? "error" : "done";
		call.row.addClass(isError ? "is-error" : "is-done");
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

	/** Marks calls that will never get a result (the turn ended or was stopped) as stopped. */
	settle(): void {
		if (!this.pending) return;
		for (const call of this.callsById.values()) {
			if (call.state !== "pending") continue;
			call.state = "stopped";
			call.row.addClass("is-stopped");
		}
		this.render();
	}

	/** A path argument, if it names a file in the vault right now. */
	private existingPath(value: unknown): string | null {
		return typeof value === "string" && value && resolve(value, this.app, this.vaultPath) ? value : null;
	}

	private addFile(path: string, edited: boolean): void {
		this.files.add(path, edited);
		this.section.addFile(path, edited);
	}

	private render(): void {
		const calls = this.calls;
		this.el.dataset.state = callsState(calls);
		// While running, the latest call still in progress; afterwards, what the group did.
		this.labelEl.setText(this.progress ?? summarise(calls));
		this.countEl.setText(callsCount(calls));
		this.section.update();
	}
}

function toolKind(name: string): Kind {
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

function filePath(input: Record<string, unknown>): string | null {
	const value = input.file_path ?? input.notebook_path;
	return typeof value === "string" && value ? value : null;
}

/** "Read 3 files, ran 2 commands": what a finished group did, after "Thought" if it also thought. */
export function summarise(calls: Call[], thought = false): string {
	const count = (kind: Kind) => calls.filter((c) => c.kind === kind).length;
	// File tools count distinct files, so reading a note twice is still one file.
	const files = (kind: Kind) => new Set(calls.filter((c) => c.kind === kind).map((c, i) => c.path ?? i)).size;
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const parts: string[] = [];
	const add = (n: number, text: (n: number) => string) => n && parts.push(text(n));
	add(files("read"), (n) => `read ${plural(n, "file", "files")}`);
	add(files("edit"), (n) => `edited ${plural(n, "file", "files")}`);
	add(files("inspect"), (n) => `looked at ${plural(n, "note", "notes")}`);
	add(count("move"), (n) => `moved ${plural(n, "item", "items")}`);
	add(count("trash"), (n) => `trashed ${plural(n, "item", "items")}`);
	add(count("search"), (n) => plural(n, "search", "searches"));
	add(count("present"), (n) => `showed ${plural(n, "note", "notes")}`);
	add(count("command"), (n) => `ran ${plural(n, "command", "commands")}`);
	add(count("fetch"), (n) => `fetched ${plural(n, "page", "pages")}`);
	add(count("web"), (n) => plural(n, "web search", "web searches"));
	add(count("agent"), (n) => `ran ${plural(n, "agent", "agents")}`);
	add(count("other"), (n) => `used ${plural(n, parts.length ? "other tool" : "tool", parts.length ? "other tools" : "tools")}`);
	if (thought) parts.unshift("thought");
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Reading notes/a.md": what a running call is doing. */
function progressText(kind: Kind, name: string, input: Record<string, unknown>, vaultPath: string): string {
	const str = (key: string) => (typeof input[key] === "string" ? shorten(input[key] as string, vaultPath, 60) : "");
	const target = (verb: string, value: string) => (value ? `${verb} ${value}` : verb);
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

/** "Moving notes/a.md": what a running Obsidian tool call is doing. */
function vaultProgress(tool: string, kind: Kind, input: Record<string, unknown>, vaultPath: string): string {
	const str = (key: string) => (typeof input[key] === "string" ? shorten(input[key] as string, vaultPath, 60) : "");
	const target = (verb: string, value: string) => (value ? `${verb} ${value}` : verb);
	switch (tool) {
		case "vault_links":
			return target("Reading links of", str("path"));
		case "vault_outline":
			return target("Outlining", str("path"));
		case "vault_frontmatter":
			return target(kind === "inspect" ? "Reading properties of" : "Editing properties of", str("path"));
		case "vault_tags":
			return target("Tagging", str("path"));
		case "vault_query":
			return "Querying notes";
		case "vault_move":
			return target("Moving", str("from"));
		case "vault_trash":
			return target("Trashing", str("path"));
		case "workspace_context":
			return "Checking open notes";
		case "workspace_present":
			return target("Opening", str("path"));
		case "dataview_query":
			return "Running a Dataview query";
		case "template_create":
			return target("Creating", str("path"));
		case "daily_note":
			return "Finding the daily note";
		case "bases_query":
			return "Querying bases";
		default:
			return `Using ${tool}`;
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
function shorten(value: string, vaultPath: string, max: number): string {
	const prefix = vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
	const text = (value.startsWith(prefix) ? value.slice(prefix.length) : value).replace(/\s*\n\s*/g, " ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
