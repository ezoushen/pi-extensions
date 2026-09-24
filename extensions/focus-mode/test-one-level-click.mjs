import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

const message = (timestamp, content) => ({ role: "assistant", timestamp, content });
const plain = (value) => value.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const click = (y, alt = true) => ({ type: "click", button: "left", x: 4, y, width: 80, height: 40, screenX: 4, screenY: y, shift: false, alt, ctrl: false });

initTheme("dark");

function createExchange(first = "thinking") {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const content = [];
	if (first === "text") content.push({ type: "text", text: "Starting note." });
	if (first === "thinking") content.push({ type: "thinking", thinking: "Checking the first item." });
	content.push({ type: "toolCall", id: "first", name: "read", arguments: { path: "first" } });
	content.push(
		{ type: "text", text: "A checkpoint." },
		{ type: "toolCall", id: "second", name: "read", arguments: { path: "second" } },
		{ type: "toolCall", id: "third", name: "read", arguments: { path: "third" } },
	);
	const activity = message(101, content);
	const answer = message(102, [{ type: "text", text: "The final answer." }]);
	model.ingest(activity);
	model.ingest(answer);
	for (const id of ["first", "second", "third"]) {
		const result = { content: [{ type: "text", text: `NATIVE_${id.toUpperCase()}_OUTPUT` }], isError: false };
		model.start(id, "read", 1000);
		model.end(id, false, result, 1100);
	}
	model.endExchange();
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, model);
	const toolPatch = installToolFold(ToolExecutionComponent, model);
	const assistant = new AssistantMessageComponent();
	assistant.updateContent(message(activity.timestamp, activity.content.map((item) => ({ ...item }))), false);
	const tools = new Map(["first", "second", "third"].map((id) => {
		const component = new ToolExecutionComponent("read", id, { path: id }, {}, undefined, { requestRender() {} }, ".");
		component.updateResult({ content: [{ type: "text", text: `NATIVE_${id.toUpperCase()}_OUTPUT` }], isError: false }, false);
		return [id, component];
	}));
	return {
		model,
		activity,
		assistant,
		tools,
		progressRow: () => plain(assistant.render(80).join("\n")).split("\n").findIndex((line) => line.includes("Worked for")),
		processRow: (id) => plain(tools.get(id).render(80).join("\n")).split("\n").findIndex((line) => line.includes("◈ 0 ⚙ 2")),
		close() { thinkingPatch.restore(); toolPatch.restore(); },
	};
}

test("one-level toggles open direct children and leaves grandchildren unchanged", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	model.ingest(message(101, [
		{ type: "thinking", thinking: "Check the first item." },
		{ type: "toolCall", id: "first", name: "read", arguments: { path: "first" } },
		{ type: "text", text: "A checkpoint." },
		{ type: "toolCall", id: "second", name: "read", arguments: { path: "second" } },
		{ type: "toolCall", id: "third", name: "read", arguments: { path: "third" } },
	]));
	model.ingest(message(102, [{ type: "text", text: "The answer." }]));
	model.endExchange();
	const [firstProcess, secondProcess] = model.processes();

	assert.equal(model.isOpen("second"), false);
	assert.equal(model.toggleOneLevel({ kind: "progress", exchange: 1 }), true);
	assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [true, true]);
	assert.equal(model.isOpen("second"), false);
	assert.equal(model.isThinkingOpen({ timestamp: 101 }, 0), false);
	assert.equal(model.toggleOneLevel({ kind: "progress", exchange: 1 }), false);
	assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [false, false]);

	model.toggle("second");
	assert.equal(model.toggleOneLevel({ kind: "progress", exchange: 1 }), true);
	assert.equal(model.isOpen("second"), true);
	assert.equal(model.isOpen("third"), false);
	assert.equal(model.toggleOneLevel({ kind: "progress", exchange: 1 }), false);
	assert.equal(model.isOpen("second"), true);

	assert.equal(model.toggleOneLevel({ kind: "process", id: secondProcess.id }), true);
	assert.equal(model.isOpen("second"), true);
	assert.equal(model.isOpen("third"), true);
	assert.equal(model.toggleOneLevel({ kind: "process", id: secondProcess.id }), false);
	assert.equal(model.isOpen("second"), false);
	assert.equal(model.isOpen("third"), false);
	assert.equal(model.isProcessOpen(firstProcess.id), false);
});

test("option-click on a settled progress row opens its processes without opening blocks", () => {
	const view = createExchange();
	try {
		const { model, assistant, tools } = view;
		assert.ok(view.progressRow() >= 0);
		assert.equal(assistant.handleMouse(click(view.progressRow()))?.handled, true);
		assert.match(plain(assistant.render(80).join("\n")), /▾ Worked for/);
		assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [true, true]);
		assert.ok(model.processes().every((process) => process.blocks.every((block) => block.kind === "thinking"
			? !model.isThinkingOpen({ timestamp: 101 }, block.index)
			: !model.isOpen(block.key.slice(5)))));
		assert.doesNotMatch([...tools.values()].map((tool) => plain(tool.render(80).join("\n"))).join("\n"), /NATIVE_.*_OUTPUT/);

		assert.equal(assistant.handleMouse(click(view.progressRow()))?.handled, true);
		assert.match(plain(assistant.render(80).join("\n")), /▸ Worked for/);
		assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [false, false]);
	} finally { view.close(); }
});

