import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { FoldPicker } from "./src/fold-picker.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

initTheme("dark");

const message = (timestamp, content) => ({ role: "assistant", timestamp, content });

test("a settled answered exchange folds progress before its trailing text", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	model.beginExchange(1);
	const first = message(10, [{ type: "thinking", thinking: "plan" }, { type: "text", text: "checking" }, { type: "toolCall", id: "read-1", name: "read", arguments: {} }]);
	model.observeThinking(first, { type: "thinking_delta", contentIndex: 0, delta: "plan" });
	model.ingest(first);
	now = 1400;
	model.start("read-1", "read");
	model.end("read-1", false, undefined, 1500);
	now = 1600;
	model.ingest(message(20, [{ type: "text", text: "answer" }]));
	assert.equal(model.progressForItem("thinking:10:0"), undefined);
	model.endExchange();
	assert.equal(model.progressLine(1), "▸ Worked for 600ms · ◈1 ⚙1 · 1 note");
	assert.deepEqual(model.progressForItem("thinking:10:0"), { exchange: 1, lead: true, open: false });
	assert.deepEqual(model.progressForItem("text:10:1"), { exchange: 1, lead: false, open: false });
	assert.equal(model.progressForItem("text:20:0"), undefined);
	assert.equal(model.toggleLatestExchange(), true);
	assert.equal(model.progressLine(1), "▾ Worked for 600ms · ◈1 ⚙1 · 1 note");
});

test("progress duration begins at the first process block when assistant text comes first", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	model.beginExchange(1);
	model.ingest(message(11, [{ type: "text", text: "I will inspect the file." }]));
	now = 1100;
	model.ingest(message(12, [{ type: "toolCall", id: "read-first-block", name: "read", arguments: { path: "file" } }]));
	now = 1200;
	model.ingest(message(13, [{ type: "text", text: "Here is the answer." }]));
	model.endExchange();
	assert.equal(model.progressLine(1), "▸ Worked for 100ms · ◈0 ⚙1 · 1 note");
});

test("exchanges without process blocks or trailing text do not fold", () => {
	const noTrailingText = new ToolFoldModel(() => 1000);
	noTrailingText.beginExchange(1);
	noTrailingText.ingest(message(21, [
		{ type: "thinking", thinking: "Still working." },
		{ type: "toolCall", id: "unfinished", name: "read", arguments: {} },
		{ type: "text", text: "   " },
	]));
	noTrailingText.endExchange();
	assert.equal(noTrailingText.progressLine(1), "");
	assert.equal(noTrailingText.progressForItem("thinking:21:0"), undefined);

	const noProcess = new ToolFoldModel(() => 1000);
	noProcess.beginExchange(1);
	noProcess.ingest(message(22, [{ type: "text", text: "A response with no process." }]));
	noProcess.endExchange();
	assert.equal(noProcess.progressLine(1), "");
	assert.equal(noProcess.progressForItem("text:22:0"), undefined);
});

