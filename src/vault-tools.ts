import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
	FileView,
	MarkdownView,
	TFile,
	TFolder,
	getAllTags,
	moment,
	normalizePath,
	parseLinktext,
	type App,
	type CachedMetadata,
	type TAbstractFile,
} from "obsidian";
import { z } from "zod";
import { vaultRelative } from "./references";

/** The MCP server's name. Its tools reach Claude Code as `mcp__apollo__<tool>`. */
export const VAULT_SERVER = "apollo";
export const VAULT_TOOL_PREFIX = `mcp__${VAULT_SERVER}__`;

export type PresentPlacementHint = "auto" | "beside" | "tab";

export interface PresentRequest {
	heading?: string;
	line?: number;
	placement?: PresentPlacementHint;
}

/** What the tools need from the chat that runs them. */
export interface ToolHost {
	app: App;
	vaultPath: string;
	/** Tool names turned off in settings. */
	disabled: readonly string[];
	/** Opens a note for the user (OBS-14). Returns what to tell the agent. */
	present(path: string, req: PresentRequest): Promise<string>;
	/** The note in this chat's presentation pane, if it has one. */
	presentationPath(): string | null;
}

export interface ToolInfo {
	name: string;
	/** For the settings list. */
	summary: string;
	/** Read-only tools run without a permission prompt. */
	readOnly: boolean;
	/** Loaded up front rather than deferred behind tool search (OBS-12). */
	alwaysLoad?: boolean;
	/** Bridges (OBS-10): the plugin they need, for the settings list. */
	requires?: string;
	/** Bridges are offered only when this is true at session start. */
	available?(app: App): boolean;
}

/** Every Obsidian tool, in the order settings lists them. */
export const OBSIDIAN_TOOLS: readonly ToolInfo[] = [
	{ name: "vault_links", summary: "Outgoing links, backlinks and unresolved links of a note, as Obsidian resolves them.", readOnly: true, alwaysLoad: true },
	{ name: "vault_outline", summary: "Headings, block IDs, tags, embeds and frontmatter of a note, without its body.", readOnly: true },
	{ name: "vault_frontmatter", summary: "Read, set or remove frontmatter properties, written by Obsidian so the YAML stays valid.", readOnly: false, alwaysLoad: true },
	{ name: "vault_tags", summary: "Add or remove tags in a note's frontmatter.", readOnly: false },
	{ name: "vault_query", summary: "Find notes by tags, folder, properties and links.", readOnly: true },
	{ name: "vault_move", summary: "Rename or move a note or folder, updating links to it.", readOnly: false, alwaysLoad: true },
	{ name: "vault_trash", summary: "Delete a note or folder the way Obsidian does, following your Deleted files setting.", readOnly: false },
	{ name: "workspace_context", summary: "The active note, open tabs and the current editor selection.", readOnly: true },
	{ name: "workspace_present", summary: "Open a note for you to look at, beside the chat.", readOnly: true },
	{ name: "dataview_query", summary: "Run a Dataview (DQL) query.", readOnly: true, requires: "Dataview", available: (app) => !!dataviewApi(app) },
	{
		name: "template_create",
		summary: "Create a note from a template.",
		readOnly: false,
		requires: "Templater or core Templates",
		available: (app) => !!templater(app) || !!coreTemplates(app),
	},
	{ name: "daily_note", summary: "The path of today's (or another day's) daily note.", readOnly: true, requires: "core Daily notes", available: (app) => !!dailyNotes(app) },
	{ name: "bases_query", summary: "List bases, or the rows of a base view.", readOnly: true, requires: "core Bases", available: (app) => !!basesQuery(app) },
];

/**
 * Shown to the model with the tools (OBS-11). Stands in for the Apollo
 * output style until there is one. Shell equivalents stay allowed.
 */
const INSTRUCTIONS = [
	"These tools run inside Obsidian and see the vault the way Obsidian does: links resolved by Obsidian, frontmatter and tags from its metadata cache.",
	"Paths are relative to the vault root; absolute paths inside the vault also work.",
	"To rename or move notes prefer vault_move over mv, since it updates links to them. To delete prefer vault_trash over rm, since it follows the user's trash setting.",
	"To change properties or tags prefer vault_frontmatter and vault_tags over editing YAML by hand.",
	"Use workspace_present to show the user a note you want them to look at.",
].join(" ");

