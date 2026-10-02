// Live proof for pi-prefix-stabilizer's sticky extension sections: a real `pi --mode rpc`
// session against a loopback stub provider, with a helper extension that adds a prompt
// section in before_agent_start and, after the first run, wakes the agent with an
// extension message (as a background-task notification does). The stub answers that
// wake-up run with one tool call, as the real notification runs did.
//
// Pi skips before_agent_start for that wake-up run, so at its next turn pi records the
// helper's section as removed; without the stabilizer it is dropped from the leading
// system prompt and comes back on the next typed prompt: the prompt head flips twice and a prefix cache is lost twice. The control
// run proves the flip happens on this pi; the stabilizer run proves it no longer reaches
// the provider.
//
// Hermetic: PI_CODING_AGENT_DIR points at a scratch directory and only 127.0.0.1 is
// contacted. Skips if `pi` is not on PATH (or PI_BIN).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startStubProvider } from "./stub-provider.mjs";
import { spawnPiRpc } from "./rpc-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stabilizer = join(repoRoot, "extensions", "prefix-stabilizer", "prefix-stabilizer.js");

function resolvePiBin() {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const HELPER = `
export default function (pi) {
	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions?.sections;
		if (sections) sections.test_harness = "always read the adapter first";
	});
	let woke = false;
	pi.on("agent_end", () => {
		if (woke) return;
		woke = true;
		setTimeout(() => pi.sendMessage({ customType: "test-notify", content: "background task finished", display: true }, { triggerTurn: true }), 100);
	});
}
`;

function scratchAgent(baseUrl, compat = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sticky-sections-"));
	writeFileSync(join(agentDir, "helper.mjs"), HELPER);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "free-model", defaultProjectTrust: "never" }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				stub: {
					baseUrl,
					api: "openai-completions",
					apiKey: "stub-key",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, ...compat },
					models: [{ id: "free-model", name: "Free", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
				},
			},
		}),
	);
	return agentDir;
}

const leadingSystem = (request) => {
	const first = request.body.messages?.[0];
	return first?.role === "system" ? first.content : undefined;
};

