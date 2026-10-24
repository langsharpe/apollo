import type { SDKAssistantMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Keymap, MarkdownRenderer, Notice, setIcon, setTooltip, type App, type Component, type WorkspaceLeaf } from "obsidian";
import type { ActivityGroup } from "./activity";
import type ApolloPlugin from "./main";
import { MarkdownStream } from "./markdown-stream";
import type { Presenter } from "./presenter";
import { linkifyPaths, openReference, renderWithReferences, vaultRelative } from "./references";
import type { AgentTasks } from "./tasks";
import type { ThinkingBlock } from "./thinking";
import { filePath, toolKind, type Step } from "./tool-calls";
import { contentBlocks, displayPrompt, INTERRUPTED, resultText, taskNotification } from "./transcript-history";
import { WorkSection } from "./work";

/** What an Agent call returns when the agent goes to the background. */
const BACKGROUND_AGENT = "Async agent launched";

/** What the transcript needs from the view that owns it. */
export interface TranscriptHost {
	app: App;
	plugin: ApolloPlugin;
	/** The view: owns the transcript's DOM events and Markdown render lifetimes. */
	component: Component;
	leaf: WorkspaceLeaf;
	presenter: Presenter;
	tasks(): AgentTasks;
	/** Thinking and tool calls are showing in this chat. */
	showWork(): boolean;
	/** A message's brain icon was clicked: show or hide thinking and tool calls, keeping `anchor` in place. */
	toggleWork(anchor: HTMLElement): void;
	/** A message's fork action was clicked (HIST-3a). */
	fork(uuid: string, role: "user" | "assistant"): void;
}

/**
 * Everything rendered into the transcript, with the state that follows a turn
 * as it streams in: the reply being written, the thinking block, the runs of
 * work, and the tool calls waiting for results. The live message handler and
 * history replay drive the same object. It only renders; the view decides
 * what the session's messages mean.
 */
export class Transcript {
	/** Streaming state for the current text block. */
	private textStream: MarkdownStream | null = null;
	private textStarted = 0;
	/** The thinking block streaming now, if any. */
	private thinking: ThinkingBlock | null = null;
	/** Streamed text blocks waiting for their message UUID, which arrives with the assistant message. */
	private textAwaitingUuid: HTMLElement[] = [];
	/** Marks a tool call done or failed, by tool_use id, with the result's text. */
	private toolResults = new Map<string, (isError: boolean, output: string) => void>();
	/** Write calls that will create a note, by tool_use id, for auto-present (OBS-19). */
	private newNotes = new Map<string, string>();
	/** Runs of thinking and tool calls in the transcript; the last one takes more while nothing follows it. */
	private sections: WorkSection[] = [];
	/** The group holding each Agent call, by tool_use id, for the agent's progress and edits (RND-9). */
	private agentCalls = new Map<string, ActivityGroup>();
	/** New work sections open as they're added, after the brain icon or the status row showed them, until they're hidden again. */
	private expandWork = false;

	constructor(
		readonly el: HTMLElement,
		private readonly host: TranscriptHost,
	) {
		// References, wikilinks and skill rows open their file (CTX-9, CTX-10, SLS-8).
		host.component.registerDomEvent(el, "click", (evt) => this.onClick(evt));
	}

	private get app(): App {
		return this.host.app;
	}

	private get plugin(): ApolloPlugin {
		return this.host.plugin;
	}

	/** Drops everything shown and the state that goes with it. */
	reset(): void {
		this.textStream?.cancel();
		this.textStream = null;
		this.thinking = null;
		this.textAwaitingUuid = [];
		this.toolResults.clear();
		this.newNotes.clear();
		this.sections = [];
		this.agentCalls.clear();
		this.el.empty();
	}

	/** A line of muted text standing in for content, such as "Loading chat…". */
	placeholder(text: string): HTMLElement {
		return this.el.createDiv({ cls: "apollo-empty", text });
	}

	clearPlaceholder(): void {
		this.el.querySelector(".apollo-empty")?.remove();
	}

	note(text: string, cls = "apollo-note"): void {
		this.el.createDiv({ cls: `apollo-msg ${cls}`, text });
	}

