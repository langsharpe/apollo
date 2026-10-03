import { Keymap, TFile, TFolder, normalizePath, setIcon, type App, type PaneType, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type { ReferenceFormat } from "./settings";

/** A file or folder reference found in text. */
export interface Reference {
	/** Offsets of the whole token in the text, including any `@` and quotes. */
	from: number;
	to: number;
	/** Vault-relative path, without a trailing slash. */
	path: string;
	folder: boolean;
	/** First line of a `path:L10-L24` range. */
	line?: number;
}

/**
 * How a file or folder is written into a message (CTX-8). Folders end in `/`.
 * Paths with spaces are quoted, which Claude Code's @-mentions understand
 * (backslash escapes don't work; see docs/m3-findings.md).
 */
export function formatReference(file: TAbstractFile, format: ReferenceFormat): string {
	const path = file instanceof TFolder ? `${file.path}/` : file.path;
	const quoted = /\s/.test(path) ? `"${path}"` : path;
	return format === "mention" ? `@${quoted}` : quoted;
}

/** A selection as `path:L10-L24` and the selected text as a quote (CTX-5). */
export function formatSelection(file: TFile, fromLine: number, toLine: number, text: string): string {
	const path = /\s/.test(file.path) ? `"${file.path}"` : file.path;
	const range = fromLine === toLine ? `L${fromLine}` : `L${fromLine}-L${toLine}`;
	const quote = text.replace(/\n$/, "").split("\n").map((line) => `> ${line}`).join("\n");
	return `${path}:${range}\n${quote}\n`;
}

/** A path relative to the vault, or null if it's outside. Accepts absolute paths and file:// URLs. */
export function vaultRelative(path: string, vaultPath: string): string | null {
	let abs = path.trim();
	if (abs.startsWith("file://")) {
		try {
			abs = decodeURIComponent(new URL(abs).pathname);
		} catch {
			return null;
		}
	}
	const root = vaultPath.replace(/\/+$/, "");
	if (abs === root) return "";
	return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1).replace(/\/+$/, "") : null;
}

/** Whether text looks like an absolute path or file URL, the kind people paste from Finder or a terminal. */
export function isAbsolutePath(text: string): boolean {
	return /^(\/|~\/|file:\/\/)[^\n]*$/.test(text.trim());
}

