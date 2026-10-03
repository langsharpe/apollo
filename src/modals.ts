import { Modal, Setting, SuggestModal, type App } from "obsidian";

/** Asks for a line of text. Resolves with the trimmed text, or null if cancelled or empty. */
export function promptText(app: App, title: string, value: string, cta: string): Promise<string | null> {
	return new Promise((resolve) => {
		let result: string | null = null;
		const modal = new Modal(app);
		modal.setTitle(title);
		const submit = () => {
			result = input.value.trim() || null;
			modal.close();
		};
		const input = modal.contentEl.createEl("input", { cls: "apollo-modal-input", attr: { type: "text" } });
		input.value = value;
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.isComposing) {
				evt.preventDefault();
				submit();
			}
		});
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((b) => b.setButtonText(cta).setCta().onClick(submit));
		modal.onClose = () => resolve(result);
		modal.open();
		input.select();
	});
}

/** Asks for confirmation of a destructive action. */
export function confirmAction(app: App, title: string, message: string, cta: string): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.setTitle(title);
		modal.contentEl.createEl("p", { text: message });
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((b) =>
				b
					.setButtonText(cta)
					.setWarning()
					.onClick(() => {
						confirmed = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}

export interface PickOption {
	value: string;
	label: string;
	note?: string;
}

/** Asks the user to pick one option. Resolves with its value, or null if dismissed. */
export function pickOne(app: App, options: PickOption[], placeholder: string): Promise<string | null> {
	return new Promise((resolve) => {
		let picked: string | null = null;
		const modal = new (class extends SuggestModal<PickOption> {
			override getSuggestions(query: string): PickOption[] {
				const q = query.toLowerCase();
				return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
			}
			override renderSuggestion(option: PickOption, el: HTMLElement): void {
				el.createDiv({ text: option.label });
				if (option.note) el.createEl("small", { cls: "apollo-pick-note", text: option.note });
			}
			override onChooseSuggestion(option: PickOption): void {
				picked = option.value;
			}
			override onClose(): void {
				super.onClose();
				// onChooseSuggestion runs after close, so resolve on the next tick.
				window.setTimeout(() => resolve(picked), 0);
			}
		})(app);
		modal.setPlaceholder(placeholder);
		modal.open();
	});
}
