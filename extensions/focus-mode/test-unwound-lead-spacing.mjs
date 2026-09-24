import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold } from "./src/tool-render.ts";

initTheme("dark");

const width = 80;
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content, stopReason: "stop" });
const plain = (line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\\\)/g, "");

function assistant(message) {
	const component = new AssistantMessageComponent();
	component.updateContent(snapshot(message.timestamp, message.content.map((item) => ({ ...item }))), false);
	return component;
}

function assertUnwoundLeadKeepsSeparator({ timestamp, content, settleProgress = false, toggle, lead }) {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const message = snapshot(timestamp, content);
	model.ingest(message);
	if (settleProgress) {
		model.ingest(snapshot(timestamp + 1, [{ type: "text", text: "Final answer." }]));
		model.endExchange();
	}
	const patch = installThinkingFold(AssistantMessageComponent, model);
	try {
		const components = [assistant(snapshot(timestamp - 1, [{ type: "text", text: "Previous message." }])), assistant(message)];
		const rows = () => components.flatMap((component) => component.render(width)).map(plain);
		const findLead = (rendered) => rendered.findIndex(lead);
		const folded = rows();
		const foldedLead = findLead(folded);
		assert.notEqual(foldedLead, -1, `folded lead is missing\n${folded.join("\n")}`);
		assert.equal(folded[foldedLead - 1], "", `Pi's separator is above the folded lead\n${folded.join("\n")}`);
		toggle(model);
		const unwound = rows();
		const unwoundLead = findLead(unwound);
		assert.notEqual(unwoundLead, -1, `unwound lead is missing\n${unwound.join("\n")}`);
		assert.equal(unwoundLead, foldedLead, `unwinding preserves the row count above the lead\n${unwound.join("\n")}`);
		assert.equal(unwound[unwoundLead - 1], "", `Pi's separator stays above the unwound lead\n${unwound.join("\n")}`);
	} finally {
		patch.restore();
	}
}

test("unwound thinking-led progress keeps Pi's separator above its lead", () => {
	assertUnwoundLeadKeepsSeparator({
		timestamp: 301,
		content: [{ type: "thinking", thinking: "Checking the first item." }, { type: "toolCall", id: "thinking-lead", name: "read", arguments: { path: "data.txt" } }],
		settleProgress: true,
		toggle: (model) => model.toggleProgress(1),
		lead: (line) => line.includes("Worked for"),
	});
});

test("unwound text-led progress keeps Pi's separator above its lead", () => {
	assertUnwoundLeadKeepsSeparator({
		timestamp: 401,
		content: [{ type: "text", text: "I will inspect the file." }, { type: "toolCall", id: "text-lead", name: "read", arguments: { path: "data.txt" } }],
		settleProgress: true,
		toggle: (model) => model.toggleProgress(1),
		lead: (line) => line.includes("Worked for"),
	});
});

test("an open process without progress keeps Pi's separator above its lead", () => {
	assertUnwoundLeadKeepsSeparator({
		timestamp: 501,
		content: [{ type: "thinking", thinking: "Checking the first item." }],
		toggle: (model) => model.toggleProcess(model.processes()[0].id),
		lead: (line) => /[▸▾] ◈ 1 ⚙ 0/.test(line),
	});
});
