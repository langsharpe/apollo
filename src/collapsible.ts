import { setIcon } from "obsidian";

/** A row header that expands and collapses `el` (its `is-open` class) on click, Enter or Space. */
export function createToggleHeader(el: HTMLElement): HTMLElement {
	const header = el.createDiv({ cls: "apollo-activity-header", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
	setIcon(header.createSpan({ cls: "apollo-activity-chevron" }), "chevron-right");
	const toggle = () => setOpen(el, !el.hasClass("is-open"));
	header.addEventListener("click", toggle);
	header.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault();
		toggle();
	});
	return header;
}

/** Expands or collapses a row made with `createToggleHeader`. */
export function setOpen(el: HTMLElement, open: boolean): void {
	el.toggleClass("is-open", open);
	el.querySelector(":scope > .apollo-activity-header")?.setAttr("aria-expanded", String(open));
}