test("real Pi components show one settled progress line, then unwind native interim text and process rows", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	model.beginExchange(1);
	const a = message(101, [{ type: "thinking", thinking: "First trace." }, { type: "text", text: "Note A" }, { type: "toolCall", id: "read-a", name: "read", arguments: { path: "a" } }]);
	const b = message(102, [{ type: "thinking", thinking: "Second trace." }, { type: "toolCall", id: "read-b", name: "read", arguments: { path: "b" } }, { type: "text", text: "Note B" }]);
	const c = message(103, [{ type: "thinking", thinking: "Third trace." }, { type: "toolCall", id: "read-c", name: "read", arguments: { path: "c" } }]);
	const d = message(104, [{ type: "text", text: "Final answer" }]);
	for (const item of [a, b, c, d]) { model.ingest(message(item.timestamp, item.content.map((part) => ({ ...part })))); now += 100; }
	const theme = () => ({ fg(_color, text) { return `\x1b[2m${text}\x1b[0m`; }, bg(_color, text) { return `\x1b[7m${text}\x1b[0m`; } });
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model, theme);
	const toolPatch = installToolFold(ToolExecutionComponent, model, theme);
	const ui = { requestRender() {} };
	const assistant = (source) => { const component = new AssistantMessageComponent(); component.updateContent(message(source.timestamp, source.content.map((part) => ({ ...part }))), false); return component; };
	const tool = (id, path) => new ToolExecutionComponent("read", id, { path }, {}, undefined, ui, ".");
	try {
		const components = [assistant(a), tool("read-a", "a"), assistant(b), tool("read-b", "b"), assistant(c), tool("read-c", "c"), assistant(d)];
		const rawLines = () => components.flatMap((component) => component.render(80)).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, ""));
		const lines = () => rawLines().filter((line) => line.trim());
		assert.doesNotMatch(lines().join("\n"), /Worked for/);
		assert.match(lines().join("\n"), /Note A[\s\S]*Note B[\s\S]*Final answer/);
		model.endExchange();
		assert.equal(lines().filter((line) => line.includes("Worked for")).length, 1);
		assert.doesNotMatch(lines().join("\n"), /Note A|Note B|▸ ◈|▾ ◈/);
		assert.match(lines().at(-1), /Final answer/);
		const folded = rawLines();
		const progressRow = folded.findIndex((line) => line.includes("Worked for"));
		const answerRow = folded.findIndex((line) => line.includes("Final answer"));
		assert.equal(answerRow - progressRow - 1, 1, JSON.stringify(folded));
		const native = new AssistantMessageComponent();
		native.updateContent(message(d.timestamp, d.content.map((part) => ({ ...part }))), false);
		const markdown = (component) => component.contentContainer.children.filter((child) => child.constructor.name === "Markdown").map((child) => child.render(80));
		assert.deepEqual(markdown(components.at(-1)), markdown(native));
		model.toggleLatestExchange();
		const expanded = lines();
		assert.match(expanded[0], /▾ Worked for/);
		const progressGlyphColumn = expanded[0].indexOf("▾");
		assert.equal(expanded.find((line) => line.includes("Note A"))?.indexOf("│"), progressGlyphColumn);
		assert.equal(expanded.find((line) => line.includes("Note B"))?.indexOf("│"), progressGlyphColumn);
		assert.equal(expanded.find((line) => line.includes("▸ ◈"))?.indexOf("├"), progressGlyphColumn);
		const expandedRows = rawLines();
		const expandedProgress = expandedRows.findIndex((line) => line.includes("Worked for"));
		const firstProcess = expandedRows.findIndex((line, index) => index > expandedProgress && line.includes("▸ ◈"));
		assert.equal(firstProcess - expandedProgress - 1, 1, JSON.stringify(expandedRows));
		assert.equal(expanded.at(-1)?.indexOf("Final answer"), lines().at(-1)?.indexOf("Final answer"));
		model.toggleLatestExchange();
		assert.equal(lines().filter((line) => line.includes("Worked for")).length, 1);
	} finally { thinkingPatch.restore(); toolPatch.restore(); }
});

test("a process line has one blank row above and below it between assistant texts", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const source = message(201, [
		{ type: "text", text: "Before the process" },
		{ type: "thinking", thinking: "Inspecting." },
		{ type: "text", text: "After the process" },
	]);
	model.ingest(message(source.timestamp, source.content.map((part) => ({ ...part }))));
	const patch = installThinkingFold(AssistantMessageComponent, model);
	try {
		const component = new AssistantMessageComponent();
		component.updateContent(message(source.timestamp, source.content.map((part) => ({ ...part }))), false);
		const plain = component.render(80).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, ""));
		const line = plain.findIndex((row) => row.includes("▸ ◈"));
		const before = plain.findLastIndex((row, index) => index < line && row.includes("Before the process"));
		const after = plain.findIndex((row, index) => index > line && row.includes("After the process"));
		assert.notEqual(line, -1);
		assert.equal(line - before - 1, 1);
		assert.equal(after - line - 1, 1);
		const region = component.contentContainer.children.find((child) => child.constructor.name === "MouseRegion");
		const clicked = region.handleMouse({ type: "click", button: "left", y: 1, width: 80, height: 2 });
		assert.equal(clicked?.handled, true);
		assert.equal(model.isProcessOpen(model.processes()[0].id), true);
	} finally { patch.restore(); }
});