/** Bridge plugins are checked once per session, so results can be cached per server. */
export interface VaultServer {
	server: McpSdkServerConfigWithInstance;
	/** Full names of the read-only tools on it, for `allowedTools`. */
	readOnlyTools: string[];
}

/** The in-process MCP server for one chat's Claude Code process. */
export function createVaultServer(host: ToolHost): VaultServer {
	const infos = OBSIDIAN_TOOLS.filter((t) => !host.disabled.includes(t.name) && (t.available?.(host.app) ?? true));
	const defs = toolDefinitions(host);
	const tools = infos.map((t) => defs[t.name as ToolName]);
	return {
		server: createSdkMcpServer({ name: VAULT_SERVER, version: "1.0.0", instructions: INSTRUCTIONS, tools }),
		readOnlyTools: infos.filter((t) => t.readOnly).map((t) => VAULT_TOOL_PREFIX + t.name),
	};
}

type ToolName =
	| "vault_links"
	| "vault_outline"
	| "vault_frontmatter"
	| "vault_tags"
	| "vault_query"
	| "vault_move"
	| "vault_trash"
	| "workspace_context"
	| "workspace_present"
	| "dataview_query"
	| "template_create"
	| "daily_note"
	| "bases_query";

/** A failure to report to the agent as a tool error. */
class ToolError extends Error {}

/** Thrown inside processFrontMatter to skip the write when nothing changes. */
class NoChange extends Error {}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const json = (value: unknown): Result => text(JSON.stringify(value, null, 2));

/** Wraps a handler so thrown errors come back as tool errors rather than failing the call. */
function handle<A>(fn: (args: A) => Promise<Result>): (args: A) => Promise<Result> {
	return async (args) => {
		try {
			return await fn(args);
		} catch (err) {
			return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
		}
	};
}

/** Longest text result, so a big query doesn't flood the context. */
const MAX_OUTPUT = 20_000;

