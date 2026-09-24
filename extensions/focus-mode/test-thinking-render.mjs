import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold } from "./src/tool-render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FoldPicker } from "./src/fold-picker.ts";

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

test("fresh Pi message objects keep one thinking clock through late thinking_end and history render", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	const patch = installThinkingFold(AssistantMessageComponent, model);
	const component = new AssistantMessageComponent();
	const snapshot = (thinking, text = "") => ({
		role: "assistant", timestamp: 42, stopReason: "stop",
		content: [{ type: "thinking", thinking }, ...(text ? [{ type: "text", text }] : [])],
	});
	try {
		const first = snapshot("first thought");
		model.observeThinking(first, { type: "thinking_delta", contentIndex: 0, delta: "first thought" });
		component.updateContent(snapshot("first thought"), true);
		now = 2200;
		const second = snapshot("first thought second thought");
		model.observeThinking(second, { type: "thinking_delta", contentIndex: 0, delta: " second thought" });
		component.updateContent(snapshot("first thought second thought"), true);
		assert.match(component.render(80).join("\n"), /Thinking.*1\.2s.*~\d+ tok/);
		now = 3300;
		model.observeThinking(snapshot("first thought second thought", "answer"), { type: "text_start", contentIndex: 1 });
		component.updateContent(snapshot("first thought second thought", "answer"), true);
		now = 3800;
		model.observeThinking(snapshot("first thought second thought", "answer"), { type: "thinking_end", contentIndex: 0 });
		model.settleThinking(snapshot("first thought second thought", "answer"));
		component.updateContent(snapshot("first thought second thought", "answer"), false);
		assert.match(component.render(80).join("\n"), /Thinking.*2\.3s.*4 words/);
		const history = new AssistantMessageComponent();
		history.updateContent(snapshot("first thought second thought", "answer"), false);
		assert.match(history.render(80).join("\n"), /Thinking.*2\.3s.*4 words/);
	} finally { patch.restore(); }
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

test("thinking title uses active dim ANSI while text and opened trace keep native styling", () => {
	const message = { role: "assistant", timestamp: 91, content: [
		{ type: "thinking", thinking: "native trace" }, { type: "text", text: "answer" },
	], stopReason: "stop" };
	const model = new ToolFoldModel();
	const native = new AssistantMessageComponent();
	native.updateContent(message, false);
	let ansi = "\x1b[38;2;80;80;80m";
	const patch = installThinkingFold(AssistantMessageComponent, model, () => ({
		fg(name, value) { assert.equal(name, "dim"); return `${ansi}${value}\x1b[0m`; },
	}));
	const folded = new AssistantMessageComponent();
	try {
		folded.updateContent(message, false);
		assert.match(folded.render(80).join("\n"), /\x1b\[38;2;80;80;80m.*Thinking.*\x1b\[0m/);
		ansi = "\x1b[38;2;120;120;120m";
		assert.match(folded.render(80).join("\n"), /\x1b\[38;2;120;120;120m.*Thinking.*\x1b\[0m/);
		const nativeText = native.contentContainer.children.find((child) => child.constructor.name === "Markdown");
		const foldedText = folded.contentContainer.children.find((child) => child.constructor.name === "Markdown");
		assert.deepEqual(foldedText.render(80), nativeText.render(80));
		const region = folded.contentContainer.children.find((child) => child.constructor.name === "MouseRegion");
		region.onMouse({ type: "click", button: "left" });
		const opened = folded.contentContainer.children.find((child) => child.constructor.name === "MouseRegion").render(80);
		assert.match(opened[0], /Thinking/, "the title stays when the block opens");
		assert.deepEqual(opened.slice(1), native.contentContainer.children.find((child) => child.constructor.name === "MouseRegion").render(80));
	} finally { patch.restore(); }
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

test("a long headline clips at 40 columns while duration and stats remain", () => {
	let now = 0;
	const model = new ToolFoldModel(() => now);
	const trace = "Checking the extraordinarily lengthy configuration statement before using the result.";
	const message = { role: "assistant", timestamp: 400, content: [{ type: "thinking", thinking: trace }], stopReason: "stop" };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: trace });
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	const { folded, restore } = mount(message, model);
	try {
		now = 1200;
		model.settleThinking({ timestamp: 400 });
		folded.updateContent({ ...message, content: [{ ...message.content[0] }] }, false);
		const lines = folded.render(40);
		assert.match(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /◈ Checking.*… · 1\.2s · \d+ words/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	} finally { restore(); }
});

test("CJK headline selects the last full sentence and fits the title width", () => {
	const model = new ToolFoldModel(() => 0);
	const trace = "正在检查配置文件。下一步还在输入";
	const message = { role: "assistant", timestamp: 401, content: [{ type: "thinking", thinking: trace }], stopReason: "stop" };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: trace });
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	const { folded, restore } = mount(message, model);
	try {
		model.settleThinking({ timestamp: 401 });
		folded.updateContent({ ...message, content: [{ ...message.content[0] }] }, false);
		const lines = folded.render(40);
		assert.match(lines.join("\n"), /◈ 正在检查配置文件。 · /);
		assert.doesNotMatch(lines.join("\n"), /下一步还在输入/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	} finally { restore(); }
});

test("live process and picker rows use the same completed headline", () => {
	const model = new ToolFoldModel(() => 1000);
	const trace = "Checked the configuration.\nStill reading";
	const message = { role: "assistant", timestamp: 402, content: [{ type: "thinking", thinking: trace }], stopReason: "stop" };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: trace });
	model.ingest(message);
	assert.match(model.processLine(model.processes()[0].id), /◈ Checked the configuration\. · /);
	const theme = { fg(_color, text) { return text; }, bg(_color, text) { return text; } };
	const picker = new FoldPicker(model, () => theme, () => {}, () => {});
	const rows = picker.render(80);
	assert.ok(rows.some((line) => line.includes("Checked the configuration.")));
	assert.ok(picker.render(40).every((line) => visibleWidth(line) === 40));
});

test("model headline appears in fresh Pi render snapshots and retains active dim color", () => {
	const model = new ToolFoldModel(() => 1000);
	const snapshot = () => ({ role: "assistant", timestamp: 500, content: [{ type: "thinking", thinking: "Checking the setting. More unfinished text" }], stopReason: "stop" });
	model.observeThinking(snapshot(), { type: "thinking_delta", contentIndex: 0, delta: snapshot().content[0].thinking });
	model.ingest(snapshot());
	model.toggleProcess(model.processes()[0].id);
	const patch = installThinkingFold(AssistantMessageComponent, model, () => ({ fg(_name, text) { return `\x1b[2m${text}\x1b[0m`; } }));
	const component = new AssistantMessageComponent();
	try {
		component.updateContent(snapshot(), true);
		model.setThinkingHeadline(snapshot(), 0, "≈ Checking settings");
		component.updateContent(snapshot(), true);
		assert.match(component.render(80).join("\n"), /\x1b\[2m◈ ≈ Checking settings · /);
		model.setThinkingHeadline(snapshot(), 0, undefined);
		component.updateContent(snapshot(), true);
		assert.match(component.render(80).join("\n"), /◈ Checking the setting\./);
	} finally { patch.restore(); }
});