	userBubble(text: string): HTMLElement {
		const el = this.el.createDiv({ cls: "apollo-msg apollo-user" });
		renderWithReferences(el, text, this.app, this.plugin.vaultPath());
		return el;
	}

	// Streaming

	startText(): void {
		this.finishStreaming();
		const el = this.el.createDiv({ cls: "apollo-msg apollo-assistant" });
		this.textStream = new MarkdownStream(el.createDiv({ cls: "markdown-rendered" }), (text, out, component) => this.renderMarkdown(text, out, component), this.host.component);
		this.textStarted = Date.now();
		this.textAwaitingUuid.push(el);
	}

	appendText(text: string): void {
		if (!this.textStream) this.startText();
		this.textStream!.append(text);
	}

	startThinking(): void {
		this.finishStreaming();
		this.thinking = this.workSection().thinking();
	}

	appendThinking(text: string): void {
		this.thinking?.append(text);
	}

	finishStreaming(): void {
		void this.thinking?.finish();
		this.thinking = null;
		void this.textStream?.finish();
		this.textStream = null;
	}

	/** The assistant message that holds the next streamed text arrived: its reply gets the message actions. */
	textMessage(uuid: string): void {
		const el = this.textAwaitingUuid.shift();
		if (el) this.addMessageActions(el, uuid, "assistant");
	}

	/** The turn ended: nothing streamed is waiting for a UUID, and calls without results are settled. */
	endTurn(): void {
		this.finishStreaming();
		this.settleActivities();
		this.textAwaitingUuid = [];
	}

	/** What the turn is waiting on: a reply streaming in, or the latest thinking or tool call (RND-8). */
	currentStep(): Step | null {
		if (this.textStream) return { label: "Writing a reply", since: this.textStarted, kind: "text" };
		for (const section of [...this.sections].reverse()) {
			const step = section.current();
			if (step) return step;
		}
		return null;
	}

	// Work

	/** Shows each section open or closed. `expand` also makes new sections open as they're added. */
	setWorkOpen(show: boolean, expand: boolean): void {
		this.expandWork = show && expand;
		if (this.expandWork || !show) for (const section of this.sections) section.setOpen(show);
	}

	/** Redraws the brain icons on messages after showing or hiding work changed. */
	renderWorkToggles(): void {
		for (const el of Array.from(this.el.querySelectorAll<HTMLElement>(".apollo-work-toggle"))) this.renderWorkToggle(el);
	}

	private renderWorkToggle(el: HTMLElement): void {
		const show = this.host.showWork();
		setIcon(el, show ? "brain" : "brain-circuit");
		el.toggleClass("is-active", show);
		setTooltip(el, show ? "Hide thinking and tool calls" : "Show thinking and tool calls");
	}

	/** Marks calls that will never get a result as stopped. Background agents carry on unless `all`. */
	settleActivities(all = false): void {
		for (const section of this.sections) section.settle(all);
	}

	/** The section for the next thinking block or tool call: the last one while nothing follows it, otherwise a new one. */
	private workSection(): WorkSection {
		const last = this.sections[this.sections.length - 1];
		if (last && last.el === this.el.lastElementChild) return last;
		const section = new WorkSection(this.el, this.app, this.plugin.vaultPath(), (text, el) => this.renderMarkdown(text, el));
		if (this.expandWork && this.host.showWork()) section.setOpen(true);
		this.sections.push(section);
		return section;
	}

	// Tool calls

	toolRow(id: string, name: string, input: Record<string, unknown>): void {
		this.finishStreaming();
		if (name === "Skill" && typeof input.skill === "string") {
			// The model chose a skill (SLS-8).
			const row = this.skillRow(input.skill);
			this.toolResults.set(id, (isError) => row.addClass(isError ? "is-error" : "is-done"));
			return;
		}
		// Consecutive calls share a group; anything shown after it starts a new one.
		const target = this.workSection().activity();
		target.add(id, name, input);
		const agent = toolKind(name) === "agent";
		if (agent) this.agentCalls.set(id, target);
		this.toolResults.set(id, (isError, output) => {
			// A background agent's call returns at once; its row runs until the agent ends (RND-9).
			if (agent && !isError && (this.host.tasks().byToolUse(id)?.background || output.startsWith(BACKGROUND_AGENT))) {
				target.background(id);
				return;
			}
			target.finish(id, isError, output);
			const created = this.newNotes.get(id);
			this.newNotes.delete(id);
			if (created && !isError) void this.autoPresent(created);
		});
	}

