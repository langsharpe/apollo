import { TFile, type App, type WorkspaceLeaf } from "obsidian";

/** The path of the file a leaf shows: from its view, or for a deferred tab from its saved state. */
export function leafFilePath(leaf: WorkspaceLeaf): string | undefined {
	const view = leaf.view as { file?: TFile | null };
	if (view.file instanceof TFile) return view.file.path;
	const saved = leaf.getViewState().state?.file;
	return typeof saved === "string" ? saved : undefined;
}

/** Whether the leaf is in the left or right sidebar. */
export function isInSidebar(app: App, leaf: WorkspaceLeaf): boolean {
	const root = leaf.getRoot();
	return root === app.workspace.leftSplit || root === app.workspace.rightSplit;
}
