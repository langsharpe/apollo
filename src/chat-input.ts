import { homedir } from "node:os";
import { Menu, TFile, TFolder, prepareFuzzySearch, renderResults, setIcon, type App, type Component, type SearchResult, type TAbstractFile } from "obsidian";
import { sourceLabel, type CatalogueEntry } from "./catalogue";
import { InputMenu, type ChooseHow, type MenuRow } from "./input-menu";
import type ApolloPlugin from "./main";
import { findReferences, formatReference, isAbsolutePath, vaultRelative } from "./references";

export interface ChatInputHandlers {
	submit(): void;
	/** Escape with no menu open. Returns true if it was used. */
	escape(): boolean;
	changed(): void;
}

/** Obsidian internals the public API doesn't expose. All may be missing. */
interface AppInternals {
	dragManager?: {
		draggable?: {
			type?: string;
			file?: TAbstractFile;
			files?: TAbstractFile[];
			linktext?: string;
			sourcePath?: string;
		} | null;
	};
}

type SlashToken = { kind: "slash"; from: number; query: string };
type FileToken = { kind: "file"; from: number; query: string };

const FILE_RESULTS = 50;
const RECENT_FILES = 10;
/** Characters of a description to render; the row shows one line. */
const NOTE_LENGTH = 160;
const SLASH_GROUPS: [CatalogueEntry["kind"], string][] = [
	["apollo", "Apollo"],
	["skill", "Skills"],
	["command", "Commands"],
	["mcp-prompt", "MCP prompts"],
	["builtin", "Claude Code"],
];

/**
 * The chat's message box. A plain textarea, so typing, undo and IME behave
 * natively, with a backdrop behind it that draws references as chips. Adds
 * the @ file picker (CTX-1), the slash menu (SLS-1), drag and drop (CTX-2),
 * paste normalisation (CTX-6) and the open-notes menu (CTX-7).
 */
export class ChatInput {
	readonly el: HTMLTextAreaElement;
	private readonly app: App;
	private readonly backdropEl: HTMLElement;
	private readonly warningEl: HTMLElement;
	private readonly slashMenu: InputMenu<CatalogueEntry>;
	private readonly fileMenu: InputMenu<TAbstractFile>;
	private token: SlashToken | FileToken | null = null;
	/** Token start where the menu was dismissed with Escape, so it stays closed while typing on. */
	private dismissedAt: number | null = null;
	/** Pasted or dropped paths outside the vault, flagged while they stay in the text (CTX-6). */
	private outside = new Set<string>();

	constructor(
		parent: HTMLElement,
		private readonly plugin: ApolloPlugin,
		private readonly component: Component,
		private readonly handlers: ChatInputHandlers,
	) {
		this.app = plugin.app;
		this.warningEl = parent.createDiv({ cls: "apollo-input-warning" });
		this.warningEl.hide();
		const box = parent.createDiv({ cls: "apollo-input-box" });
		this.backdropEl = box.createDiv({ cls: "apollo-input-backdrop", attr: { "aria-hidden": "true" } });
		this.el = box.createEl("textarea", { attr: { placeholder: "Ask Claude…  (@ for files, / for commands, Enter to send)", rows: "3" } });
		this.slashMenu = new InputMenu(box, (entry, how) => this.chooseCommand(entry, how), "apollo-slash-menu");
		this.fileMenu = new InputMenu(box, (file, how) => this.chooseFile(file, how), "apollo-file-menu");

		const on = <K extends keyof HTMLElementEventMap>(type: K, cb: (evt: HTMLElementEventMap[K]) => void) =>
			component.registerDomEvent(this.el, type, cb);
		on("keydown", (evt) => this.onKeyDown(evt));
		on("input", () => {
			this.refresh();
			this.handlers.changed();
		});
		// The caret moving (clicks, arrows) can enter or leave a token.
		on("keyup", (evt) => {
			if (evt.key.startsWith("Arrow") || evt.key === "Home" || evt.key === "End") this.updateMenus();
		});
		on("click", () => this.updateMenus());
		on("blur", () => this.closeMenus());
		on("scroll", () => (this.backdropEl.scrollTop = this.el.scrollTop));
		on("paste", (evt) => this.onPaste(evt));
		on("dragover", (evt) => this.onDragOver(evt));
		on("dragleave", () => box.removeClass("is-drag-over"));
		on("drop", (evt) => this.onDrop(evt));
		// Resizing the textarea, or the pane, re-wraps its text.
		const resize = new ResizeObserver(() => this.syncBackdrop());
		resize.observe(this.el);
		component.register(() => resize.disconnect());
		// Chips depend on which files exist and what the catalogue holds.
		component.registerEvent(plugin.catalogue.onChanged(() => this.renderBackdrop()));
		component.registerEvent(this.app.vault.on("create", () => this.renderBackdrop()));
		component.registerEvent(this.app.vault.on("delete", () => this.renderBackdrop()));
		component.registerEvent(this.app.vault.on("rename", () => this.renderBackdrop()));
	}

