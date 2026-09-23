import assert from "node:assert/strict";
import test from "node:test";
import { ToolFoldModel } from "./src/tool-fold.ts";

const exchange = [
	{ role: "assistant", timestamp: 101, content: [
		{ type: "thinking", thinking: "first thought" }, { type: "text", text: "First answer" },
		{ type: "toolCall", id: "call-a", name: "bash", arguments: { command: "pwd" } },
		{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "one" } },
	] },
	{ role: "assistant", timestamp: 102, content: [
		{ type: "thinking", thinking: "second thought" },
		{ type: "toolCall", id: "call-c", name: "bash", arguments: { command: "ls" } },
	] },
	{ role: "assistant", timestamp: 103, content: [{ type: "text", text: "Final answer" }] },
];

test("visible text separates two processes while blocks across assistant messages stay together", () => {
	const model = new ToolFoldModel(() => 1000);
	for (const message of exchange) model.ingest(message);
	const processes = model.processes();
	assert.deepEqual(processes.map((process) => process.blocks.map((block) => block.key)), [
		["thinking:101:0"],
		["tool:call-a", "tool:call-b", "thinking:102:0", "tool:call-c"],
	]);
	assert.equal(model.processForTool("call-c")?.id, processes[1].id);
	assert.equal(model.processForThinking({ timestamp: 102 }, 0)?.id, processes[1].id);
	model.ingest({ ...exchange[1], content: [...exchange[1].content] });
	assert.equal(model.processes().length, 2);
});

test("a live process switches to a running tool and retains wall time after closing", () => {
	let now = 1000;
	const model = new ToolFoldModel(() => now);
	const thinking = { role: "assistant", timestamp: 201, content: [{ type: "thinking", thinking: "checking" }] };
	model.ingest(thinking);
	model.observeThinking(thinking, { type: "thinking_delta", contentIndex: 0, delta: "checking" });
	const process = model.processes()[0];
	assert.match(model.processLine(process.id), /◈1 ⚙0.*◈ Thinking/);
	now = 2200;
	const withTool = { role: "assistant", timestamp: 201, content: [
		{ type: "thinking", thinking: "checking" },
		{ type: "toolCall", id: "call-live", name: "bash", arguments: { command: "pwd" } },
	] };
	model.observeThinking(withTool, { type: "thinking_end", contentIndex: 0 });
	model.ingest(withTool);
	model.start("call-live", "bash");
	now = 3200;
	assert.match(model.processLine(process.id), /◈1 ⚙1.*⚙ bash running 1\.0s/);
	model.end("call-live", false, undefined, now);
	model.ingest({ role: "assistant", timestamp: 202, content: [{ type: "text", text: "done" }] });
	now = 9000;
	assert.match(model.processLine(process.id), /◈1 ⚙1.*2\.2s/);
	assert.equal(model.toggleProcess(process.id), true);
	assert.equal(model.isProcessOpen(process.id), true);
});
