import type { CanUseTool, PermissionMode, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { MarkdownRenderer, type App, type Component } from "obsidian";
import { diffLines, withContext } from "./diff";

export interface PermissionRequest {
	toolName: string;
	input: Record<string, unknown>;
	options: Parameters<CanUseTool>[2];
	/** The chat was in Auto mode, so this call is one Auto mode did not approve on its own. */
	autoMode: boolean;
}

export interface CardContext {
	app: App;
	component: Component;
	vaultPath: string;
}

// Plain text only: escalation reasons may carry ANSI escapes.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (text: string) => text.replace(ANSI, "");

/**
 * Renders an inline approval card for a `canUseTool` request (PRM-T2) and
 * resolves with the user's decision. The card shrinks to a one-line summary
 * once answered, or when the request is cancelled (e.g. by Stop).
 */
export function showPermissionCard(parent: HTMLElement, ctx: CardContext, req: PermissionRequest): Promise<PermissionResult> {
	const card = parent.createDiv({ cls: "apollo-card" });
	const { toolName, input, options } = req;

	return new Promise<PermissionResult>((resolve) => {
		let settled = false;
		const finish = (result: PermissionResult, summary: string) => {
			if (settled) return;
			settled = true;
			options.signal.removeEventListener("abort", onAbort);
			card.empty();
			card.addClass("is-answered", result.behavior === "allow" ? "is-allowed" : "is-denied");
			card.createDiv({ cls: "apollo-card-summary", text: summary });
			resolve(result);
		};
		const onAbort = () => finish({ behavior: "deny", message: "Cancelled." }, `${label(req)}: cancelled`);
		options.signal.addEventListener("abort", onAbort);

		if (toolName === "AskUserQuestion") renderQuestions(card, ctx, req, finish);
		else if (toolName === "ExitPlanMode") renderPlan(card, ctx, req, finish);
		else renderToolRequest(card, ctx, req, finish);
	});
}

type Finish = (result: PermissionResult, summary: string) => void;

function label(req: PermissionRequest): string {
	return req.options.displayName || req.toolName;
}

function renderHeader(card: HTMLElement, req: PermissionRequest, fallbackTitle: string): void {
	const { options } = req;
	card.createDiv({ cls: "apollo-card-title", text: plain(options.title || fallbackTitle) });
	// Skip descriptions the body already shows: a file tool's path, or a command's description.
	const { file_path: path, description: inputDesc } = req.input;
	const shown = options.description && (options.description === inputDesc || (typeof path === "string" && path.endsWith(options.description)));
	if (options.description && !shown) card.createDiv({ cls: "apollo-card-desc", text: plain(options.description) });
	const rule = options.matchedAskRule;
	if (rule) {
		const ruleText = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
		card.createDiv({ cls: "apollo-card-reason", text: plain(`Your ask rule ${ruleText} (${rule.source}) requires approval.`) });
	} else if (req.autoMode) {
		const reason = options.decisionReason ? `: ${plain(options.decisionReason)}` : ".";
		// Either the classifier couldn't decide or a rule forced an ask; Claude Code doesn't say which.
		card.createDiv({ cls: "apollo-card-reason", text: `Auto mode needs your approval for this call${reason}` });
	} else if (options.decisionReason) {
		card.createDiv({ cls: "apollo-card-reason", text: plain(options.decisionReason) });
	}
	if (options.blockedPath) card.createDiv({ cls: "apollo-card-desc", text: `Path: ${options.blockedPath}` });
}

/** Allow once, allow for session, or deny with optional feedback. */
function renderToolRequest(card: HTMLElement, ctx: CardContext, req: PermissionRequest, finish: Finish): void {
	const { toolName, input, options } = req;
	renderHeader(card, req, `Claude wants to use ${toolName}`);
	void renderToolInput(card.createDiv({ cls: "apollo-card-body" }), ctx, toolName, input);

	const feedback = card.createEl("textarea", {
		cls: "apollo-card-feedback",
		attr: { rows: "1", placeholder: "Feedback for Claude if you deny (optional)" },
	});
	const actions = card.createDiv({ cls: "apollo-card-actions" });
	const name = label(req);

	const allowOnce = actions.createEl("button", { text: "Allow once" });
	allowOnce.onclick = () => finish({ behavior: "allow", updatedInput: input }, `${name}: allowed once`);

	// Session-scoped versions of Claude Code's own "don't ask again" rules.
	const sessionRules = (options.suggestions ?? []).map((s): PermissionUpdate => ({ ...s, destination: "session" }));
	if (sessionRules.length && !options.suppressAlwaysAllowRule) {
		// For edits Claude Code suggests switching to Accept edits rather than a rule; say so.
		const acceptsEdits = sessionRules.some((r) => r.type === "setMode" && r.mode === "acceptEdits");
		const allowSession = actions.createEl("button", { text: acceptsEdits ? "Allow all edits this session" : "Allow for session" });
		allowSession.onclick = () =>
			finish({ behavior: "allow", updatedInput: input, updatedPermissions: sessionRules }, `${name}: allowed for this session`);
	}

	const deny = actions.createEl("button", { text: "Deny", cls: "mod-warning" });
	deny.onclick = () => {
		const text = feedback.value.trim();
		// Like the CLI: a bare deny stops the turn; deny with feedback lets Claude continue with it.
		finish(
			text
				? { behavior: "deny", message: `The user denied this ${toolName} call and said: ${text}` }
				: { behavior: "deny", message: `The user denied this ${toolName} call.`, interrupt: true },
			text ? `${name}: denied with feedback` : `${name}: denied`,
		);
	};
	if (options.defaultToNo) deny.addClass("mod-cta");
	else allowOnce.addClass("mod-cta");
}

/** ExitPlanMode: show the plan and choose how to proceed. */
function renderPlan(card: HTMLElement, ctx: CardContext, req: PermissionRequest, finish: Finish): void {
	const { input } = req;
	card.addClass("apollo-card-plan");
	renderHeader(card, req, "Claude has a plan and wants to start");
	const plan = typeof input.plan === "string" ? input.plan : "";
	if (plan) {
		const body = card.createDiv({ cls: "apollo-card-body apollo-card-markdown" });
		void MarkdownRenderer.render(ctx.app, plan, body, "", ctx.component);
	}

	const feedback = card.createEl("textarea", {
		cls: "apollo-card-feedback",
		attr: { rows: "1", placeholder: "What should change in the plan? (for Keep planning)" },
	});
	const actions = card.createDiv({ cls: "apollo-card-actions" });
	const approve = (mode: PermissionMode, summary: string) =>
		finish(
			{ behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] },
			summary,
		);
	const auto = actions.createEl("button", { text: "Approve, accept edits", cls: "mod-cta" });
	auto.onclick = () => approve("acceptEdits", "Plan approved: accepting edits");
	const manual = actions.createEl("button", { text: "Approve, ask for edits" });
	manual.onclick = () => approve("default", "Plan approved: asking before edits");
	const keep = actions.createEl("button", { text: "Keep planning" });
	keep.onclick = () => {
		const text = feedback.value.trim();
		finish(
			{ behavior: "deny", message: text ? `The user wants to keep planning: ${text}` : "The user wants to keep planning." },
			"Kept planning",
		);
	};
}

