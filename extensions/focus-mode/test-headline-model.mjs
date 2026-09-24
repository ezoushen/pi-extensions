import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startStubProvider } from "../../test/live/stub-provider.mjs";
import { registerExchangeStats } from "./focus-mode.ts";

initTheme("dark");

async function waitFor(check) {
	const until = Date.now() + 2000;
	while (Date.now() < until) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("headline did not arrive");
}

test("registered Pi model receives a bounded non-reasoning request and supplies the title", async () => {
	const stub = await startStubProvider(() => "Checking live progress");
	const dir = mkdtempSync(join(tmpdir(), "pi-headline-model-"));
	const handlers = new Map();
	try {
		writeFileSync(join(dir, "focus-mode.json"), JSON.stringify({ summaryModel: "stub/headline-model" }));
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { stub: {
			baseUrl: stub.baseUrl, api: "openai-completions", apiKey: "stub-key",
			models: [{ id: "headline-model", name: "Headline stub", reasoning: true, input: ["text"],
				compat: { thinkingFormat: "qwen", supportsReasoningEffort: false },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
		} } }));
		const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		assert.ok(registry.find("stub", "headline-model"));
		registerExchangeStats({
			on: (name, handler) => handlers.set(name, handler),
			registerShortcut() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
		}, undefined, { agentDir: dir, environment: {} });
		const ctx = {
			hasUI: true, cwd: dir, isProjectTrusted: () => false, modelRegistry: registry,
			ui: { notify() {}, setStatus() {} },
		};
		handlers.get("session_start")({}, ctx);
		const trace = "Checking a live reasoning trace. " + "x".repeat(1600);
		const snapshot = () => ({ role: "assistant", timestamp: 934, content: [{ type: "thinking", thinking: trace }], stopReason: "stop" });
		handlers.get("message_update")({ message: snapshot(), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: trace } }, ctx);
		const component = new AssistantMessageComponent();
		await waitFor(() => {
			component.updateContent(snapshot(), true);
			return component.render(100).join("\n").includes("≈ Checking live progress");
		});
		assert.equal(stub.requests.length, 1);
		assert.equal(stub.requests[0].body.enable_thinking, false);
		assert.equal(stub.requests[0].body.max_completion_tokens, 32);
		assert.match(JSON.stringify(stub.requests[0].body.messages), /x{100}/);
	} finally {
		handlers.get("session_shutdown")?.({}, { hasUI: false });
		rmSync(dir, { recursive: true, force: true });
		await stub.close();
	}
});
