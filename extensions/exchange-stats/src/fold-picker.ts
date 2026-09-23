import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolFoldModel } from "./tool-fold.ts";

type Theme = { fg(color: "dim", text: string): string };

interface Item {
	label: string;
	toggle(): void;
}

/** A keyboard overlay over the fold state retained by the model. */
export class FoldPicker {
	private selected = 0;
	private model: ToolFoldModel;
	private getTheme: () => Theme;
	private requestRender: () => void;
	private done: () => void;
	constructor(model: ToolFoldModel, getTheme: () => Theme, requestRender: () => void, done: () => void) {
		this.model = model;
		this.getTheme = getTheme;
		this.requestRender = requestRender;
		this.done = done;
	}

	private items(): Item[] {
		const items: Item[] = [];
		let exchange = 0;
		for (const process of this.model.processes()) {
			if (process.exchange !== exchange) {
				exchange = process.exchange;
				const id = exchange;
				items.push({ label: `Exchange ${id}`, toggle: () => { this.model.toggleExchange(id); } });
			}
			items.push({ label: `  ${this.model.processLine(process.id)}`, toggle: () => { this.model.toggleProcess(process.id); } });
			for (const block of process.blocks) {
				if (block.kind === "thinking") {
					items.push({ label: `    ${this.model.thinkingTitle(block.message, block.index, block.trace, false)}`, toggle: () => { this.model.toggleThinking(block.message, block.index); } });
				} else {
					const id = block.key.slice(5);
					const parts = this.model.titleParts(id);
					items.push({ label: `    ⚙ ${parts?.name ?? "tool"}  ${parts?.argument ?? ""}  ${parts?.stats ?? ""}`, toggle: () => { this.model.toggle(id); } });
				}
			}
		}
		return items;
	}

	render(width: number): string[] {
		const rows = this.items();
		const theme = this.getTheme();
		const lines = [theme.fg("dim", truncateToWidth("Fold exchange / process / block", width, "…"))];
		if (!rows.length) return [...lines, theme.fg("dim", "  No blocks yet")];
		this.selected = Math.min(this.selected, rows.length - 1);
		return [...lines, ...rows.map((row, index) => {
			const mark = index === this.selected ? ">" : " ";
			return mark + theme.fg("dim", truncateToWidth(` ${row.label}`, Math.max(0, width - 1), "…"));
		})];
	}

	handleInput(data: string): void {
		const rows = this.items();
		if (matchesKey(data, Key.escape)) { this.done(); return; }
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.down)) this.selected = Math.min(rows.length - 1, this.selected + 1);
		else if (matchesKey(data, Key.enter)) rows[this.selected]?.toggle();
		else return;
		this.requestRender();
	}

	invalidate(): void {}
}
