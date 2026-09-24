import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

initTheme("dark");
const ui = { requestRender() {} };
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content, stopReason: "stop" });
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
// Distinct zero-width ANSI per theme colour, so tests can see how each row was styled.
const FG = { dim: 1, muted: 2, accent: 3 };
const BG_OPEN = "\x1b[48;5;236m";
const theme = (innerReset = false) => ({
	fg(color, text) {
		const body = innerReset ? text.replace(" ", "\x1b[0m ") : text;
		return `\x1b[38;5;${FG[color]}m${body}\x1b[39m`;
	},
	bg(color, text) { assert.equal(color, "selectedBg"); return `${BG_OPEN}${text}\x1b[49m`; },
	italic(text) { return `\x1b[3m${text}\x1b[23m`; },
});
const HOVER = /\x1b\[48;5;236m/;
const move = (y, height = 40) => ({ type: "move", button: "none", x: 5, y, width: 80, height });

function setup(timestamp, getTheme = theme, settled = false) {
	const model = new ToolFoldModel(() => 100);
	const message = snapshot(timestamp, [
		{ type: "thinking", thinking: "Checking the setup file." },
		{ type: "toolCall", id: `hover-${timestamp}`, name: "bash", arguments: { command: "echo hover" } },
		{ type: "text", text: "Plain answer text." },
	]);
	if (settled) model.beginExchange(1);
	model.ingest(message);
	if (settled) model.endExchange();
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model, getTheme);
	const toolPatch = installToolFold(ToolExecutionComponent, model, getTheme);
	const assistant = new AssistantMessageComponent();
	assistant.updateContent(snapshot(timestamp, message.content.map((item) => ({ ...item }))), false);
	const tool = new ToolExecutionComponent("bash", `hover-${timestamp}`, { command: "echo hover" }, {}, undefined, ui, ".");
	tool.updateResult({ content: [{ type: "text", text: "hover" }], isError: false }, false);
	const rowOf = (lines, needle) => lines.findIndex((line) => plain(line).includes(needle));
	return { model, message, assistant, tool, rowOf, restore() { thinkingPatch.restore(); toolPatch.restore(); } };
}

