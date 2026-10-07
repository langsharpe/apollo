import type { SDKAPIRetryMessage } from "@anthropic-ai/claude-agent-sdk";
import { setIcon, type Component } from "obsidian";
import { formatDuration, type Step } from "./activity";
import type { AgentTask } from "./tasks";

/** What the progress line reports on, read fresh on every refresh. */
export interface ProgressSource {
	/** What the turn is waiting on now, or null between steps. */
	step(): Step | null;
	/** Subagents still running. */
	tasks(): AgentTask[];
	/** A permission card or question is waiting for the user. */
	awaiting(): boolean;
}

type Phase = "starting" | "compacting" | "stopping";

/*
 * Thresholds are defaults to tune, not research results (docs/progress.md).
 * The quiet budgets depend on what Claude is doing: a test run can go minutes
 * without output, a model response rarely goes 45 seconds without a token.
 */
const SHOW_ELAPSED_AFTER = 10_000;
const AGENT_QUIET_AFTER = 180_000;
const MAX_AGENT_ROWS = 3;

function quietAfter(kind: Step["kind"] | undefined): number {
	switch (kind) {
		case "command":
		case "agent":
			return 180_000;
		case "fetch":
		case "web":
		case "other":
			return 60_000;
		default:
			return 45_000;
	}
}

const RETRY_REASONS: Partial<Record<SDKAPIRetryMessage["error"], string>> = {
	overloaded: "the API is overloaded",
	rate_limit: "rate limited",
	server_error: "server error",
};

/**
 * The status row at the end of the transcript (RND-8), and the only place
 * that says what Claude is doing now: the rows above it are a record. It
 * answers two questions: does Claude need you, and is it alive. The label is
 * the current step in plain words, with how long it has run once that's
 * more than a few seconds; the turn's elapsed time sits on the right.
 * Liveness comes from Claude Code's own events, not from the model saying
 * it's busy: when they stop for longer than the step allows, the row says so
 * in words and colour and the spinner stops. Failed tool calls don't count
 * against it, since Claude usually just tries something else. Subagents get
 * a row each, and keep the status up after the turn that started them ends
 * (RND-9).
 */
export class ProgressLine {
	private readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly warningEl: HTMLElement;
	private readonly elapsedEl: HTMLElement;
	private readonly agentsEl: HTMLElement;
	/** The agent rows last rendered, to skip rebuilding them when nothing changed. */
	private agentsKey = "";

	private turnStarted: number | null = null;
	private lastEvent = 0;
	private phase: Phase | null = null;
	private retry: { text: string } | null = null;

	constructor(
		parent: HTMLElement,
		component: Component,
		private readonly source: ProgressSource,
	) {
		this.el = parent.createDiv({ cls: "apollo-working" });
		const main = this.el.createDiv({ cls: "apollo-working-main" });
		main.createDiv({ cls: "apollo-working-spinner" });
		this.labelEl = main.createSpan({ cls: "apollo-working-label" });
		this.warningEl = main.createSpan({ cls: "apollo-working-warning" });
		this.elapsedEl = main.createSpan({ cls: "apollo-working-elapsed" });
		this.agentsEl = this.el.createDiv({ cls: "apollo-working-agents" });
		// Elapsed times and quiet spells change without any event.
		component.registerInterval(window.setInterval(() => this.refresh(), 1000));
	}

	/** A turn is running: from send, or from a turn Claude Code started itself, until its result. */
	get inTurn(): boolean {
		return this.turnStarted !== null;
	}

	begin(phase: Phase | null = null): void {
		this.turnStarted = this.lastEvent = Date.now();
		this.phase = phase;
		this.retry = null;
		this.refresh();
	}

	/** The turn's result arrived. Agents may still be running. */
	end(): void {
		this.turnStarted = null;
		this.retry = null;
		if (this.phase !== "stopping") this.phase = null;
		this.refresh();
	}

	/** Nothing is running any more. */
	idle(): void {
		this.turnStarted = null;
		this.phase = null;
		this.retry = null;
		this.refresh();
	}

