import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold } from "./src/tool-render.ts";

initTheme("dark");

// Pi 1.5.0 reuses a message's Markdown children across `updateContent` calls, so a streaming
// turn runs the fold wrapper over the same instance once per snapshot. Older Pi rebuilt them,
// which hides what happens when the wrapper is not installed once per instance. These fakes
// copy Pi's slot reuse, and Pi's width padding, so the regression is visible here.
class Spacer {
	render() { return [""]; }
}

class Markdown {
	constructor(text) { this.text = text; }
	render(width) {
		const pad = " ".repeat(width); // Pi pads every row to the width it is given
		return [`${this.text}${pad}`, pad];
	}
}

class MouseRegion {
	render() { return ["◈ trace"]; }
}

class StreamingAssistant {
	constructor() {
		this.contentContainer = { children: [] };
		this.markdownSlots = [];
		this.hideThinkingBlock = false;
		this.thinkingVisibilityOverrides = new Map();
		this.outputPad = 0;
		this.isStreaming = true;
	}

	updateContent(message) {
		const previous = this.markdownSlots;
		this.markdownSlots = [];
		const block = (kind, text) => {
			const slot = previous[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : new Markdown(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};
		this.contentContainer.children = [
			new Spacer(),
			block("assistant-text", message.content[0].text),
			new MouseRegion(),
			new Spacer(),
			block("assistant-text", message.content[3].text),
		];
	}

	render(width) { return this.contentContainer.children.flatMap((child) => child.render(width)); }
}

const snapshot = (n) => ({
	role: "assistant", timestamp: 101, stopReason: "stop",
	content: [
		{ type: "text", text: "Let me check that first." },
		{ type: "thinking", thinking: `planning ${n}` },
		{ type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
		{ type: "text", text: "The answer is forty-two." },
	],
});

const strip = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter((row) => row);

test("one snapshot per streamed chunk keeps one progress row over a reused Markdown child", () => {
	const model = new ToolFoldModel(() => 1000);
	const patch = installThinkingFold(StreamingAssistant, model, () => ({ fg: (_color, text) => text, bg: (_color, text) => text }));
	assert.equal(patch.installed, true);
	try {
		model.beginExchange(1);
		model.ingest(snapshot(0));
		model.endExchange(1234);

		const component = new StreamingAssistant();
		let previous;
		for (let chunk = 0; chunk < 40; chunk++) {
			component.updateContent(snapshot(chunk));
			const slots = component.markdownSlots.map((slot) => slot.markdown);
			assert.equal(slots.length, 2);
			if (previous) assert.ok(slots.every((markdown, index) => markdown === previous[index]), "the fakes must reuse Markdown children like Pi 1.5.0");
			previous = slots;
		}
		model.toggleProgress(1); // the reader expands the progress fold

		const rows = strip(component.render(120));
		assert.equal(rows.filter((row) => row.includes("Worked for")).length, 1, `one progress row, got:\n${rows.join("\n")}`);
		const note = rows.filter((row) => row.includes("Let me check that first."));
		assert.equal(note.length, 1, `the interim note is shown once, got:\n${rows.join("\n")}`);
		assert.match(note[0], /^\s*[│├└]\s*Let me check that first\.$/, "the note sits under a progress guide");
	} finally {
		patch.restore();
	}
});

test("a collapsed progress fold keeps its single row whatever the snapshot count", () => {
	const model = new ToolFoldModel(() => 1000);
	const patch = installThinkingFold(StreamingAssistant, model, () => ({ fg: (_color, text) => text, bg: (_color, text) => text }));
	assert.equal(patch.installed, true);
	try {
		model.beginExchange(1);
		model.ingest(snapshot(0));
		model.endExchange(1234);
		const component = new StreamingAssistant();
		for (let chunk = 0; chunk < 30; chunk++) component.updateContent(snapshot(chunk));
		const rows = strip(component.render(120));
		assert.equal(rows.filter((row) => row.includes("Worked for")).length, 1, rows.join("\n"));
		assert.ok(!rows.some((row) => row.includes("Let me check that first.")), "a folded note stays hidden");
	} finally {
		patch.restore();
	}
});
