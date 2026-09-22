import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import extension from "./compaction-cache.ts";

const MODEL_WITHOUT_COST = {
	id: "self-hosted-flash",
	provider: "local",
	maxTokens: 32768,
	contextWindow: 262144,
};

function mount() {
	const handlers = {};
	const commands = {};
	extension({
		on(name, handler) {
			(handlers[name] ??= []).push(handler);
		},
		registerCommand(name, command) {
			commands[name] = command;
		},
	});
	return { handlers, commands };
}

function context(model, notices, cwd = process.cwd()) {
	return {
		cwd,
		isProjectTrusted: () => true,
		model,
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
}

function compactionEvent() {
	return {
		preparation: {},
		customInstructions: undefined,
		signal: undefined,
	};
}

test("missing cost metadata declines once and names the reason", async () => {
	const { handlers } = mount();
	const notices = [];
	const ctx = context(MODEL_WITHOUT_COST, notices);

	await handlers.session_before_compact[0](compactionEvent(), ctx);
	await handlers.session_before_compact[0](compactionEvent(), ctx);

	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /inactive.*no cost metadata/i);
});

test("a models matcher overrides missing cost metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "compaction-cache-matcher-"));
	try {
		const configDir = join(root, CONFIG_DIR_NAME);
		mkdirSync(configDir);
		writeFileSync(join(configDir, "compaction-cache.json"), JSON.stringify({ models: ["local/*"] }));
		const { commands } = mount();
		const notices = [];

		await commands["compaction-cache-status"].handler("", context(MODEL_WITHOUT_COST, notices, root));

		assert.match(notices[0].message, /active for local\/self-hosted-flash/i);
		assert.match(notices[0].message, /models matcher/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a metered model remains inactive without a models matcher", async () => {
	const { handlers } = mount();
	const notices = [];
	const model = { ...MODEL_WITHOUT_COST, cost: { input: 3, cacheRead: 0.3 } };

	await handlers.session_before_compact[0](compactionEvent(), context(model, notices));

	assert.equal(notices.length, 1);
	assert.match(notices[0].message, /inactive.*non-zero input or cache-read price/i);
});

test("models match provider/id globs and bare model ids", async () => {
	const root = mkdtempSync(join(tmpdir(), "compaction-cache-convention-"));
	try {
		const configDir = join(root, CONFIG_DIR_NAME);
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "compaction-cache.json"),
			JSON.stringify({ models: ["cloud/*-flash", "bare-model"] }),
		);
		const { commands } = mount();

		for (const model of [
			{ ...MODEL_WITHOUT_COST, provider: "cloud", id: "fast-flash" },
			{ ...MODEL_WITHOUT_COST, provider: "another-provider", id: "bare-model" },
		]) {
			const notices = [];
			await commands["compaction-cache-status"].handler("", context(model, notices, root));
			assert.match(notices[0].message, /active for/i);
			assert.match(notices[0].message, /models matcher/i);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the status command reports applicability and every setting with provenance", async () => {
	const root = mkdtempSync(join(tmpdir(), "compaction-cache-status-"));
	try {
		const configDir = join(root, CONFIG_DIR_NAME);
		mkdirSync(configDir);
		const configPath = join(configDir, "compaction-cache.json");
		writeFileSync(configPath, JSON.stringify({ models: ["local/*"], scope: "full" }));
		const { commands } = mount();
		const notices = [];

		await commands["compaction-cache-status"].handler("", context(MODEL_WITHOUT_COST, notices, root));

		assert.equal(notices.length, 1);
		const report = notices[0].message;
		assert.match(report, /active for local\/self-hosted-flash/i);
		assert.match(report, /rule: models matcher/i);
		for (const setting of ["enabled", "models", "logPath", "debug", "scope", "maxWords"]) {
			assert.match(report, new RegExp(`^${setting} = .+ \\(.+\\)$`, "m"));
		}
		assert.match(report, new RegExp(`models = .*project: ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(report, /enabled = true \(default\)/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
