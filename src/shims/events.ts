// Swapped in for `events` inside the Agent SDK (see esbuild.config.mjs), which
// imports only `once` and `setMaxListeners`. In Obsidian's renderer,
// AbortController is the DOM one, and Node's setMaxListeners throws on DOM
// AbortSignals. The call only silences listener-count warnings, so skipping
// it is harmless.
import * as events from "node:events";

export const once = events.once;

export function setMaxListeners(...args: Parameters<typeof events.setMaxListeners>): void {
	try {
		events.setMaxListeners(...args);
	} catch {
		// DOM AbortSignal: nothing to configure.
	}
}