	/** A tool call's result arrived. */
	toolResult(toolUseId: string, isError: boolean, content: unknown): void {
		this.toolResults.get(toolUseId)?.(isError, resultText(content));
	}

	/** Remembers a Write that is about to create a note, when auto-present is on (OBS-19). */
	noteNewFile(id: string, input: Record<string, unknown>): void {
		if (!this.plugin.settings.autoPresent || typeof input.file_path !== "string") return;
		const rel = vaultRelative(input.file_path, this.plugin.vaultPath());
		if (!rel || !rel.toLowerCase().endsWith(".md")) return;
		// The call hasn't run yet, so an existing file means an overwrite.
		if (!this.app.vault.getAbstractFileByPath(rel)) this.newNotes.set(id, rel);
	}

	private async autoPresent(path: string): Promise<void> {
		try {
			await this.host.presenter.presentNew(path);
		} catch (err) {
			console.warn("Apollo: couldn't present", path, err);
		}
	}

	/** Files a subagent edits, listed under its Agent call (RND-9). */
	agentEdits(parentId: string, content: SDKAssistantMessage["message"]["content"]): void {
		const group = this.agentCalls.get(parentId);
		if (!group) return;
		for (const block of content) {
			if (block.type !== "tool_use" || toolKind(block.name) !== "edit") continue;
			const path = filePath(block.input as Record<string, unknown>);
			if (path) group.addAgentEdit(path);
		}
	}

	/** An agent finished, failed or was stopped: its call shows how, with its totals (RND-9). */
	agentEnded(toolUseId: string, status: string, totals: string): void {
		this.agentCalls.get(toolUseId)?.endAgent(toolUseId, status === "completed" ? "done" : status === "failed" ? "error" : "stopped", totals);
	}

	/** A live agent's latest activity, shown on its call (RND-9). */
	agentProgress(toolUseId: string, text: string, toolUses: number, description: string): void {
		this.agentCalls.get(toolUseId)?.agentProgress(toolUseId, text, toolUses, description);
	}

	// Skills

	/** A "Skill: name" row linking to its SKILL.md (SLS-8). */
	private skillRow(name: string): HTMLElement {
		const row = this.el.createDiv({ cls: "apollo-msg apollo-tool apollo-skill" });
		row.createSpan({ cls: "apollo-tool-name", text: "Skill" });
		const path = this.plugin.catalogue.get(name)?.path;
		const nameEl = row.createSpan({ cls: "apollo-tool-summary", text: name });
		if (path) {
			nameEl.addClass("apollo-ref");
			nameEl.dataset.skillPath = path;
			setTooltip(nameEl, path);
		}
		return row;
	}

	/** A skill row for a message that runs a skill as a slash command (SLS-8). */
	skillRowForCommand(text: string): void {
		const name = /^\/(\S+)/.exec(text)?.[1];
		const entry = name ? this.plugin.catalogue.get(name) : undefined;
		if (entry?.kind === "skill") this.skillRow(entry.name).addClass("is-done");
	}

	// Messages

	/** Hover actions on a message: show or hide thinking and tool calls, and "Fork from here" (HIST-3a). */
	addMessageActions(el: HTMLElement, uuid: string, role: "user" | "assistant"): void {
		if (el.querySelector(":scope > .apollo-msg-actions")) return;
		const component = this.host.component;
		const actions = el.createDiv({ cls: "apollo-msg-actions" });
		const work = actions.createDiv({ cls: "clickable-icon apollo-work-toggle" });
		this.renderWorkToggle(work);
		component.registerDomEvent(work, "click", (evt) => {
			evt.stopPropagation();
			this.host.toggleWork(el);
		});
		const fork = actions.createDiv({ cls: "clickable-icon" });
		setIcon(fork, "git-branch");
		setTooltip(fork, role === "user" ? "Fork from here, to edit and resend this message" : "Fork from here");
		component.registerDomEvent(fork, "click", (evt) => {
			evt.stopPropagation();
			this.host.fork(uuid, role);
		});
	}

