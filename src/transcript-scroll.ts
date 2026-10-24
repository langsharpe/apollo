/** Pixels from the bottom that still count as being at the end. */
const STICKY_SCROLL = 40;
/** Room above a message scrolled to the top of the transcript. */
const ANCHOR_MARGIN = 8;

/**
 * Scroll anchoring for a chat's transcript (RND-11). Output keeps the end in
 * view while the chat is pinned; sending a message instead puts it at the top
 * so its reply reads from the start. Only the user's own scrolling unpins.
 */
export class TranscriptScroller {
	/** New output keeps the end of the transcript in view. Only the user's own scrolling clears it. */
	private pinned = true;
	/** scrollTop at the last scroll event, or the last one set here, to tell your scrolling from content changing. */
	private lastScrollTop = 0;
	/** The message you sent last. It's scrolled to the top so its reply reads from the start, and output doesn't push it away. */
	private anchor: HTMLElement | null = null;
	/** Padding below the transcript that lets `anchor` reach the top while the reply is shorter than the view. */
	private spacer = 0;
	private readonly mutations: MutationObserver;
	private readonly resizes: ResizeObserver;

	/** `scrolled` runs after the user scrolls, so the view can save its position. */
	constructor(
		private readonly el: HTMLElement,
		private readonly scrolled: () => void,
	) {
		// Output often grows after it's added (Markdown rendering, tool results), so follow every change while pinned.
		this.mutations = new MutationObserver(() => this.follow());
		this.mutations.observe(el, { childList: true, subtree: true, characterData: true });
		// The input growing and pane resizes shrink the transcript.
		this.resizes = new ResizeObserver(() => this.follow());
		this.resizes.observe(el);
	}

	/** Stops watching for changes. */
	dispose(): void {
		this.mutations.disconnect();
		this.resizes.disconnect();
	}

	/** The scroll position to save, or null when following the end. */
	get position(): number | null {
		return this.pinned ? null : this.el.scrollTop;
	}

	/** The view follows the end of the output, rather than staying where you left it. */
	get following(): boolean {
		return this.pinned;
	}

	/** Brings back a saved position: the end for null. */
	restore(position: number | null | undefined): void {
		if (position == null) {
			this.toEnd();
			return;
		}
		this.setScrollTop(position);
		this.pinned = this.isNearEnd();
	}

	/** Forgets the anchor and follows the end again, for an emptied transcript. */
	reset(): void {
		this.pinned = true;
		this.lastScrollTop = 0;
		this.anchor = null;
		this.updateSpacer();
	}

	/** Keeps up with layout changes: resizes the room below, and stays at the end while pinned. */
	follow(): void {
		this.updateSpacer();
		if (this.pinned) this.toEnd();
	}

	/** Shows the end of the transcript and keeps it in view as output arrives. */
	toEnd(): void {
		this.pinned = true;
		this.setScrollTop(this.el.scrollHeight);
	}

	/** Shows the end once, for something that needs an answer, without following the output after it. */
	revealEnd(): void {
		this.setScrollTop(this.el.scrollHeight);
	}

	/**
	 * Puts a message you sent at the top of the view (RND-11), so its reply reads from
	 * the start as it streams in below. The view stays there until you scroll.
	 */
	anchorAtTop(el: HTMLElement): void {
		this.anchor = el;
		this.pinned = false;
		this.updateSpacer();
		this.setScrollTop(this.offsetOf(el) - ANCHOR_MARGIN);
	}

	/** Runs `change`, which alters the transcript's layout, and keeps `el` where it is on screen. */
	keepInPlace(el: HTMLElement, change: () => void): void {
		const before = el.getBoundingClientRect().top;
		change();
		this.updateSpacer();
		this.setScrollTop(this.el.scrollTop + el.getBoundingClientRect().top - before);
		this.pinned = this.isNearEnd();
	}

	/**
	 * Scrolling up unpins; reaching the end pins again. Content growing below
	 * doesn't scroll, and content shrinking only moves the position to the end.
	 */
	onScroll(): void {
		const top = this.el.scrollTop;
		if (top !== this.lastScrollTop) {
			if (this.isNearEnd()) this.pinned = true;
			else if (top < this.lastScrollTop) this.pinned = false;
			this.lastScrollTop = top;
		}
		this.scrolled();
	}

	/** At the end of the output, not in the room left below a message at the top. */
	private isNearEnd(): boolean {
		const el = this.el;
		return !this.spacer && el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL;
	}

	/** Scrolls without the scroll event counting as yours. */
	private setScrollTop(top: number): void {
		this.el.scrollTop = top;
		this.lastScrollTop = this.el.scrollTop;
	}

	/** Where `el` starts in the scrolled content. */
	private offsetOf(el: HTMLElement): number {
		return el.getBoundingClientRect().top - this.el.getBoundingClientRect().top + this.el.scrollTop;
	}

	/**
	 * Sizes the room below the transcript so the anchored message can sit at
	 * the top. It shrinks as the reply grows, so the content doesn't move, and
	 * is gone once the reply fills the view.
	 */
	private updateSpacer(): void {
		const el = this.el;
		let room = 0;
		if (this.anchor?.isConnected) {
			const top = el.getBoundingClientRect().top - el.scrollTop;
			let end = 0;
			for (const child of Array.from(el.children)) end = Math.max(end, child.getBoundingClientRect().bottom - top);
			room = Math.max(0, Math.ceil(this.offsetOf(this.anchor) - ANCHOR_MARGIN + el.clientHeight - end));
		}
		if (room === this.spacer) return;
		this.spacer = room;
		el.style.paddingBottom = room ? `${room}px` : "";
	}
}
