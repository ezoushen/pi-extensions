import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { registerExchangeStats } from "./exchange-stats.ts";

initTheme("dark");

function mount() {
	const handlers = new Map();
	registerExchangeStats({
		on: (name, handler) => handlers.set(name, handler),
		registerShortcut() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
	});
	const ctx = { hasUI: true, model: { id: "test" }, ui: { setStatus() {}, notify() {} } };
	return { start: () => handlers.get("session_start")({}, ctx), stop: () => handlers.get("session_shutdown")(),
		feedThinking(trace) {
			handlers.get("before_agent_start")({}, ctx);
			const message = { role: "assistant", timestamp: 200, content: [{ type: "text", text: "next" }, { type: "thinking", thinking: trace }] };
			handlers.get("message_update")({ message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: trace } }, ctx);
		},
		feed(id) {
			handlers.get("before_agent_start")({}, ctx);
			const message = { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id, name: "bash", arguments: { command: id } }] };
			handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta" } }, ctx);
		},
	};
}

const renderTool = (id) => new ToolExecutionComponent("bash", id, { command: id }, {}, undefined, { requestRender() {} }, ".").render(80).join("\n");
const renderThinking = (trace) => {
	const component = new AssistantMessageComponent();
	component.updateContent({ role: "assistant", timestamp: 200, content: [{ type: "text", text: "next" }, { type: "thinking", thinking: trace }] }, true);
	return component.render(80).join("\n");
};

test("factory-only loading leaves Pi component prototypes untouched", () => {
	const toolRender = ToolExecutionComponent.prototype.render;
	const toolMouse = ToolExecutionComponent.prototype.handleMouse;
	const thinkingUpdate = AssistantMessageComponent.prototype.updateContent;
	const instance = mount();
	assert.equal(ToolExecutionComponent.prototype.render, toolRender);
	assert.equal(ToolExecutionComponent.prototype.handleMouse, toolMouse);
	assert.equal(AssistantMessageComponent.prototype.updateContent, thinkingUpdate);
	instance.stop();
});

test("a session restart installs once, clears its prior folds, and restores on shutdown", () => {
	const toolRender = ToolExecutionComponent.prototype.render;
	const thinkingUpdate = AssistantMessageComponent.prototype.updateContent;
	const instance = mount();
	try {
		instance.start();
		const firstWrapper = ToolExecutionComponent.prototype.render;
		assert.notEqual(firstWrapper, toolRender);
		instance.start();
		assert.equal(ToolExecutionComponent.prototype.render, firstWrapper);
		instance.feed("old");
		assert.match(renderTool("old"), /▸.*⚙1/);
		instance.stop();
		assert.equal(ToolExecutionComponent.prototype.render, toolRender);
		assert.equal(AssistantMessageComponent.prototype.updateContent, thinkingUpdate);
		instance.start();
		instance.feed("new");
		assert.match(renderTool("new"), /▸.*⚙1/);
		assert.doesNotMatch(renderTool("old"), /▸/);
	} finally { instance.stop(); }
	assert.equal(ToolExecutionComponent.prototype.render, toolRender);
	assert.equal(AssistantMessageComponent.prototype.updateContent, thinkingUpdate);
});

test("overlapping instances share one wrapper and only the last owner restores it", () => {
	const toolRender = ToolExecutionComponent.prototype.render;
	const thinkingUpdate = AssistantMessageComponent.prototype.updateContent;
	const first = mount(), second = mount();
	try {
		first.start();
		first.feed("first");
		const wrapper = ToolExecutionComponent.prototype.render;
		second.start();
		second.feed("second");
		second.feedThinking("checking the second session");
		assert.equal(ToolExecutionComponent.prototype.render, wrapper);
		assert.match(renderTool("second"), /▸.*⚙1/);
		assert.equal(renderThinking("checking the second session").match(/Thinking/g)?.length, 1);
		first.stop();
		assert.equal(ToolExecutionComponent.prototype.render, wrapper);
		assert.match(renderTool("second"), /▸.*⚙1/);
		assert.equal(renderThinking("checking the second session").match(/Thinking/g)?.length, 1);
		second.stop();
		assert.equal(ToolExecutionComponent.prototype.render, toolRender);
		assert.equal(AssistantMessageComponent.prototype.updateContent, thinkingUpdate);
	} finally { first.stop(); second.stop(); }
});

test("a later wrapper stays installed and delegates to native output after shutdown", () => {
	const native = ToolExecutionComponent.prototype.render;
	const instance = mount();
	instance.start();
	const foldWrapper = ToolExecutionComponent.prototype.render;
	function otherWrapper(width) { return foldWrapper.call(this, width); }
	ToolExecutionComponent.prototype.render = otherWrapper;
	instance.feed("wrapped");
	assert.match(renderTool("wrapped"), /▸.*⚙1/);
	instance.stop();
	assert.equal(ToolExecutionComponent.prototype.render, otherWrapper);
	assert.doesNotMatch(renderTool("wrapped"), /▸/);
	const next = mount();
	try {
		next.start();
		next.feed("again");
		assert.equal(ToolExecutionComponent.prototype.render, otherWrapper);
		assert.equal(renderTool("again").match(/⚙ bash/g)?.length ?? 0, 0);
		assert.match(renderTool("again"), /▸.*⚙1/);
	} finally { next.stop(); ToolExecutionComponent.prototype.render = native; }
});
