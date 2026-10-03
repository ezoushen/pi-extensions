import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { registerExchangeStats } from "./focus-mode.ts";

// The exchange card's fields: tokens per second by default, and a `cardFields` setting
// that chooses which fields a card shows.
function mount({ config, projectConfig, trusted = false, environment = {} } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "focus-mode-fields-"));
	const cwd = join(agentDir, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (config !== undefined) writeFileSync(join(agentDir, "focus-mode.json"), JSON.stringify(config));
	if (projectConfig !== undefined) writeFileSync(join(cwd, ".pi", "focus-mode.json"), JSON.stringify(projectConfig));
	const handlers = new Map(), notices = [];
	let renderer;
	registerExchangeStats({
		on: (name, handler) => handlers.set(name, handler),
		registerShortcut() {}, registerCommand() {}, appendEntry() {},
		registerEntryRenderer: (_type, value) => { renderer = value; },
	}, ToolExecutionComponent, { agentDir, environment });
	const ctx = { hasUI: true, cwd, model: { id: "test" }, isProjectTrusted: () => trusted, sessionManager: { getBranch: () => [] },
		ui: { setStatus() {}, notify: (message) => notices.push(message) } };
	handlers.get("session_start")({}, ctx);
	const theme = { bg: (_n, v) => v, fg: (_n, v) => v, bold: (v) => v };
	const render = (data) => renderer({ type: "custom", customType: "exchange-stats", data }, { expanded: false }, theme)
		.render(200).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).join(" ");
	return { render, notices, close: () => { handlers.get("session_shutdown")(); rmSync(agentDir, { recursive: true, force: true }); } };
}

const turn = (output, modelMs) => ({ index: 1, durationMs: modelMs + 1_000, toolMs: 1_000, modelMs, outputPerSec: 0, tools: [], input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
// Two turns: 300 + 150 output tokens over 4s + 2s of model time = 75 tok/s; tool time excluded.
const exchange = {
	kind: "exchange", index: 1, promptCount: 1, turnCount: 2, turns: [turn(300, 4_000), turn(150, 2_000)],
	startedAt: 0, durationMs: 9_000, waitingMs: 0, toolMs: 2_000, model: "glm-5.3-flash", stopReason: "stop",
	input: 1_200, output: 450, reasoning: 0, cacheRead: 80_000, cacheWrite: 0, totalTokens: 0, cost: 0,
};

test("an exchange card shows output tokens per second of model time after the output count", () => {
	const m = mount();
	try {
		assert.equal(m.render(exchange), "⏱ 9.0s · glm-5.3-flash (in 1.2k · out 450 · 75 tps · cache 80.0k · $0)");
	} finally { m.close(); }
});

test("a slow exchange shows one decimal, and a card without output shows no rate", () => {
	const m = mount();
	try {
		assert.match(m.render({ ...exchange, output: 9, turns: [turn(9, 2_000)] }), /out 9 · 4\.5 tps ·/);
		assert.doesNotMatch(m.render({ ...exchange, output: 0, turns: [turn(0, 2_000)] }), /tps/);
	} finally { m.close(); }
});

test("a session card's rate is its output over wall time less tools and waiting", () => {
	const m = mount();
	try {
		// 600 tokens over 20s - 4s tools - 1s waiting = 40 tok/s.
		const session = { ...exchange, kind: "session", index: 3, turnCount: 5, turns: [], durationMs: 20_000, toolMs: 4_000, waitingMs: 1_000, output: 600 };
		assert.match(m.render(session), /out 600 · 40 tps ·/);
	} finally { m.close(); }
});

test("cardFields chooses which fields the card shows", () => {
	const m = mount({ config: { cardFields: ["model", "output", "tps", "cost"] } });
	try {
		assert.equal(m.render(exchange), "glm-5.3-flash (out 450 · 75 tps · $0)");
	} finally { m.close(); }
});

test("the field order on the card stays fixed whatever order cardFields lists", () => {
	const m = mount({ config: { cardFields: ["tps", "duration", "input"] } });
	try {
		assert.equal(m.render(exchange), "⏱ 9.0s (in 1.2k · 75 tps)");
	} finally { m.close(); }
});

test("PI_FOCUS_MODE_CARD_FIELDS overrides the file with a comma-separated list", () => {
	const m = mount({ config: { cardFields: ["model"] }, environment: { PI_FOCUS_MODE_CARD_FIELDS: "duration, tps" } });
	try {
		assert.equal(m.render(exchange), "⏱ 9.0s (75 tps)");
	} finally { m.close(); }
});

test("a trusted project's cardFields applies, an untrusted one does not", () => {
	const trusted = mount({ projectConfig: { cardFields: ["tps"] }, trusted: true });
	const untrusted = mount({ projectConfig: { cardFields: ["tps"] } });
	try {
		assert.equal(trusted.render(exchange), "(75 tps)");
		assert.match(untrusted.render(exchange), /^⏱ 9\.0s · glm-5\.3-flash \(/);
	} finally { trusted.close(); untrusted.close(); }
});

test("unknown field names are ignored with one warning, and no valid field falls back to the default", () => {
	const typo = mount({ config: { cardFields: ["model", "tsp"] } });
	const none = mount({ config: { cardFields: ["nope"] } });
	try {
		assert.equal(typo.render(exchange), "glm-5.3-flash");
		assert.equal(typo.notices.filter((n) => /cardFields/.test(n)).length, 1);
		assert.match(typo.notices.join("\n"), /tsp/);
		assert.equal(none.render(exchange), "⏱ 9.0s · glm-5.3-flash (in 1.2k · out 450 · 75 tps · cache 80.0k · $0)");
	} finally { typo.close(); none.close(); }
});