// A token starts at the beginning of the text or after whitespace or an
// opening bracket, and is an optional `@` then a quoted or bare path.
const TOKEN = /(@?)(?:"([^"\n]+)"|([^\s"'`()<>[\]{}]+))/g;
const BOUNDARY = /[\s([{<'"`]/;
const LINE_SUFFIX = /:L?(\d+)(?:-L?\d+)?$/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * File and folder references in text: `@`-mentions, quoted paths, and bare
 * paths that contain a `/` or a `.` (so ordinary words that happen to match
 * a folder name aren't picked up). Absolute paths inside the vault count.
 * Only paths that exist in the vault are returned.
 */
export function findReferences(text: string, app: App, vaultPath: string): Reference[] {
	const refs: Reference[] = [];
	for (const m of text.matchAll(TOKEN)) {
		const start = m.index;
		if (start > 0 && !BOUNDARY.test(text[start - 1]!)) continue;
		const mention = m[1] === "@";
		const quoted = m[2] !== undefined;
		let raw = quoted ? m[2]! : m[3]!;
		let end = start + m[0].length;
		if (!mention && !quoted && !/[/.]/.test(raw)) continue;
		let ref = resolve(raw, app, vaultPath);
		// "See Notes/a.md." ends a sentence, not the path.
		if (!ref && !quoted) {
			const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
			if (trimmed && trimmed !== raw) {
				end -= raw.length - trimmed.length;
				raw = trimmed;
				ref = resolve(raw, app, vaultPath);
			}
		}
		if (ref) refs.push({ from: start, to: end, ...ref });
	}
	return refs;
}

/** Resolves one path token, with an optional `:L10` suffix, to a vault file or folder. */
export function resolve(raw: string, app: App, vaultPath: string): Omit<Reference, "from" | "to"> | null {
	let path = raw;
	let line: number | undefined;
	const suffix = LINE_SUFFIX.exec(path);
	if (suffix) {
		line = Number(suffix[1]);
		path = path.slice(0, suffix.index);
	}
	if (path.startsWith("/") || path.startsWith("file://")) {
		const rel = vaultRelative(path, vaultPath);
		if (rel === null || rel === "") return null;
		path = rel;
	}
	const folderHint = path.endsWith("/");
	path = normalizePath(path.replace(/\/+$/, ""));
	if (!path || path === "/") return null;
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile && !folderHint) return { path, folder: false, ...(line ? { line } : {}) };
	if (file instanceof TFolder) return { path, folder: true };
	return null;
}

/**
 * Opens a referenced file, at a line if given, or reveals a folder in the
 * file explorer. Files open in the most recent note pane rather than over
 * the chat; with Mod held, in a new tab (or as Obsidian's modifiers say).
 * `from` is the chat's leaf: a note pane in the same tab group would hide
 * the chat, so the file opens in a split beside it instead.
 */
export async function openReference(app: App, path: string, opts: { line?: number; evt?: MouseEvent; from?: WorkspaceLeaf } = {}): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFolder) {
		revealFolder(app, file);
		return;
	}
	if (!(file instanceof TFile)) return;
	const paneType = opts.evt ? Keymap.isModEvent(opts.evt) : false;
	const leaf = paneType ? app.workspace.getLeaf(paneType as PaneType) : noteLeaf(app, opts.from);
	await leaf.openFile(file, opts.line ? { eState: { line: opts.line - 1 } } : {});
	app.workspace.setActiveLeaf(leaf, { focus: true });
}

/** The most recent pane that shows notes, so opening a file doesn't replace or hide a chat. */
function noteLeaf(app: App, from?: WorkspaceLeaf): WorkspaceLeaf {
	const { workspace } = app;
	const visible = (leaf: WorkspaceLeaf) => leaf.view.navigation && (!from || leaf.parent !== from.parent);
	const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
	if (recent && visible(recent)) return recent;
	let found: WorkspaceLeaf | null = null;
	workspace.iterateRootLeaves((leaf) => {
		if (!found && visible(leaf)) found = leaf;
	});
	if (found) return found;
	return from ? workspace.createLeafBySplit(from, "vertical") : workspace.getLeaf("tab");
}

interface FileExplorerInternals {
	revealInFolder?(file: TAbstractFile): void;
}

interface AppInternals {
	internalPlugins?: { getEnabledPluginById?(id: string): FileExplorerInternals | null };
}

/** Shows a folder in the file explorer. Uses an Obsidian internal; does nothing without it. */
function revealFolder(app: App, folder: TFolder): void {
	(app as App & AppInternals).internalPlugins?.getEnabledPluginById?.("file-explorer")?.revealInFolder?.(folder);
}

/** A clickable reference chip, for sent messages (CTX-9) and output (CTX-10). */
export function createReferenceEl(parent: HTMLElement | DocumentFragment, text: string, ref: Pick<Reference, "path" | "folder" | "line">, tag: "span" | "a" = "span"): HTMLElement {
	const el = createEl(tag, { cls: "apollo-ref", text });
	el.dataset.path = ref.path;
	if (ref.line) el.dataset.line = String(ref.line);
	el.setAttr("aria-label", ref.folder ? `Reveal ${ref.path}` : `Open ${ref.path}`);
	parent.appendChild(el);
	return el;
}

/** Writes text into `el`, with references as chips (CTX-9). */
export function renderWithReferences(el: HTMLElement, text: string, app: App, vaultPath: string): void {
	let last = 0;
	for (const ref of findReferences(text, app, vaultPath)) {
		if (ref.from > last) el.appendText(text.slice(last, ref.from));
		const chip = createReferenceEl(el, "", ref);
		setIcon(chip.createSpan({ cls: "apollo-ref-icon" }), ref.folder ? "folder" : "file-text");
		chip.appendText(text.slice(ref.from, ref.to));
		last = ref.to;
	}
	if (last < text.length) el.appendText(text.slice(last));
}

/**
 * Makes vault paths in rendered Markdown clickable (CTX-10): inline code
 * that is a path, and paths in plain text. Links and code blocks are left
 * alone.
 */
export function linkifyPaths(root: HTMLElement, app: App, vaultPath: string): void {
	for (const code of Array.from(root.querySelectorAll("code"))) {
		if (code.closest("pre, a")) continue;
		const ref = resolve(code.textContent?.trim() ?? "", app, vaultPath);
		if (!ref) continue;
		code.addClass("apollo-ref");
		code.dataset.path = ref.path;
		if (ref.line) code.dataset.line = String(ref.line);
	}
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => (node.parentElement?.closest("a, code, pre, .apollo-ref") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	});
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	for (const node of nodes) {
		const text = node.data;
		if (!/[/.]/.test(text)) continue;
		const refs = findReferences(text, app, vaultPath);
		if (!refs.length) continue;
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const ref of refs) {
			if (ref.from > last) frag.appendText(text.slice(last, ref.from));
			createReferenceEl(frag, text.slice(ref.from, ref.to), ref, "a");
			last = ref.to;
		}
		if (last < text.length) frag.appendText(text.slice(last));
		node.replaceWith(frag);
	}
}
