# Apollo: Obsidian plugin spec

Working name: **Apollo**. A desktop-only Obsidian plugin that runs Claude Code inside the vault via the Claude Agent SDK, with chats in tabs and explicit control over prompt, context, MCP and skills.

Status: draft v0.1
Owner: Lang

---

## 1. Goals

1. Chat with Claude Code inside Obsidian, with the vault root as the working directory and the same behaviour as the CLI by default.
2. One chat per tab, opening in the main workspace (split or tab), not locked to the sidebar.
3. A resumable list of past chats, shared with the CLI so `claude --resume` and the plugin see the same sessions.
4. Fast, low-friction ways to reference files and folders, replacing the current "copy path, paste into chat" habit.
5. Explicit, per-vault control over: system prompt mode, CLAUDE.md loading, MCP servers, skills directory.
6. No hidden prompt injection. Anything the plugin adds to the model's context is visible and toggleable.

## 2. Non-goals

- Mobile support (the SDK spawns local processes).
- Supporting agents other than Claude Code.
- Its own model/API layer. All model access goes through Claude Code and its existing login.
- Replacing Obsidian's editor features (inline completion, etc.). Chat only for v1.
- Publishing to the community store (personal use first; revisit auth and terms before distributing).

## 3. Architecture overview

```
Obsidian (Electron renderer, Node available)
  └─ Apollo plugin
       ├─ ChatView (ItemView)          one per tab/leaf
       │    └─ ChatSession             owns one SDK query() in streaming-input mode
       ├─ SessionListView (ItemView)   sidebar list of past chats
       ├─ ContextService               @mentions, path insertion, drag and drop
       ├─ ConfigResolver               builds SDK Options from plugin settings
       └─ SettingsTab
                │
                ▼
   @anthropic-ai/claude-agent-sdk  ──spawns──►  claude (native binary)
                                               cwd = vault root
                                               transcripts in ~/.claude/projects/<vault>/
```

Key decisions:

- **SDK, not raw CLI.** Streaming, resume, fork, permission callbacks and interrupts are first class.
- **Streaming-input mode per tab.** Each tab holds a long-lived `query()` fed by an async iterable of user messages, so the Claude Code process stays warm between turns.
- **Transcripts stay where Claude Code puts them.** The plugin stores only metadata (custom titles, pins, tab state). This is what makes CLI interop work.

## 4. Functional requirements

### 4.1 Chat tabs

| ID | Requirement |
|---|---|
| TAB-1 | Each chat is an Obsidian leaf hosting a `ChatView`. Multiple chats can be open at once. |
| TAB-2 | Setting: **Open new chats in** `tab` / `split right` / `split down` / `right sidebar`. Implemented with `workspace.getLeaf('tab')` or `getLeaf('split', direction)`. |
| TAB-3 | Commands: *New chat*, *New chat in split*, *Close chat*, *Focus next chat*, *Focus previous chat*. All bindable to hotkeys. |
| TAB-3a | **New chat in current pane** (the most-used action, equivalent of `/new`). Starts a fresh session in the focused chat pane; the previous session stays in the chat list. Ships with a **default hotkey** (proposed `Mod+Shift+N`, confirm no conflict in M0) via `addCommand({ hotkeys })`. If focus is in a note rather than a chat, opens a new chat using the *Open new chats in* setting. Also available as `/new` typed in the input. |
| TAB-4 | Tab title = session title (first prompt summary, or user rename). Show a status dot: idle, running, awaiting permission, error. |
| TAB-5 | Tab state (session ID, draft text, scroll position) persists through `getState`/`setState`, so Obsidian restores open chats on restart. |
| TAB-6 | Idle tabs release their Claude Code process after a configurable timeout (default 10 min) and transparently resume on the next message. Note: releasing the process likely clears Claude Code's in-memory record of seen files, so native file-change notes stop for that session until files are read again. CHG-2 covers this once change awareness ships. |
| TAB-7 | **Model per tab.** A dropdown in the chat toolbar, beside the permission mode, offers Claude Code's model aliases (`opus`, `sonnet`, `fable`, `haiku`), each labelled with the version it currently resolves to (e.g. "Opus 5.5"), from `supportedModels()`. Labels update when Claude Code moves an alias to a newer version. Switchable mid-chat via `setModel`. New chats start on the **Default model** setting (Opus). `/model` also offers pinned and older versions; a chat on one of those shows it as an extra dropdown entry. The chat's model persists with its tab state (TAB-5). |

