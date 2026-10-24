import type { CatalogueEntry } from "./catalogue";

/** Commands Apollo handles itself and never sends (SLS-6). */
export const APOLLO_COMMANDS: CatalogueEntry[] = [
	{ name: "new", description: "Start a new chat in this pane. The current one stays in the chat list.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "clear", description: "Same as /new: a fresh session in this pane.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "fork", description: "Fork this chat into a new tab.", argumentHint: "", kind: "apollo", source: "apollo" },
	{ name: "model", description: "Set the model for this chat.", argumentHint: "[model]", kind: "apollo", source: "apollo" },
	{ name: "effort", description: "Set the effort level for this chat.", argumentHint: "[low|medium|high|xhigh|max|default]", kind: "apollo", source: "apollo" },
	{ name: "mode", description: "Set the permission mode for this chat.", argumentHint: "[ask|accept-edits|plan|auto]", kind: "apollo", source: "apollo" },
];

const COMMAND_PATTERN = new RegExp(`^/(${APOLLO_COMMANDS.map((e) => e.name).join("|")})(?:\\s+([\\s\\S]*))?$`);

/** An Apollo command in the input, with its trimmed argument, or null if the text is anything else. */
export function parseApolloCommand(text: string): { name: string; arg: string } | null {
	const m = COMMAND_PATTERN.exec(text);
	return m ? { name: m[1]!, arg: m[2]?.trim() ?? "" } : null;
}