async function runSession(piBin, extensions, compat, { followUp = false, resume = false } = {}) {
	let agentDir;
	const stub = await startStubProvider((_body, n) =>
		n === 2 && followUp
			? { steps: [{ delayMs: 1500, delta: { role: "assistant", content: "noted" } }] }
			: n === 2
			? {
					steps: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(agentDir, "settings.json") }) } }] } }],
					finishReason: "tool_calls",
				}
			: undefined,
	);
	agentDir = scratchAgent(stub.baseUrl, compat);
	const args = ["--mode", "rpc", "--provider", "stub", "--model", "free-model", "--session-dir", join(agentDir, "sessions"), "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--no-extensions"];
	for (const path of [join(agentDir, "helper.mjs"), ...extensions]) args.push("-e", path);
	const rpc = spawnPiRpc(piBin, args, { ...process.env, PI_CODING_AGENT_DIR: agentDir });
	let resumed;
	try {
		await rpc.promptAndWaitIdle("start the review", "p1");
		// The helper's wake-up run: a tool call, then the turn after its result; or a slow
		// reply during which the user queues a follow-up, which pi sends as the next turn.
		const start = Date.now();
		if (followUp) {
			while (stub.requests.length < 2 && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 20));
			rpc.send({ id: "f1", type: "follow_up", message: "is it done?" });
		}
		while (stub.requests.length < 3 && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 50));
		assert.equal(stub.requests.length, 3, `the extension message never ran two turns; stderr=${rpc.stderr.join("")}`);
		await new Promise((r) => setTimeout(r, 500));
		await rpc.promptAndWaitIdle("did the task finish?", "p2");
		const drift = rpc.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify" && /system prompt changed/.test(e.message));
		const updates = stub.requests.map((request) =>
			(request.body.messages ?? []).slice(1).filter((m) => m.role === "system").map((m) => m.content),
		);
		const sessionDir = join(agentDir, "sessions");
		const recorded = readdirSync(sessionDir, { recursive: true })
			.filter((name) => String(name).endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(sessionDir, String(name)), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)))
			.filter((entry) => entry.type === "custom" && entry.customType === "pi-prefix-stabilizer");
		let resumedHead;
		let resumedUpdates;
		if (resume) {
			await rpc.stop();
			resumed = spawnPiRpc(piBin, [...args, "--continue"], { ...process.env, PI_CODING_AGENT_DIR: agentDir });
			const before = stub.requests.length;
			await resumed.promptAndWaitIdle("after the restart", "p3");
			resumedHead = leadingSystem(stub.requests[before]);
			resumedUpdates = (stub.requests[before].body.messages ?? []).slice(1).filter((m) => m.role === "system").map((m) => m.content);
		}
		return { heads: stub.requests.slice(0, 4).map(leadingSystem), updates, drift, recorded, resumedHead, resumedUpdates };
	} finally {
		await rpc.stop();
		await resumed?.stop();
		await stub.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const piBin = resolvePiBin();

test("control: without the stabilizer the wake-up run drops the extension section", { skip: !piBin && "pi not found" }, async () => {
	const { heads } = await runSession(piBin, []);
	assert.equal(heads.length, 4);
	assert.match(heads[0], /always read the adapter first/);
	assert.doesNotMatch(heads[2], /always read the adapter first/, "pi kept the section on the wake-up run; the flip this test guards no longer happens");
	assert.match(heads[3], /always read the adapter first/);
});

test("with the stabilizer every request carries the same leading system prompt", { skip: !piBin && "pi not found" }, async () => {
	const { heads, drift, recorded, resumedHead } = await runSession(piBin, [stabilizer], {}, { resume: true });
	assert.equal(recorded.length, 1, "the dropped removal was not recorded in the session for resume");
	assert.equal(heads.length, 4);
	assert.match(heads[0], /always read the adapter first/);
	assert.equal(heads[2], heads[0], "the wake-up run's second turn changed the prompt head");
	assert.equal(heads[3], heads[0], "the next typed prompt changed the prompt head");
	assert.equal(resumedHead, heads[0], "resuming the session changed the prompt head");
	assert.deepEqual(drift.map((e) => e.message), []);
});

test("with mid-conversation system messages the stabilizer sends no flip updates", { skip: !piBin && "pi not found" }, async () => {
	const compat = { supportsMidConvoSystemMessages: true };
	const control = await runSession(piBin, [], compat);
	assert.match(control.updates.flat().join("\n"), /Removed system prompt section "test_harness"/, "control: pi no longer sends the removal; the case this test guards is gone");
	// Resuming replays the recorded removals, so the request after a restart matches too.
	const { heads, updates, drift, resumedHead, resumedUpdates } = await runSession(piBin, [stabilizer], compat, { resume: true });
	assert.deepEqual(new Set(heads).size, 1);
	assert.deepEqual(updates.flat(), []);
	assert.equal(resumedHead, heads[0]);
	assert.deepEqual(resumedUpdates, [], "after resuming, the recorded removal reached the model");
	assert.deepEqual(drift.map((e) => e.message), []);
});

test("a follow-up queued during the wake-up run keeps the same leading system prompt", { skip: !piBin && "pi not found" }, async () => {
	const control = await runSession(piBin, [], {}, { followUp: true });
	assert.doesNotMatch(control.heads[2], /always read the adapter first/, "control: the follow-up turn kept the section; the case this test guards is gone");
	const { heads, drift } = await runSession(piBin, [stabilizer], {}, { followUp: true });
	assert.equal(heads.length, 4);
	assert.equal(new Set(heads).size, 1, "a request changed the prompt head");
	assert.deepEqual(drift.map((e) => e.message), []);
});
