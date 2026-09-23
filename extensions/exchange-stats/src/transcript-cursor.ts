import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ToolFoldModel } from "./tool-fold.ts";

/** Captures navigation keys while the transcript highlight is active. */
export class TranscriptCursor {
	private model: ToolFoldModel;
	private changed: () => void;
	private done: () => void;
	constructor(model: ToolFoldModel, changed: () => void, done: () => void) {
		this.model = model;
		this.changed = changed;
		this.done = done;
	}
	// The overlay owns focus while the model's existing renderers draw the highlight.
	render(): string[] { return []; }
	invalidate(): void {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.model.stopCursor(); this.changed(); this.done(); }
		else if (matchesKey(data, Key.up)) { this.model.cursorMove(-1); this.changed(); }
		else if (matchesKey(data, Key.down)) { this.model.cursorMove(1); this.changed(); }
		else if (matchesKey(data, Key.enter)) { this.model.cursorToggle(); this.changed(); }
	}
}