### 4.2 Chat list and resume

| ID | Requirement |
|---|---|
| HIST-1 | A sidebar `SessionListView` lists sessions for this vault using the SDK's `listSessions({ dir: vaultPath })`, newest first. |
| HIST-2 | Shows title, last updated, and whether it is open in a tab. Search by title. |
| HIST-3 | Actions: **Open** (resume in new tab, or focus if already open), **Fork** (`forkSession: true`), **Rename**, **Pin**, **Delete** (with confirm; uses SDK `deleteSession`). |
| HIST-3a | **Fork from any message.** Every user and assistant message has a *Fork from here* action. It opens a new tab whose session branches at that message (`resume` + `resumeSessionAt: <message uuid>` + `forkSession: true`), leaving the original untouched. The forked tab's title records its parent, and the chat list can group forks under their parent. |
| HIST-4 | Sessions started from the terminal in the vault directory appear in the list and can be resumed. Sessions started in the plugin can be resumed from the terminal with `claude --resume`. |
| HIST-5 | Reopening a session replays its history into the view (SDK `getSessionMessages`). |
| HIST-6 | Optional: "Copy chat link" producing `obsidian://apollo?session=<id>` to paste into notes. |

### 4.3 File and folder references (path helper)

This replaces copying paths into chat by hand.

