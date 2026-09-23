import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installToolFold } from "./src/tool-render.ts";

initTheme("dark");
const ui = { requestRender() {} };
const result = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

function mount(now = () => 0, args = { command: "printf 'first\\nsecond\\n'" }) {
	const model = new ToolFoldModel(now);
	const component = new ToolExecutionComponent("bash", "call-1", args, {}, undefined, ui, ".");
	const original = ToolExecutionComponent.prototype.render;
	const native = component.render(80);
	const patch = installToolFold(ToolExecutionComponent, model);
	assert.equal(patch.installed, true);
	return { model, component, native, original, restore: patch.restore };
}

test("finished bash call folds to a title with command, status, duration and line count", () => {
	let time = 1000;
	const { model, component, restore } = mount(() => time);
	try {
		model.start("call-1", "bash", 1000);
		component.markExecutionStarted();
		time = 1450;
		component.updateResult(result("first\nsecond\n"));
		model.end("call-1", false, component.result, time);
		const lines = component.render(80);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /bash.*printf.*✓.*450ms.*2 lines/);
	} finally { restore(); }
});

test("running time grows between renders and failed calls show a cross", () => {
	let time = 1000;
	const { model, component, restore } = mount(() => time);
	try {
		model.start("call-1", "bash", time);
		component.markExecutionStarted();
		const first = component.render(80)[0];
		time = 2000;
		const second = component.render(80)[0];
		assert.match(first, /running.*0ms/);
		assert.match(second, /running.*1\.0s/);
		component.updateResult(result("failure", true));
		model.end("call-1", true, component.result, time);
		assert.match(component.render(80)[0], /✗.*1\.0s.*1 line/);
	} finally { restore(); }
});

test("model toggle returns the component's original full rendering and folds again", () => {
	const { model, component, original, restore } = mount();
	try {
		component.updateResult(result("first\nsecond"));
		model.end("call-1", false, component.result, 300);
		const expected = original.call(component, 80);
		assert.equal(component.render(80).length, 1);
		assert.equal(model.toggle("call-1"), true);
		assert.deepEqual(component.render(80), expected);
		assert.equal(model.toggle("call-1"), false);
		assert.equal(component.render(80).length, 1);
	} finally { restore(); }
});

test("tool timing survives a new Pi component for the same toolCallId", () => {
	let now = 1000;
	const { model, restore } = mount(() => now);
	try {
		model.start("call-1", "bash", now);
		now = 2500;
		const replacement = new ToolExecutionComponent("bash", "call-1", { command: "pwd" }, {}, undefined, ui, ".");
		assert.match(replacement.render(80)[0], /running 1\.5s/);
	} finally { restore(); }
});

test("tool titles fit 20, 40 and 80 columns with CJK arguments", () => {
	const { model, component, restore } = mount(() => 4000, { command: "讀取設定檔並顯示全部內容" });
	try {
		model.start("call-1", "bash", 0);
		component.updateResult(result("甲\n乙"));
		model.end("call-1", false, component.result, 4000);
		for (const width of [20, 40, 80]) {
			const lines = component.render(width);
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]) <= width, `${width}: ${lines[0]}`);
			assert.match(lines[0], /bash/);
			if (width === 40) assert.match(lines[0], /讀.*…/);
		}
	} finally { restore(); }
});

test("read title keeps the filename and stats after shortening an injected home path", () => {
	const home = "/fixture/home";
	const path = `${home}/Workspace/a/very/long/path/to/SETUP.md`;
	const model = new ToolFoldModel(() => 100);
	const tool = new ToolExecutionComponent("read", "path-call", { path }, {}, undefined, ui, ".");
	const patch = installToolFold(ToolExecutionComponent, model, () => undefined, () => 1, () => home);
	try {
		model.start("path-call", "read", 0);
		tool.updateResult(result("one\ntwo"));
		model.end("path-call", false, tool.result, 100);
		const line = tool.render(60)[0];
		assert.match(line, /~\/…\/.*SETUP\.md.*✓ 100ms · 2 lines/);
		assert.ok(visibleWidth(line) <= 60);
	} finally { patch.restore(); }
});

test("truncated bash title retains the command head and dims every visible title character", () => {
	const model = new ToolFoldModel(() => 100);
	const tool = new ToolExecutionComponent("bash", "long-command", { command: "printf beginning-of-command and-a-very-long-remainder-that-will-not-fit" }, {}, undefined, ui, ".");
	const patch = installToolFold(ToolExecutionComponent, model, () => ({ fg(_color, value) { return `\x1b[2m${value}\x1b[0m`; } }));
	try {
		model.start("long-command", "bash", 0);
		tool.updateResult(result("one\ntwo"));
		model.end("long-command", false, tool.result, 100);
		const line = tool.render(45)[0];
		assert.match(line, /printf beginn.*….*✓ 100ms · 2 lines/);
		let dim = false;
		for (const part of line.matchAll(/\x1b\[[0-9;]*m|[^\x1b]+/g)) {
			if (part[0] === "\x1b[2m") dim = true;
			else if (part[0] === "\x1b[0m") dim = false;
			else if (part[0].trim()) assert.equal(dim, true, part[0]);
		}
	} finally { patch.restore(); }
});

test("tool title uses the active dim theme on each render; native open output keeps Pi styling", () => {
	initTheme("dark");
	const model = new ToolFoldModel(() => 1000);
	const tool = new ToolExecutionComponent("bash", "themed-call", { command: "pwd" }, {}, undefined, ui, ".");
	const original = ToolExecutionComponent.prototype.render;
	let ansi = "\x1b[38;2;80;80;80m";
	const theme = () => ({ fg(name, value) { assert.equal(name, "dim"); return `${ansi}${value}\x1b[0m`; } });
	const patch = installToolFold(ToolExecutionComponent, model, theme);
	try {
		model.start("themed-call", "bash", 0);
		assert.match(tool.render(80)[0], /\x1b\[38;2;80;80;80m.*bash.*\x1b\[0m/);
		ansi = "\x1b[38;2;120;120;120m";
		assert.match(tool.render(80)[0], /\x1b\[38;2;120;120;120m.*bash.*\x1b\[0m/);
		model.toggle("themed-call");
		assert.deepEqual(tool.render(80), original.call(tool, 80));
	} finally { patch.restore(); }
});
