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

const record010 = {
	kind: "exchange",
	index: 3,
	promptCount: 1,
	turnCount: 1,
	turns: [{
		index: 1,
		durationMs: 13_200,
		toolMs: 0,
		modelMs: 13_200,
		outputPerSec: 7 / 13.2,
		tools: [],
		input: 11,
		output: 7,
		reasoning: 2,
		cacheRead: 3,
		cacheWrite: 0,
		totalTokens: 18,
		cost: 0.0042,
	}],
	startedAt: Date.UTC(2026, 8, 24, 6, 18, 53),
	endedAt: Date.UTC(2026, 8, 24, 6, 32, 5),
	durationMs: 13_200,
	waitingMs: 0,
	toolMs: 0,
	model: "old-model",
	stopReason: "stop",
	input: 11,
	output: 7,
	reasoning: 2,
	cacheRead: 3,
	cacheWrite: 0,
	totalTokens: 18,
	cost: 0.0042,
};

function withLocalClock(now, timeZone, action) {
	const previousTimeZone = process.env.TZ;
	const previousNow = Date.now;
	process.env.TZ = timeZone;
	Date.now = () => now;
	try {
		assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, timeZone);
		action();
	} finally {
		Date.now = previousNow;
		if (previousTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = previousTimeZone;
	}
}

function renderEntry(mounted, data) {
	const theme = {
		bg: (_name, value) => value,
		fg: (_name, value) => value,
		bold: (value) => value,
	};
	return mounted.renderer()({ type: "custom", customType: "exchange-stats", data }, { expanded: false }, theme)
		.render(100).join("\n");
}

test("a literal 0.1.0 exchange record renders its local finish time", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const endedAt = record010.endedAt;
	const expectedTime = new Date(endedAt).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone,
	});

	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		const rendered = renderEntry(mounted, record010);
		const headline = rendered.split("\n").find((line) => line.includes("Exchange"));
		assert.equal(headline?.trim(), "⏱ Exchange 3 · 13.2s · " + expectedTime + "  old-model");
	});
});

test("an exchange finished on an earlier local day includes the date", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const endedAt = Date.UTC(2026, 8, 23, 15);
	const expectedDate = new Date(endedAt).toLocaleDateString(undefined, { dateStyle: "medium", timeZone });
	const expectedTime = new Date(endedAt).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone,
	});

	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		const rendered = renderEntry(mounted, { ...record010, endedAt });
		const headline = rendered.split("\n").find((line) => line.includes("Exchange"));
		assert.equal(headline?.trim(), "⏱ Exchange 3 · 13.2s · " + expectedDate + " " + expectedTime + "  old-model");
	});
});

test("an exchange without endedAt omits the finish time and session headlines stay unchanged", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		const oldRecord = { ...record010 };
		delete oldRecord.endedAt;
		const exchange = renderEntry(mounted, oldRecord).split("\n").find((line) => line.includes("Exchange"));
		assert.equal(exchange?.trim(), "⏱ Exchange 3 · 13.2s  old-model");

		const session = renderEntry(mounted, { ...record010, kind: "session" }).split("\n").find((line) => line.includes("Session"));
		assert.equal(session?.trim(), "📊 Session · 1 turn across 3 exchanges  old-model");
	});
});

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

test("exchange card text rows use the theme's italic styling with their gray color", () => {
	const mounted = mount();
	const theme = {
		bg: (_name, value) => value,
		fg: (_name, value) => `\x1b[38;5;1m${value}\x1b[39m`,
		italic: (value) => `\x1b[3m${value}\x1b[23m`,
		bold: (value) => value,
	};
	const lines = mounted.renderer()({ type: "custom", customType: "exchange-stats", data: record010 }, { expanded: false }, theme)
		.render(100).filter((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
	assert.equal(lines.length, 3);
	for (const line of lines) {
		assert.match(line, /\x1b\[38;5;1m/);
		assert.match(line, /\x1b\[3m/);
	}
});
