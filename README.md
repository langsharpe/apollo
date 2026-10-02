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

## Usage (M0 spike)

Run **Apollo: Open chat** (or click the ribbon icon) to open a chat in a split. Apollo finds `claude` through your login shell; to override, set **Claude CLI path** in settings. Tools that need approval are denied until M1 adds permission cards.

The Agent SDK is bundled into `main.js`. It expects Node globals that differ in Obsidian's renderer, so `esbuild.config.mjs` shims them. See [docs/m0-findings.md](docs/m0-findings.md).

## Probing Claude Code behaviour

```sh
node scripts/probe-m0.mts           # MCP and output-style checks, no model calls
node scripts/probe-m0.mts --turns   # also runs three short Haiku turns
```

## Install elsewhere

Copy `manifest.json`, `main.js` and `styles.css` into `<vault>/.obsidian/plugins/apollo/`, then enable **Apollo** under Settings → Community plugins.
