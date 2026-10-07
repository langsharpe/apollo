import type { App } from "obsidian";
import { ActivityGroup, addChange, callsCount, createToggleHeader, FileLinks, summarise, type Step } from "./activity";
import { ThinkingBlock } from "./thinking";

/**
 * A run of thinking and tool calls between messages, collapsed to one row
 * (RND-7). The header summarises what it did so far; what is happening now
 * shows in the status row at the end of the transcript (RND-8). The files
 * read and edited and any structural changes stay visible below it as links. Expanding it shows the thinking rows and activity
 * groups, which expand in turn. A run of one row shows just that row.
 */
export class WorkSection {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly files: FileLinks;
	private readonly changesEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly groups: ActivityGroup[] = [];
	private readonly thoughts: ThinkingBlock[] = [];

	constructor(
		parent: HTMLElement,
		private readonly app: App,
		private readonly vaultPath: string,
		private readonly render: (text: string, el: HTMLElement) => Promise<void>,
	) {
		this.el = parent.createDiv({ cls: "apollo-msg apollo-activity apollo-work" });
		const header = createToggleHeader(this.el);
		this.labelEl = header.createSpan({ cls: "apollo-activity-label" });
		this.countEl = header.createSpan({ cls: "apollo-activity-count" });
		this.files = new FileLinks(this.el.createDiv({ cls: "apollo-activity-files" }), app, vaultPath);
		this.changesEl = this.el.createDiv({ cls: "apollo-activity-changes" });
		this.bodyEl = this.el.createDiv({ cls: "apollo-work-body" });
	}

	/** The group for the next tool call: the last one while nothing follows it, otherwise a new one. */
	activity(): ActivityGroup {
		const last = this.groups[this.groups.length - 1];
		if (last && last.el === this.bodyEl.lastElementChild) return last;
		const group = new ActivityGroup(this.bodyEl, this.app, this.vaultPath, this);
		this.groups.push(group);
		return group;
	}

	thinking(): ThinkingBlock {
		const block = new ThinkingBlock(this.bodyEl, this.render, () => this.update());
		this.thoughts.push(block);
		this.update();
		return block;
	}

	/** What the turn is waiting on in this section: thinking, or the latest call still running (RND-8). */
	current(): Step | null {
		const thinking = this.thoughts.find((t) => t.streaming && t.el === this.bodyEl.lastElementChild);
		if (thinking) return { label: "Thinking", since: thinking.started, kind: "thinking" };
		for (const group of [...this.groups].reverse()) {
			const step = group.current();
			if (step) return step;
		}
		return null;
	}

	/** Marks calls that will never get a result as stopped. Background agents carry on unless `all`. */
	settle(all = false): void {
		for (const group of this.groups) group.settle(all);
	}

	addFile(path: string, edited: boolean): void {
		this.files.add(path, edited);
	}

	addChange(text: string): void {
		addChange(this.changesEl, text, this.app, this.vaultPath);
	}

	/** Refreshes the header from the rows inside. */
	update(): void {
		// Thinking with no text removes itself, and may leave nothing to show.
		if (!this.bodyEl.childElementCount) {
			this.el.remove();
			return;
		}
		const calls = this.groups.flatMap((g) => g.calls);
		const thoughts = this.thoughts.filter((t) => t.el.parentElement === this.bodyEl);
		this.labelEl.setText(summarise(calls, thoughts.length > 0));
		this.countEl.setText(callsCount(calls));
	}
}
