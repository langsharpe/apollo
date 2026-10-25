import { Component } from "obsidian";

/** Renders Markdown into an element, with a parent component for whatever the rendered content registers. */
export type RenderMarkdown = (text: string, el: HTMLElement, component: Component) => Promise<void>;

/** The shortest wait before a streaming reply's unfinished paragraph is rendered again. */
const RENDER_INTERVAL = 60;
/** The wait is at least this many times the last render's duration, so rendering takes at most a fifth of the main thread. */
const RENDER_BACKOFF = 4;

/**
 * Assistant text rendered as Markdown while it streams (RND-1), so headings and bold show as they arrive instead
 * of raw syntax that changes when the block ends. Completed top-level blocks are rendered once and kept; only the
 * unfinished tail is rendered again, at most every RENDER_INTERVAL ms, and less often when rendering is slow. A code
 * fence or math block still open in the tail shows as plain text until it closes, so long code isn't highlighted again
 * on every update and half-written diagrams and formulas aren't rendered. When the block ends, the whole text is
 * rendered once more, off-screen, and swapped in, so things that span blocks (list numbering, footnotes, reference
 * links) come out the same as when the chat is loaded from history.
 */
export class MarkdownStream {
	private text = "";
	/** Where the text not yet rendered for good starts. */
	private stable = 0;
	/** Rendered blocks sit directly in the element, as they do once finished, so the theme's spacing applies; the unfinished tail is everything after this marker. */
	private tailMarker = document.createComment("");
	private tailComponent: Component | null = null;
	/** Owns everything rendered while streaming, so it can all be unloaded once the final render replaces it. */
	private streaming = new Component();
	private timer: number | null = null;
	/** How long the last tail render took, in ms. */
	private renderTime = 0;
	/** Bumped by each tail render and by finishing, so a slow render can't land after a newer one. */
	private version = 0;

	constructor(
		private readonly el: HTMLElement,
		private readonly render: RenderMarkdown,
		private readonly parent: Component,
	) {
		parent.addChild(this.streaming);
		el.append(this.tailMarker);
	}

	/** The Markdown received so far. */
	get markdown(): string {
		return this.text;
	}

	append(text: string): void {
		this.text += text;
		this.timer ??= window.setTimeout(() => {
			this.timer = null;
			this.renderStreaming();
		}, Math.max(RENDER_INTERVAL, RENDER_BACKOFF * this.renderTime));
	}

	async finish(): Promise<void> {
		this.stop();
		const version = this.version;
		const out = createDiv();
		await this.render(this.text, out, this.parent);
		if (version !== this.version) return;
		this.el.replaceChildren(...Array.from(out.childNodes));
		this.parent.removeChild(this.streaming);
	}

	/** Stops rendering, for a transcript that is being cleared. */
	cancel(): void {
		this.stop();
		this.parent.removeChild(this.streaming);
	}

	private stop(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.version++;
	}

	private renderStreaming(): void {
		const { end, fence } = scan(this.text, this.stable);
		if (end > this.stable) {
			// Holds the block's place until it has rendered.
			const slot = document.createComment("");
			this.tailMarker.before(slot);
			const out = createDiv();
			void this.render(this.text.slice(this.stable, end), out, this.streaming).then(() => slot.replaceWith(...Array.from(out.childNodes)));
			this.stable = end;
		}
		const version = ++this.version;
		const component = this.streaming.addChild(new Component());
		const out = createDiv();
		const started = performance.now();
		void this.render(this.text.slice(this.stable, fence ?? undefined), out, component).then(() => {
			this.renderTime = performance.now() - started;
			if (version !== this.version) {
				this.streaming.removeChild(component);
				return;
			}
			if (fence !== null) out.append(plainBlock(this.text.slice(fence)));
			while (this.tailMarker.nextSibling) this.tailMarker.nextSibling.remove();
			this.tailMarker.after(...Array.from(out.childNodes));
			if (this.tailComponent) this.streaming.removeChild(this.tailComponent);
			this.tailComponent = component;
		});
	}
}

/**
 * Scans the text from `from`. `end` is where the part that can be rendered on its own and won't change ends: the start
 * of the last line that opens a new top-level block, after a blank line and outside code fences and math blocks. A
 * line indented after a blank line may still belong to a list item, so it isn't a boundary. `fence` is where a code
 * fence or math block that hasn't closed yet starts, or null.
 */
function scan(text: string, from: number): { end: number; fence: number | null } {
	let end = from;
	let fence: { marker: string; start: number } | null = null;
	for (let pos = from; pos < text.length; ) {
		const nl = text.indexOf("\n", pos);
		// The last line may still be arriving: it can open a fence, but can't close one or end a block.
		const complete = nl >= 0;
		const line = text.slice(pos, complete ? nl : undefined).trim();
		const start = pos;
		pos = complete ? nl + 1 : text.length;
		if (fence) {
			const { marker } = fence;
			if (complete && (marker === "$$" ? line.endsWith("$$") : line.startsWith(marker) && /^([`~])\1*$/.test(line))) fence = null;
			continue;
		}
		const open = /^(`{3,}|~{3,}|\$\$)/.exec(line);
		if (open) {
			if (!(open[1] === "$$" && line.length > 2 && line.endsWith("$$"))) fence = { marker: open[1], start };
			continue;
		}
		if (complete && !line && /\S/.test(text.charAt(pos))) end = pos;
	}
	return { end, fence: fence?.start ?? null };
}

/** An open code fence or math block as plain preformatted text, without its opening line. */
function plainBlock(text: string): HTMLElement {
	const nl = text.indexOf("\n");
	const pre = createEl("pre");
	pre.createEl("code", { text: nl < 0 ? "" : text.slice(nl + 1) });
	return pre;
}
