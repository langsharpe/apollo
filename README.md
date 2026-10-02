# Apollo

Obsidian plugin that runs Claude Code inside the vault. See [spec.md](spec.md).

Desktop only. Requires Obsidian 1.13.0 or later.

## Build

```sh
npm install
npm run build   # type-check, produce main.js, install into the dev vault
npm run dev     # rebuild and reinstall on change (no type-check)
```

## Development

Every build installs `main.js` and `manifest.json` into the dev vault at `~/Code/ApolloTest/.obsidian/plugins/apollo/` (override with `APOLLO_VAULT=/path/to/vault`). If the vault doesn't exist, that step is skipped. In a new vault, enable **Apollo** once under Settings → Community plugins.

The build also writes a `.hotreload` marker, so with the [Hot Reload](https://github.com/pjeby/hot-reload) plugin enabled in the dev vault, Obsidian reloads Apollo about a second after each build.

Without Hot Reload, use the Obsidian CLI:

```sh
obsidian vault=ApolloTest plugin:reload id=apollo
obsidian vault=ApolloTest dev:errors
```

## Usage

Run **Apollo: New chat** (or click the bot ribbon icon) to open a chat. **Open new chats in** (settings) picks a new tab, a split right or down, or the right sidebar. **Apollo: New chat in current pane** (`Mod+Alt+N`, or `/new` in the input) starts a fresh session in the focused chat. Other commands: *New chat in split*, *Close chat*, *Focus next chat*, *Focus previous chat*, *Open chat list*. Apollo finds `claude` through your login shell; to override, set **Claude CLI path** in settings.

Each chat keeps one Claude Code process running between turns, and stops it after the **Idle process timeout** (10 minutes by default). The next message resumes the session. Open chats, their drafts and scroll positions come back when Obsidian restarts.

Pick the permission mode (Ask, Accept edits, Plan, Auto) in the chat toolbar; the default for new chats is a setting. Tool calls that need approval show an inline card. Stop (or `Esc`) interrupts the turn, and messages sent while Claude is working queue until the turn ends.

**Claude chats** (the messages ribbon icon, or *Open chat list*) lists every Claude Code session for the vault, including ones started in the terminal. Click to open or resume; right-click to fork, rename, pin or delete. Sessions are Claude Code's own transcripts, so `claude --resume` in the vault sees the same list. Hover a message and click the branch icon to fork from there. Forking from one of your messages puts it back in the input to edit and resend.

The Agent SDK is bundled into `main.js`. It expects Node globals that differ in Obsidian's renderer, so `esbuild.config.mjs` shims them. See [docs/m0-findings.md](docs/m0-findings.md), [docs/m1-findings.md](docs/m1-findings.md) and [docs/m2-findings.md](docs/m2-findings.md).

## Probing Claude Code behaviour

```sh
node scripts/probe-m0.mts           # MCP and output-style checks, no model calls
node scripts/probe-m0.mts --turns   # also runs three short Haiku turns
node scripts/probe-m1.mts           # streaming input, interrupt, permission modes (Haiku and Sonnet turns)
node scripts/probe-m2.mts           # message UUIDs, forks, rename and delete (Haiku turns, sessions cleaned up)
```

## Install elsewhere

Copy `manifest.json`, `main.js` and `styles.css` into `<vault>/.obsidian/plugins/apollo/`, then enable **Apollo** under Settings → Community plugins.
