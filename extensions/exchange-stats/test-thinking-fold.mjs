import assert from "node:assert/strict";
import test from "node:test";
import { ToolFoldModel } from "./src/tool-fold.ts";

test("the first visible event freezes thinking time when thinking_end arrives late", () => {
	let now = 0;
	const model = new ToolFoldModel(() => now);
	const message = { content: [{ type: "thinking", thinking: "First thought" }, { type: "text", text: "Answer" }] };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: "First thought" });
	now = 3000;
	model.observeThinking(message, { type: "text_start", contentIndex: 1 });
	now = 9000;
	model.observeThinking(message, { type: "thinking_end", contentIndex: 0 });
	assert.match(model.thinkingTitle(message, 0, "First thought", false), /Thinking.*3\.0s.*2 words/);
});

test("live thinking uses an explicitly marked estimate when usage is absent", () => {
	let now = 0;
	const model = new ToolFoldModel(() => now);
	const message = { content: [{ type: "thinking", thinking: "" }] };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: "one two three four" });
	const first = model.thinkingTitle(message, 0, "one two three four", true);
	now = 1000;
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: " five six seven eight" });
	const second = model.thinkingTitle(message, 0, "one two three four five six seven eight", true);
	assert.match(first, /0ms.*~\d+ tok/);
	assert.match(second, /1\.0s.*~\d+ tok.*tok\/s/);
	assert.notEqual(first, second);
});

test("reported reasoning usage is shown as measured tokens", () => {
	const model = new ToolFoldModel(() => 1000);
	const message = { content: [{ type: "thinking", thinking: "thought" }] };
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: "thought" }, 17);
	assert.match(model.thinkingTitle(message, 0, "thought", true), /17 tok · 0 tok\/s/);
	assert.doesNotMatch(model.thinkingTitle(message, 0, "thought", true), /~/);
});

test("thinking title shows the last complete sentence while a later line streams", () => {
	const model = new ToolFoldModel(() => 1000);
	const message = { timestamp: 55 };
	const trace = "Need to retrieve the CURSOR_BRIDGE_MODE value without exposing secrets.\n\nGrepping for the spec";
	model.observeThinking(message, { type: "thinking_delta", contentIndex: 0, delta: trace });
	assert.match(model.thinkingTitle({ timestamp: 55 }, 0, trace, true), /^◈ Need to retrieve the CURSOR_BRIDGE_MODE value without exposing secrets\. · /);
});

test("thinking keeps its placeholder until a sentence completes", () => {
	const model = new ToolFoldModel(() => 1000);
	assert.match(model.thinkingTitle({ timestamp: 56 }, 0, "**Grepping** for the `spec`", true), /^◈ Thinking · /);
});

test("thinking headline strips markdown markers", () => {
	const model = new ToolFoldModel(() => 1000);
	assert.match(model.thinkingTitle({ timestamp: 57 }, 0, "- **Reading** the `spec`.\npartial", true), /^◈ Reading the spec\. · /);
	assert.match(model.thinkingTitle({ timestamp: 58 }, 0, "Read the spec\npartial", true), /^◈ Read the spec · /);
});

test("headline sentence boundaries keep filenames and versions intact", () => {
	const model = new ToolFoldModel(() => 0);
	const title = (trace, streaming) => model.thinkingTitle({ timestamp: 59 }, 0, trace, streaming);
	assert.match(title("I should check exchange-stats.ts first.", false), /^◈ I should check exchange-stats\.ts first\. · /);
	assert.match(title("Version 0.87.1 is installed.", false), /^◈ Version 0\.87\.1 is installed\. · /);
	assert.match(title("Read data.txt then run run.sh with bash", true), /^◈ Thinking · /);
	assert.match(title("See e.g. the README.", false), /^◈ (?:See e\.g\. the README\.|the README\.) · /);
	assert.match(title("Checking exchange-stats.ts.", true), /^◈ Thinking · /);
	assert.match(title("Checking exchange-stats.ts. ", true), /^◈ Checking exchange-stats\.ts\. · /);
	assert.match(title("继续检查？下一步", true), /^◈ 继续检查？ · /);
	assert.match(title("继续检查！下一步", true), /^◈ 继续检查！ · /);
});

test("a failed final headline after a live model headline reverts title and record to the trace sentence", () => {
	const model = new ToolFoldModel(() => 1000);
	const trace = "Checking the fallback. More";
	const snapshot = () => ({ role: "assistant", timestamp: 77, content: [{ type: "thinking", thinking: trace }] });
	model.beginExchange(1);
	model.ingest(snapshot());
	model.observeThinking(snapshot(), { type: "thinking_delta", contentIndex: 0, delta: trace });
	model.setThinkingHeadline({ timestamp: 77 }, 0, "≈ Live model headline");
	assert.match(model.thinkingTitle({ timestamp: 77 }, 0, trace, true), /≈ Live model headline/);
	model.settleThinking(snapshot());
	model.setThinkingHeadline({ timestamp: 77 }, 0, undefined);
	assert.match(model.thinkingTitle({ timestamp: 77 }, 0, trace, false), /◈ Checking the fallback\. ·/);
	assert.doesNotMatch(model.thinkingTitle({ timestamp: 77 }, 0, trace, false), /≈/);
	const [record] = model.recordsForExchange(1);
	assert.equal(record.headline, "Checking the fallback.");
	assert.equal(record.headlineSource, "trace");
});