	/** Claude Code sent something, from the main thread or a subagent. */
	heartbeat(): void {
		this.lastEvent = Date.now();
	}

	setPhase(phase: Phase | null): void {
		// Stopping holds until the turn ends.
		if (this.phase === "stopping" && phase !== null) return;
		this.phase = phase;
		this.refresh();
	}

	/** An API request failed and will be retried; null once output flows again. */
	setRetry(msg: SDKAPIRetryMessage | null): void {
		if (!msg && !this.retry) return;
		this.retry = msg ? { text: `Retrying: ${RETRY_REASONS[msg.error] ?? (msg.error_status ? `API error ${msg.error_status}` : "connection error")} (attempt ${msg.attempt} of ${msg.max_retries})` } : null;
		this.refresh();
	}

	refresh(): void {
		const tasks = this.source.tasks();
		if (!this.inTurn && !tasks.length && !this.phase) return;
		const now = Date.now();
		const step = this.inTurn ? this.source.step() : null;
		let state: "ok" | "awaiting" | "warning" = "ok";
		let label: string;
		let warning = "";
		if (this.phase === "stopping") label = "Stopping…";
		else if (this.source.awaiting()) {
			label = "Waiting for your answer";
			state = "awaiting";
		} else if (this.phase === "starting") label = "Starting Claude Code…";
		else if (this.retry) {
			label = this.retry.text;
			state = "warning";
		} else if (this.phase === "compacting") label = "Compacting the conversation…";
		else if (this.inTurn) {
			label = step?.label ?? "Working…";
			if (step && now - step.since >= SHOW_ELAPSED_AFTER) label += ` for ${formatDuration(now - step.since)}`;
		} else label = `Waiting on ${tasks.length === 1 ? "an agent" : `${tasks.length} agents`}`;

		// Silent: nothing from Claude Code for longer than this step allows.
		const quiet = now - this.lastEvent;
		if (this.inTurn && state === "ok" && quiet >= quietAfter(step?.kind)) {
			warning = `No activity for ${formatDuration(quiet)}`;
			state = "warning";
		}

		if (this.el.dataset.state !== state) this.el.dataset.state = state;
		setText(this.labelEl, label);
		setText(this.warningEl, warning);
		const elapsed = this.turnStarted !== null ? now - this.turnStarted : 0;
		setText(this.elapsedEl, elapsed >= SHOW_ELAPSED_AFTER ? formatDuration(elapsed) : "");
		this.renderAgents(tasks, now);
	}

	private renderAgents(tasks: AgentTask[], now: number): void {
		const rows = tasks.slice(0, MAX_AGENT_ROWS).map((t) => {
			const quiet = now - t.lastEvent >= AGENT_QUIET_AFTER;
			const meta = quiet
				? `No activity for ${formatDuration(now - t.lastEvent)}`
				: [t.toolUses ? `${t.toolUses} ${t.toolUses === 1 ? "tool" : "tools"}` : "", formatDuration(now - t.started)].filter(Boolean).join(" · ");
			return { name: t.description || "Agent", activity: t.activity, meta, quiet };
		});
		const more = tasks.length - rows.length;
		const key = JSON.stringify([rows, more]);
		if (key === this.agentsKey) return;
		this.agentsKey = key;
		this.agentsEl.empty();
		for (const row of rows) {
			const el = this.agentsEl.createDiv({ cls: "apollo-working-agent" });
			el.toggleClass("is-quiet", row.quiet);
			setIcon(el.createSpan({ cls: "apollo-working-agent-icon" }), "bot");
			el.createSpan({ cls: "apollo-working-agent-name", text: row.name });
			el.createSpan({ cls: "apollo-working-agent-activity", text: row.activity });
			el.createSpan({ cls: "apollo-working-agent-meta", text: row.meta });
		}
		if (more > 0) this.agentsEl.createDiv({ cls: "apollo-working-agent is-more", text: `and ${more} more ${more === 1 ? "agent" : "agents"}` });
	}
}

/** Refreshes run on most events, so only touch the DOM when the text changes. */
function setText(el: HTMLElement, text: string): void {
	if (el.textContent !== text) el.setText(text);
}
