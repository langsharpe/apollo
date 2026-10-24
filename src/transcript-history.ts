import { agentTotals } from "./format";

/** Content blocks as stored in transcripts, loosely typed. */
export interface HistoryBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
}

/** A tool result's text, from either a string or text blocks. */
export function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text!)
		.join("\n");
}

export const INTERRUPTED = "[Request interrupted by user]";

/**
 * A user entry's text as the user would recognise it. Claude Code stores
 * slash commands as tags and adds reminders and command output as user
 * entries; those aren't prompts, so they return "".
 */
export function displayPrompt(text: string): string {
	const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
	if (stripped.startsWith(INTERRUPTED)) return INTERRUPTED;
	const command = /<command-name>([^<]*)<\/command-name>/.exec(stripped);
	if (command) {
		const args = /<command-args>([^<]*)<\/command-args>/.exec(stripped)?.[1]?.trim();
		const name = command[1]!.trim();
		return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
	}
	if (/^<(local-command-\w+|command-message|bash-\w+|task-notification)>/.test(stripped) || stripped.startsWith("Caveat: The messages below")) return "";
	return stripped;
}

/** A background task's report, which Claude Code stores as a user entry; null for anything else. */
export function taskNotification(text: string): { toolUseId: string; status: string; totals: string } | null {
	if (!text.trimStart().startsWith("<task-notification>")) return null;
	const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim() ?? "";
	return { toolUseId: tag("tool-use-id"), status: tag("status"), totals: agentTotals(Number(tag("tool_uses")) || 0, Number(tag("duration_ms")) || 0) };
}

/**
 * A transcript message's content as blocks. `SessionMessage.message` is
 * `unknown` in the SDK, and Claude Code stores plain prompts as a string.
 */
export function contentBlocks(message: unknown): HistoryBlock[] {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as HistoryBlock[]) : [];
}

/** A transcript user message's prompt text, or "" if it isn't a prompt. */
export function userPrompt(message: unknown): string {
	const texts = contentBlocks(message).filter((b) => b.type === "text" && b.text).map((b) => b.text!);
	return displayPrompt(texts.join("\n\n"));
}
