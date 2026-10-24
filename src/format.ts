/** Small text helpers shared across views and tools. */

/** The message of a thrown value, whatever it is. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** "1 note", "2 notes"; pass `many` when the plural isn't just an "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** `text` cut to at most `max` characters, ending in "…" if it was cut. */
export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "12s", "1m 05s" or "1h 02m". */
export function formatDuration(ms: number): string {
	const secs = Math.max(0, Math.floor(ms / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
	return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** An agent's totals: "5 tools · 30s". */
export function agentTotals(toolUses: number, durationMs: number): string {
	return [toolUses ? plural(toolUses, "tool") : "", durationMs ? formatDuration(durationMs) : ""].filter(Boolean).join(" · ");
}