| ID | Requirement |
|---|---|
| CTX-1 | **@ picker.** Typing `@` in the input opens a fuzzy picker over vault files *and folders* (built on Obsidian's suggest APIs and `vault.getAllLoadedFiles()`). |
| CTX-2 | **Drag and drop.** Dragging a file or folder from the file explorer, a tab header, or a search result into the input inserts a reference chip. Multiple items supported. |
| CTX-3 | **Context menu.** Right-click a file or folder (`file-menu` event) → *Add to chat*. Submenu: *active chat* / *new chat*. Also available on multi-selection (`files-menu`). |
| CTX-4 | **Active note command.** *Add current note to chat* (suggested hotkey `Cmd+Shift+L`). |
| CTX-5 | **Selection command.** *Add selection to chat* inserts `path:L10-L24` plus the selected text as a quoted block. |
| CTX-6 | **Paste normalisation.** Pasting an absolute path inside the vault converts it to a vault-relative reference chip. Paths outside the vault stay as text, with a warning icon. |
| CTX-7 | **Open tabs shortcut.** A button lists currently open notes for one-click insertion. |
| CTX-8 | **Insertion format** (setting): `@relative/path.md` (Claude Code @-mention, contents attached) or plain `relative/path.md` (path only, agent reads it if needed). Default: plain path, since it's cheaper and lets the agent decide. |
| CTX-9 | Chips are visible in the sent message and clickable to open the file. |
| CTX-10 | Paths in assistant output and tool calls render as clickable links that open the file (or reveal the folder). |

### 4.4 System prompt modes

Setting: **Prompt mode**, per vault, overridable per chat before the first message.

| Mode | SDK config | Notes |
|---|---|---|
| **Claude Code default** (default) | `systemPrompt: { type: 'preset', preset: 'claude_code' }` | Identical to CLI. |
| **Default + append** | preset plus `append: <text>` | Text from a vault note (setting: path), so it's editable in Obsidian. |
| **Default + output style** | preset, plus `settings: { outputStyle: '<name>' }` | Removes the coding section, keeps tool guidance and safety. Style file lives in `.claude/output-styles/`. Plugin offers a picker of available styles. |
| **Custom** | `systemPrompt: <contents of a vault note>` | Full replacement. Settings show a warning that tool guidance and safety instructions are lost. Plugin prepends the recommended sentence explaining system reminders unless disabled. |

Requirements:

| ID | Requirement |
|---|---|
| PRM-1 | The resolved prompt mode is shown in the chat header (e.g. "Preset + style: Vault Assistant"). |
| PRM-2 | Changing mode mid-chat warns that it applies from the next session, since Claude Code records the system prompt per session. |
| PRM-3 | No hidden additions. Any plugin-authored text sent to the model is listed in a *View injected context* panel. |

### 4.5 CLAUDE.md and settings sources

| ID | Requirement |
|---|---|
| CFG-2 | Toggle **Load user settings** (`~/.claude/settings.json`, user CLAUDE.md, user skills). Controls inclusion of `'user'` in `settingSources`. Default on. |
| CFG-3 | `'project'` and `'local'` setting sources are always on. |
| CFG-4 | Button: *Open CLAUDE.md* (creates it if missing) and *Open .claude/settings.json*. Because Obsidian hides dot-folders, these open via a plugin-provided editor or the system editor. |

### 4.6 MCP control

| ID | Requirement |
|---|---|
| MCP-1 | Per-tab MCP status panel from `query.mcpServerStatus()`: name, source (user, project, managed, claude.ai connector), status, tool count. |
| MCP-2 | **Disable claude.ai connectors** toggle → `disableClaudeAiConnectors: true` passed via inline `settings`. Targets the enterprise-provisioned connectors. |
| MCP-3 | **Per-server deny list** (vault-level) → `deniedMcpServers` entries, matched by name (e.g. `claude.ai Slack`). |
| MCP-4 | **Strict mode** toggle: only servers defined in the plugin's own list load (equivalent of `--strict-mcp-config`, passed via `extraArgs` if the SDK has no direct option). |
| MCP-5 | Managed (`managed-mcp.json`) servers are shown as locked, with a note that they can't be overridden locally. |
| MCP-6 | Changes apply to new sessions; open tabs show a *Reload to apply* banner. |

### 4.7 Skills directory

| ID | Requirement |
|---|---|
| SKL-1 | Setting: **Skills folder** (vault-relative, visible folder, e.g. `System/Skills`). Default empty. |
| SKL-2 | **Mode A, linked (default):** plugin maintains a symlink `.claude/skills → <Skills folder>`. Skills behave exactly as project skills in CLI and plugin. Plugin checks and repairs the link on load. |
| SKL-3 | **Mode B, plugin-loaded:** plugin passes the folder as a local plugin via the SDK `plugins` option. Requires the plugin scaffold (`.claude-plugin/plugin.json` + `skills/`); the plugin generates it. Skills are namespaced `plugin:skill` and are not visible to the CLI. |
| SKL-4 | Skills panel lists loaded skills (from the session init message) with source and a link to open each `SKILL.md` as a normal note. |
| SKL-5 | *New skill* command scaffolds `<Skills folder>/<name>/SKILL.md` from a template. |

### 4.7a Slash menu and skill execution

Typing `/` at the start of the input opens a menu of everything invocable. It must appear instantly, so it is served from a plugin-side catalogue, not by asking a running Claude Code process.

| ID | Requirement |
|---|---|
| SLS-1 | **Slash menu.** `/` at the start of input (or after whitespace) opens a fuzzy-filtered list. Each row: name, description, argument hint, source badge. Keyboard: arrows to move, `Tab` to complete, `Enter` to insert, `Esc` to close. |
| SLS-2 | **Contents**, grouped: plugin commands (`/new`, `/fork`, `/clear`, `/model`, `/mode`), skills (vault, Skills folder, user, plugin, managed), custom slash commands (`.claude/commands/`), and MCP prompts (`/server:prompt`). |
| SLS-3 | **Preloaded catalogue.** On plugin load (after layout ready, off the critical path) the plugin scans skill and command locations itself and parses frontmatter (`name`, `description`, `argument-hint`): `<vault>/.claude/skills/`, the configured Skills folder, `~/.claude/skills/`, `<vault>/.claude/commands/`, `~/.claude/commands/`, and enabled Claude Code plugin directories. Result cached in memory and in plugin data for the next launch. |
| SLS-4 | **Live refresh.** Vault watchers update the catalogue when a `SKILL.md` or command file in the vault changes. `~/.claude` paths are re-scanned on window focus (cheap stat check) rather than watched continuously. |
| SLS-5 | **Reconcile with the authoritative list.** When a session starts, the init message (and `supportedCommands()` where available) lists what Claude Code actually loaded, including managed skills, plugin skills and MCP prompts the scan can't see. The catalogue merges this in, and marks scanned entries Claude Code did not load (e.g. disabled or shadowed) as unavailable. |
| SLS-6 | **Execution.** Selecting a skill or command inserts `/name ` into the input; arguments follow as typed text. On send, the text goes to Claude Code as-is, which runs the skill or command natively. Plugin commands (`/new` etc.) are intercepted and handled locally, never sent. |
| SLS-7 | **Terminal-only commands hidden.** CLI commands that only make sense in a terminal (e.g. `/doctor`, `/terminal-setup`) are excluded from the menu. |
| SLS-8 | **Skill invocation is visible.** When a skill runs (invoked by the user or chosen by the model), the chat shows a "Skill: name" row linking to its `SKILL.md`. |
| SLS-9 | **Performance target.** Menu opens within 50 ms of typing `/`, with no process spawn and no network. |

### 4.8 Permissions and tool calls

| ID | Requirement |
|---|---|
| PRM-T1 | Permission mode per tab: *Ask* (default), *Accept edits*, *Plan*, *Auto*. Switchable mid-chat via `setPermissionMode`. No bypass mode in v1. |
| PRM-T2 | `canUseTool` renders an inline approval card: tool, input summary, diff for Edit/Write. Options: allow once, allow for session, deny with feedback. In **Auto** mode, Claude Code's own auto-mode judgement decides what runs unprompted; only the calls it escalates reach the card. The card says when a request came from an auto-mode escalation. |
| PRM-T3 | Hard rules live in `.claude/settings.json` permissions, not plugin logic. The plugin does not ship deny rules by default; Auto mode is the expected default for routine vault work, with the user adding rules as needed. |
| PRM-T4 | Stop button calls `interrupt()`; queued messages return to the input. |

### 4.9 Rendering

| ID | Requirement |
|---|---|
| RND-1 | Assistant text streams (`includePartialMessages`) and renders with `MarkdownRenderer.render`, so wikilinks, embeds and callouts work. |
| RND-2 | Tool calls collapse into an activity row (count, files touched); expandable to full input/output. |
| RND-3 | Edits show a diff; clicking opens the file at the changed line. |
| RND-4 | Context usage meter from result usage data. |
| RND-5 | Copy message as Markdown; *Save chat as note* (exports transcript into a configurable folder). |

### 4.10 Change awareness (nice to have)

Priority: **nice to have**, post-v1. Claude Code already tells the model when a file it has seen changes on disk, but that mechanism is inconsistent: it only tracks files read directly in the main conversation, its record lives in memory (so resumed sessions start empty), a per-turn budget truncates notes when many files change, renames aren't covered, and its wording has changed across releases. This feature makes change awareness plugin-owned and reliable.

| ID | Requirement |
|---|---|
| CHG-1 | **Seen-files ledger** per session, built from the stream: Read, Write and Edit tool calls (including subagent calls, identified by parent tool use ID), files referenced via chips or @-mentions, and optionally Grep/Glob result paths (setting, default off). |
| CHG-2 | Ledger is **persisted** in plugin data keyed by session ID, so it survives resume, fork (inherited by the fork) and idle process release (TAB-6). |
| CHG-3 | **Snapshots**: store each file's content as of when it was last seen, in a plugin cache folder, for diffing. Snapshots are pruned when the session is deleted. |
| CHG-4 | **Watchers** on `vault.on('modify')`, `('rename')` and `('delete')`. Only changes to ledger files are tracked. Renames update the ledger path and are reported as renames, not delete plus create. |
| CHG-5 | Changes made by the agent's own tool calls are excluded (matched against the tool call that wrote them), so only user and third-party edits are reported. |
| CHG-6 | **Injection at send**: an SDK `UserPromptSubmit` hook returns `additionalContext` listing changed files since the last turn: path, change type (modified, renamed, deleted), and a unified diff capped at N lines. Over the cap, a short "changed, re-read before editing" line instead. |
| CHG-7 | **Injection mid-turn**: a `PostToolUse` hook reports edits made while the agent is working, at the next tool boundary. |
| CHG-8 | **Budget**: per-turn cap on injected content (setting, default ~2k tokens). Priority order: files the agent wrote, then files it read, then referenced files. Anything over budget is listed by path only. |
| CHG-9 | **Plain wording**: factual statements only ("You edited X since your last turn; here is the diff"). Never instructs the model to withhold anything from the user. |
| CHG-10 | **Visibility**: a chip above the input ("2 changed notes will be shared") that expands to show exactly what will be injected, with per-file remove. Listed in the *View injected context* panel (PRM-3). |
| CHG-11 | Toggle to turn the feature off per vault (default on once shipped). |

Known trade-off: system reminders don't appear in the SDK message stream, so the plugin can't tell whether Claude Code also sent its own note for the same file. Occasional duplicate notices are accepted; the plugin's version is kept concise. `CLAUDE_CODE_DISABLE_ATTACHMENTS` is not used to suppress the native note because it also removes the skills list and @-mention expansion.

### 4.11 Obsidian-native tools (optional)

An in-process MCP server (`createSdkMcpServer`, `type: "sdk"`) exposing Obsidian's own API to the agent as tools, prefixed `mcp__apollo__`. Handlers run inside the plugin with direct access to `app`, so there is no subprocess and no dependency on the Obsidian CLI. Claude Code's built-in Read, Edit, Write, Grep and Glob stay available; these tools add link awareness, metadata *writing*, and link-safe structural operations.

The vault currently has little frontmatter, so the emphasis is on tools that let the agent **build** metadata as it works, not just query it.

| ID | Requirement |
|---|---|
| OBS-1 | **Toggle**: *Include Obsidian tools* (vault setting, default on). Off means the server isn't registered and the agent sees only Claude Code's tools. Per-tool toggles in an expandable list. |
| OBS-2 | **`vault_links(path)`**: outgoing links, backlinks and unresolved links, resolved by Obsidian (aliases, heading links, relative paths). Built from `metadataCache.resolvedLinks`/`unresolvedLinks`, not the undocumented `getBacklinksForFile`. Useful even without frontmatter, since wikilinks already exist. |
| OBS-3 | **`vault_outline(path)`**: headings, block IDs, tags, embeds and frontmatter from `metadataCache.getFileCache()`, without returning the body. |
| OBS-4 | **`vault_frontmatter(path, set?, remove?)`**: structured property edits via `fileManager.processFrontMatter()`, so YAML is always valid and formatting is Obsidian's. The primary tool for building up metadata. |
| OBS-5 | **`vault_tags(path, add?, remove?)`**: add or remove tags in frontmatter `tags`, normalised to Obsidian's tag rules. |
| OBS-6 | **`vault_query(tags?, folder?, frontmatter?, linksTo?)`**: find notes by metadata and links. Returns paths only. Reports how many notes lack metadata so the agent knows when to fall back to Grep. |
| OBS-7 | **`vault_move(from, to)`**: rename or move via `fileManager.renameFile()`, updating links per the user's Obsidian settings. |
| OBS-8 | **`vault_trash(path)`**: delete via `fileManager.trashFile()`, respecting the user's trash setting. |
| OBS-9 | **`workspace_context()`**: active note, open tabs, current editor selection. |
| OBS-10 | **Optional bridges**, each shown only if the plugin is installed: Dataview (DQL query), Templater or core Templates (create from template), Daily Notes (today's note path), Bases. |
| OBS-11 | **No blocking of shell equivalents.** `mv` and `rm` via Bash remain allowed and are governed by the permission mode (Auto by default). Preference for `vault_move` and `vault_trash` is expressed as guidance in the Apollo output style, not as deny rules. |
| OBS-12 | **Loading**: `vault_links`, `vault_frontmatter` and `vault_move` marked `alwaysLoad` so they don't sit behind tool search; the rest are deferred. |
| OBS-13 | Tool calls render like built-in ones (RND-2), and structural changes (move, trash, frontmatter) show a before/after summary. |
| OBS-14 | **`workspace_present(path, heading?, line?, placement?)`**: opens a note for the user to look at. `placement` is a hint: `auto` (default), `beside`, `tab`. Opens in reading or editing view per the user's default. Scrolls to `heading` or `line` if given (via `openLinkText` with a subpath, or `eState.line`). |
| OBS-15 | **Placement algorithm** for `auto`, evaluated against the leaf hosting the calling chat (the plugin maps session ID to leaf): (1) if the note is already open in any leaf, reveal that leaf and scroll, never duplicate; (2) else reuse this chat's **presentation pane**, a leaf Apollo opened for this chat earlier, replacing its file so repeated presents don't pile up splits; (3) else use the most recently active unpinned markdown leaf in the main area that isn't a chat, opening as a new tab in its tab group; (4) else split the chat leaf side by side (`createLeafBySplit(chatLeaf, 'vertical')`) and mark the new leaf as this chat's presentation pane. If the chat lives in the sidebar, steps 3 and 4 target the main area's active tab group. Pinned leaves are never replaced. |
| OBS-16 | **No focus stealing.** Opens with `active: false`, so the cursor stays in the chat input. A setting allows focusing the note instead. |
| OBS-17 | **Presentation pane is visible as such.** Its tab shows a small Apollo marker; closing it simply clears the association, and the next present re-runs the algorithm. Pinning it in Obsidian keeps it out of reuse. |
| OBS-18 | **Rate limit**: at most N presents per turn (setting, default 3); extra calls return a message telling the agent to list the remaining files as links instead. |
| OBS-19 | **Auto-present** setting (default off): automatically present notes the agent creates with Write, without a tool call. Uses the same algorithm and rate limit. |

## 5. Settings summary

| Setting | Scope | Default |
|---|---|---|
| Claude CLI path | Device | Auto-detect (login shell `which claude`) |
| Extra environment variables | Device | Empty |
| Open new chats in | Vault | Split right |
| Prompt mode | Vault | Claude Code default |
| Append / custom prompt note | Vault | Empty |
| Output style | Vault | None |
| Load user settings | Vault | On |
| Disable claude.ai connectors | Vault | Off |
| MCP deny list | Vault | Empty |
| Strict MCP | Vault | Off |
| Skills folder / mode | Vault | Empty / Linked |
| Reference insertion format | Vault | Plain path |
| Default permission mode | Vault | Ask (options: Ask, Accept edits, Plan, Auto) |
| New chat in current pane hotkey | Device | `Mod+Shift+N` |
| Idle process timeout | Device | 10 min |
| Max running processes | Device | 4 |
| Default model | Vault | Opus (options: Opus, Sonnet, Fable, Haiku, labelled with their current versions) |
| Default effort | Vault | Claude Code default |
| Include Obsidian tools | Vault | On (per-tool toggles) |
| Present: default placement | Vault | Auto |
| Present: focus the note | Vault | Off (focus stays in chat) |
| Present: max per turn | Vault | 3 |
| Present: auto-present new notes | Vault | Off |
| Change awareness | Vault | On (once shipped) |
| Change awareness: include Grep/Glob hits | Vault | Off |
| Change awareness: per-turn budget | Vault | ~2k tokens |

## 6. ConfigResolver: settings to SDK options

```ts
function buildOptions(s: Settings, chat: ChatState): Options {
  const env = {
    ...process.env,
    ...parseEnv(s.extraEnv),
    PATH: resolvedPath,
  };

  return {
    cwd: vaultPath,
    pathToClaudeCodeExecutable: s.cliPath,
    env,
    systemPrompt: resolvePrompt(s, chat),        // preset / preset+append / custom
    settingSources: s.loadUserSettings
      ? ['user', 'project', 'local']
      : ['project', 'local'],
    settings: {
      ...(s.outputStyle ? { outputStyle: s.outputStyle } : {}),
      ...(s.disableConnectors ? { disableClaudeAiConnectors: true } : {}),
      ...(s.mcpDeny.length ? { deniedMcpServers: s.mcpDeny } : {}),
    },
    ...(s.skillsMode === 'plugin' ? { plugins: [{ type: 'local', path: skillsPluginPath }] } : {}),
    ...(s.obsidianTools ? { mcpServers: { apollo: apolloSdkServer(app, s.enabledObsidianTools) } } : {}),
    extraArgs: {
      ...(s.strictMcp ? { 'strict-mcp-config': null } : {}),
      ...(chat.permissionMode === 'auto' ? { 'enable-auto-mode': null } : {}),  // confirm in M0
    },
    permissionMode: chat.permissionMode,
    ...(chat.model ? { model: chat.model } : {}),  // alias or ID; null leaves Claude Code's default
    canUseTool: chat.onPermissionRequest,
    includePartialMessages: true,
    abortController: chat.abort,
    ...(chat.sessionId ? { resume: chat.sessionId } : {}),
    ...(chat.forkAt ? { resumeSessionAt: chat.forkAt } : {}),
    ...(chat.fork ? { forkSession: true } : {}),
  };
}
```

## 7. Non-functional requirements

- **Desktop only.** `isDesktopOnly: true` in the manifest.
- **Process hygiene.** Every spawned process is tracked and killed on tab close, plugin unload and Obsidian quit.
- **No telemetry.** Network traffic is only what Claude Code itself makes.
- **Secrets.** Any values the plugin stores go in Obsidian's SecretStorage, not `data.json`.
- **Bundling.** SDK marked external in esbuild; native binary resolved from the user's install, not bundled.
- **Startup cost.** Plugin load must not spawn processes; the first one starts on the first message.
- **Debugging.** A *Debug: log raw requests* toggle sets `OTEL_LOG_RAW_API_BODIES=file:<dir>`, so the exact system prompt, tools and reminders can be inspected.

## 8. Milestones

| # | Scope | Exit criteria |
|---|---|---|
| M0 | Spike | SDK runs from Obsidian on macOS; CLI path detection works; one round trip streams into a view. Answer open questions 1 to 4. |
| M1 | Single chat | One `ChatView`, streaming, Markdown rendering, stop, permission cards including Auto mode. *New chat in current pane* hotkey. Prompt mode: default only. |
| M2 | Tabs and history | TAB-1 to TAB-6, HIST-1 to HIST-5 including fork from any message. CLI interop verified both directions. |
| M3 | Path helper and slash menu | CTX-1 to CTX-10. SLS-1 to SLS-9 (catalogue, menu, execution), meeting the 50 ms target. |
| M4 | Prompt and config | All prompt modes, settings-source toggle, injected-context panel. |
| M5 | MCP, skills and Obsidian tools | MCP-1 to MCP-6, SKL-1 to SKL-5, OBS-1 to OBS-19. |
| M6 | Polish | Diffs, context meter, export, chat links, settings UX. |
| M7 | Change awareness (nice to have) | CHG-1 to CHG-11. Verified against a resumed session and a renamed note. |

## 9. Open questions (resolve in M0)

1. Does `deniedMcpServers` in inline SDK `settings` take effect at the same precedence as a settings file, or only in managed settings?
2. Is there a first-class SDK option for strict MCP config, or is `extraArgs` the only route?
3. Does the SDK expand `@path` mentions in the prompt the same way the interactive CLI does? Determines whether CTX-8's "@" format attaches contents.
4. Does `outputStyle` via inline `settings` pick up custom styles from `.claude/output-styles/` in the vault?
5. Does the enterprise's managed configuration block any of MCP-2 to MCP-4? Check `/mcp` in the vault from the CLI first.
6. Symlinked `.claude/skills`: does Obsidian Sync or another sync tool in use replace symlinks? If so, Mode B becomes the default.
7. Horizontal vs vertical naming in `getLeaf('split', ...)`: confirm which direction gives side-by-side panes.
8. How does the SDK enable Claude Code's auto permission mode? Claudian passes an `enable-auto-mode` extra arg; confirm whether `permissionMode: 'auto'` alone is enough, and whether managed settings in the enterprise config allow it.
9. Does `Mod+Shift+N` clash with a core Obsidian or commonly used plugin hotkey on this machine?
10. Fork from an *assistant* message: confirm `resumeSessionAt` accepts assistant message UUIDs as well as user ones, and what happens to tool calls mid-turn.
11. Change awareness: capture the native file-changed reminder with raw-request logging on the current Claude Code version, to see its exact form, when it fires, and whether it survives resume. Informs CHG-6 wording and how much duplication to expect.
12. Can SDK hook callbacks (`UserPromptSubmit`, `PostToolUse`) return `additionalContext` from in-process TypeScript, without shell hooks? Confirm the field name and placement in the current SDK.
13. Slash commands via the SDK: confirm that sending `/skill-name args` as the prompt text runs the skill exactly as in the CLI, and whether `supportedCommands()` needs a live query or can be called cheaply at session start.
14. Skill shadowing: when the same skill name exists at user and project level, which wins? The catalogue (SLS-5) should mirror Claude Code's precedence.
15. Obsidian tools: confirm `createSdkMcpServer` tools work alongside `settingSources` MCP servers and `strictMcp`, and that `alwaysLoad` can be set on an SDK server.

## 10. References

- Agent SDK: modifying system prompts, https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- Claude Code: output styles, https://code.claude.com/docs/en/output-styles
- Claude Code: MCP (scopes, disabling servers, connectors), https://code.claude.com/docs/en/mcp
- Prior art: Agent Client (view placement, session history), Claudian (path conventions, link-safe renames), Copilot (skills linking, chats as notes)
