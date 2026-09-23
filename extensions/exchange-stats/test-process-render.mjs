import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

initTheme("dark");
const ui = { requestRender() {} };
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content, stopReason: "stop" });
const messages = [
	snapshot(101, [
		{ type: "thinking", thinking: "first trace" }, { type: "text", text: "First answer" },
		{ type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
		{ type: "toolCall", id: "b", name: "read", arguments: { path: "one" } },
	]),
	snapshot(102, [
		{ type: "thinking", thinking: "second trace" },
		{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
	]),
	snapshot(103, [{ type: "text", text: "Final answer" }]),
];

test("real Pi components show one line per process, preserve text, and reopen L2 after rebuild", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	let ansi = "\x1b[38;2;80;80;80m";
	const theme = () => ({ fg(color, text) { assert.equal(color, "dim"); return `${ansi}${text}\x1b[0m`; } });
	const nativeUpdate = AssistantMessageComponent.prototype.updateContent;
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model, theme);
	const toolPatch = installToolFold(ToolExecutionComponent, model, theme);
	const assistant = (message) => { const component = new AssistantMessageComponent(); component.updateContent(snapshot(message.timestamp, message.content.map((item) => ({ ...item }))), false); return component; };
	const tool = (id, name, args) => new ToolExecutionComponent(name, id, args, {}, undefined, ui, ".");
	try {
		for (const message of messages) model.ingest(snapshot(message.timestamp, message.content.map((item) => ({ ...item }))));
		const components = [assistant(messages[0]), tool("a", "bash", { command: "pwd" }), tool("b", "read", { path: "one" }), assistant(messages[1]), tool("c", "bash", { command: "ls" }), assistant(messages[2])];
		const lines = () => components.flatMap((component) => component.render(100)).filter((line) => line.trim());
		const l1 = lines().join("\n");
		assert.equal((l1.match(/▸ ◈/g) ?? []).length, 2);
		assert.doesNotMatch(l1, /⚙ read.*running/);
		assert.match(l1, /First answer/);
		assert.match(l1, /Final answer/);
		assert.match(l1, /\x1b\[38;2;80;80;80m.*▸ ◈/);
		for (const [message, component] of [[messages[0], components[0]], [messages[2], components[5]]]) {
			const native = new AssistantMessageComponent();
			nativeUpdate.call(native, message, false);
			const markdown = (item) => item.contentContainer.children.filter((child) => child.constructor.name === "Markdown").map((child) => child.render(100));
			assert.deepEqual(markdown(component), markdown(native));
		}
		assert.match(components[0].render(10).join("\n"), /\x1b\[38;2;80;80;80m[^\x1b]*…\x1b\[0m/);
		assert.match(components[1].render(10).join("\n"), /\x1b\[38;2;80;80;80m[^\x1b]*…\x1b\[0m/);
		const second = model.processes()[1];
		model.toggleProcess(second.id);
		const l2 = lines().join("\n");
		assert.equal((l2.match(/▾ ◈/g) ?? []).length, 1);
		assert.match(l2, /⚙ bash.*pwd/);
		assert.match(l2, /⚙ read.*one/);
		const detail = lines().map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
		const titles = detail.filter((line) => /^(⚙|◈ Thinking)/.test(line));
		assert.deepEqual(titles.map((line) => line.startsWith("◈") ? "thinking" : line.split(/\s+/)[1]), ["bash", "read", "thinking", "bash"]);
		ansi = "\x1b[38;2;120;120;120m";
		const replacement = assistant(messages[1]);
		assert.match(replacement.render(100).join("\n"), /\x1b\[38;2;120;120;120m.*Thinking/);
		assert.match(tool("c", "bash", { command: "ls" }).render(100).join("\n"), /⚙ bash.*ls/);
		assert.equal(model.processForThinking({ timestamp: 102 }, 0)?.id, second.id);
		assert.equal(model.isProcessOpen(second.id), true);
	} finally { thinkingPatch.restore(); toolPatch.restore(); }
});

test("tool and thinking titles use the same Pi content margin", () => {
	const model = new ToolFoldModel(() => 100);
	const message = snapshot(701, [
		{ type: "thinking", thinking: "Checking the file." },
		{ type: "toolCall", id: "margin-read", name: "read", arguments: { path: "SETUP.md" } },
	]);
	model.ingest(message);
	model.toggleProcess(model.processes()[0].id);
	let outputPad = 1;
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model, () => undefined, () => {}, (pad) => { outputPad = pad; });
	const toolPatch = installToolFold(ToolExecutionComponent, model, () => undefined, () => outputPad);
	try {
		const assistant = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 2);
		assistant.updateContent(snapshot(701, message.content.map((item) => ({ ...item }))), false);
		const tool = new ToolExecutionComponent("read", "margin-read", { path: "SETUP.md" }, {}, undefined, ui, ".");
		const thinkingLine = assistant.render(80).find((line) => line.includes("◈ Checking"));
		const toolLine = tool.render(80).find((line) => line.includes("⚙ read"));
		assert.ok(thinkingLine && toolLine);
		assert.equal(thinkingLine.indexOf("◈"), toolLine.indexOf("⚙"));
		assert.equal(toolLine.indexOf("⚙"), 2);
		model.ingest(snapshot(702, [{ type: "text", text: "Next" }, { type: "toolCall", id: "lead-tool", name: "bash", arguments: { command: "pwd" } }]));
		const lead = new ToolExecutionComponent("bash", "lead-tool", { command: "pwd" }, {}, undefined, ui, ".");
		assert.equal(lead.render(80)[0].indexOf("▸"), 2);
	} finally { thinkingPatch.restore(); toolPatch.restore(); }
});

test("fresh streaming snapshots move the process line from thinking to the running tool", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	const assistant = new AssistantMessageComponent();
	try {
		const first = snapshot(301, [{ type: "thinking", thinking: "checking" }]);
		model.observeThinking(first, { type: "thinking_delta", contentIndex: 0, delta: "checking" });
		model.ingest(first);
		assistant.updateContent(snapshot(301, [{ type: "thinking", thinking: "checking" }]), true);
		assert.match(assistant.render(100).join("\n"), /▸ ◈1 ⚙0.*◈ Thinking/);
		now = 1500;
		const second = snapshot(301, [
			{ type: "thinking", thinking: "checking" },
			{ type: "toolCall", id: "live", name: "bash", arguments: { command: "pwd" } },
		]);
		model.observeThinking(second, { type: "toolcall_start", contentIndex: 1 });
		model.ingest(second);
		model.start("live", "bash");
		assistant.updateContent(snapshot(301, second.content.map((item) => ({ ...item }))), true);
		const tool = new ToolExecutionComponent("bash", "live", { command: "pwd" }, {}, undefined, ui, ".");
		now = 2500;
		assert.match(assistant.render(100).join("\n"), /▸ ◈1 ⚙1.*⚙ bash running 1\.0s/);
		assert.deepEqual(tool.render(100), []);
		model.end("live", false, undefined, now);
		model.ingest(snapshot(302, [{ type: "text", text: "Answer" }]));
		now = 9000;
		assert.match(assistant.render(100).join("\n"), /▸ ◈1 ⚙1.*1\.5s/);
	} finally { thinkingPatch.restore(); toolPatch.restore(); }
});
