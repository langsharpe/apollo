import { setIcon } from "obsidian";

/**
 * A block of Claude's thinking, as one collapsed row (RND-6). Claude Code
 * sends a summary rather than the raw thinking. It streams in as plain text
 * and renders as Markdown once the block ends; it shows when the row is
 * expanded.
 */
export class ThinkingBlock {
	readonly el: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private text = "";

	constructor(
		parent: HTMLElement,
		private readonly render: (text: string, el: HTMLElement) => Promise<void>,
	) {
		this.el = parent.createDiv({ cls: "apollo-msg apollo-thinking is-streaming" });
		this.headerEl = this.el.createDiv({ cls: "apollo-activity-header", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
		setIcon(this.headerEl.createSpan({ cls: "apollo-activity-chevron" }), "chevron-right");
		this.labelEl = this.headerEl.createSpan({ cls: "apollo-thinking-label", text: "Thinking…" });
		this.bodyEl = this.el.createDiv({ cls: "apollo-thinking-body" });
		this.headerEl.addEventListener("click", () => this.toggle());
		this.headerEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			this.toggle();
		});
	}

	append(text: string): void {
		this.text += text;
		this.bodyEl.setText(this.text);
	}

	/** Swaps the streamed text for Markdown. A block with no text (redacted, or display omitted) is removed. */
	async finish(): Promise<void> {
		if (!this.text.trim()) {
			this.el.remove();
			return;
		}
		this.el.removeClass("is-streaming");
		this.labelEl.setText("Thought");
		this.bodyEl.empty();
		await this.render(this.text, this.bodyEl);
	}

	private toggle(): void {
		const open = !this.el.hasClass("is-open");
		this.el.toggleClass("is-open", open);
		this.headerEl.setAttr("aria-expanded", String(open));
	}
}
