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
		const lines = assistant.render(80);
		const processLine = lines.find((line) => plain(line).includes("▾ ◈"));
		const thinkingTitle = lines.find((line) => plain(line).includes("◈ Checking"));
		const toolTitle = tool.render(80).find((line) => plain(line).includes("⚙ bash"));
		assert.ok(processLine && thinkingTitle && toolTitle);
		assert.equal(column(thinkingTitle, "◈"), column(processLine, "▾") + 2);
		assert.equal(column(toolTitle, "⚙"), column(processLine, "▾") + 2);
	} finally { restore(); }
});

test("opening a tool block keeps its title and indents the native output below it", () => {
	const { model, tool, restore } = setup(802);
	try {
		model.toggle("indent-802");
		const lines = tool.render(80);
		const titleAt = lines.findIndex((line) => plain(line).includes("⚙ bash"));
		assert.ok(titleAt >= 0, "the folded title stays visible when the block is open");
		const titleColumn = column(lines[titleAt], "⚙");
		const body = lines.slice(titleAt + 1).filter((line) => plain(line).trim());
		assert.ok(body.some((line) => plain(line).includes("nested-output")), "native output follows the title");
		for (const line of body) assert.ok(plain(line).search(/\S/) >= titleColumn + 2, `native line is indented: ${JSON.stringify(plain(line))}`);
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
		for (const line of body) assert.ok(plain(line).search(/\S/) >= titleColumn + 2, `native line is indented: ${JSON.stringify(plain(line))}`);
	} finally { restore(); }
});

test("clicks inside an opened tool's native output reach Pi at native row and width", () => {
	const nativeMouse = Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, "handleMouse");
	const seen = [];
	ToolExecutionComponent.prototype.handleMouse = function (event) { seen.push(event); return { handled: true }; };
	const model = new ToolFoldModel(() => 100);
	const message = snapshot(804, [
		{ type: "text", text: "Next" },
		{ type: "toolCall", id: "indent-mouse", name: "bash", arguments: { command: "echo nested-output" } },
	]);
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	try {
		const tool = new ToolExecutionComponent("bash", "indent-mouse", { command: "echo nested-output" }, {}, undefined, ui, ".");
		model.toggle("indent-mouse");
		const lines = tool.render(80);
		const header = lines.findIndex((line) => plain(line).includes("⚙ bash  echo")) + 1;
		assert.equal(header, 2, "process line and title precede the native output");
		tool.handleMouse({ type: "click", button: "left", y: header + 2, x: 10, width: 80, height: lines.length });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].y, 2, "row is relative to Pi's own output");
		assert.equal(seen[0].width, 76, "width is the width Pi's output was rendered at");
	} finally {
		toolPatch.restore();
		if (nativeMouse) Object.defineProperty(ToolExecutionComponent.prototype, "handleMouse", nativeMouse);
		else delete ToolExecutionComponent.prototype.handleMouse;
	}
});
