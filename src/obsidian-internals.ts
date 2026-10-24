import type { App, EventRef, Menu, TAbstractFile, View, WorkspaceLeaf } from "obsidian";

/**
 * Every Obsidian API that isn't public, in one place, so an Obsidian update
 * has one file to check. Each one is typed as optional and every accessor
 * tolerates it being missing. Shapes that belong to one tool, such as
 * Dataview's API, stay with that tool in vault-tools.ts.
 */

interface LeafInternals {
	tabHeaderEl?: HTMLElement;
	/** Refreshes the tab header's icon and title from the view, not the view header. */
	updateHeader?(): void;
	/** When the leaf was last active, in ms. */
	activeTime?: number;
}

interface ViewInternals {
	/** The view header's title. */
	titleEl?: HTMLElement;
}

/** A deferred tab's stand-in view, which shows the icon and title saved with the layout. */
interface DeferredViewInternals {
	icon?: string;
	title?: string;
}

interface VaultInternals {
	/** Values from `.obsidian/app.json`, such as `readableLineLength`. */
	getConfig?(key: string): unknown;
	/** Fires with the key after a setting changes. */
	on(name: "config-changed", callback: (key: string) => unknown): EventRef;
}

export interface Draggable {
	type?: string;
	file?: TAbstractFile;
	files?: TAbstractFile[];
	linktext?: string;
	sourcePath?: string;
}

interface AppInternals {
	hotkeyManager?: { printHotkeyForCommand?(id: string): string };
	dragManager?: { draggable?: Draggable | null };
	internalPlugins?: { getEnabledPluginById?(id: string): unknown };
	plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> };
	cli?: { handlers?: Map<string, { handler?(flags: Record<string, unknown>): Promise<unknown> }> };
}

interface MenuInternals {
	items?: { section?: string }[];
	/** Section order, from `addSections`. */
	sections?: string[];
}

interface RibbonInternals {
	items?: { icon: string; buttonEl?: HTMLElement }[];
}

const asApp = (app: App) => app as App & AppInternals;
const asLeaf = (leaf: WorkspaceLeaf) => leaf as WorkspaceLeaf & LeafInternals;

/** The leaf's tab header element, for status attributes and the presentation marker. */
export function tabHeaderEl(leaf: WorkspaceLeaf): HTMLElement | undefined {
	return asLeaf(leaf).tabHeaderEl;
}

/** Redraws the tab header's icon and title from the view. */
export function refreshTabHeader(leaf: WorkspaceLeaf): void {
	asLeaf(leaf).updateHeader?.();
}

/** When the leaf was last active, in ms, or 0. */
export function leafActiveTime(leaf: WorkspaceLeaf): number {
	return asLeaf(leaf).activeTime ?? 0;
}

/** The view header's title element, which the chat makes editable. */
export function viewTitleEl(view: View): HTMLElement | undefined {
	return (view as View & ViewInternals).titleEl;
}

/** A deferred view's icon and title, which are writable, or undefined for a loaded view that has neither. */
export function deferredHeader(view: View): DeferredViewInternals {
	return view as View & DeferredViewInternals;
}

/** A value from `.obsidian/app.json`, such as `readableLineLength`. */
export function vaultConfig(app: App, key: string): unknown {
	return (app.vault as App["vault"] & VaultInternals).getConfig?.(key);
}

/** Calls back with the key after a setting in `.obsidian/app.json` changes. */
export function onVaultConfigChanged(app: App, callback: (key: string) => void): EventRef {
	return (app.vault as App["vault"] & VaultInternals).on("config-changed", callback);
}

/** A core plugin's instance, if it is enabled. Its shape is the caller's to know. */
export function internalPlugin<T>(app: App, id: string): T | null {
	return (asApp(app).internalPlugins?.getEnabledPluginById?.(id) as T | null | undefined) ?? null;
}

/** A community plugin's instance, if it is enabled. */
export function communityPlugin<T>(app: App, id: string): T | null {
	const plugins = asApp(app).plugins;
	return plugins?.enabledPlugins?.has(id) ? ((plugins.plugins?.[id] as T | undefined) ?? null) : null;
}

/** One of Obsidian's CLI command handlers, such as `base:query`. */
export function cliHandler(app: App, name: string): ((flags: Record<string, unknown>) => Promise<unknown>) | null {
	const entry = asApp(app).cli?.handlers?.get(name);
	return entry?.handler ? (flags) => entry.handler!(flags) : null;
}

/** The hotkey bound to a command, as text, or undefined if there is none. */
export function printHotkey(app: App, commandId: string): string | undefined {
	return asApp(app).hotkeyManager?.printHotkeyForCommand?.(commandId);
}

/** What is being dragged now, such as a file from the explorer. */
export function draggedItem(app: App): Draggable | null {
	return asApp(app).dragManager?.draggable ?? null;
}

/** The sections the menu's items already use. */
export function usedMenuSections(menu: Menu): Set<string | undefined> {
	return new Set((menu as Menu & MenuInternals).items?.map((i) => i.section));
}

/** The menu's section order, or undefined if Obsidian doesn't expose it. */
export function menuSectionOrder(menu: Menu): string[] | undefined {
	return (menu as Menu & MenuInternals).sections;
}

/** Sets the icon on the left ribbon's own copy of a button, which it keeps for its menu and redraws. */
export function setRibbonItemIcon(app: App, buttonEl: HTMLElement, icon: string): void {
	const ribbon = app.workspace.leftRibbon as unknown as RibbonInternals;
	const item = ribbon.items?.find((i) => i.buttonEl === buttonEl);
	if (item) item.icon = icon;
}

/** The index of a leaf in its tab group, or -1. */
export function indexInTabGroup(group: unknown, leaf: WorkspaceLeaf): number {
	return (group as { children?: unknown[] }).children?.indexOf(leaf) ?? -1;
}
