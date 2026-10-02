import esbuild from "esbuild";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
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
			// Marker that tells the Hot Reload plugin to watch this folder.
			await writeFile(join(pluginDir, ".hotreload"), "");
			console.log(`Installed to ${pluginDir}`);
		});
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
		// Resolved from the user's install at runtime, never bundled (spec §7).
		"@anthropic-ai/claude-agent-sdk",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2022",
	platform: "node",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	plugins: [installToVault],
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
