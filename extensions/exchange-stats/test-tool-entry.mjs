import assert from "node:assert/strict";
import test from "node:test";
import { registerExchangeStats } from "./exchange-stats.ts";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

function mount(componentClass) {
	const handlers = new Map();
	const entries = [];
	const warnings = [];
	registerExchangeStats({
		on(name, handler) { handlers.set(name, handler); },
		registerEntryRenderer() {},
		appendEntry(type, data) { entries.push({ type, data }); },
		registerCommand() {},
	}, componentClass);
	const ctx = { hasUI: true, model: { id: "test" }, ui: { setStatus() {}, notify(message) { warnings.push(message); } } };
	return { handlers, entries, warnings, ctx };
}

test("missing render warns once while the exchange card still settles", () => {
	class MissingRender {}
	const mounted = mount(MissingRender);
	mounted.handlers.get("session_start")({}, mounted.ctx);
	mounted.handlers.get("session_start")({}, mounted.ctx);
	assert.equal(mounted.warnings.length, 1);
	mounted.handlers.get("before_agent_start")({}, mounted.ctx);
	mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.ctx);
	mounted.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, mounted.ctx);
	mounted.handlers.get("agent_settled")({}, mounted.ctx);
	assert.equal(mounted.entries.length, 1);
	assert.equal(mounted.entries[0].type, "exchange-stats");
	mounted.handlers.get("session_shutdown")();
});

test("session shutdown restores the component render prototype identity", () => {
	class StubTool { render() { return ["native"]; } }
	const original = StubTool.prototype.render;
	const mounted = mount(StubTool);
	assert.notEqual(StubTool.prototype.render, original);
	mounted.handlers.get("session_shutdown")();
	assert.equal(StubTool.prototype.render, original);
});


test("Pi tool events drive a real component title", () => {
	initTheme("dark");
	const mounted = mount(ToolExecutionComponent);
	const tool = new ToolExecutionComponent("bash", "call-entry", { command: "pwd" }, {}, undefined, { requestRender() {} }, ".");
	try {
		mounted.handlers.get("session_start")({}, mounted.ctx);
		mounted.handlers.get("before_agent_start")({}, mounted.ctx);
		mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.ctx);
		mounted.handlers.get("tool_execution_start")({ toolCallId: "call-entry", toolName: "bash", args: { command: "pwd" } }, mounted.ctx);
		const result = { content: [{ type: "text", text: "one\ntwo" }], isError: false };
		tool.updateResult(result);
		mounted.handlers.get("tool_execution_end")({ toolCallId: "call-entry", toolName: "bash", result, isError: false }, mounted.ctx);
		const lines = tool.render(80);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /bash.*pwd.*✓.*2 lines/);
	} finally { mounted.handlers.get("session_shutdown")(); }
});
