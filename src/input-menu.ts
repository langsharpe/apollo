/** One row of an input menu. */
export interface MenuRow<T> {
	value: T;
	render(el: HTMLElement): void;
	/** Rows with a heading start a group. */
	heading?: string;
	dimmed?: boolean;
}

export type ChooseHow = "enter" | "tab" | "click";

/**
 * Rows rendered at a time. Laying out a row costs about 0.3 ms, and only a
 * handful are visible, so the rest are added as the list scrolls (SLS-9).
 */
const BATCH = 30;

/**
 * A suggestion list that floats above the chat input, for the @ picker and
 * the slash menu. It never takes focus: the textarea keeps the caret and
 * forwards navigation keys through `handleKey`. Styled with Obsidian's own
 * suggestion classes.
 */
export class InputMenu<T> {
	private readonly el: HTMLElement;
	private readonly listEl: HTMLElement;
	private readonly rowsEl: HTMLElement;
	private readonly footerEl: HTMLElement;
	private rows: MenuRow<T>[] = [];
	private itemEls: HTMLElement[] = [];
	private selected = 0;

	constructor(
		parent: HTMLElement,
		private readonly onChoose: (value: T, how: ChooseHow) => void,
		cls: string,
	) {
		this.el = parent.createDiv({ cls: `suggestion-container apollo-menu ${cls}` });
		this.el.hide();
		this.listEl = this.el.createDiv({ cls: "suggestion" });
		this.rowsEl = this.listEl.createDiv();
		this.footerEl = this.listEl.createDiv({ cls: "apollo-menu-footer" });
		// Clicking a row must not blur the textarea.
		this.el.addEventListener("mousedown", (evt) => evt.preventDefault());
		this.el.addEventListener("scroll", () => {
			const el = this.el;
			if (this.itemEls.length < this.rows.length && el.scrollTop + el.clientHeight > el.scrollHeight - 100) this.renderMore();
		});
	}

	get isOpen(): boolean {
		return this.el.isShown();
	}

	/** Shows rows, or closes the menu if there are none. */
	show(rows: MenuRow<T>[], footer?: string): void {
		this.rows = rows;
		this.rowsEl.empty();
		this.itemEls = [];
		if (!rows.length) {
			this.close();
			return;
		}
		this.renderMore();
		this.footerEl.setText(footer ?? "");
		this.footerEl.toggle(!!footer);
		this.el.show();
		// The first row is at the top already. Scrolling it into view would force a layout now rather than at paint.
		this.el.scrollTop = 0;
		this.select(0, false);
	}

	close(): void {
		this.el.hide();
		this.rows = [];
		this.rowsEl.empty();
		this.itemEls = [];
	}

	private renderMore(): void {
		const start = this.itemEls.length;
		for (const [offset, row] of this.rows.slice(start, start + BATCH).entries()) {
			const i = start + offset;
			if (row.heading) this.rowsEl.createDiv({ cls: "apollo-menu-heading", text: row.heading });
			const item = this.rowsEl.createDiv({ cls: "suggestion-item mod-complex" });
			if (row.dimmed) item.addClass("is-dimmed");
			row.render(item);
			item.addEventListener("mousemove", () => this.select(i, false));
			item.addEventListener("click", () => this.onChoose(row.value, "click"));
			this.itemEls.push(item);
		}
	}

	/** Arrows move, Enter and Tab choose, Escape closes. Returns true if the key was used. */
	handleKey(evt: KeyboardEvent): boolean {
		if (!this.isOpen || evt.isComposing) return false;
		switch (evt.key) {
			case "ArrowDown":
				this.select((this.selected + 1) % this.rows.length, true);
				return true;
			case "ArrowUp":
				this.select((this.selected - 1 + this.rows.length) % this.rows.length, true);
				return true;
			case "Enter":
			case "Tab": {
				if (evt.shiftKey) return false;
				const row = this.rows[this.selected];
				if (!row) return false;
				this.onChoose(row.value, evt.key === "Tab" ? "tab" : "enter");
				return true;
			}
			case "Escape":
				this.close();
				return true;
		}
		return false;
	}

	private select(index: number, scroll: boolean): void {
		while (index >= this.itemEls.length && this.itemEls.length < this.rows.length) this.renderMore();
		this.itemEls[this.selected]?.removeClass("is-selected");
		this.selected = index;
		const el = this.itemEls[index];
		el?.addClass("is-selected");
		if (scroll) el?.scrollIntoView({ block: "nearest" });
	}
}
