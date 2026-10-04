import { TFile, WorkspaceTabs, resolveSubpath, type WorkspaceSplit, setIcon, setTooltip, type App, type EventRef, type WorkspaceLeaf } from "obsidian";
import type { ApolloSettings } from "./settings";
import type { PresentRequest } from "./vault-tools";

/** Obsidian internals the public API doesn't expose. May be missing. */
interface LeafInternals {
	tabHeaderEl?: HTMLElement;
	/** When the leaf was last active, in ms. */
	activeTime?: number;
}

/**
 * Opens notes for the user to look at, on behalf of one chat (OBS-14 to
 * OBS-19). Remembers the chat's presentation pane, the leaf it opened notes
 * in before, so repeated presents reuse it instead of piling up splits.
 */
export class Presenter {
	private pane: WorkspaceLeaf | null = null;
	private pinnedRef: EventRef | null = null;
	private marker: HTMLElement | null = null;
	/** Presents so far this turn (OBS-18). */
	private count = 0;
	/** Bumped by every present, so a late auto-present can tell it's been overtaken. */
	private seq = 0;

	constructor(
		private readonly app: App,
		private readonly settings: () => ApolloSettings,
		/** The leaf hosting the chat; placement is worked out relative to it. */
		private readonly chatLeaf: WorkspaceLeaf,
		/** The chat's title, for the presentation pane's tooltip. */
		private readonly chatTitle: () => string,
	) {}

	/** Resets the per-turn limit. Called when the chat sends a message. */
	newTurn(): void {
		this.count = 0;
	}

	/** The note in the presentation pane, if the pane is still open. */
	presentationPath(): string | null {
		const pane = this.livePane();
		return pane ? (this.fileOf(pane) ?? null) : null;
	}

