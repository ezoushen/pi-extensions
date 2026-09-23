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
