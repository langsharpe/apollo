import { Modal, Setting, type App } from "obsidian";

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