function clip(value: string): string {
	return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n… (cut at ${MAX_OUTPUT} characters)` : value;
}

const pathArg = z.string().describe("Vault-relative path, such as Projects/Plan.md. Absolute paths inside the vault and link text such as Plan also work.");

function toolDefinitions(host: ToolHost) {
	const { app } = host;
	const files = new VaultFiles(app, host.vaultPath);
	const ro = (title: string) => ({ annotations: { title, readOnlyHint: true, openWorldHint: false } });
	const rw = (title: string, destructive = false) => ({ annotations: { title, readOnlyHint: false, destructiveHint: destructive, openWorldHint: false } });
	const alwaysLoad = (name: ToolName) => OBSIDIAN_TOOLS.find((t) => t.name === name)?.alwaysLoad ?? false;

	return {
		vault_links: tool(
			"vault_links",
			"Links of a note as Obsidian resolves them (aliases, heading links, relative paths): outgoing links with their heading or block subpaths, unresolved links, and backlinks from other notes. Faster and more accurate than grepping for [[links]].",
			{ path: pathArg },
			handle(async ({ path }) => {
				const file = files.file(path);
				const { resolvedLinks, unresolvedLinks } = app.metadataCache;
				const subpaths = new Map<string, Set<string>>();
				const embedded = new Set<string>();
				const cache = app.metadataCache.getFileCache(file);
				const refs = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
				for (const [ref, embed] of [...refs.map((r) => [r, false] as const), ...(cache?.embeds ?? []).map((r) => [r, true] as const)]) {
					const { path: linkpath, subpath } = parseLinktext(ref.link);
					const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, file.path) : file;
					if (!dest) continue;
					if (embed) embedded.add(dest.path);
					if (subpath) (subpaths.get(dest.path) ?? subpaths.set(dest.path, new Set()).get(dest.path)!).add(subpath);
				}
				const outgoing = Object.entries(resolvedLinks[file.path] ?? {}).map(([target, count]) => ({
					path: target,
					count,
					...(subpaths.has(target) ? { subpaths: [...subpaths.get(target)!] } : {}),
					...(embedded.has(target) ? { embedded: true } : {}),
				}));
				const unresolved = Object.entries(unresolvedLinks[file.path] ?? {}).map(([link, count]) => ({ link, count }));
				const backlinks = Object.entries(resolvedLinks)
					.filter(([source, targets]) => source !== file.path && targets[file.path])
					.map(([source, targets]) => ({ path: source, count: targets[file.path]! }));
				return json({ path: file.path, outgoing, unresolved, backlinks });
			}),
			{ ...ro("Note links"), alwaysLoad: alwaysLoad("vault_links") },
		),

		vault_outline: tool(
			"vault_outline",
			"Structure of a note without its body: frontmatter, headings, block IDs, tags and embeds, with 1-based line numbers. Use it to find where to read or edit in a long note.",
			{ path: pathArg },
			handle(async ({ path }) => {
				const file = files.note(path);
				const cache = files.cache(file);
				const line = (item: { position: { start: { line: number } } }) => item.position.start.line + 1;
				return json({
					path: file.path,
					frontmatter: cache.frontmatter ?? null,
					headings: (cache.headings ?? []).map((h) => ({ level: h.level, heading: h.heading, line: line(h) })),
					blocks: Object.values(cache.blocks ?? {}).map((b) => ({ id: b.id, line: line(b) })),
					tags: (cache.tags ?? []).map((t) => ({ tag: t.tag, line: line(t) })),
					embeds: (cache.embeds ?? []).map((e) => ({
						link: e.link,
						target: app.metadataCache.getFirstLinkpathDest(parseLinktext(e.link).path, file.path)?.path ?? null,
						line: line(e),
					})),
					links: cache.links?.length ?? 0,
				});
			}),
			ro("Note outline"),
		),

		vault_frontmatter: tool(
			"vault_frontmatter",
			"Reads or edits a note's frontmatter properties through Obsidian, so the YAML stays valid and formatted the way Obsidian writes it. With neither set nor remove, returns the current properties. The way to add metadata to notes as you work.",
			{
				path: pathArg,
				set: z.record(z.string(), z.any()).optional().describe("Properties to add or change, such as {\"status\": \"draft\", \"aliases\": [\"Plan\"]}. null makes a property empty."),
				remove: z.array(z.string()).optional().describe("Property names to remove."),
			},
			handle(async ({ path, set, remove }) => {
				const file = files.note(path);
				if (!set && !remove?.length) return json({ path: file.path, frontmatter: app.metadataCache.getFileCache(file)?.frontmatter ?? {} });
				const both = Object.keys(set ?? {}).filter((k) => remove?.includes(k));
				if (both.length) throw new ToolError(`Can't both set and remove ${both.join(", ")}.`);
				const changes: string[] = [];
				await processFrontMatter(app, file, (fm) => {
					for (const key of remove ?? []) {
						if (!(key in fm)) continue;
						changes.push(`${key}: ${show(fm[key])} → (removed)`);
						delete fm[key];
					}
					for (const [key, value] of Object.entries(set ?? {})) {
						if (key in fm && same(fm[key], value)) continue;
						changes.push(`${key}: ${key in fm ? show(fm[key]) : "(unset)"} → ${show(value)}`);
						fm[key] = value;
					}
					return changes.length > 0;
				});
				return text(changes.length ? `Frontmatter of ${q(file.path)}:\n${changes.join("\n")}` : `No changes: the frontmatter of ${q(file.path)} already matches.`);
			}),
			{ ...rw("Edit frontmatter"), alwaysLoad: alwaysLoad("vault_frontmatter") },
		),

		vault_tags: tool(
			"vault_tags",
			"Adds or removes tags in a note's frontmatter `tags` property. Tags are normalised to Obsidian's rules: no #, spaces become hyphens, nested tags use /. Tags written inline in the body aren't changed.",
			{
				path: pathArg,
				add: z.array(z.string()).optional().describe("Tags to add, such as [\"project/apollo\", \"draft\"]."),
				remove: z.array(z.string()).optional().describe("Tags to remove."),
			},
			handle(async ({ path, add, remove }) => {
				const file = files.note(path);
				const invalid: string[] = [];
				const norm = (list: string[] | undefined) =>
					(list ?? []).flatMap((raw) => {
						const tag = normaliseTag(raw);
						if (!tag) invalid.push(raw);
						return tag ? [tag] : [];
					});
				const toAdd = norm(add);
				const toRemove = norm(remove).map((t) => t.toLowerCase());
				if (!toAdd.length && !toRemove.length) throw new ToolError(invalid.length ? `Not valid tags: ${invalid.join(", ")}.` : "Give tags to add or remove.");
				let before: string[] = [];
				let after: string[] = [];
				await processFrontMatter(app, file, (fm) => {
					before = tagList(fm.tags);
					after = before.filter((t) => !toRemove.includes(t.toLowerCase()));
					for (const tag of toAdd) if (!after.some((t) => t.toLowerCase() === tag.toLowerCase())) after.push(tag);
					if (same(before, after)) return false;
					if (after.length) fm.tags = after;
					else delete fm.tags;
					return true;
				});
				const lines = [same(before, after) ? `No changes: tags of ${q(file.path)} are ${show(before)}.` : `Tags of ${q(file.path)}: ${show(before)} → ${show(after)}`];
				const inline = (app.metadataCache.getFileCache(file)?.tags ?? []).map((t) => t.tag.slice(1)).filter((t) => toRemove.includes(t.toLowerCase()));
				if (inline.length) lines.push(`Still tagged inline in the body: ${[...new Set(inline)].map((t) => `#${t}`).join(", ")}. Edit the body to remove those.`);
				if (invalid.length) lines.push(`Ignored, not valid tags: ${invalid.join(", ")}.`);
				return text(lines.join("\n"));
			}),
			rw("Edit tags"),
		),

		vault_query: tool(
			"vault_query",
			"Finds notes by metadata and links, newest first. Returns paths only. Criteria combine with AND. Also says how many notes in scope have no frontmatter or tags, since those can only be found by content: use Grep for them.",
			{
				tags: z.array(z.string()).optional().describe("Notes must have all of these tags, in frontmatter or inline. A tag also matches its nested tags (project matches project/apollo)."),
				folder: z.string().optional().describe("Only notes in this folder or below it."),
				frontmatter: z
					.record(z.string(), z.any())
					.optional()
					.describe("Property values to match, such as {\"status\": \"draft\"}. Strings match case-insensitively; a list property matches if it contains the value. null matches any note that has the property."),
				linksTo: z.string().optional().describe("Only notes that link to this note (path or link text)."),
				limit: z.number().int().min(1).max(500).optional().describe("Most paths to return. Default 100."),
			},
			handle(async ({ tags, folder, frontmatter, linksTo, limit }) => {
				let scope = app.vault.getMarkdownFiles();
				let folderPath = "";
				if (folder) {
					folderPath = files.relative(folder);
					if (folderPath && !(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) throw new ToolError(`No folder at ${folder}.`);
					if (folderPath) scope = scope.filter((f) => f.path.startsWith(`${folderPath}/`));
				}
				const wantTags = (tags ?? []).map((t) => normaliseTag(t)?.toLowerCase()).filter((t): t is string => !!t);
				let linkSources: Set<string> | null = null;
				if (linksTo) {
					const target = files.find(linksTo);
					const { resolvedLinks, unresolvedLinks } = app.metadataCache;
					linkSources = new Set();
					if (target) {
						for (const [source, targets] of Object.entries(resolvedLinks)) if (targets[target.path]) linkSources.add(source);
					} else {
						const name = linksTo.replace(/\.md$/i, "").toLowerCase();
						for (const [source, links] of Object.entries(unresolvedLinks)) {
							if (Object.keys(links).some((l) => l.toLowerCase() === name || l.toLowerCase().split("/").pop() === name)) linkSources.add(source);
						}
					}
				}
				let withoutFrontmatter = 0;
				let withoutTags = 0;
				const matches: TFile[] = [];
				for (const file of scope) {
					const cache = app.metadataCache.getFileCache(file);
					const fm = cache?.frontmatter;
					const noteTags = (cache ? (getAllTags(cache) ?? []) : []).map((t) => t.slice(1).toLowerCase());
					if (!fm || !Object.keys(fm).length) withoutFrontmatter++;
					if (!noteTags.length) withoutTags++;
					if (linkSources && !linkSources.has(file.path)) continue;
					if (!wantTags.every((want) => noteTags.some((t) => t === want || t.startsWith(`${want}/`)))) continue;
					if (frontmatter && !Object.entries(frontmatter).every(([key, want]) => fm && key in fm && (want === null || matchesValue(fm[key], want)))) continue;
					matches.push(file);
				}
				matches.sort((a, b) => b.stat.mtime - a.stat.mtime);
				const max = limit ?? 100;
				const result: Record<string, unknown> = {
					matches: matches.slice(0, max).map((f) => f.path),
					total: matches.length,
					scope: { folder: folderPath || "/", notes: scope.length, withoutFrontmatter, withoutTags },
				};
				if (matches.length > max) result.truncated = `Showing ${max} of ${matches.length}. Raise limit or narrow the query.`;
				if ((wantTags.length || frontmatter) && (withoutFrontmatter || withoutTags)) {
					result.note = `${withoutFrontmatter} of ${scope.length} notes in scope have no frontmatter and ${withoutTags} have no tags, so a metadata query can't find them. Use Grep to search their content.`;
				}
				return json(result);
			}),
			ro("Query notes"),
		),

		vault_move: tool(
			"vault_move",
			"Renames or moves a note, file or folder through Obsidian, which updates links to it across the vault. Prefer this over mv. Missing parent folders are created. If `to` is an existing folder or ends in /, the item moves into it keeping its name.",
			{
				from: pathArg,
				to: z.string().describe("New vault-relative path, such as Archive/Plan.md. The extension may be left off."),
			},
			handle(async ({ from, to }) => {
				const item = files.item(from);
				let dest = files.relative(to);
				if (!dest) throw new ToolError("Give a destination path.");
				if (to.endsWith("/") || app.vault.getAbstractFileByPath(dest) instanceof TFolder) dest = normalizePath(`${dest}/${item.name}`);
				else if (item instanceof TFile && !dest.toLowerCase().endsWith(`.${item.extension.toLowerCase()}`)) dest = `${dest}.${item.extension}`;
				if (dest === item.path) return text(`${item.path} is already there.`);
				if (item instanceof TFolder && dest.startsWith(`${item.path}/`)) throw new ToolError("Can't move a folder into itself.");
				// A change of case only is the same file on a case-insensitive disk.
				if (app.vault.getAbstractFileByPath(dest) && dest.toLowerCase() !== item.path.toLowerCase()) throw new ToolError(`${dest} already exists.`);
				const linking = files.linkingNotes(item);
				const old = item.path;
				await files.ensureFolder(parentOf(dest));
				await app.fileManager.renameFile(item, dest);
				const links = linking.size ? `Updated links in ${plural(linking.size, "note")}.` : "No other notes linked to it.";
				return text(`Moved ${q(old)} → ${q(dest)}. ${links}`);
			}),
			{ ...rw("Move or rename"), alwaysLoad: alwaysLoad("vault_move") },
		),

		vault_trash: tool(
			"vault_trash",
			"Deletes a note, file or folder through Obsidian, following the user's Deleted files setting (system trash, the vault's .trash folder, or permanent). Prefer this over rm.",
			{ path: pathArg },
			handle(async ({ path }) => {
				const item = files.item(path);
				const linking = files.linkingNotes(item);
				const count = item instanceof TFolder ? countFiles(item) : 0;
				await app.fileManager.trashFile(item);
				const where = TRASH_TEXT[getConfig(app, "trashOption") as string] ?? "moved to the trash, per the Deleted files setting";
				const what = item instanceof TFolder ? `${q(item.path)} (${plural(count, "file")})` : q(item.path);
				const links = linking.size ? ` ${plural(linking.size, "note")} linked to it; those links are now unresolved.` : "";
				return text(`Trashed ${what}: ${where}.${links}`);
			}),
			rw("Trash", true),
		),

		workspace_context: tool(
			"workspace_context",
			"What the user has open in Obsidian: the active note, the open tabs, and the text selected in the active note's editor, if any.",
			{},
			handle(async () => {
				const { workspace } = app;
				const active = workspace.getActiveFile();
				const tabs: { path: string; active?: true; pinned?: true; presentation?: true }[] = [];
				const presentation = host.presentationPath();
				const seen = new Set<string>();
				workspace.iterateRootLeaves((leaf) => {
					const state = leaf.getViewState();
					const path = leaf.view instanceof FileView ? leaf.view.file?.path : typeof state.state?.file === "string" ? state.state.file : undefined;
					if (!path || seen.has(path)) return;
					seen.add(path);
					tabs.push({ path, ...(path === active?.path ? { active: true as const } : {}), ...(state.pinned ? { pinned: true as const } : {}), ...(path === presentation ? { presentation: true as const } : {}) });
				});
				let selection: { path: string; fromLine: number; toLine: number; text: string } | null = null;
				const editorView = workspace.getLeavesOfType("markdown").map((l) => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === active?.path);
				const editor = editorView?.editor;
				if (editor && active && editor.somethingSelected()) {
					const from = editor.getCursor("from");
					const to = editor.getCursor("to");
					selection = { path: active.path, fromLine: from.line + 1, toLine: to.line + 1, text: clip(editor.getSelection()) };
				}
				return json({ activeNote: active?.path ?? null, selection, openTabs: tabs });
			}),
			ro("Workspace context"),
		),

		workspace_present: tool(
			"workspace_present",
			"Opens a note in Obsidian for the user to look at, without taking focus from the chat. Use it when you want the user to see a note, such as one you wrote or one you're discussing. A note that is already open is revealed rather than opened twice. A few notes per turn at most; list others as links.",
			{
				path: pathArg,
				heading: z.string().optional().describe("Heading to scroll to, or a block ID as ^id."),
				line: z.number().int().min(1).optional().describe("1-based line to scroll to."),
				placement: z
					.enum(["auto", "beside", "tab"])
					.optional()
					.describe("auto (default): reuse where notes were shown before. beside: next to the chat. tab: a new tab next to the user's notes."),
			},
			handle(async ({ path, heading, line, placement }) => text(await host.present(files.file(path).path, { heading, line, placement }))),
			ro("Show note"),
		),

		dataview_query: tool(
			"dataview_query",
			"Runs a Dataview Query Language query (LIST, TABLE or TASK) and returns the result as Markdown. Dataview sees inline fields as well as frontmatter.",
			{
				query: z.string().describe("DQL, such as: TABLE status FROM #project WHERE status != \"done\""),
				origin: z.string().optional().describe("Note the query runs from, for `this` and relative links."),
			},
			handle(async ({ query, origin }) => {
				const api = dataviewApi(app);
				if (!api) throw new ToolError("Dataview isn't enabled.");
				const originPath = origin ? files.file(origin).path : undefined;
				const result = await api.queryMarkdown(query, originPath);
				if (!result.successful) throw new ToolError(`Dataview: ${result.error}`);
				return text(clip(result.value || "(no results)"));
			}),
			ro("Dataview query"),
		),

		template_create: tool(
			"template_create",
			"Creates a note from a template, with the template plugin filling it in: Templater if enabled, otherwise core Templates ({{title}}, {{date}}, {{time}}).",
			{
				template: z.string().describe("Template path, or its name inside the templates folder."),
				path: z.string().describe("Vault-relative path of the new note. .md may be left off."),
			},
			handle(async ({ template, path }) => {
				const tp = templater(app);
				const core = coreTemplates(app);
				const folder = tp?.settings?.templates_folder || core?.options?.folder || "";
				const tpl = files.find(template) ?? (folder ? files.find(`${folder}/${template}`) : null);
				if (!(tpl instanceof TFile)) throw new ToolError(`No template at ${template}${folder ? ` or in ${folder}` : ""}.`);
				let dest = files.relative(path);
				if (!dest.toLowerCase().endsWith(".md")) dest += ".md";
				if (app.vault.getAbstractFileByPath(dest)) throw new ToolError(`${dest} already exists.`);
				const parent = parentOf(dest);
				await files.ensureFolder(parent);
				const name = dest.split("/").pop()!.replace(/\.md$/i, "");
				if (tp) {
					const created = await tp.templater.create_new_note_from_template(tpl, app.vault.getFolderByPath(parent || "/") ?? undefined, name, false);
					if (!created) throw new ToolError("Templater didn't create the note. Check Obsidian for a Templater error.");
					return text(`Created ${q(created.path)} from ${q(tpl.path)} with Templater.`);
				}
				if (!core) throw new ToolError("Neither Templater nor core Templates is enabled.");
				const content = fillCoreTemplate(await app.vault.read(tpl), name, core.options ?? {});
				const created = await app.vault.create(dest, content);
				return text(`Created ${q(created.path)} from ${q(tpl.path)} with core Templates.`);
			}),
			rw("Create from template"),
		),

		daily_note: tool(
			"daily_note",
			"Path of the daily note for today or another day, using the Daily notes folder and date format, and whether it exists yet.",
			{ date: z.string().optional().describe("Day as YYYY-MM-DD. Default today.") },
			handle(async ({ date }) => {
				const daily = dailyNotes(app);
				if (!daily) throw new ToolError("Core Daily notes isn't enabled.");
				const day = date ? momentFn(date, "YYYY-MM-DD", true) : momentFn();
				if (!day.isValid()) throw new ToolError(`Not a YYYY-MM-DD date: ${date}`);
				const format = daily.getFormat?.() || daily.options?.format || "YYYY-MM-DD";
				// getFolder returns the folder itself; options hold its path.
				const folderValue = daily.getFolder?.();
				const folder = folderValue instanceof TFolder ? folderValue.path : (daily.options?.folder ?? "");
				const path = normalizePath(`${folder}/${day.format(format)}.md`);
				return json({ path, exists: !!app.vault.getFileByPath(path) });
			}),
			ro("Daily note"),
		),

		bases_query: tool(
			"bases_query",
			"Without a path, lists the vault's bases (.base files). With one, returns the rows of a view as JSON: each note's path and the view's columns.",
			{
				path: z.string().optional().describe("Path of a .base file."),
				view: z.string().optional().describe("View name. Default the first view."),
			},
			handle(async ({ path, view }) => {
				if (!path) return json({ bases: app.vault.getFiles().filter((f) => f.extension === "base").map((f) => f.path) });
				const run = basesQuery(app);
				if (!run) throw new ToolError("Core Bases isn't enabled.");
				const file = files.file(path);
				try {
					return text(clip(String(await run({ path: file.path, ...(view ? { view } : {}), format: "json" }))));
				} catch (err) {
					// Obsidian's handler throws plain strings.
					throw new ToolError(err instanceof Error ? err.message : String(err));
				}
			}),
			ro("Bases query"),
		),
	} satisfies Record<ToolName, unknown>;
}