test("option-click on a process opens and closes its thinking and tool blocks", () => {
	const view = createExchange();
	try {
		const { model, tools } = view;
		model.toggleProgress(1);
		const process = model.processes()[1];
		const lead = tools.get("second");
		assert.ok(view.processRow("second") >= 0);
		assert.equal(lead.handleMouse(click(view.processRow("second")))?.handled, true);
		assert.equal(model.isProcessOpen(process.id), true);
		for (const id of ["second", "third"]) assert.match(plain(tools.get(id).render(80).join("\n")), new RegExp(`NATIVE_${id.toUpperCase()}_OUTPUT`));
		assert.equal(model.isProcessOpen(model.processes()[0].id), false);

		assert.equal(lead.handleMouse(click(view.processRow("second")))?.handled, true);
		assert.equal(model.isProcessOpen(process.id), false);
		for (const id of ["second", "third"]) assert.doesNotMatch(plain(tools.get(id).render(80).join("\n")), /NATIVE_.*_OUTPUT/);
	} finally { view.close(); }
});

test("option-click on a thinking-led process opens and closes its direct blocks", () => {
	const view = createExchange();
	try {
		const { model, assistant, activity, tools } = view;
		model.toggleProgress(1);
		const process = model.processes()[0];
		const processRow = () => plain(assistant.render(80).join("\n")).split("\n").findIndex((line) => /[▸▾] ◈ 1 ⚙ 1/.test(line));
		assert.ok(processRow() >= 0);
		assert.equal(assistant.handleMouse(click(processRow()))?.handled, true);
		assert.equal(model.isProcessOpen(process.id), true);
		assert.equal(model.isThinkingOpen(activity, 0), true);
		assert.match(plain(tools.get("first").render(80).join("\n")), /NATIVE_FIRST_OUTPUT/);

		assert.equal(assistant.handleMouse(click(processRow()))?.handled, true);
		assert.equal(model.isProcessOpen(process.id), false);
		assert.equal(model.isThinkingOpen(activity, 0), false);
		assert.doesNotMatch(plain(tools.get("first").render(80).join("\n")), /NATIVE_FIRST_OUTPUT/);
	} finally { view.close(); }
});

test("option-click on a block title opens only that block like a plain click", () => {
	const view = createExchange();
	try {
		const { model, assistant, tools, activity } = view;
		model.toggleProgress(1);
		model.toggleProcess(model.processes()[0].id);
		model.toggleProcess(model.processes()[1].id);
		const tool = tools.get("second");
		const titleRow = () => plain(tool.render(80).join("\n")).split("\n").findIndex((line) => line.includes("⚙ read") && line.includes("second"));
		assert.ok(titleRow() >= 0);
		assert.equal(tool.handleMouse(click(titleRow()))?.handled, true);
		assert.match(plain(tool.render(80).join("\n")), /NATIVE_SECOND_OUTPUT/);
		assert.doesNotMatch(plain(tools.get("third").render(80).join("\n")), /NATIVE_THIRD_OUTPUT/);

		const thinkingTitle = () => plain(assistant.render(80).join("\n")).split("\n").findIndex((line) => line.includes("Checking the first item"));
		assert.ok(thinkingTitle() >= 0);
		assert.equal(assistant.handleMouse(click(thinkingTitle()))?.handled, true);
		assert.equal(model.isThinkingOpen(activity, 0), true);
	} finally { view.close(); }
});

test("option-click on a text-led progress row opens its direct processes", () => {
	const view = createExchange("text");
	try {
		const { model, assistant } = view;
		assert.ok(view.progressRow() >= 0);
		assert.equal(assistant.handleMouse(click(view.progressRow()))?.handled, true);
		assert.match(plain(assistant.render(80).join("\n")), /▾ Worked for/);
		assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [true, true]);
	} finally { view.close(); }
});

test("option-click on a tool-led progress row opens its direct processes", () => {
	const view = createExchange("tool");
	try {
		const { model, tools } = view;
		const first = tools.get("first");
		assert.ok(plain(first.render(80).join("\n")).includes("Worked for"));
		assert.equal(first.handleMouse(click(0))?.handled, true);
		assert.deepEqual(model.processes().map((process) => model.isProcessOpen(process.id)), [true, true]);
		assert.doesNotMatch([...tools.values()].map((tool) => plain(tool.render(80).join("\n"))).join("\n"), /NATIVE_.*_OUTPUT/);
	} finally { view.close(); }
});