	get value(): string {
		return this.el.value;
	}

	set value(text: string) {
		this.el.value = text;
		this.closeMenus();
		this.refresh();
	}

	focus(): void {
		this.el.focus();
	}

	/** Inserts references at the caret (CTX-2 to CTX-4, CTX-7). */
	insertReferences(files: TAbstractFile[]): void {
		if (!files.length) return;
		const format = this.plugin.settings.referenceFormat;
		this.insertAtCaret(files.map((f) => formatReference(f, format)).join(" "), true);
	}

	/** Inserts a block of text on its own lines, e.g. a quoted selection (CTX-5). */
	insertBlock(text: string): void {
		const { selectionStart: start, selectionEnd: end, value } = this.el;
		// Spaces left after the caret's text, e.g. by a reference, would trail the line.
		const from = start - (/[ \t]*$/.exec(value.slice(0, start))?.[0].length ?? 0);
		const lead = from > 0 && value[from - 1] !== "\n" ? "\n" : "";
		this.replaceRange(from, end, `${lead}${text}`);
	}

	/** Menu of open notes, for one-click insertion (CTX-7). */
	showOpenNotes(evt: MouseEvent): void {
		const files: TFile[] = [];
		const seen = new Set<string>();
		const { workspace } = this.app;
		workspace.iterateAllLeaves((leaf) => {
			// Sidebar panels such as backlinks name a file too, but aren't open notes.
			const root = leaf.getRoot();
			if (root === workspace.leftSplit || root === workspace.rightSplit) return;
			// Deferred tabs have no view yet, but their saved state names the file.
			const path = leaf.getViewState().state?.file;
			const file = typeof path === "string" ? this.app.vault.getFileByPath(path) : null;
			if (file && !seen.has(file.path)) {
				seen.add(file.path);
				files.push(file);
			}
		});
		const menu = new Menu();
		if (!files.length) {
			menu.addItem((item) => item.setTitle("No open notes").setDisabled(true));
		} else {
			for (const file of files) {
				menu.addItem((item) =>
					item
						.setTitle(file.path)
						.setIcon("file-text")
						.onClick(() => this.insertReferences([file])),
				);
			}
			if (files.length > 1) {
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("Add all open notes")
						.setIcon("files")
						.onClick(() => this.insertReferences(files)),
				);
			}
		}
		menu.showAtMouseEvent(evt);
	}

	private onKeyDown(evt: KeyboardEvent): void {
		if (evt.isComposing) return;
		const menu = this.openMenu();
		if (menu?.handleKey(evt)) {
			evt.preventDefault();
			if (evt.key === "Escape" && this.token) this.dismissedAt = this.token.from;
			return;
		}
		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			this.handlers.submit();
		} else if (evt.key === "Escape" && this.handlers.escape()) {
			evt.preventDefault();
		}
	}

	private openMenu(): InputMenu<CatalogueEntry> | InputMenu<TAbstractFile> | null {
		if (this.slashMenu.isOpen) return this.slashMenu;
		if (this.fileMenu.isOpen) return this.fileMenu;
		return null;
	}

	private closeMenus(): void {
		this.slashMenu.close();
		this.fileMenu.close();
		this.token = null;
	}

	/** Re-draws chips and warnings, then opens or updates a menu for the token at the caret. */
	private refresh(): void {
		this.renderBackdrop();
		this.updateMenus();
	}

	private currentToken(): SlashToken | FileToken | null {
		const { selectionStart: start, selectionEnd: end, value } = this.el;
		if (start !== end) return null;
		const before = value.slice(0, start);
		// SLS-1: "/" at the start or after whitespace. CTX-1: "@" likewise, or after a bracket.
		const slash = /(?:^|\s)\/(\S*)$/.exec(before);
		if (slash) return { kind: "slash", from: start - slash[1]!.length - 1, query: slash[1]! };
		const at = /(?:^|[\s([])@([^\s"]*)$/.exec(before);
		if (at) return { kind: "file", from: start - at[1]!.length - 1, query: at[1]! };
		return null;
	}

	private updateMenus(): void {
		const token = this.currentToken();
		if (!token || token.from !== this.dismissedAt) this.dismissedAt = null;
		if (!token || this.dismissedAt !== null) {
			this.closeMenus();
			return;
		}
		// Arrow keys and clicks re-check the caret; leave an open menu, and its selection, alone if nothing changed.
		const same = this.token && this.token.kind === token.kind && this.token.from === token.from && this.token.query === token.query;
		if (same && this.openMenu()) return;
		this.token = token;
		if (token.kind === "slash") {
			this.fileMenu.close();
			this.slashMenu.show(this.slashRows(token.query), "↑↓ move · Tab complete · Enter insert · Esc close");
		} else {
			this.slashMenu.close();
			this.fileMenu.show(this.fileRows(token.query));
		}
	}

	/**
	 * Slash menu rows from the in-memory catalogue (SLS-9): grouped when
	 * nothing is typed yet, ranked by fuzzy match otherwise. Entries Claude
	 * Code didn't load sink to the bottom, dimmed (SLS-5).
	 */
	private slashRows(query: string): MenuRow<CatalogueEntry>[] {
		const entries = this.plugin.catalogue.entries();
		if (!query) {
			const rows: MenuRow<CatalogueEntry>[] = [];
			for (const [kind, heading] of SLASH_GROUPS) {
				const group = entries.filter((e) => e.kind === kind);
				// Apollo's own commands keep their listed order, /new first.
				if (kind !== "apollo") group.sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable) || a.name.localeCompare(b.name));
				group.forEach((e, i) => rows.push(this.slashRow(e, null, i === 0 ? heading : undefined)));
			}
			return rows;
		}
		const match = prepareFuzzySearch(query);
		const scored: { e: CatalogueEntry; result: SearchResult; score: number }[] = [];
		for (const e of entries) {
			const result = match(e.name);
			if (result) scored.push({ e, result, score: result.score - (e.unavailable ? 1000 : 0) });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.map(({ e, result }) => this.slashRow(e, result));
	}

	private slashRow(e: CatalogueEntry, result: SearchResult | null, heading?: string): MenuRow<CatalogueEntry> {
		return {
			value: e,
			...(heading ? { heading } : {}),
			dimmed: !!e.unavailable,
			render: (el) => {
				const content = el.createDiv({ cls: "suggestion-content" });
				const title = content.createDiv({ cls: "suggestion-title" });
				title.createSpan({ text: "/" });
				const name = title.createSpan();
				if (result) renderResults(name, e.name, result);
				else name.setText(e.name);
				if (e.argumentHint) title.createSpan({ cls: "apollo-menu-hint", text: ` ${e.argumentHint}` });
				const note = e.unavailable ? `${e.unavailable}. ${e.description}` : e.description;
				// Only one line shows, but laying out a 1,000-character description costs as much as showing it.
				if (note) content.createDiv({ cls: "suggestion-note", text: note.length > NOTE_LENGTH ? `${note.slice(0, NOTE_LENGTH - 1)}…` : note });
				el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: `apollo-badge is-${e.source}`, text: sourceLabel(e) });
			},
		};
	}

	/** Tab completes the name; Enter or click inserts `/name ` (SLS-1, SLS-6). */
	private chooseCommand(entry: CatalogueEntry, how: ChooseHow): void {
		const token = this.token;
		if (token?.kind !== "slash") return;
		const end = token.from + 1 + token.query.length;
		if (how === "tab" && token.query !== entry.name) {
			this.replaceRange(token.from, end, `/${entry.name}`);
			return;
		}
		this.replaceRange(token.from, end, `/${entry.name} `);
		this.closeMenus();
	}

	/** Vault files and folders by fuzzy path match. With nothing typed, recent files. */
	private fileRows(query: string): MenuRow<TAbstractFile>[] {
		const { vault, workspace } = this.app;
		if (!query) {
			return workspace
				.getLastOpenFiles()
				.map((path) => vault.getAbstractFileByPath(path))
				.filter((f): f is TAbstractFile => !!f)
				.slice(0, RECENT_FILES)
				.map((f, i) => this.fileRow(f, null, i === 0 ? "Recent files" : undefined));
		}
		const match = prepareFuzzySearch(query);
		const scored: { f: TAbstractFile; result: SearchResult }[] = [];
		for (const f of vault.getAllLoadedFiles()) {
			if (f.path === "/" || !f.path) continue;
			const result = match(f.path);
			if (result) scored.push({ f, result });
		}
		scored.sort((a, b) => b.result.score - a.result.score);
		return scored.slice(0, FILE_RESULTS).map(({ f, result }) => this.fileRow(f, result));
	}

	private fileRow(f: TAbstractFile, result: SearchResult | null, heading?: string): MenuRow<TAbstractFile> {
		return {
			value: f,
			...(heading ? { heading } : {}),
			render: (el) => {
				const icon = el.createDiv({ cls: "suggestion-icon" });
				setIcon(icon, f instanceof TFolder ? "folder" : "file-text");
				const content = el.createDiv({ cls: "suggestion-content" });
				const title = content.createDiv({ cls: "suggestion-title" });
				const path = f instanceof TFolder ? `${f.path}/` : f.path;
				if (result) renderResults(title, path, result);
				else title.setText(path);
			},
		};
	}

	/** Tab completes the path (into a folder, to keep going); Enter or click inserts the reference. */
	private chooseFile(file: TAbstractFile, how: ChooseHow): void {
		const token = this.token;
		if (token?.kind !== "file") return;
		const end = token.from + 1 + token.query.length;
		if (how === "tab" && file instanceof TFolder) {
			this.replaceRange(token.from, end, `@${file.path}/`);
			return;
		}
		const ref = formatReference(file, this.plugin.settings.referenceFormat);
		const after = this.el.value.slice(end);
		this.replaceRange(token.from, end, /^\s/.test(after) ? ref : `${ref} `);
		this.closeMenus();
	}

	/** CTX-6: absolute paths inside the vault become references; others stay as text, flagged. */
	private onPaste(evt: ClipboardEvent): void {
		const data = evt.clipboardData;
		if (!data) return;
		const paths = osFilePaths(data);
		const lines = paths.length ? paths : data.getData("text/plain").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		if (!lines.length || !lines.every(isAbsolutePath)) return;
		evt.preventDefault();
		this.insertPaths(lines);
	}

	private insertPaths(paths: string[]): void {
		const format = this.plugin.settings.referenceFormat;
		const parts = paths.map((p) => {
			const rel = vaultRelative(p.replace(/^~(?=\/)/, homedir()), this.plugin.vaultPath());
			const file = rel ? this.app.vault.getAbstractFileByPath(rel) : null;
			if (file) return formatReference(file, format);
			this.outside.add(p);
			return p;
		});
		this.insertAtCaret(parts.join(" "), true);
	}

	private onDragOver(evt: DragEvent): void {
		const dt = evt.dataTransfer;
		if (!dt) return;
		if (!this.draggable() && !dt.types.includes("Files") && !dt.types.includes("text/plain")) return;
		// Keep Obsidian's workspace from treating this as a drop onto the pane.
		evt.preventDefault();
		evt.stopPropagation();
		dt.dropEffect = "copy";
		this.el.parentElement?.addClass("is-drag-over");
	}

	/** CTX-2: files and folders from the explorer, tab headers, search, links, or the OS. */
	private onDrop(evt: DragEvent): void {
		this.el.parentElement?.removeClass("is-drag-over");
		const files = this.droppedFiles(evt);
		if (files.vault.length || files.outside.length) {
			evt.preventDefault();
			evt.stopPropagation();
			this.el.focus();
			if (files.vault.length) this.insertReferences(files.vault);
			if (files.outside.length) this.insertPaths(files.outside);
		}
	}

	private draggable() {
		return (this.app as App & AppInternals).dragManager?.draggable ?? null;
	}

	private droppedFiles(evt: DragEvent): { vault: TAbstractFile[]; outside: string[] } {
		const { vault, metadataCache } = this.app;
		const drag = this.draggable();
		if (drag) {
			if ((drag.type === "file" || drag.type === "folder") && drag.file) return { vault: [drag.file], outside: [] };
			if (drag.type === "files" && drag.files) return { vault: drag.files, outside: [] };
			if (drag.type === "link" && drag.linktext) {
				const file = metadataCache.getFirstLinkpathDest(drag.linktext.split("#")[0]!, drag.sourcePath ?? "");
				if (file) return { vault: [file], outside: [] };
			}
		}
		const dt = evt.dataTransfer;
		if (!dt) return { vault: [], outside: [] };
		const paths = osFilePaths(dt);
		if (paths.length) {
			const inVault: TAbstractFile[] = [];
			const outside: string[] = [];
			for (const p of paths) {
				const rel = vaultRelative(p, this.plugin.vaultPath());
				const file = rel ? vault.getAbstractFileByPath(rel) : null;
				if (file) inVault.push(file);
				else outside.push(p);
			}
			return { vault: inVault, outside };
		}
		// Obsidian puts obsidian:// URLs or wikilinks in the text of its drags.
		const found: TAbstractFile[] = [];
		for (const line of dt.getData("text/plain").split(/\r?\n/)) {
			const file = this.fileFromText(line.trim());
			if (file) found.push(file);
			else if (line.trim()) return { vault: [], outside: [] };
		}
		return { vault: found, outside: [] };
	}

	private fileFromText(text: string): TAbstractFile | null {
		if (!text) return null;
		if (text.startsWith("obsidian://")) {
			try {
				const path = new URL(text).searchParams.get("file");
				if (!path) return null;
				return this.app.vault.getAbstractFileByPath(path) ?? this.app.vault.getAbstractFileByPath(`${path}.md`);
			} catch {
				return null;
			}
		}
		const link = /^!?\[\[([^\]|#]+)/.exec(text);
		if (link) return this.app.metadataCache.getFirstLinkpathDest(link[1]!, "");
		return null;
	}

	private insertAtCaret(text: string, spaced: boolean): void {
		const { selectionStart: start, selectionEnd: end, value } = this.el;
		let insert = text;
		if (spaced) {
			if (start > 0 && !/\s/.test(value[start - 1]!)) insert = ` ${insert}`;
			if (!/^\s/.test(value.slice(end))) insert = `${insert} `;
		}
		this.replaceRange(start, end, insert);
	}

	/** Replaces a range through the editing commands, so it can be undone. */
	private replaceRange(from: number, to: number, text: string): void {
		this.el.focus();
		this.el.setSelectionRange(from, to);
		if (!document.execCommand("insertText", false, text)) {
			this.el.setRangeText(text, from, to, "end");
			this.el.dispatchEvent(new Event("input"));
		}
	}

	/** Draws references as chips behind the text, and flags paths outside the vault (CTX-6). */
	private renderBackdrop(): void {
		const text = this.el.value;
		const marks: { from: number; to: number; cls: string; title?: string }[] = [];
		const command = /^\/(\S+)/.exec(text);
		if (command && this.plugin.catalogue.get(command[1]!)) marks.push({ from: 0, to: command[0].length, cls: "is-command" });
		for (const ref of findReferences(text, this.app, this.plugin.vaultPath())) marks.push({ from: ref.from, to: ref.to, cls: ref.folder ? "is-ref is-folder" : "is-ref" });
		const outside: string[] = [];
		for (const p of [...this.outside]) {
			let at = text.indexOf(p);
			if (at === -1) {
				this.outside.delete(p);
				continue;
			}
			outside.push(p);
			while (at !== -1) {
				marks.push({ from: at, to: at + p.length, cls: "is-outside" });
				at = text.indexOf(p, at + p.length);
			}
		}
		marks.sort((a, b) => a.from - b.from);

		const el = this.backdropEl;
		el.empty();
		let last = 0;
		for (const m of marks) {
			if (m.from < last) continue;
			if (m.from > last) el.appendText(text.slice(last, m.from));
			el.createSpan({ cls: `apollo-mark ${m.cls}`, text: text.slice(m.from, m.to) });
			last = m.to;
		}
		// A trailing newline needs something after it to take up a line.
		el.appendText(`${text.slice(last)}​`);
		el.scrollTop = this.el.scrollTop;

		this.warningEl.empty();
		this.warningEl.toggle(outside.length > 0);
		if (outside.length) {
			setIcon(this.warningEl.createSpan({ cls: "apollo-input-warning-icon" }), "alert-triangle");
			this.warningEl.createSpan({
				text: `Outside the vault, so Claude may need permission to read it: ${outside.join(", ")}`,
			});
		}
	}

	/** Matches the backdrop's text box to the textarea's, including room for its scrollbar. */
	private syncBackdrop(): void {
		const style = getComputedStyle(this.el);
		const bd = this.backdropEl.style;
		for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingBottom", "borderTopWidth", "borderLeftWidth", "borderRightWidth", "borderBottomWidth", "tabSize"] as const) {
			bd[prop] = style[prop];
		}
		const scrollbar = this.el.offsetWidth - this.el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
		bd.paddingRight = `${parseFloat(style.paddingRight) + Math.max(0, scrollbar)}px`;
		this.backdropEl.scrollTop = this.el.scrollTop;
	}
}

/** Absolute paths of files dragged or pasted from the OS. */
function osFilePaths(data: DataTransfer): string[] {
	if (!data.files?.length) return [];
	let getPath: ((file: File) => string) | null = null;
	try {
		// Electron removed File.path; webUtils is its replacement.
		const electron = require("electron") as { webUtils?: { getPathForFile(file: File): string } };
		if (electron.webUtils) getPath = (file) => electron.webUtils!.getPathForFile(file);
	} catch {
		// Not in Electron.
	}
	return Array.from(data.files)
		.map((f) => getPath?.(f) || (f as File & { path?: string }).path || "")
		.filter(Boolean);
}
