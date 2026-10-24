import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { setIcon, setTooltip, type Component } from "obsidian";
import { effortOptions, modelOptions, nullIfDefault, orDefault, PERMISSION_MODES } from "./chat-options";

export interface ChatToolbarHandlers {
	copySessionId(): void;
	changeModel(model: string | null): void;
	changeEffort(effort: EffortLevel | null): void;
	changeMode(mode: PermissionMode): void;
	showOpenNotes(evt: MouseEvent): void;
	send(): void;
	stop(): void;
}

/** Fills a dropdown with `options` (value to label) and selects `value`. */
function fillSelect(select: HTMLSelectElement, options: Record<string, string>, value: string): void {
	select.empty();
	for (const [optionValue, text] of Object.entries(options)) select.createEl("option", { value: optionValue, text });
	select.value = value;
}

/**
 * The row under the input: the info icon, the model, effort and mode
 * dropdowns, the open-notes button, and Send and Stop. It only draws and
 * reports; the view decides what each choice does.
 */
export class ChatToolbar {
	private readonly infoEl: HTMLElement;
	private readonly modelEl: HTMLSelectElement;
	private readonly effortEl: HTMLSelectElement;
	private readonly modeEl: HTMLSelectElement;
	private readonly stopBtn: HTMLButtonElement;

	constructor(parent: HTMLElement, component: Component, handlers: ChatToolbarHandlers) {
		const el = parent.createDiv({ cls: "apollo-toolbar" });
		// Status dot plus model and session details on hover.
		this.infoEl = el.createDiv({ cls: "apollo-info clickable-icon" });
		setIcon(this.infoEl, "info");
		// The tooltip shows a short ID, but `claude --resume` needs the full one.
		component.registerDomEvent(this.infoEl, "click", () => handlers.copySessionId());
		this.modelEl = el.createEl("select", { cls: "dropdown apollo-model", attr: { "aria-label": "Model" } });
		component.registerDomEvent(this.modelEl, "change", () => handlers.changeModel(nullIfDefault(this.modelEl.value)));
		this.effortEl = el.createEl("select", { cls: "dropdown apollo-effort", attr: { "aria-label": "Effort" } });
		component.registerDomEvent(this.effortEl, "change", () => handlers.changeEffort(nullIfDefault(this.effortEl.value as EffortLevel | "default")));
		this.modeEl = el.createEl("select", { cls: "dropdown apollo-mode", attr: { "aria-label": "Permission mode" } });
		component.registerDomEvent(this.modeEl, "change", () => handlers.changeMode(this.modeEl.value as PermissionMode));
		// CTX-7.
		const openNotes = el.createDiv({ cls: "apollo-open-notes clickable-icon", attr: { "aria-label": "Add an open note" } });
		setIcon(openNotes, "files");
		component.registerDomEvent(openNotes, "click", (evt) => handlers.showOpenNotes(evt));
		const buttons = el.createDiv({ cls: "apollo-buttons" });
		this.stopBtn = buttons.createEl("button", { text: "Stop" });
		const sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
		component.registerDomEvent(sendBtn, "click", () => handlers.send());
		component.registerDomEvent(this.stopBtn, "click", () => handlers.stop());
	}

	renderModel(models: Parameters<typeof modelOptions>[0], current: string | null): void {
		fillSelect(this.modelEl, modelOptions(models, current), orDefault(current));
	}

	/** Hidden for a model without effort levels. */
	renderEffort(models: Parameters<typeof effortOptions>[0], model: string | null, current: EffortLevel | null): void {
		const options = effortOptions(models, model, current);
		const labelled = Object.fromEntries(Object.entries(options).map(([value, text]) => [value, `${text} effort`]));
		fillSelect(this.effortEl, labelled, orDefault(current));
		this.effortEl.toggle(Object.keys(options).length > 0);
	}

	renderMode(current: PermissionMode): void {
		const modes: Record<string, string> = { ...PERMISSION_MODES };
		// Show modes the plugin doesn't offer (e.g. from settings) rather than misreporting them.
		if (!(current in modes)) modes[current] = current;
		fillSelect(this.modeEl, modes, current);
	}

	setInfo(lines: string[]): void {
		setTooltip(this.infoEl, lines.join("\n"), { placement: "top" });
	}

	setStopEnabled(enabled: boolean): void {
		this.stopBtn.disabled = !enabled;
	}
}
