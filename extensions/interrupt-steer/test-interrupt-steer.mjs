import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerInterruptSteer from "./interrupt-steer.ts";

function createHarness({ editorText = "", idle = false, steering = [], followUp = [], sendError } = {}) {
	const shortcuts = new Map();
	const calls = [];
	const events = new Map();
	const sent = [];
	const notifications = [];
	let currentText = editorText;
	let agentIdle = idle;

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		on(event, handler) {
			events.set(event, handler);
		},
		sendUserMessage(content, options) {
			calls.push("sendUserMessage");
			if (sendError) throw sendError;
			sent.push({ content, options });
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			getEditorText() {
				calls.push("getEditorText");
				return currentText;
			},
			setEditorText(text) {
				calls.push("setEditorText");
				currentText = text;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
		isIdle() {
			calls.push("isIdle");
			return agentIdle;
		},
		hasPendingMessages() {
			calls.push("hasPendingMessages");
			return steering.length + followUp.length > 0;
		},
		abort() {
			calls.push("abort");
			const queued = [...steering, ...followUp];
			steering.length = 0;
			followUp.length = 0;
			const queuedText = queued.join("\n\n");
			currentText = [queuedText, currentText].filter((text) => text.trim()).join("\n\n");
		},
		async waitForIdle() {
			calls.push("waitForIdle");
			agentIdle = true;
		},
	};

	return {
		calls,
		ctx,
		events,
		get editorText() {
			return currentText;
		},
		pi,
		notifications,
		sent,
		shortcuts,
	};
}

test("interrupt shortcut aborts, waits for idle, then sends the editor text once", async () => {
	const harness = createHarness({ editorText: "do X instead" });
	registerInterruptSteer(harness.pi);
	const shortcut = harness.shortcuts.get("ctrl+alt+enter");

	assert.ok(shortcut);
	await shortcut.handler(harness.ctx);

	assert.deepEqual(harness.sent, [{ content: "do X instead", options: undefined }]);
	assert.equal(harness.editorText, "");
	assert.equal(harness.calls.filter((call) => call === "abort").length, 1);
	assert.equal(harness.calls.filter((call) => call === "waitForIdle").length, 1);
	assert.ok(harness.calls.indexOf("abort") < harness.calls.indexOf("waitForIdle"));
	assert.ok(harness.calls.indexOf("waitForIdle") < harness.calls.indexOf("sendUserMessage"));
	assert.ok(harness.calls.indexOf("waitForIdle") < harness.calls.lastIndexOf("getEditorText"));
});

test("interrupt sends Pi-restored steering and follow-up messages before the typed text", async () => {
	const harness = createHarness({
		editorText: "do X instead",
		steering: ["first steering", "second steering"],
		followUp: ["first follow-up", "second follow-up"],
	});
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, [{
		content: "first steering\n\nsecond steering\n\nfirst follow-up\n\nsecond follow-up\n\ndo X instead",
		options: undefined,
	}]);
	assert.equal(harness.editorText, "");
	assert.deepEqual(harness.notifications, []);
});

test("idle shortcut sends editor text without aborting", async () => {
	const harness = createHarness({ editorText: "next prompt", idle: true });
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, [{ content: "next prompt", options: undefined }]);
	assert.equal(harness.editorText, "");
	assert.equal(harness.calls.includes("abort"), false);
});

test("empty editor shows one notification without sending or aborting", async () => {
	const harness = createHarness({ idle: true });
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.equal(harness.calls.includes("abort"), false);
	assert.equal(harness.notifications.length, 1);
});

test("empty streaming run with no queue stays active and shows one notification", async () => {
	const harness = createHarness();
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.equal(harness.calls.includes("abort"), false);
	assert.equal(harness.notifications.length, 1);
});

test("queued messages are sent when the editor is empty", async () => {
	const harness = createHarness({ steering: ["continue with the queued change"] });
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, [{ content: "continue with the queued change", options: undefined }]);
	assert.equal(harness.editorText, "");
	assert.ok(harness.calls.indexOf("abort") < harness.calls.indexOf("waitForIdle"));
});

test("failed send restores the message and shows one warning", async () => {
	const harness = createHarness({
		editorText: "keep this prompt",
		steering: ["queued steering"],
		followUp: ["queued follow-up"],
		sendError: new Error("send failed"),
	});
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.equal(harness.editorText, "queued steering\n\nqueued follow-up\n\nkeep this prompt");
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "warning");
});

test("valid key setting replaces the default shortcut", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-interrupt-steer-settings-"));
	try {
		writeFileSync(join(agentDir, "pi-interrupt-steer.json"), JSON.stringify({ key: "ctrl+shift+x" }));
		const harness = createHarness();
		registerInterruptSteer(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("ctrl+shift+x"), true);
		assert.equal(harness.shortcuts.has("ctrl+alt+enter"), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("environment key setting overrides the agent setting", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-interrupt-steer-env-settings-"));
	try {
		writeFileSync(join(agentDir, "pi-interrupt-steer.json"), JSON.stringify({ key: "ctrl+shift+x" }));
		const harness = createHarness();
		registerInterruptSteer(harness.pi, {
			agentDir,
			environment: { PI_INTERRUPT_STEER_KEY: "alt+y" },
		});

		assert.equal(harness.shortcuts.has("alt+y"), true);
		assert.equal(harness.shortcuts.has("ctrl+shift+x"), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("invalid key setting uses the default shortcut and warns once", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-interrupt-steer-invalid-settings-"));
	try {
		writeFileSync(join(agentDir, "pi-interrupt-steer.json"), JSON.stringify({ key: "not-a-key" }));
		const harness = createHarness();
		registerInterruptSteer(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("ctrl+alt+enter"), true);
		assert.equal(harness.shortcuts.has("not-a-key"), false);
		const onSessionStart = harness.events.get("session_start");
		onSessionStart({}, harness.ctx);
		onSessionStart({}, harness.ctx);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
