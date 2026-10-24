import { setIcon, setTooltip, type App } from "obsidian";
import { plural } from "./format";
import { createToggleHeader, setOpen } from "./collapsible";
import { createReferenceEl, linkifyPaths, resolveReference } from "./references";
import { filePath, inputText, progressText, shorten, summariseCalls, toolKind, toolSummary, vaultTool, type CallSummary, type Kind, type Step } from "./tool-calls";
import type { WorkSection } from "./work";

export interface Call {
	kind: Kind;
	state: CallSummary["state"];
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

/**
 * The header a work section and an activity group share: a summary of the
 * calls, the files read and edited as links, and the structural changes
 * (OBS-13) with their paths as links.
 */
export class SummaryHeader {
	private readonly labelEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly files: FileLinks;
	private readonly changesEl: HTMLElement;

	constructor(
		el: HTMLElement,
		private readonly app: App,
		private readonly vaultPath: string,
	) {
		const header = createToggleHeader(el);
		this.labelEl = header.createSpan({ cls: "apollo-activity-label" });
		this.countEl = header.createSpan({ cls: "apollo-activity-count" });
		this.files = new FileLinks(el.createDiv({ cls: "apollo-activity-files" }), app, vaultPath);
		this.changesEl = el.createDiv({ cls: "apollo-activity-changes" });
	}

	addFile(path: string, edited: boolean): void {
		this.files.add(path, edited);
	}

	/** A before/after summary of a move, trash or property edit. */
	addChange(text: string): void {
		linkifyPaths(this.changesEl.createDiv({ cls: "apollo-activity-change", text }), this.app, this.vaultPath);
	}

	/** Shows what the calls did so far, after "Thought" if `thought`, and how many there are. Failures aren't counted: Claude usually just tries something else. */
	setCalls(calls: readonly (CallSummary)[], thought = false): void {
		this.labelEl.setText(summariseCalls(calls, thought));
		this.countEl.setText(calls.length ? plural(calls.length, "tool") : "");
	}
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
	private readonly summary: SummaryHeader;
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
		this.summary = new SummaryHeader(this.el, app, vaultPath);
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
			this.summary.addChange(output);
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
		this.summary.addFile(path, edited);
		this.section.addFile(path, edited);
	}

	private render(): void {
		const calls = this.calls;
		this.summary.setCalls(calls);
		this.section.update();
	}
}