test("a tool process line has one blank row above and below it between assistant messages", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const before = message(202, [{ type: "text", text: "Before the process" }, { type: "toolCall", id: "read-202", name: "read", arguments: { path: "file" } }]);
	const after = message(203, [{ type: "text", text: "After the process" }]);
	model.ingest(message(before.timestamp, before.content.map((part) => ({ ...part }))));
	model.ingest(message(after.timestamp, after.content.map((part) => ({ ...part }))));
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	try {
		const components = [
			new AssistantMessageComponent(),
			new ToolExecutionComponent("read", "read-202", { path: "file" }, {}, undefined, { requestRender() {} }, "."),
			new AssistantMessageComponent(),
		];
		components[0].updateContent(message(before.timestamp, before.content.map((part) => ({ ...part }))), false);
		components[2].updateContent(message(after.timestamp, after.content.map((part) => ({ ...part }))), false);
		const plain = components.flatMap((component) => component.render(80)).map((row) => row.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, ""));
		const line = plain.findIndex((row) => row.includes("▸ ◈"));
		const beforeRow = plain.findLastIndex((row, index) => index < line && row.includes("Before the process"));
		const afterRow = plain.findIndex((row, index) => index > line && row.includes("After the process"));
		assert.notEqual(line, -1);
		assert.equal(line - beforeRow - 1, 1);
		assert.equal(afterRow - line - 1, 1);
		const process = model.processes()[0];
		const clicked = components[1].handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 3 });
		assert.equal(clicked?.handled, true);
		assert.equal(model.isProcessOpen(process.id), true);
	} finally { thinkingPatch.restore(); toolPatch.restore(); }
});

test("the picker exchange row toggles and reflects settled progress", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	model.ingest(message(301, [{ type: "thinking", thinking: "Inspecting." }, { type: "text", text: "Answer" }]));
	model.endExchange();
	const picker = new FoldPicker(model, () => ({ fg: (_color, text) => text, bg: (_color, text) => text }), () => {}, () => {});
	const exchangeRow = () => picker.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).find((line) => line.includes("Exchange 1"));
	assert.match(exchangeRow(), /▸ Exchange 1/);
	picker.handleInput("\r");
	assert.match(model.progressLine(1), /^▾/);
	assert.match(exchangeRow(), /▾ Exchange 1/);
});