interface Question {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string }[];
}

/** AskUserQuestion: collect answers and return them as the tool's input. */
function renderQuestions(card: HTMLElement, ctx: CardContext, req: PermissionRequest, finish: Finish): void {
	const questions = (req.input.questions as Question[] | undefined) ?? [];
	card.addClass("apollo-card-questions");
	card.createDiv({ cls: "apollo-card-title", text: "Claude has a question" });

	const readers = questions.map((q, qi) => {
		const block = card.createDiv({ cls: "apollo-question" });
		if (q.header) block.createSpan({ cls: "apollo-question-header", text: q.header });
		block.createDiv({ cls: "apollo-question-text", text: q.question });
		const name = `apollo-q-${Date.now()}-${qi}`;
		const inputs = q.options.map((opt) => {
			const row = block.createEl("label", { cls: "apollo-question-option" });
			const box = row.createEl("input", { attr: { type: q.multiSelect ? "checkbox" : "radio", name } });
			const text = row.createDiv();
			text.createDiv({ text: opt.label });
			if (opt.description) text.createDiv({ cls: "apollo-card-desc", text: opt.description });
			return { box, label: opt.label };
		});
		const other = block.createEl("input", { cls: "apollo-question-other", attr: { type: "text", placeholder: "Other…" } });
		return () => {
			const picked = inputs.filter((i) => i.box.checked).map((i) => i.label);
			if (other.value.trim()) picked.push(other.value.trim());
			return picked.join(", ");
		};
	});

	const actions = card.createDiv({ cls: "apollo-card-actions" });
	const submit = actions.createEl("button", { text: "Answer", cls: "mod-cta" });
	submit.onclick = () => {
		const answers: Record<string, string> = {};
		questions.forEach((q, qi) => (answers[q.question] = readers[qi]!()));
		const summary = Object.values(answers).filter(Boolean).join("; ") || "no answer";
		finish({ behavior: "allow", updatedInput: { ...req.input, answers } }, `Answered: ${summary}`);
	};
	const skip = actions.createEl("button", { text: "Skip" });
	skip.onclick = () => finish({ behavior: "deny", message: "The user declined to answer." }, "Question skipped");
}