/** Path lookups shared by the tools. */
class VaultFiles {
	constructor(
		private readonly app: App,
		private readonly vaultPath: string,
	) {}

	/** A vault-relative path from what the agent passed. Absolute paths must be inside the vault. */
	relative(input: string): string {
		let path = input.trim();
		if (path.startsWith("/") || path.startsWith("file://")) {
			const rel = vaultRelative(path, this.vaultPath);
			if (rel === null) throw new ToolError(`${input} is outside the vault.`);
			path = rel;
		}
		path = path.replace(/^\.\//, "").replace(/\/+$/, "");
		return path ? normalizePath(path) : "";
	}

	/** A file or folder by path, path without .md, or link text. Null if there's none. */
	find(input: string): TAbstractFile | null {
		const path = this.relative(input);
		if (!path) return null;
		const { vault, metadataCache } = this.app;
		return vault.getAbstractFileByPath(path) ?? vault.getAbstractFileByPath(`${path}.md`) ?? metadataCache.getFirstLinkpathDest(path, "");
	}

	item(input: string): TAbstractFile {
		const item = this.find(input);
		if (!item || item.path === "/") throw new ToolError(`Nothing at ${input} in the vault.`);
		return item;
	}

	file(input: string): TFile {
		const item = this.item(input);
		if (!(item instanceof TFile)) throw new ToolError(`${item.path} is a folder.`);
		return item;
	}

	note(input: string): TFile {
		const file = this.file(input);
		if (file.extension !== "md") throw new ToolError(`${file.path} isn't a Markdown note.`);
		return file;
	}

	cache(file: TFile): CachedMetadata {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) throw new ToolError(`Obsidian hasn't indexed ${file.path} yet. Try again in a moment.`);
		return cache;
	}

