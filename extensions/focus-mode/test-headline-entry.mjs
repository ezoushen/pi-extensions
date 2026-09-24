import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { registerExchangeStats } from "./focus-mode.ts";

initTheme("dark");

function mount(agentDir, modelRegistry) {
	const handlers = new Map();
	const notifications = [];
	const statuses = [];
	registerExchangeStats({
		on: (name, handler) => handlers.set(name, handler),
		registerShortcut() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
	}, undefined, { agentDir, environment: {} });
	const ctx = {
		hasUI: true, cwd: agentDir, isProjectTrusted: () => false, modelRegistry,
		ui: { notify: (message) => notifications.push(message), setStatus: (_key, value) => statuses.push(value) },
	};
	return { handlers, notifications, statuses, ctx };
}

test("unset summaryModel never looks up a model or sends a request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headline-entry-"));
	try {
		const mounted = mount(dir, { find() { throw new Error("must not look up"); } });
		mounted.handlers.get("session_start")({}, mounted.ctx);
		const message = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "x".repeat(1600) }] };
		mounted.handlers.get("message_update")({ message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: message.content[0].thinking } }, mounted.ctx);
		mounted.handlers.get("message_end")({ message }, mounted.ctx);
		assert.equal(mounted.notifications.filter((text) => text.includes("summaryModel")).length, 0);
		mounted.handlers.get("session_shutdown")({}, mounted.ctx);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown configured model is announced once and thinking keeps its fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headline-entry-"));
	try {
		writeFileSync(join(dir, "focus-mode.json"), JSON.stringify({ summaryModel: "stub/missing" }));
		const mounted = mount(dir, { find: () => undefined });
		mounted.handlers.get("session_start")({}, mounted.ctx);
		const message = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "Checking the setting. More unfinished text" }] };
		mounted.handlers.get("message_update")({ message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: message.content[0].thinking } }, mounted.ctx);
		const component = new AssistantMessageComponent();
		component.updateContent({ ...message, content: [{ ...message.content[0] }] }, true);
		assert.match(component.render(80).join("\n"), /Checking the setting\./);
		assert.doesNotMatch(component.render(80).join("\n"), /≈/);
		assert.equal(mounted.notifications.filter((text) => text.includes("stub/missing")).length, 1);
		assert.match(mounted.notifications[0], /^focus-mode:/);
		mounted.handlers.get("session_shutdown")({}, mounted.ctx);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const { name, response, expected } of [
	{
		name: "a length stop with only reasoning",
		response: { stopReason: "length", content: [{ type: "thinking", thinking: "still thinking" }] },
		expected: /stub\/headline.*output cap.*thinkingLevelMap\.off/,
	},
	{
		name: "a provider error",
		response: { stopReason: "error", errorMessage: `Provider rejected request\n${"x".repeat(240)}`, content: [] },
		expected: /stub\/headline.*Provider rejected request/,
	},
	{
		name: "a rejected request",
		response: new Error("Provider connection refused\nretry later"),
		expected: /stub\/headline.*Provider connection refused retry later/,
	},
]) {
	test(`${name} announces one actionable line and keeps the trace headline`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-headline-entry-"));
		try {
			writeFileSync(join(dir, "focus-mode.json"), JSON.stringify({ summaryModel: "stub/headline" }));
			const mounted = mount(dir, { find: () => ({}), streamSimple: () => ({ result: async () => {
				if (response instanceof Error) throw response;
				return response;
			} }) });
			mounted.handlers.get("session_start")({}, mounted.ctx);
			const trace = "Checking the setting. " + "x".repeat(1600);
			const snapshot = () => ({ role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: trace }] });
			mounted.handlers.get("message_update")({ message: snapshot(), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: trace } }, mounted.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(mounted.notifications.length, 1);
			assert.match(mounted.notifications[0], expected);
			assert.ok(mounted.notifications[0].length < 240);
			assert.doesNotMatch(mounted.notifications[0], /[\r\n]/);
			if (name === "a provider error") assert.doesNotMatch(mounted.notifications[0], /x{120}/);
			const component = new AssistantMessageComponent();
			component.updateContent(snapshot(), true);
			assert.match(component.render(80).join("\n"), /Checking the setting\./);
			mounted.handlers.get("session_shutdown")({}, mounted.ctx);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}
