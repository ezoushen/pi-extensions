import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

initTheme("dark");
const ui = { requestRender() {} };
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content, stopReason: "stop" });
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const column = (line, glyph) => plain(line).indexOf(glyph);
const nativeToolRender = ToolExecutionComponent.prototype.render;

function setup(timestamp) {
	const model = new ToolFoldModel(() => 100);
	const message = snapshot(timestamp, [
		{ type: "thinking", thinking: "Checking the setup file." },
		{ type: "toolCall", id: `indent-${timestamp}`, name: "bash", arguments: { command: "echo nested-output" } },
	]);
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	const assistant = new AssistantMessageComponent();
	assistant.updateContent(snapshot(timestamp, message.content.map((item) => ({ ...item }))), false);
	const tool = new ToolExecutionComponent("bash", `indent-${timestamp}`, { command: "echo nested-output" }, {}, undefined, ui, ".");
	tool.updateResult({ content: [{ type: "text", text: "nested-output" }], isError: false }, false);
	return { model, message, assistant, tool, restore() { thinkingPatch.restore(); toolPatch.restore(); } };
}

test("block titles in an open process are indented under its process line", () => {
	const { assistant, tool, restore } = setup(801);
	try {
		const assistantRows = assistant.render(80);
		const toolRows = tool.render(80);
		const rows = [...assistantRows, ...toolRows];
		const processAt = rows.findIndex((line) => plain(line).includes("▾ ◈"));
		const thinkingAt = rows.findIndex((line) => plain(line).includes("◈ Checking"));
		const toolAt = assistantRows.length + toolRows.findIndex((line) => plain(line).includes("⚙ bash"));
		const processLine = rows[processAt];
		const thinkingTitle = rows[thinkingAt];
		const toolTitle = rows[toolAt];
		assert.ok(processLine && thinkingTitle && toolTitle);
		assert.equal(thinkingAt, processAt + 1, "an open process title directly follows its process line");
		assert.equal(toolAt, thinkingAt + 1, "the next block title directly follows its process sibling");
		assert.equal(column(thinkingTitle, "◈"), column(processLine, "▾") + 2);
		assert.equal(column(toolTitle, "⚙"), column(processLine, "▾") + 2);
	} finally { restore(); }
});

test("opening a tool block keeps its title and indents the native output below it", () => {
	const { model, tool, restore } = setup(802);
	try {
		const output = "first line\n\nlast line";
		tool.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
		const native = new ToolExecutionComponent("bash", "indent-802", { command: "echo nested-output" }, {}, undefined, ui, ".");
		native.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
		const nativeRows = nativeToolRender.call(native, 76);
		const nativeStart = nativeRows.findIndex((line) => plain(line).trim() !== "");
		const nativeEnd = nativeRows.findLastIndex((line) => plain(line).trim() !== "");
		model.toggle("indent-802");
		const lines = tool.render(80);
		const titleAt = lines.findIndex((line) => plain(line).includes("⚙ bash"));
		assert.ok(titleAt >= 0, "the folded title stays visible when the block is open");
		const titleColumn = column(lines[titleAt], "⚙");
		const body = lines.slice(titleAt + 1);
		assert.ok(body.some((line) => plain(line).includes("nested-output")), "native output follows the title");
		for (const line of body.filter((row) => plain(row).trim())) assert.ok(plain(line).slice(2).search(/\S/) >= titleColumn, `native line is indented after its guide: ${JSON.stringify(plain(line))}`);
		assert.deepEqual(body.map((line) => line.slice(4)), nativeRows.slice(nativeStart, nativeEnd + 1), "native output keeps its rows and internal blank lines while edge padding is removed");
	} finally { restore(); }
});

test("opening a thinking block keeps its title and indents the native trace below it", () => {
	const { model, message, assistant, restore } = setup(803);
	try {
		model.toggleThinking(message, 0);
		const lines = assistant.render(80);
		const titleAt = lines.findIndex((line) => plain(line).includes("◈ Checking the setup file."));
		assert.ok(titleAt >= 0, "the folded title stays visible when the block is open");
		const titleColumn = column(lines[titleAt], "◈");
		const body = lines.slice(titleAt + 1).filter((line) => plain(line).trim());
		assert.ok(body.some((line) => plain(line).includes("Checking the setup file.")), "native trace follows the title");
		for (const line of body) assert.ok(plain(line).slice(2).search(/\S/) >= titleColumn, `native line is indented after its guide: ${JSON.stringify(plain(line))}`);
	} finally { restore(); }
});

test("clicks inside an opened tool's native output reach Pi at native row and width", () => {
	const nativeMouse = Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "handleMouse");
	const seen = [];
	ToolExecutionComponent.prototype.handleMouse = function (event) { seen.push(event); return { handled: true }; };
	const model = new ToolFoldModel(() => 100);
	const native = new ToolExecutionComponent("bash", "indent-mouse", { command: "echo nested-output" }, {}, undefined, ui, ".");
	native.updateResult({ content: [{ type: "text", text: "nested-output" }], isError: false }, false);
	const nativeTarget = nativeToolRender.call(native, 76).findLastIndex((line) => plain(line).includes("nested-output"));
	const message = snapshot(804, [
		{ type: "text", text: "Next" },
		{ type: "toolCall", id: "indent-mouse", name: "bash", arguments: { command: "echo nested-output" } },
	]);
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	try {
		const tool = new ToolExecutionComponent("bash", "indent-mouse", { command: "echo nested-output" }, {}, undefined, ui, ".");
		tool.updateResult({ content: [{ type: "text", text: "nested-output" }], isError: false }, false);
		model.toggle("indent-mouse");
		const lines = tool.render(80);
		const outputRow = lines.findLastIndex((line) => plain(line).includes("nested-output"));
		assert.ok(outputRow >= 0, "opened native output is visible without its leading blank padding");
		tool.handleMouse({ type: "click", button: "left", y: outputRow, x: 10, width: 80, height: lines.length });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].y, nativeTarget, "click row is relative to Pi's untrimmed output");
		assert.equal(seen[0].width, 76, "width is the width Pi's output was rendered at");
		tool.handleMouse({ type: "move", button: "none", y: outputRow, x: 10, width: 80, height: lines.length });
		assert.equal(seen.length, 2);
		assert.equal(seen[1].y, nativeTarget, "hover row is relative to Pi's untrimmed output");
		assert.equal(seen[1].width, 76);
	} finally {
		toolPatch.restore();
		if (nativeMouse) Object.defineProperty(ToolExecutionComponent.prototype, "handleMouse", nativeMouse);
		else delete ToolExecutionComponent.prototype.handleMouse;
	}
});
