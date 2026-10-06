import { createToggleHeader } from "./activity";

/**
 * A block of Claude's thinking, as one collapsed row (RND-6). Claude Code
 * sends a summary rather than the raw thinking. It streams in as plain text
 * and renders as Markdown once the block ends; it shows when the row is
 * expanded.
 */
export class ThinkingBlock {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private text = "";
	/** Still streaming; false once finished, including when removed for having no text. */
	streaming = true;

	constructor(
		parent: HTMLElement,
		private readonly render: (text: string, el: HTMLElement) => Promise<void>,
		/** Called when the block finishes or is removed. */
		private readonly onFinish: () => void,
	) {
		this.el = parent.createDiv({ cls: "apollo-msg apollo-thinking is-streaming" });
		const header = createToggleHeader(this.el);
		this.labelEl = header.createSpan({ cls: "apollo-thinking-label", text: "Thinking…" });
		this.bodyEl = this.el.createDiv({ cls: "apollo-thinking-body" });
	}

	append(text: string): void {
		this.text += text;
		this.bodyEl.setText(this.text);
	}

	/** Swaps the streamed text for Markdown. A block with no text (redacted, or display omitted) is removed. */
	async finish(): Promise<void> {
		if (!this.streaming) return;
		this.streaming = false;
		if (!this.text.trim()) {
			this.el.remove();
			this.onFinish();
			return;
		}
		this.el.removeClass("is-streaming");
		this.labelEl.setText("Thought");
		this.bodyEl.empty();
		this.onFinish();
		await this.render(this.text, this.bodyEl);
	}
}