	/**
	 * Opens a note per OBS-15 and returns what to tell the agent. Throws if
	 * there's no such note.
	 */
	async present(path: string, req: PresentRequest = {}): Promise<string> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`No file at ${path} in the vault.`);
		this.seq++;
		const max = this.settings().presentMaxPerTurn;
		if (this.count >= max) {
			return `Not opened: already showed ${max} ${max === 1 ? "note" : "notes"} this turn, the limit set in Apollo. List ${file.path} and any other notes as links in your reply instead.`;
		}
		this.count++;

		const { line, missing } = this.scrollLine(file, req);
		const eState = line === undefined ? undefined : { line };
		const focus = this.settings().presentFocus;
		const placement = req.placement ?? this.settings().presentPlacement;
		const { workspace } = this.app;
		// Creating a leaf makes it active; put focus back afterwards unless asked to move it (OBS-16).
		const prevLeaf = workspace.activeLeaf;
		const prevEl = activeDocument.activeElement;

		let leaf: WorkspaceLeaf;
		let how: string;
		const existing = this.findOpen(file);
		if (existing) {
			// (1) Never open a note twice.
			leaf = existing;
			await leaf.loadIfDeferred();
			if (eState) leaf.setEphemeralState(eState);
			how = "It was already open, so its tab was brought to the front";
		} else {
			const reuse = placement !== "tab" ? this.livePane() : null;
			if (reuse) {
				// (2) This chat's presentation pane, replacing its note.
				leaf = reuse;
				how = "Opened in the pane beside the chat, replacing the note shown there";
			} else {
				const near = placement !== "beside" ? this.recentNoteLeaf() : null;
				if (near) {
					// (3) A new tab beside the user's most recent note.
					leaf = this.tabAfter(near);
					how = "Opened in a new tab next to the user's notes";
				} else if (placement === "tab" && !this.inSidebar()) {
					leaf = this.tabAfter(this.chatLeaf);
					how = "Opened in a new tab next to the chat";
				} else {
					// (4) Split the chat, or for a sidebar chat, a tab in the main area.
					leaf = this.splitLeaf();
					how = "Opened beside the chat";
				}
				if (placement !== "tab") this.setPane(leaf);
			}
			await leaf.openFile(file, { active: focus, ...(eState ? { eState } : {}) });
		}
		await workspace.revealLeaf(leaf);
		if (focus) {
			workspace.setActiveLeaf(leaf, { focus: true });
		} else {
			if (prevLeaf && workspace.activeLeaf !== prevLeaf) workspace.setActiveLeaf(prevLeaf, { focus: false });
			if (prevEl instanceof HTMLElement && prevEl.isConnected && activeDocument.activeElement !== prevEl) prevEl.focus();
		}
		const where = line === undefined ? "" : req.heading && !missing ? ` at ${req.heading}` : ` at line ${line + 1}`;
		const note = missing ? ` No heading or block "${req.heading}" was found, so it opened at the top.` : "";
		return `${how}: ${file.path}${where}.${note}`;
	}

	/**
	 * Presents a note the agent just wrote (OBS-19), once Obsidian has picked
	 * it up. Gives way to any present made in the meantime, so it never
	 * replaces a note the agent chose to show.
	 */
	async presentNew(path: string): Promise<void> {
		const seq = this.seq;
		for (let waited = 0; !this.app.vault.getFileByPath(path) && waited < 3000; waited += 100) await sleep(100);
		if (seq !== this.seq || !this.app.vault.getFileByPath(path)) return;
		await this.present(path);
	}

	/** Forgets the presentation pane. Called when the chat closes. */
	close(): void {
		this.setPane(null);
	}

	/** The 0-based line for a heading, block or line request. */
	private scrollLine(file: TFile, req: PresentRequest): { line?: number; missing?: boolean } {
		if (req.heading) {
			const cache = this.app.metadataCache.getFileCache(file);
			const subpath = req.heading.startsWith("#") ? req.heading : `#${req.heading}`;
			const found = cache ? resolveSubpath(cache, subpath) : null;
			if (found) return { line: found.start.line };
			if (!req.line) return { missing: true };
		}
		return req.line ? { line: req.line - 1 } : {};
	}

	/** A leaf already showing the file. Prefers one the chat won't hide by revealing. */
	private findOpen(file: TFile): WorkspaceLeaf | null {
		const matches: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.fileOf(leaf) === file.path) matches.push(leaf);
		});
		// A tab in the chat's own tab group would replace the chat on screen; show a copy beside it instead.
		return matches.find((leaf) => leaf.parent !== this.chatLeaf.parent || this.inSidebar()) ?? null;
	}

	private fileOf(leaf: WorkspaceLeaf): string | undefined {
		const view = leaf.view as { file?: TFile | null };
		if (view.file instanceof TFile) return view.file.path;
		const state = leaf.getViewState().state?.file;
		return typeof state === "string" ? state : undefined;
	}

	/** The presentation pane, unless it has been closed, pinned or dragged next to the chat. */
	private livePane(): WorkspaceLeaf | null {
		const pane = this.pane;
		if (!pane) return null;
		let attached = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf === pane) attached = true;
		});
		if (!attached || pane.getViewState().pinned || (pane.parent === this.chatLeaf.parent && !this.inSidebar())) {
			this.setPane(null);
			return null;
		}
		return pane;
	}

	/** The most recently active unpinned note in the main area, outside the chat's tab group. */
	private recentNoteLeaf(): WorkspaceLeaf | null {
		const { workspace } = this.app;
		let best: WorkspaceLeaf | null = null;
		let bestTime = -1;
		workspace.iterateRootLeaves((leaf) => {
			if (leaf.getRoot() !== workspace.rootSplit) return;
			if (leaf.getViewState().type !== "markdown" || leaf.getViewState().pinned) return;
			if (!(leaf.parent instanceof WorkspaceTabs)) return;
			if (!this.inSidebar() && leaf.parent === this.chatLeaf.parent) return;
			const time = (leaf as WorkspaceLeaf & LeafInternals).activeTime ?? 0;
			if (time > bestTime) {
				best = leaf;
				bestTime = time;
			}
		});
		return best;
	}

	private inSidebar(): boolean {
		const root = this.chatLeaf.getRoot();
		return root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit;
	}

	private splitLeaf(): WorkspaceLeaf {
		const { workspace } = this.app;
		if (!this.inSidebar()) return workspace.createLeafBySplit(this.chatLeaf, "vertical");
		const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
		return recent?.parent instanceof WorkspaceTabs ? this.tabAfter(recent) : workspace.getLeaf("tab");
	}

	/** A new tab right after `leaf`, in its tab group. */
	private tabAfter(leaf: WorkspaceLeaf): WorkspaceLeaf {
		// The public signature asks for a split, but a tab group works, and `children` is internal.
		const group = leaf.parent as unknown as WorkspaceSplit & { children?: unknown[] };
		const index = group.children?.indexOf(leaf) ?? -1;
		return this.app.workspace.createLeafInParent(group, index === -1 ? 0 : index + 1);
	}

	/** Marks a leaf as the presentation pane (OBS-17), or clears the mark. */
	private setPane(leaf: WorkspaceLeaf | null): void {
		if (this.pane === leaf) return;
		if (this.pinnedRef) this.pane?.offref(this.pinnedRef);
		this.pinnedRef = null;
		this.marker?.remove();
		this.marker = null;
		if (this.pane) tabHeader(this.pane)?.removeClass("apollo-presentation");
		this.pane = leaf;
		if (!leaf) return;
		// Pinning takes the pane out of reuse.
		this.pinnedRef = leaf.on("pinned-change", (pinned) => pinned && this.setPane(null));
		const header = tabHeader(leaf);
		if (!header) return;
		header.addClass("apollo-presentation");
		this.marker = createSpan({ cls: "apollo-presentation-marker" });
		setIcon(this.marker, "bot");
		setTooltip(this.marker, `Apollo shows notes for “${this.chatTitle()}” here. Pin the tab to keep it.`);
		const title = header.querySelector(".workspace-tab-header-inner-title");
		if (title) title.after(this.marker);
		else header.appendChild(this.marker);
	}
}

function tabHeader(leaf: WorkspaceLeaf): HTMLElement | undefined {
	return (leaf as WorkspaceLeaf & LeafInternals).tabHeaderEl;
}
