import assert from "node:assert/strict";
import test from "node:test";

import exchangeStats from "./exchange-stats.ts";

function mount() {
	const handlers = new Map();
	const entries = [];
	const statuses = [];
	let renderer;

	exchangeStats({
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerEntryRenderer(_type, entryRenderer) {
			renderer = entryRenderer;
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		registerCommand() {},
		registerShortcut() {},
	});

	const context = {
		hasUI: true,
		model: { id: "pi-test-model" },
		ui: { setStatus: (key, value) => statuses.push({ key, value }) },
	};
	return { handlers, entries, statuses, renderer: () => renderer, context };
}

test("an exchange renders with only Pi-provided events and context", () => {
	const mounted = mount();
	mounted.handlers.get("session_start")({}, mounted.context);
	mounted.handlers.get("before_agent_start")({}, mounted.context);
	mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.context);
	mounted.handlers.get("turn_end")(
		{
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: {
					input: 11,
					output: 7,
					reasoning: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 18,
					cost: { total: 0.0042 },
				},
			},
		},
		mounted.context,
	);
	mounted.handlers.get("agent_settled")({}, mounted.context);

	assert.equal(mounted.entries.length, 1);
	assert.equal(mounted.entries[0].type, "exchange-stats");
	assert.equal(mounted.entries[0].data.output, 7);
	assert.equal(mounted.entries[0].data.cost, 0.0042);

	const identityTheme = {
		bg: (_name, value) => value,
		fg: (_name, value) => value,
		bold: (value) => value,
	};
	const card = mounted.renderer()(mounted.entries[0], { expanded: false }, identityTheme);
	const rendered = card.render(100).join("\n");
	assert.match(rendered, /Exchange 1/);
	assert.match(rendered, /out 7/);
	assert.match(rendered, /\$0\.00420/);
	for (const expanded of [false, true]) {
		const colors = [];
		const theme = { bg: (_name, value) => value, fg: (name, value) => { colors.push(name); return value; }, bold: (value) => value };
		const lines = mounted.renderer()(mounted.entries[0], { expanded }, theme).render(100).join("\n");
		assert.match(lines, /Exchange 1.*\n.*out 7.*\n.*in 11/s);
		assert.doesNotMatch(lines, /#\s*1|expand|stop:|avg .* per turn/);
		assert.equal(colors.every((color) => color === "dim"), true);
	}
	assert.match(mounted.statuses.at(-1).value, /out 7/);
});
