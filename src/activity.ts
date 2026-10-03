import { setIcon, setTooltip, type App } from "obsidian";
import { createReferenceEl, resolve } from "./references";

/** What a tool call does, for a group's summary and progress line. */
type Kind = "read" | "edit" | "search" | "command" | "fetch" | "web" | "agent" | "other";

type CallState = "pending" | "done" | "error" | "stopped";

interface Call {
	kind: Kind;
	state: CallState;
	row: HTMLElement;
	/** Vault-relative or absolute path for file tools. */
	path: string | null;
	/** "Reading notes/a.md", shown while the call runs. */
	progress: string;
}

const SUMMARY_LENGTH = 120;

/**
 * A run of consecutive tool calls, collapsed to one row (RND-2). The header
 * shows what is running now, or a summary once everything has finished.
 * Files read and edited stay visible as links below it; the individual calls
 * are listed when expanded.
 */
export class ActivityGroup {
	readonly el: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly filesEl: HTMLElement;
	private readonly callsEl: HTMLElement;
	private readonly calls = new Map<string, Call>();
	/** File links by path; `edited` wins over read when a file is both. */
	private readonly files = new Map<string, { el: HTMLElement; edited: boolean }>();

	constructor(
		parent: HTMLElement,
		private readonly app: App,
		private readonly vaultPath: string,
	) {
		this.el = parent.createDiv({ cls: "apollo-msg apollo-activity" });
		this.headerEl = this.el.createDiv({ cls: "apollo-activity-header", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
		setIcon(this.headerEl.createSpan({ cls: "apollo-activity-chevron" }), "chevron-right");
		this.statusEl = this.headerEl.createSpan({ cls: "apollo-activity-status" });
		this.labelEl = this.headerEl.createSpan({ cls: "apollo-activity-label" });
		this.countEl = this.headerEl.createSpan({ cls: "apollo-activity-count" });
		this.filesEl = this.el.createDiv({ cls: "apollo-activity-files" });
		this.callsEl = this.el.createDiv({ cls: "apollo-activity-calls" });
		this.headerEl.addEventListener("click", () => this.toggle());
		this.headerEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			this.toggle();
		});
	}

	get pending(): boolean {
		for (const call of this.calls.values()) if (call.state === "pending") return true;
		return false;
	}

	add(id: string, name: string, input: Record<string, unknown>): void {
		const kind = toolKind(name);
		const summary = toolSummary(input, this.vaultPath);
		const row = this.callsEl.createDiv({ cls: "apollo-tool" });
		row.createSpan({ cls: "apollo-tool-name", text: name });
		const path = filePath(input);
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
		this.calls.set(id, { kind, state: "pending", row, path, progress: progressText(kind, name, input, this.vaultPath) });
		if (path && (kind === "read" || kind === "edit")) this.addFile(path, kind === "edit");
		this.render();
	}

	finish(id: string, isError: boolean): void {
		const call = this.calls.get(id);
		if (!call || call.state !== "pending") return;
		call.state = isError ? "error" : "done";
		call.row.addClass(isError ? "is-error" : "is-done");
		this.render();
	}

	/** Marks calls that will never get a result (the turn ended or was stopped) as stopped. */
	settle(): void {
		if (!this.pending) return;
		for (const call of this.calls.values()) {
			if (call.state !== "pending") continue;
			call.state = "stopped";
			call.row.addClass("is-stopped");
		}
		this.render();
	}

	private toggle(): void {
		const open = !this.el.hasClass("is-open");
		this.el.toggleClass("is-open", open);
		this.headerEl.setAttr("aria-expanded", String(open));
	}

	private addFile(path: string, edited: boolean): void {
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
			el = createReferenceEl(this.filesEl, "", ref);
		} else {
			// Outside the vault, or deleted since: shown, but not a link.
			el = this.filesEl.createSpan();
			setTooltip(el, path);
		}
		el.addClass("apollo-activity-file");
		if (edited) el.addClass("is-edited");
		setIcon(el.createSpan({ cls: "apollo-ref-icon" }), edited ? "pencil" : "file-text");
		el.appendText(name);
		this.files.set(path, { el, edited });
	}

	private render(): void {
		const calls = [...this.calls.values()];
		const running = calls.filter((c) => c.state === "pending");
		const failed = calls.filter((c) => c.state === "error").length;
		const state = running.length ? "running" : failed ? "error" : calls.some((c) => c.state === "stopped") ? "stopped" : "done";
		this.el.dataset.state = state;
		// While running, the latest call still in progress; afterwards, what the group did.
		this.labelEl.setText(running.length ? `${running[running.length - 1]!.progress}…` : summarise(calls));
		const counts = [`${calls.length} ${calls.length === 1 ? "tool" : "tools"}`];
		if (failed) counts.push(`${failed} failed`);
		this.countEl.setText(counts.join(" · "));
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

/** "Read 3 files, ran 2 commands": what a finished group did. */
function summarise(calls: Call[]): string {
	const count = (kind: Kind) => calls.filter((c) => c.kind === kind).length;
	// File tools count distinct files, so reading a note twice is still one file.
	const files = (kind: Kind) => new Set(calls.filter((c) => c.kind === kind).map((c, i) => c.path ?? i)).size;
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const parts: string[] = [];
	const add = (n: number, text: (n: number) => string) => n && parts.push(text(n));
	add(files("read"), (n) => `read ${plural(n, "file", "files")}`);
	add(files("edit"), (n) => `edited ${plural(n, "file", "files")}`);
	add(count("search"), (n) => plural(n, "search", "searches"));
	add(count("command"), (n) => `ran ${plural(n, "command", "commands")}`);
	add(count("fetch"), (n) => `fetched ${plural(n, "page", "pages")}`);
	add(count("web"), (n) => plural(n, "web search", "web searches"));
	add(count("agent"), (n) => `ran ${plural(n, "agent", "agents")}`);
	add(count("other"), (n) => `used ${plural(n, parts.length ? "other tool" : "tool", parts.length ? "other tools" : "tools")}`);
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

/** One-line description of a tool call's input. */
export function toolSummary(input: Record<string, unknown>, vaultPath: string, max = SUMMARY_LENGTH): string {
	const value = ["file_path", "notebook_path", "command", "pattern", "url", "query", "description", "skill"]
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
