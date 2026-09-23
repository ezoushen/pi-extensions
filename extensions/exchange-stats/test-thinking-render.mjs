import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold } from "./src/tool-render.ts";

initTheme("dark");

function mount(message, model = new ToolFoldModel()) {
	const native = new AssistantMessageComponent();
	native.updateContent(message, true);
	const patch = installThinkingFold(AssistantMessageComponent, model);
	assert.equal(patch.installed, true);
	const folded = new AssistantMessageComponent();
	folded.updateContent(message, true);
	return { native, folded, model, restore: patch.restore };
}

test("live title grows with Pi's real assistant component", () => {
	let now = 0;
	const model = new ToolFoldModel(() => now);
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "one two three four" }], stopReason: "stop" };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: message.content[0].thinking });
	const { folded, restore } = mount(message, model);
	try {
		const first = folded.render(100).join("\n");
		now = 1000;
		message.content[0].thinking += " five six seven eight";
		model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: " five six seven eight" });
		folded.updateContent(message, true);
		const second = folded.render(100).join("\n");
		assert.match(first, /Thinking.*0ms.*~5 tok/);
		assert.match(second, /Thinking.*1\.0s.*~10 tok/);
	} finally { restore(); }
});

test("the live title keeps counting on render and stays on one line at narrow widths", () => {
	let now = 0;
	const model = new ToolFoldModel(() => now);
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "checking several things" }], stopReason: "stop" };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: message.content[0].thinking });
	const { folded, restore } = mount(message, model);
	try {
		assert.match(folded.render(80).join("\n"), /0ms/);
		now = 1000;
		assert.match(folded.render(80).join("\n"), /1\.0s/);
		for (const width of [20, 40, 80]) {
			const lines = folded.render(width);
			assert.equal(lines.length, 2);
		}
	} finally { restore(); }
});

test("two thinking runs fold while text children render exactly as Pi renders them", () => {
	const message = { role: "assistant", content: [
		{ type: "thinking", thinking: "first trace" }, { type: "text", text: "First answer\nsecond line" },
		{ type: "thinking", thinking: "second trace" }, { type: "text", text: "Final answer" },
	], stopReason: "stop" };
	const { native, folded, restore } = mount(message);
	try {
		const nativeText = native.contentContainer.children.filter((child) => child.constructor.name === "Markdown");
		const foldedText = folded.contentContainer.children.filter((child) => child.constructor.name === "Markdown");
		assert.deepEqual(foldedText.map((child) => child.render(80)), nativeText.map((child) => child.render(80)));
		assert.equal(folded.render(80).join("\n").match(/◈ Thinking/g)?.length, 2);
	} finally { restore(); }
});

test("hideThinkingBlock does not change titles or opened native traces", () => {
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "full trace here" }], stopReason: "stop" };
	const { folded, restore } = mount(message);
	try {
		const title = folded.render(80);
		folded.setHideThinkingBlock(true);
		assert.deepEqual(folded.render(80), title);
		const region = folded.contentContainer.children.find((child) => child.constructor.name === "MouseRegion");
		region.onMouse({ type: "click", button: "left" });
		assert.match(folded.render(80).join("\n"), /full trace here/);
		folded.setHideThinkingBlock(false);
		assert.match(folded.render(80).join("\n"), /full trace here/);
		region.onMouse({ type: "click", button: "left" });
		assert.deepEqual(folded.render(80), title);
	} finally { restore(); }
});

test("empty thinking content adds no title or blank line", () => {
	for (const content of [[{ type: "thinking", thinking: "" }], [{ type: "text", text: "answer" }]]) {
		const message = { role: "assistant", content, stopReason: "stop" };
		const { native, folded, restore } = mount(message);
		try { assert.deepEqual(folded.render(80), native.render(80)); }
		finally { restore(); }
	}
});