	/** Notes outside an item that link to it, or into it for a folder. */
	linkingNotes(item: TAbstractFile): Set<string> {
		const inside = (path: string) => path === item.path || (item instanceof TFolder && path.startsWith(`${item.path}/`));
		const sources = new Set<string>();
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (inside(source)) continue;
			if (Object.keys(targets).some(inside)) sources.add(source);
		}
		return sources;
	}

	async ensureFolder(path: string): Promise<void> {
		if (!path) return;
		let current = "";
		for (const part of path.split("/")) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFile) throw new ToolError(`${current} is a file, not a folder.`);
			if (!existing) await this.app.vault.createFolder(current);
		}
	}
}

/**
 * Edits frontmatter with Obsidian's writer. `edit` returns false when it
 * changed nothing, and then the note isn't rewritten.
 */
async function processFrontMatter(app: App, file: TFile, edit: (fm: Record<string, unknown>) => boolean): Promise<void> {
	try {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (!edit(fm)) throw new NoChange();
		});
	} catch (err) {
		if (!(err instanceof NoChange)) throw err;
	}
}

/**
 * A tag as Obsidian accepts it: no leading #, no spaces, only letters,
 * numbers, _, - and /, and not all digits. Null if nothing valid is left.
 */
export function normaliseTag(raw: string): string | null {
	const tag = raw
		.trim()
		.replace(/^#+/, "")
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}\p{M}_\-/]/gu, "")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return tag && !/^\d+$/.test(tag) ? tag : null;
}

