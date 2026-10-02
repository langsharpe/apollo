import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ShellEnv {
	/** PATH as seen by the user's login shell. */
	path: string;
	/** Absolute path to `claude`, or null if it could not be found. */
	claudePath: string | null;
}

// Obsidian launched from the Dock inherits launchd's minimal PATH, so ask the
// login shell instead. Markers fence off anything rc files print.
const START = "__SHELL_ENV_START__";
const END = "__SHELL_ENV_END__";
const PROBE = `printf '${START}%s\\n%s${END}' "$PATH" "$(command -v claude)"`;

// Common install locations, checked when the shell lookup fails.
const FALLBACK_PATHS = [
	join(homedir(), ".local", "bin", "claude"),
	join(homedir(), ".claude", "local", "claude"),
	"/opt/homebrew/bin/claude",
	"/usr/local/bin/claude",
];

let cached: Promise<ShellEnv> | null = null;

/** Resolves PATH and the `claude` binary once per plugin load. */
export function resolveShellEnv(): Promise<ShellEnv> {
	cached ??= detect();
	return cached;
}

async function detect(): Promise<ShellEnv> {
	const fromShell = await probeLoginShell().catch(() => null);
	const path = fromShell?.path || process.env.PATH || "";
	let claudePath = fromShell?.claudePath ?? null;
	if (!claudePath || !(await isExecutable(claudePath))) {
		claudePath = null;
		for (const candidate of FALLBACK_PATHS) {
			if (await isExecutable(candidate)) {
				claudePath = candidate;
				break;
			}
		}
	}
	return { path, claudePath };
}

function probeLoginShell(): Promise<ShellEnv> {
	const shell = process.env.SHELL || "/bin/zsh";
	return new Promise((resolve, reject) => {
		execFile(shell, ["-ilc", PROBE], { timeout: 5000 }, (err, stdout) => {
			const start = stdout.indexOf(START);
			const end = stdout.indexOf(END, start);
			if (start === -1 || end === -1) {
				reject(err ?? new Error("Login shell produced no output"));
				return;
			}
			const [path = "", claudePath = ""] = stdout.slice(start + START.length, end).split("\n");
			resolve({ path, claudePath: claudePath.startsWith("/") ? claudePath : null });
		});
	});
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
