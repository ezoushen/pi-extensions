import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { registerExchangeStats } from "./exchange-stats.ts";

initTheme("dark");
const assistant = (timestamp, content) => ({ role: "assistant", timestamp, content: content.map((item) => ({ ...item })), stopReason: "stop" });
const tool = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: `secret-${id}` } });

function mount(entries, dir, modelRegistry) {
	const handlers = new Map(), shortcuts = new Map();
	let renderer, picker;
	registerExchangeStats({
		on: (name, handler) => handlers.set(name, handler),
		registerShortcut: (key, value) => shortcuts.set(key, value.handler),
		registerCommand() {}, registerEntryRenderer: (_type, value) => { renderer = value; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	}, ToolExecutionComponent, { agentDir: dir, environment: {} });
	const ctx = { hasUI: true, cwd: dir, model: { id: "test" }, isProjectTrusted: () => false, modelRegistry,
		sessionManager: { getBranch: () => entries },
		ui: { setStatus() {}, notify() {}, custom(factory) { picker = factory({ requestRender() {} }, { fg: (_name, value) => value, bg: (_name, value) => value }, undefined, () => {}); return Promise.resolve(); } },
	};
	handlers.get("session_start")({}, ctx);
	return { handlers, shortcuts, ctx, renderer: () => renderer, picker: () => picker, close: () => handlers.get("session_shutdown")() };
}

test("a second extension instance restores a model headline and saved time without another summary call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fold-restore-"));
	const entries = [];
	let calls = 0;
	const registry = { find: () => ({}), streamSimple: () => { calls++; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Checking saved state" }] }) }; } };
	try {
		writeFileSync(join(dir, "exchange-stats.json"), JSON.stringify({ summaryModel: "stub/headline" }));
		const first = mount(entries, dir, registry);
		const trace = "Checking details. " + "x ".repeat(900);
		const message = assistant(101, [{ type: "thinking", thinking: trace }, tool("one")]);
		first.handlers.get("before_agent_start")({}, first.ctx);
		first.handlers.get("message_update")({ message: assistant(101, message.content), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: trace } }, first.ctx);
		for (let i = 0; i < 100 && calls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(calls, 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		first.handlers.get("message_end")({ message: assistant(101, message.content) }, first.ctx);
		entries.push({ type: "message", message });
		first.handlers.get("tool_execution_start")({ toolCallId: "one", toolName: "bash" }, first.ctx);
		first.handlers.get("tool_execution_end")({ toolCallId: "one", toolName: "bash", result: { content: [{ type: "text", text: "private output" }] }, isError: false }, first.ctx);
		first.handlers.get("agent_settled")({}, first.ctx);
		const record = entries.at(-1).data;
		assert.deepEqual(record.blocks.map((block) => block.kind), ["thinking", "tool"]);
		assert.equal(record.blocks[0].headlineSource, "model");
		assert.deepEqual(Object.keys(record.blocks[0]).sort(), ["durationMs", "endedAt", "headline", "headlineSource", "id", "kind", "startedAt", "status", "wordCount"].sort());
		assert.deepEqual(Object.keys(record.blocks[1]).sort(), ["durationMs", "endedAt", "id", "kind", "lineCount", "startedAt", "status"].sort());
		assert.doesNotMatch(JSON.stringify(record.blocks), /private output|secret-one|Checking details|x x x/);
		first.close();
		const second = mount(entries, dir, registry);
		second.shortcuts.get("ctrl+alt+f")(second.ctx);
		const component = new AssistantMessageComponent();
		component.updateContent(assistant(101, message.content), false);
		const lines = component.render(100).join("\n");
		assert.match(lines, /≈ Checking saved state · .* · 902 words/);
		assert.doesNotMatch(lines, /· 0ms ·/);
		const toolComponent = new ToolExecutionComponent("bash", "one", { command: "secret-one" }, { content: [{ type: "text", text: "private output" }] }, undefined, { requestRender() {} }, ".");
		assert.match(toolComponent.render(100).join("\n"), /⚙ bash.*secret-one.*✓.*1 line/);
		assert.equal(calls, 1);
		second.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a model headline that resolves after the exchange settles is shown live and restored", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fold-late-"));
	const entries = [];
	const pending = [];
	const registry = { find: () => ({}), streamSimple: () => ({ result: () => new Promise((resolve) => pending.push(resolve)) }) };
	const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
	try {
		writeFileSync(join(dir, "exchange-stats.json"), JSON.stringify({ summaryModel: "stub/headline" }));
		const first = mount(entries, dir, registry);
		const trace = "Inspecting deferred work. " + "x ".repeat(900);
		const content = [{ type: "thinking", thinking: trace }, { type: "text", text: "Done" }];
		first.handlers.get("before_agent_start")({}, first.ctx);
		first.handlers.get("message_update")({ message: assistant(401, content), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: trace } }, first.ctx);
		await flush();
		first.handlers.get("message_end")({ message: assistant(401, content) }, first.ctx);
		entries.push({ type: "message", message: assistant(401, content) });
		first.handlers.get("agent_settled")({}, first.ctx);
		const record = entries.find((entry) => entry.customType === "exchange-stats").data;
		assert.equal(record.blocks[0].headlineSource, "trace");
		while (pending.length) {
			pending.shift()({ stopReason: "stop", content: [{ type: "text", text: "Deferred model headline" }] });
			await flush();
		}
		const live = new AssistantMessageComponent();
		first.shortcuts.get("ctrl+alt+f")(first.ctx);
		live.updateContent(assistant(401, content), false);
		assert.match(live.render(100).join("\n"), /≈ Deferred model headline/);
		const followUps = entries.filter((entry) => entry.type === "custom" && entry.customType !== "exchange-stats");
		assert.ok(followUps.length > 0);
		assert.doesNotMatch(JSON.stringify(followUps), /Inspecting deferred|x x x|Done/);
		first.close();
		const second = mount(entries, dir, { find: () => ({}), streamSimple: () => { throw new Error("restore must not summarize"); } });
		second.shortcuts.get("ctrl+alt+f")(second.ctx);
		const restored = new AssistantMessageComponent();
		restored.updateContent(assistant(401, content), false);
		assert.match(restored.render(100).join("\n"), /≈ Deferred model headline · .* · 903 words/);
		second.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a 0.1.0 entry keeps its card and derives an untimed thinking title from its message", () => {
	const oldRecord = { kind: "exchange", index: 1, durationMs: 4000, turnCount: 1, promptCount: 1,
		model: "old-model", input: 2, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0,
		totalTokens: 6, cost: 0, toolMs: 0, waitingMs: 0 };
	const entries = [
		{ type: "message", message: assistant(201, [{ type: "thinking", thinking: "Inspecting the old run." }]) },
		{ type: "custom", customType: "exchange-stats", data: oldRecord },
	];
	const mounted = mount(entries);
	try {
		mounted.shortcuts.get("ctrl+alt+f")(mounted.ctx);
		const component = new AssistantMessageComponent();
		component.updateContent(assistant(201, entries[0].message.content), false);
		assert.match(component.render(90).join("\n"), /Inspecting the old run\. · — · 4 words/);
		const theme = { bg: (_name, value) => value, fg: (_name, value) => value };
		assert.match(mounted.renderer()(entries[1], { expanded: true }, theme).render(90).join("\n"), /Exchange 1.*out 4/s);
	} finally { mounted.close(); }
});