/** A frontmatter `tags` value as a list. Obsidian also accepts a comma- or space-separated string. */
function tagList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/) : [];
	return raw.map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
}

function matchesValue(actual: unknown, want: unknown): boolean {
	if (Array.isArray(want)) return want.every((w) => matchesValue(actual, w));
	if (Array.isArray(actual)) return actual.some((a) => matchesValue(a, want));
	if (typeof actual === "string" && typeof want === "string") return actual.toLowerCase() === want.toLowerCase();
	if (actual === null || actual === undefined || typeof actual === "object") return same(actual, want);
	return String(actual) === String(want);
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A property value for a before/after line. */
function show(value: unknown): string {
	if (value === null || value === undefined) return "(empty)";
	if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
	if (typeof value === "string") return value === "" ? '""' : value;
	return JSON.stringify(value);
}

/** A path as Apollo writes references: quoted if it has spaces, so the chat can make it a link. */
function q(path: string): string {
	return /\s/.test(path) ? `"${path}"` : path;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

function countFiles(folder: TFolder): number {
	let n = 0;
	for (const child of folder.children) n += child instanceof TFolder ? countFiles(child) : 1;
	return n;
}

const TRASH_TEXT: Record<string, string> = {
	system: "moved to the system trash",
	local: "moved to the vault's .trash folder",
	none: "deleted permanently",
};

/** Core Templates' variables: {{title}}, {{date}}, {{time}}, and {{date:FORMAT}}. */
function fillCoreTemplate(content: string, title: string, options: { dateFormat?: string; timeFormat?: string }): string {
	const now = momentFn();
	return content
		.replace(/{{\s*title\s*}}/gi, title)
		.replace(/{{\s*(date|time)\s*(?::([^}]*))?}}/gi, (_, kind: string, format?: string) =>
			now.format(format?.trim() || (kind.toLowerCase() === "date" ? options.dateFormat || "YYYY-MM-DD" : options.timeFormat || "HH:mm")),
		);
}

/** Obsidian's bundled moment. Its typings import it as a namespace, which TypeScript won't call. */
const momentFn = moment as unknown as (input?: string, format?: string, strict?: boolean) => { isValid(): boolean; format(format: string): string };

// Other plugins, reached through Obsidian internals. Each may be missing.

interface AppInternals {
	plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> };
	internalPlugins?: { getEnabledPluginById?(id: string): unknown };
	cli?: { handlers?: Map<string, { handler?(flags: Record<string, unknown>): Promise<unknown> }> };
	vault: { getConfig?(key: string): unknown };
}