test("hovering a process line highlights it and asks Pi to repaint", () => {
	const { assistant, rowOf, restore } = setup(901);
	try {
		const lines = assistant.render(80);
		const processRow = rowOf(lines, "▸ ◈");
		assert.ok(processRow >= 0);
		assert.match(plain(lines[processRow]), /▸ ◈ 1 ⚙ 1 ·/);
		assert.match(lines[processRow], /\x1b\[3m/);
		assert.match(lines[processRow], /\x1b\[38;5;1m/);
		assert.doesNotMatch(lines.join("\n"), HOVER);
		const result = assistant.handleMouse(move(processRow, lines.length));
		assert.equal(result?.render, true, "a hover change requests a render");
		const hovered = assistant.render(80);
		assert.match(plain(hovered[processRow]), /▸ ◈ 1 ⚙ 1 ·/);
		assert.match(hovered[processRow], HOVER);
		assert.match(hovered[processRow], /\x1b\[3m/);
		assert.match(hovered[processRow], /\x1b\[38;5;2m/);
		assert.equal(hovered.filter((line) => HOVER.test(line)).length, 1, "only the hovered row is highlighted");
	} finally { restore(); }
});

test("hovering one owner's settled progress does not highlight another owner's matching row", () => {
	const first = setup(909, theme, true);
	const second = setup(910, theme, true);
	try {
		const firstLines = first.assistant.render(80);
		const secondLines = second.assistant.render(80);
		const firstRow = first.rowOf(firstLines, "▸ Worked for");
		const secondRow = second.rowOf(secondLines, "▸ Worked for");
		assert.ok(firstRow >= 0, "first owner renders its settled progress row");
		assert.ok(secondRow >= 0, "second owner renders its settled progress row");
		first.assistant.handleMouse(move(firstRow, firstLines.length));
		assert.match(first.assistant.render(80)[firstRow], HOVER);
		assert.doesNotMatch(second.assistant.render(80)[secondRow], HOVER, "the same exchange key belongs to a different model");
	} finally {
		second.restore();
		first.restore();
	}
});

test("hovering a block title highlights only that title; moving onto text clears it", () => {
	const { model, assistant, tool, rowOf, restore } = setup(902);
	try {
		model.toggleProcess(model.processes()[0].id);
		let toolLines = tool.render(80);
		const toolTitle = rowOf(toolLines, "⚙ bash  echo");
		assert.ok(toolTitle >= 0);
		assert.match(toolLines[toolTitle], /\x1b\[3m/);
		assert.match(toolLines[toolTitle], /\x1b\[38;5;1m/);
		tool.handleMouse(move(toolTitle, toolLines.length));
		toolLines = tool.render(80);
		assert.match(toolLines[toolTitle], HOVER);
		assert.match(toolLines[toolTitle], /\x1b\[3m/);
		assert.match(toolLines[toolTitle], /\x1b\[38;5;2m/);
		const assistantLines = assistant.render(80);
		assert.doesNotMatch(assistantLines.join("\n"), HOVER, "hover is exclusive across components");

		const textRow = rowOf(assistantLines, "Plain answer text.");
		assert.ok(textRow >= 0);
		const result = assistant.handleMouse(move(textRow, assistantLines.length));
		assert.equal(result?.render, true, "clearing the hover requests a render");
		assert.doesNotMatch(tool.render(80).join("\n"), HOVER);
		assert.doesNotMatch(assistant.render(80).join("\n"), HOVER);
	} finally { restore(); }
});

test("hovering a thinking title highlights it; an opened block's native output is never highlighted", () => {
	const { model, message, assistant, tool, rowOf, restore } = setup(903);
	try {
		model.toggleProcess(model.processes()[0].id);
		let lines = assistant.render(80);
		const thinkingTitle = rowOf(lines, "◈ Checking the setup file.");
		assert.ok(thinkingTitle >= 0);
		assert.match(lines[thinkingTitle], /\x1b\[3m/);
		assert.match(lines[thinkingTitle], /\x1b\[38;5;1m/);
		assistant.handleMouse(move(thinkingTitle, lines.length));
		lines = assistant.render(80);
		assert.match(lines[thinkingTitle], HOVER);
		assert.match(lines[thinkingTitle], /\x1b\[3m/);
		assert.match(lines[thinkingTitle], /\x1b\[38;5;2m/);

		model.toggle(`hover-903`);
		let toolLines = tool.render(80);
		const body = toolLines.findIndex((line) => plain(line).includes("hover") && !plain(line).includes("⚙"));
		assert.ok(body > 0, "opened tool shows native output below its title");
		tool.handleMouse(move(body, toolLines.length));
		toolLines = tool.render(80);
		assert.doesNotMatch(toolLines.join("\n"), HOVER, "native output rows are Pi's, not a fold control");
		assert.doesNotMatch(assistant.render(80).join("\n"), HOVER, "moving onto non-control rows clears the hover");
		model.toggleThinking(message, 0);
	} finally { restore(); }
});

test("the transcript cursor's accent wins over hover on the same row", () => {
	const { model, assistant, tool, rowOf, restore } = setup(904);
	try {
		const lines = assistant.render(80);
		const processRow = rowOf(lines, "▸ ◈");
		assistant.handleMouse(move(processRow, lines.length));
		model.toggleProcess(model.processes()[0].id);
		assert.equal(model.startCursor(), true);
		assert.equal(model.isCursorHighlighted(`process:${model.processes()[0].id}`), true);
		let openLines = assistant.render(80);
		let row = openLines[rowOf(openLines, "▾ ◈")];
		assert.match(row, /\x1b\[38;5;3m/);
		assert.match(row, /\x1b\[3m/);
		assert.doesNotMatch(row, HOVER);
		model.cursorMove(1);
		row = assistant.render(80)[rowOf(assistant.render(80), "◈ Checking the setup file.")];
		assert.match(row, /\x1b\[38;5;3m/);
		assert.match(row, /\x1b\[3m/);
		model.cursorMove(1);
		row = tool.render(80)[rowOf(tool.render(80), "⚙ bash  echo")];
		assert.match(row, /\x1b\[38;5;3m/);
		assert.match(row, /\x1b\[3m/);
	} finally { restore(); }
});

test("hovered fold text restores its theme color and italic after an inner reset", () => {
	const { assistant, rowOf, restore } = setup(907, () => theme(true));
	try {
		const lines = assistant.render(80);
		const processRow = rowOf(lines, "▸ ◈");
		assistant.handleMouse(move(processRow, lines.length));
		const row = assistant.render(80)[processRow];
		assert.match(row, /\x1b\[0m\x1b\[48;5;236m\x1b\[38;5;2m\x1b\[3m ◈/);
	} finally { restore(); }
});

test("fold rows render when a theme does not provide italic", () => {
	const noItalic = () => ({
		fg(color, text) { return `\x1b[38;5;${FG[color]}m${text}\x1b[39m`; },
		bg(color, text) { assert.equal(color, "selectedBg"); return `${BG_OPEN}${text}\x1b[49m`; },
	});
	const { assistant, rowOf, restore } = setup(908, noItalic);
	try {
		const lines = assistant.render(80);
		const row = lines[rowOf(lines, "▸ ◈")];
		assert.match(row, /▸ ◈/);
		assert.doesNotMatch(row, /\x1b\[3m/);
	} finally { restore(); }
});

test("the hover bar runs from the title's indented start to the right edge, without wrapping", () => {
	const { model, tool, rowOf, restore } = setup(905);
	try {
		model.toggleProcess(model.processes()[0].id);
		let lines = tool.render(80);
		const row = rowOf(lines, "⚙ bash  echo");
		tool.handleMouse(move(row, lines.length));
		lines = tool.render(80);
		assert.equal(lines.filter((line) => plain(line).includes("⚙ bash  echo")).length, 1, "the title stays one row");
		const line = lines[row];
		const barStart = line.indexOf(BG_OPEN);
		const glyph = plain(line).indexOf("⚙");
		assert.equal(plain(line.slice(0, barStart)), " └" + " ".repeat(glyph - 2), "the dim tree guide and padding stay outside the hover bar");
		assert.ok(line.endsWith("\x1b[49m"), "the bar reaches the end of the row");
		assert.equal(plain(line).length, 80, "the row fills the width exactly");
		assert.match(line, /\x1b\[38;5;2m⚙/, "hovered text is brighter than dim");
	} finally { restore(); }
});

test("moving onto another extension-drawn row, like the exchange card, clears the hover", async () => {
	const { endHoverOnMove } = await import("./src/tool-render.ts");
	const { model, assistant, rowOf, restore } = setup(906);
	try {
		const lines = assistant.render(80);
		assistant.handleMouse(move(rowOf(lines, "▸ ◈"), lines.length));
		assert.match(assistant.render(80).join("\n"), HOVER);
		assert.deepEqual(endHoverOnMove({ type: "move" }), { handled: true, render: true });
		assert.doesNotMatch(assistant.render(80).join("\n"), HOVER);
		assert.equal(endHoverOnMove({ type: "move" }), undefined, "no repaint when nothing was hovered");
		assert.equal(endHoverOnMove({ type: "click" }), undefined);
		void model;
	} finally { restore(); }
});
