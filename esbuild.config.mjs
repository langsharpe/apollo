import esbuild from "esbuild";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const prod = process.argv[2] === "production";

// Dev vault the build installs into. Override with APOLLO_VAULT=/path/to/vault.
const vault = process.env.APOLLO_VAULT ?? join(homedir(), "Code", "ApolloTest");
const pluginDir = join(vault, ".obsidian", "plugins", "apollo");

const installToVault = {
	name: "install-to-vault",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) return;
			if (!(await stat(vault).catch(() => null))?.isDirectory()) {
				console.warn(`Vault not found at ${vault}, skipping install.`);
				return;
			}
			await mkdir(pluginDir, { recursive: true });
			await copyFile("manifest.json", join(pluginDir, "manifest.json"));
			await copyFile("main.js", join(pluginDir, "main.js"));
			await copyFile("styles.css", join(pluginDir, "styles.css"));
			// Marker that tells the Hot Reload plugin to watch this folder.
			await writeFile(join(pluginDir, ".hotreload"), "");
			console.log(`Installed to ${pluginDir}`);
		});
	},
};

// The Agent SDK assumes Node globals, but Obsidian's renderer has DOM ones.
// - AbortController is the DOM one, which Node's events.setMaxListeners
//   rejects, so `events` is routed through a tolerant shim.
// - setTimeout returns a number with no .unref(), which breaks the SDK's
//   close() and leaves the claude process running, so Node's timers are
//   imported explicitly.
const sdkFiles = /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/].*\.mjs$/;
const sdkNodeGlobals = {
	name: "sdk-node-globals",
	setup(build) {
		build.onResolve({ filter: /^(node:)?events$/ }, (args) =>
			sdkFiles.test(args.importer) ? { path: join(import.meta.dirname, "src/shims/events.ts") } : undefined,
		);
		build.onLoad({ filter: sdkFiles }, async (args) => ({
			// Appended because the file starts with a shebang; imports hoist anyway.
			contents:
				(await readFile(args.path, "utf8")) +
				'\nimport { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";\n',
			loader: "js",
		}));
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	// The Agent SDK is ESM and calls createRequire(import.meta.url), which is
	// empty in a CJS bundle. Point it at the bundle itself.
	banner: {
		js: `const __importMetaUrl = require("url").pathToFileURL(typeof __filename === "string" ? __filename : require("path").join(process.cwd(), "main.js")).href;`,
	},
	define: { "import.meta.url": "__importMetaUrl" },
	format: "cjs",
	target: "es2022",
	platform: "node",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	plugins: [sdkNodeGlobals, installToVault],
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