interface DataviewApi {
	queryMarkdown(query: string, originFile?: string): Promise<{ successful: true; value: string } | { successful: false; error: string }>;
}

interface Templater {
	settings?: { templates_folder?: string };
	templater: { create_new_note_from_template(template: TFile, folder?: TFolder, filename?: string, open?: boolean): Promise<TFile | undefined> };
}

interface CoreTemplates {
	options?: { folder?: string; dateFormat?: string; timeFormat?: string };
}

interface DailyNotes {
	options?: { folder?: string; format?: string };
	getFormat?(): string;
	getFolder?(): TFolder | null;
}

const internals = (app: App) => app as unknown as AppInternals;

function communityPlugin<T>(app: App, id: string): T | null {
	const plugins = internals(app).plugins;
	return plugins?.enabledPlugins?.has(id) ? ((plugins.plugins?.[id] as T | undefined) ?? null) : null;
}

function dataviewApi(app: App): DataviewApi | null {
	return communityPlugin<{ api?: DataviewApi }>(app, "dataview")?.api ?? null;
}

function templater(app: App): Templater | null {
	const plugin = communityPlugin<Templater>(app, "templater-obsidian");
	return plugin?.templater ? plugin : null;
}

function coreTemplates(app: App): CoreTemplates | null {
	return (internals(app).internalPlugins?.getEnabledPluginById?.("templates") as CoreTemplates | null) ?? null;
}

function dailyNotes(app: App): DailyNotes | null {
	return (internals(app).internalPlugins?.getEnabledPluginById?.("daily-notes") as DailyNotes | null) ?? null;
}

/** Obsidian's own `base:query` CLI handler, the only way to evaluate a base outside its view. */
function basesQuery(app: App): ((flags: Record<string, unknown>) => Promise<unknown>) | null {
	if (!internals(app).internalPlugins?.getEnabledPluginById?.("bases")) return null;
	const handler = internals(app).cli?.handlers?.get("base:query");
	return handler?.handler ? (flags) => handler.handler!(flags) : null;
}

function getConfig(app: App, key: string): unknown {
	return internals(app).vault.getConfig?.(key);
}
