import type { EffortLevel, ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** Permission modes a chat can use (PRM-T1). Bypass is deliberately absent in v1. */
export const PERMISSION_MODES = {
	default: "Ask",
	acceptEdits: "Accept edits",
	plan: "Plan",
	auto: "Auto",
} as const satisfies Partial<Record<PermissionMode, string>>;

export type ChatPermissionMode = keyof typeof PERMISSION_MODES;

/** Models offered before Claude Code has reported its list, which carries the versions. */
const FALLBACK_MODELS: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", fable: "Fable", haiku: "Haiku" };

/**
 * The models a chat offers in its toolbar and settings: Claude Code's
 * aliases, which follow the latest version of each family, labelled with
 * that version ("Opus 5.5"). Pinned and older models stay in /model. A
 * current model outside the list is added rather than misreported; null is
 * Claude Code's own default.
 */
export function modelOptions(models: ModelInfo[], current: string | null): Record<string, string> {
	const aliases = models.filter((m) => m.value !== "default" && !m.value.startsWith("claude-"));
	const options = aliases.length ? Object.fromEntries(aliases.map((m) => [m.value, m.displayName])) : { ...FALLBACK_MODELS };
	const value = orDefault(current);
	if (!(value in options)) options[value] = models.find((m) => m.value === value)?.displayName ?? (current ?? "Default");
	return options;
}

/** Effort levels, lowest first (TAB-8). */
export const EFFORT_LEVELS = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
} as const satisfies Record<EffortLevel, string>;

/**
 * The effort levels a model supports, from Claude Code's model list, after
 * "default" for the model's own default. Empty for a model without effort
 * (Haiku). Every level is offered until the list arrives. A current level
 * the model lacks is added rather than misreported; Claude Code runs it at
 * the nearest level the model has.
 */
export function effortOptions(models: ModelInfo[], model: string | null, current: EffortLevel | null): Record<string, string> {
	const value = orDefault(model);
	const info = models.find((m) => m.value === value) ?? models.find((m) => m.resolvedModel === value);
	const levels = info ? (info.supportedEffortLevels ?? []) : (Object.keys(EFFORT_LEVELS) as EffortLevel[]);
	if (!levels.length) return {};
	const options: Record<string, string> = { default: "Default" };
	for (const level of levels) options[level] = EFFORT_LEVELS[level];
	if (current && !(current in options)) options[current] = EFFORT_LEVELS[current];
	return options;
}

/**
 * Dropdowns, pickers and `/model default` use the string "default" for
 * Claude Code's own choice, while a chat stores null. These two convert.
 */
export function nullIfDefault<T extends string>(value: T | "default"): T | null {
	return value === "default" ? null : value;
}

export function orDefault<T extends string>(value: T | null): T | "default" {
	return value ?? "default";
}

/** A permission mode from a /mode argument: ask, accept-edits, plan or auto. */
export function parseModeArg(arg: string): ChatPermissionMode | null {
	const key = arg.toLowerCase().replace(/[\s_-]/g, "");
	const modes: Record<string, ChatPermissionMode> = { ask: "default", default: "default", acceptedits: "acceptEdits", accept: "acceptEdits", plan: "plan", auto: "auto" };
	return modes[key] ?? null;
}

/** An effort level from an /effort argument: a level, or default (auto) for the model's own. Undefined if unknown. */
export function parseEffortArg(arg: string): EffortLevel | "default" | undefined {
	const level = arg.toLowerCase();
	if (level === "default" || level === "auto") return "default";
	return level in EFFORT_LEVELS ? (level as EffortLevel) : undefined;
}

/** The full model name Claude Code resolves a chat's model to, or the model itself if the list doesn't know it. */
export function resolvedModelName(models: ModelInfo[], model: string | null): string | null {
	return models.find((m) => m.value === orDefault(model))?.resolvedModel ?? model;
}