test("compaction and tree rebuild remove prior processes from the picker and keep active toggles", async () => {
	const entry = (timestamp, id) => ({ type: "message", message: assistant(timestamp, [tool(id)]) });
	const entries = [entry(301, "old"), { type: "compaction" }, entry(302, "kept")];
	const mounted = mount(entries);
	try {
		mounted.handlers.get("session_compact")({}, mounted.ctx);
		await mounted.shortcuts.get("ctrl+alt+s")(mounted.ctx);
		let picker = mounted.picker();
		assert.doesNotMatch(picker.render(100).join("\n"), /secret-old/);
		assert.match(picker.render(100).join("\n"), /kept/);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		assert.match(picker.render(100).join("\n"), /▾.*⚙1/);
		entries.splice(2, 1, entry(303, "branch"));
		mounted.handlers.get("session_tree")({}, mounted.ctx);
		await mounted.shortcuts.get("ctrl+alt+s")(mounted.ctx);
		picker = mounted.picker();
		assert.doesNotMatch(picker.render(100).join("\n"), /secret-(?:old|kept)/);
		assert.match(picker.render(100).join("\n"), /branch/);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		assert.match(picker.render(100).join("\n"), /▾.*⚙1/);
	} finally { mounted.close(); }
});

test("an exchange longer than the live timing cache still saves its first thinking duration", () => {
	const entries = [];
	const mounted = mount(entries);
	try {
		mounted.handlers.get("before_agent_start")({}, mounted.ctx);
		for (let index = 0; index < 257; index++) {
			const message = assistant(1000 + index, [{ type: "thinking", thinking: `Step ${index}.` }]);
			mounted.handlers.get("message_update")({ message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: message.content[0].thinking } }, mounted.ctx);
			mounted.handlers.get("message_end")({ message: assistant(message.timestamp, message.content) }, mounted.ctx);
			entries.push({ type: "message", message });
		}
		mounted.handlers.get("agent_settled")({}, mounted.ctx);
		const blocks = entries.at(-1).data.blocks;
		assert.equal(blocks.length, 257);
		assert.equal(typeof blocks[0].durationMs, "number");
	} finally { mounted.close(); }
	const restored = mount(entries);
	try {
		restored.shortcuts.get("ctrl+alt+f")(restored.ctx);
		const component = new AssistantMessageComponent();
		component.updateContent(assistant(1000, [{ type: "thinking", thinking: "Step 0." }]), false);
		assert.match(component.render(90).join("\n"), /Step 0\. · \d+ms · 2 words/);
	} finally { restored.close(); }
});