	/** Renders Markdown, styled as the theme styles notes, then makes vault paths in it clickable (CTX-10). */
	private async renderMarkdown(text: string, el: HTMLElement, component: Component = this.host.component): Promise<void> {
		el.addClass("markdown-rendered");
		await MarkdownRenderer.render(this.app, text, el, "", component);
		linkifyPaths(el, this.app, this.plugin.vaultPath());
	}

	/** Renders a saved transcript: user prompts, assistant text, thinking and tool rows. */
	async renderHistory(messages: SessionMessage[]): Promise<void> {
		const renders: Promise<void>[] = [];
		for (const msg of messages) {
			if (msg.parent_tool_use_id) continue;
			const blocks = contentBlocks(msg.message);
			if (msg.type === "user") {
				const texts: string[] = [];
				for (const block of blocks) {
					if (block.type === "tool_result" && block.tool_use_id) this.toolResult(block.tool_use_id, block.is_error ?? false, block.content);
					else if (block.type === "text" && block.text) texts.push(block.text);
					else if (block.type === "image") texts.push("[Image]");
				}
				const text = texts.join("\n\n");
				// A background agent reporting back (RND-9).
				const report = taskNotification(text);
				if (report) {
					this.agentEnded(report.toolUseId, report.status, report.totals);
					continue;
				}
				const prompt = displayPrompt(text);
				if (prompt === INTERRUPTED) this.note("Stopped.");
				else if (prompt) {
					this.addMessageActions(this.userBubble(prompt), msg.uuid, "user");
					this.skillRowForCommand(prompt);
				}
			} else if (msg.type === "assistant") {
				for (const block of blocks) {
					if (block.type === "text" && block.text) {
						const el = this.el.createDiv({ cls: "apollo-msg apollo-assistant" });
						renders.push(this.renderMarkdown(block.text, el.createDiv()));
						this.addMessageActions(el, msg.uuid, "assistant");
					} else if (block.type === "thinking" && block.thinking) {
						const thinking = this.workSection().thinking();
						thinking.append(block.thinking);
						renders.push(thinking.finish());
					} else if (block.type === "tool_use" && block.id && block.name) {
						this.toolRow(block.id, block.name, block.input ?? {});
					}
				}
			}
		}
		// Calls cut off by an interrupted turn never got a result, and agents that never reported back aren't running now.
		this.settleActivities(true);
		await Promise.all(renders);
	}

	// Clicks

	private onClick(evt: MouseEvent): void {
		const target = evt.target as HTMLElement | null;
		const ref = target?.closest<HTMLElement>(".apollo-ref");
		if (ref?.dataset.path) {
			evt.preventDefault();
			void openReference(this.app, ref.dataset.path, { line: Number(ref.dataset.line) || undefined, evt, from: this.host.leaf });
			return;
		}
		if (ref?.dataset.skillPath) {
			evt.preventDefault();
			this.openSkillFile(ref.dataset.skillPath, evt);
			return;
		}
		const link = target?.closest<HTMLAnchorElement>("a.internal-link");
		if (link) {
			evt.preventDefault();
			const href = link.dataset.href ?? link.getAttribute("href");
			if (href) void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(evt) || "tab");
		}
	}

	/** Opens a SKILL.md: as a note when Obsidian indexes it, otherwise in the system editor (dot-folders aren't indexed). */
	private openSkillFile(path: string, evt: MouseEvent): void {
		const rel = vaultRelative(path, this.plugin.vaultPath());
		if (rel && this.app.vault.getFileByPath(rel)) {
			void openReference(this.app, rel, { evt, from: this.host.leaf });
			return;
		}
		void (require("electron") as { shell: { openPath(path: string): Promise<string> } }).shell.openPath(path).then((error) => {
			if (error) new Notice(`Couldn't open ${path}: ${error}`);
		});
	}
}