test("the progress row supports click, hover, cursor selection, and narrow widths", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const source = message(401, [
		{ type: "thinking", thinking: "Inspecting files." },
		{ type: "text", text: "I found the answer." },
	]);
	model.ingest(message(source.timestamp, source.content.map((part) => ({ ...part }))));
	model.endExchange();
	const theme = () => ({
		fg(color, text) { return `${color === "accent" ? "\x1b[31m" : color === "muted" ? "\x1b[33m" : "\x1b[2m"}${text}\x1b[0m`; },
		bg(_color, text) { return `\x1b[48;5;24m${text}\x1b[0m`; },
		italic(text) { return `\x1b[3m${text}\x1b[23m`; },
	});
	const patch = installThinkingFold(AssistantMessageComponent, model, theme);
	try {
		const component = new AssistantMessageComponent();
		component.updateContent(message(source.timestamp, source.content.map((part) => ({ ...part }))), false);
		const region = component.contentContainer.children.find((child) => child.constructor.name === "MouseRegion");
		assert.match(component.render(18).join("\n"), /\x1b\[2m.*\x1b\[3m|\x1b\[3m.*\x1b\[2m/);
		assert.ok(model.startCursor());
		assert.equal(model.cursorTitle(), model.progressLine(1));
		assert.match(component.render(18).join("\n"), /\x1b\[31m.*Worked/);
		assert.match(component.render(18).join("\n"), /\x1b\[3m/);
		model.cursorToggle();
		assert.match(model.progressLine(1), /^▾/);
		model.cursorToggle();
		model.stopCursor();
		const hover = region.handleMouse({ type: "move", button: "", y: 0, width: 18, height: 1 });
		assert.equal(hover?.handled, true);
		assert.match(component.render(18).join("\n"), /\x1b\[48;5;24m/);
		assert.match(component.render(18).join("\n"), /\x1b\[33m/);
		assert.match(component.render(18).join("\n"), /\x1b\[3m/);
		const click = region.handleMouse({ type: "click", button: "left", y: 0, width: 18, height: 1 });
		assert.equal(click?.handled, true);
		assert.match(model.progressLine(1), /^▾/);
		assert.ok(component.render(18).every((row) => visibleWidth(row) <= 18));
	} finally { patch.restore(); }
});

test("the progress control works when interim assistant text is its first item", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const source = message(402, [{ type: "text", text: "I will inspect the file." }, { type: "toolCall", id: "first-progress-text", name: "read", arguments: { path: "file" } }]);
	model.ingest(message(source.timestamp, source.content.map((part) => ({ ...part }))));
	model.ingest(message(403, [{ type: "text", text: "The final answer." }]));
	model.endExchange();
	const patch = installThinkingFold(AssistantMessageComponent, model);
	try {
		const component = new AssistantMessageComponent();
		component.updateContent(message(source.timestamp, source.content.map((part) => ({ ...part }))), false);
		assert.doesNotMatch(component.render(80).join("\n"), /I will inspect the file/);
		assert.match(component.render(80).join("\n"), /▸ Worked for/);
		const clicked = component.handleMouse({ type: "click", button: "left", y: 1, width: 80, height: 1 });
		assert.equal(clicked?.handled, true);
		const expanded = component.render(80).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, ""));
		assert.match(expanded.join("\n"), /▾ Worked for/);
		const progressRow = expanded.findIndex((line) => line.includes("Worked for"));
		const firstText = expanded.findIndex((line, index) => index > progressRow && line.includes("I will inspect the file."));
		assert.equal(firstText - progressRow - 1, 1, JSON.stringify(expanded));
	} finally { patch.restore(); }
});

test("picker text rows are italic while its border stays upright", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	model.ingest(message(501, [{ type: "thinking", thinking: "Inspecting files." }, { type: "text", text: "Answer" }]));
	model.endExchange();
	const theme = {
		fg(_color, text) { return `\x1b[38;5;1m${text}\x1b[39m`; },
		italic(text) { return `\x1b[3m${text}\x1b[23m`; },
		bg(_color, text) { return text; },
	};
	const picker = new FoldPicker(model, () => theme, () => {}, () => {});
	const rows = picker.render(80);
	assert.doesNotMatch(rows[0], /\x1b\[3m/);
	assert.match(rows[1], /\x1b\[38;5;1m/);
	assert.match(rows[1], /\x1b\[3m/);
	assert.ok(rows.slice(2, -1).every((row) => /\x1b\[3m/.test(row)));
	assert.doesNotMatch(rows.at(-1), /\x1b\[3m/);
});

test("clipped picker rows stay dim italic after the ellipsis", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	model.ingest(message(502, [{ type: "thinking", thinking: "Inspecting the whole repository layout before touching any file at all." }, { type: "text", text: "Answer" }]));
	model.endExchange();
	const theme = {
		fg(_color, text) { return `\x1b[38;5;1m${text}\x1b[39m`; },
		italic(text) { return `\x1b[3m${text}\x1b[23m`; },
		bg(_color, text) { return text; },
	};
	const picker = new FoldPicker(model, () => theme, () => {}, () => {});
	for (const width of [40, 20]) {
		const rows = picker.render(width);
		assert.ok(rows.slice(2, -1).some((row) => row.includes("…")), `a block row is clipped at ${width}`);
		for (const row of rows.slice(1, -1)) assert.doesNotMatch(row, /\x1b\[0m/, `no reset ends the style early at ${width}: ${JSON.stringify(row)}`);
	}
});