/** Shows what a tool call will do: a command, a diff, or the raw input. */
async function renderToolInput(el: HTMLElement, ctx: CardContext, toolName: string, input: Record<string, unknown>): Promise<void> {
	const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	const filePath = str("file_path") ?? str("notebook_path");
	if (filePath) renderPath(el, ctx, filePath);

	switch (toolName) {
		case "Bash": {
			if (str("description")) el.createDiv({ cls: "apollo-card-desc", text: str("description") });
			el.createEl("pre", { cls: "apollo-card-code", text: str("command") ?? "" });
			return;
		}
		case "Edit": {
			const note = input.replace_all ? "Replaces every occurrence." : null;
			if (note) el.createDiv({ cls: "apollo-card-desc", text: note });
			renderDiff(el, str("old_string") ?? "", str("new_string") ?? "");
			return;
		}
		case "Write": {
			const before = filePath ? await readFile(filePath, "utf8").catch(() => null) : null;
			if (before === null) el.createDiv({ cls: "apollo-card-desc", text: "New file." });
			renderDiff(el, before ?? "", str("content") ?? "");
			return;
		}
		case "WebFetch":
		case "WebSearch":
			el.createDiv({ text: str("url") ?? str("query") ?? "" });
			if (str("prompt")) el.createDiv({ cls: "apollo-card-desc", text: str("prompt") });
			return;
		default: {
			const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "file_path" && k !== "notebook_path"));
			if (Object.keys(rest).length) el.createEl("pre", { cls: "apollo-card-code", text: JSON.stringify(rest, null, 2) });
		}
	}
}

/** Vault paths become links that open the file. */
function renderPath(el: HTMLElement, ctx: CardContext, absPath: string): void {
	const prefix = ctx.vaultPath.endsWith("/") ? ctx.vaultPath : `${ctx.vaultPath}/`;
	const rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : null;
	const file = rel ? ctx.app.vault.getFileByPath(rel) : null;
	const row = el.createDiv({ cls: "apollo-card-path" });
	if (file) {
		const link = row.createEl("a", { text: rel!, href: "#" });
		link.onclick = (evt) => {
			evt.preventDefault();
			void ctx.app.workspace.getLeaf("tab").openFile(file);
		};
	} else {
		row.setText(rel ?? absPath);
	}
}

const MAX_DIFF_LINES = 400;

function renderDiff(el: HTMLElement, before: string, after: string): void {
	const lines = withContext(diffLines(before, after));
	if (!lines.some(Boolean)) {
		el.createDiv({ cls: "apollo-card-desc", text: "No changes." });
		return;
	}
	const pre = el.createDiv({ cls: "apollo-diff" });
	for (const line of lines.slice(0, MAX_DIFF_LINES)) {
		if (!line) {
			pre.createDiv({ cls: "apollo-diff-gap", text: "⋯" });
			continue;
		}
		const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
		pre.createDiv({ cls: `apollo-diff-line is-${line.kind}`, text: `${sign} ${line.text}` });
	}
	if (lines.length > MAX_DIFF_LINES) pre.createDiv({ cls: "apollo-diff-gap", text: `${lines.length - MAX_DIFF_LINES} more lines` });
}
