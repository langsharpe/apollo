# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Apollo is a desktop-only Obsidian plugin (Obsidian 1.13.0+) that runs Claude Code inside a vault through `@anthropic-ai/claude-agent-sdk`. `spec.md` is the source of truth for requirements; the IDs in code comments (`TAB-6`, `HIST-3a`, `SLS-5`, `OBS-13`, `RND-8`, …) refer to its tables. `docs/m*-findings.md` and `docs/progress.md` record verified SDK and Claude Code behaviour per milestone. Check them before assuming how the SDK behaves.

## Commands

```sh
npm install
npm run build   # tsc --noEmit, then a minified main.js, installed into the dev vault
npm run dev     # esbuild watch with inline sourcemaps, no type-check
npx tsc --noEmit   # type-check only
```

There are no unit tests and no linter. `npm run build` (the type-check) is the check to run.

Every build copies `manifest.json`, `main.js` and `styles.css` into `~/Code/ApolloTest/.obsidian/plugins/apollo/` (override with `APOLLO_VAULT=/path/to/vault`) and writes a `.hotreload` marker, so the Hot Reload plugin reloads Apollo about a second later. To verify in the real app, use the Obsidian CLI:

```sh
obsidian vault=ApolloTest plugin:reload id=apollo
obsidian vault=ApolloTest dev:errors
obsidian vault=ApolloTest dev:screenshot   # returns the frame from before the latest change; take two captures
obsidian vault=ApolloTest eval ...          # used to drive real chats when testing
```

Probe scripts in `scripts/` check SDK and Claude Code behaviour outside Obsidian, in throwaway temp vaults (run directly with `node`, e.g. `node scripts/probe-m3.mts`). Without `--turns` they make no model calls; with it they run short Haiku (sometimes Sonnet) turns. The README lists what each one covers. New SDK behaviour that the UI depends on usually gets a probe and a findings doc.

## Architecture

- **`main.ts`**, `ApolloPlugin`: registers the views and commands, owns `SessionStore`, `CommandCatalogue` and the set of live `ChatSession`s (all killed on unload). `data.json` holds settings plus `sessionMeta` (pins, fork parents) and the catalogue cache.
- **`chat-view.ts`**, `ChatView` (`apollo-chat` ItemView, one per leaf): renders the transcript, handles `SDKMessage`s in `handle()`, Apollo's own slash commands (`/new`, `/clear`, `/fork`, `/model`, `/effort`, `/mode`), the toolbar dropdowns, and tab state persistence (`ChatViewState` through `getState`/`setState`).
- **`chat-session.ts`**, `ChatSession`: one long-lived SDK `query()` in streaming-input mode per chat. The process starts on the first message, not at load (plugin load must never spawn processes). It is released after the idle timeout and resumes the same session on the next message. Mid-chat changes go through `setModel`, `setPermissionMode` and `applyFlagSettings`.
- **`apollo-commands.ts`**: the slash commands Apollo handles itself (`APOLLO_COMMANDS`, `parseApolloCommand`), which `ChatView` runs and the catalogue lists.
- **`chat-options.ts`**: the permission modes, model and effort choices a chat offers, the "default" ↔ `null` conversion, and the `/mode` and `/effort` argument parsers.
- **`config.ts`**, `buildOptions`: the single place that maps settings and chat state to SDK `Options`: vault cwd, CLI path, login-shell PATH, `settingSources`, the in-process `apollo` MCP server, a `PreToolUse` hook on `Write`, and `thinking-display: summarized`.
- **`cli.ts`**: finds `claude` and `PATH` through the login shell, since Obsidian launched from the Dock has launchd's minimal PATH.
- **`sessions.ts`**, `SessionStore`: every session read and write goes through the SDK (`listSessions`, `getSessionMessages`, `forkSession`, `renameSession`, `deleteSession`) against Claude Code's own transcripts in `~/.claude/projects/`. Apollo stores no transcripts or titles, which is what keeps `claude --resume` in sync. `session-list-view.ts` is the sidebar list.
- **Transcript rendering**: `work.ts` (`WorkSection`, the collapsed run of thinking and tool calls between messages) contains `thinking.ts` blocks and `activity.ts` groups of tool calls (file links, change summaries). `tool-calls.ts` is their DOM-free knowledge (tool kinds, the Obsidian tool table, summaries, progress text) and `collapsible.ts` the shared expand/collapse header. `progress.ts` is the status row at the end of the transcript, fed by `tasks.ts` (`AgentTasks`, subagents tracked from task events). `permission-card.ts` renders inline approval and AskUserQuestion cards, using `diff.ts`.
- **`transcript-history.ts`**: reading saved transcripts, with no DOM: `contentBlocks`, `userPrompt` and the text cleanup for slash commands, interruptions and task reports.
- **Input**: `chat-input.ts` (textarea, `@` picker, drag and drop, path paste), `input-menu.ts` (shared floating suggestion list that never takes focus), `catalogue.ts` (slash-menu entries scanned from `.claude/skills`, `.claude/commands`, `~/.claude` and plugins, then reconciled with what Claude Code reports), `references.ts` (formatting, finding and linkifying vault paths).
- **`obsidian-internals.ts`**: every non-public Obsidian API (leaf `tabHeaderEl`/`updateHeader`, `vault.getConfig`, `hotkeyManager`, `dragManager`, internal and community plugins, menu and ribbon internals) as optional types behind small accessors. Check this file first when Obsidian updates.
- **`workspace.ts`**: leaf helpers shared by the input, presenter and tools (`leafFilePath`, `isInSidebar`).
- **`format.ts`**: small text helpers shared by views and tools (`errorMessage`, `plural`, `truncate`, `formatDuration`, `agentTotals`).
- **Obsidian tools**: `vault-tools.ts` builds an in-process SDK MCP server named `apollo` (tools reach Claude as `mcp__apollo__<tool>`) on Obsidian's API. Read-only tools go in `allowedTools`; the rest follow the permission mode. `presenter.ts` handles `workspace_present`, reusing one marked pane per chat.

## Bundling gotchas

The SDK is **bundled** into `main.js`, not external (spec §7 says external; `docs/m0-findings.md` explains why that fails). `esbuild.config.mjs` works around Node-vs-DOM globals in Obsidian's renderer, scoped to the SDK's files:

- `import.meta.url` is defined as the bundle's file URL (the SDK calls `createRequire` on it).
- The SDK's `events` import goes to `src/shims/events.ts`, because Node's `setMaxListeners` rejects DOM `AbortSignal`s.
- `node:timers` is imported into the SDK modules, because DOM `setTimeout` has no `.unref()`. Without this, Stop leaves the `claude` process running.

Aborting can end the SDK stream quietly instead of throwing, so check `signal.aborted` after the loop as well as in `catch`.

## Conventions

- Tabs for indentation (`.editorconfig`). Doc comments explain why, and cite spec IDs.
- Use Obsidian's public API where possible. Internals live in `obsidian-internals.ts`, typed as optional, and must tolerate being missing.
- User-facing behaviour is documented in `README.md` (Usage). Update it, and `spec.md` when requirements change, in the same commit as the feature.
- Releases bump the version in `manifest.json`, `package.json`, `package-lock.json` and add an entry to `versions.json` (commit "Release x.y.z").
