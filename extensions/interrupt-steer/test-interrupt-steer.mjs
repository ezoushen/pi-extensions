import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerInterruptSteer from "./interrupt-steer.ts";

async function withFakeClock(run) {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const originalNow = Date.now;
	let now = 0;
	let nextId = 0;
	const pending = new Map();

	globalThis.setTimeout = (callback, delay = 0) => {
		const id = ++nextId;
		pending.set(id, { at: now + Number(delay), callback });
		return id;
	};
	globalThis.clearTimeout = (id) => pending.delete(id);
	Date.now = () => now;

	const flushMicrotasks = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	const advanceBy = async (duration) => {
		const target = now + duration;
		while (true) {
			let next;
			for (const [id, timer] of pending) {
				if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
			}
			if (!next) break;
			now = next.timer.at;
			pending.delete(next.id);
			next.timer.callback();
			await flushMicrotasks();
		}
		now = target;
		await flushMicrotasks();
	};

	try {
		await run({ advanceBy });
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		Date.now = originalNow;
	}
}

function createHarness({
	editorText = "",
	idle = false,
	steering = [],
	followUp = [],
	sendError,
	preflightFailure = false,
	acceptanceText,
	acceptanceContentType = "parts",
	unrelatedMessageText,
	handledPrompt = false,
	acceptanceDelayMs = 0,
	busyPollsAfterAbort = 2,
	neverIdle = false,
} = {}) {
	const shortcuts = new Map();
	const calls = [];
	const events = new Map();
	const sent = [];
	const notifications = [];
	const emitUserMessage = (content) => {
		calls.push("message_start");
		for (const handler of events.get("message_start") ?? []) handler({
			type: "message_start",
			message: {
				role: "user",
				content,
				timestamp: Date.now(),
			},
		}, ctx);
	};
	let currentText = editorText;
	let agentIdle = idle;
	let pollsUntilIdle;

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		on(event, handler) {
			let handlers = events.get(event);
			if (!handlers) events.set(event, handlers = new Set());
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		sendUserMessage(content, options) {
			calls.push("sendUserMessage");
			const send = async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (unrelatedMessageText !== undefined) {
					emitUserMessage([{ type: "text", text: unrelatedMessageText }]);
				}
				if (preflightFailure) throw new Error("model preflight failed");
				if (sendError) {
					calls.push("sendFailure");
					throw sendError;
				}
				if (handledPrompt) return;
				if (acceptanceDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, acceptanceDelayMs));
				}
				const acceptedText = acceptanceText ?? content;
				sent.push({ content: acceptedText, options });
				const messageContent = acceptanceContentType === "string"
					? acceptedText
					: acceptanceContentType === "split-parts"
						? [
							{ type: "text", text: acceptedText.slice(0, Math.floor(acceptedText.length / 2)) },
							{ type: "text", text: acceptedText.slice(Math.floor(acceptedText.length / 2)) },
						]
						: [{ type: "text", text: acceptedText }];
				emitUserMessage(messageContent);
			};
			void send().catch(() => {});
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
			if (!agentIdle && pollsUntilIdle !== undefined && !neverIdle) {
				if (pollsUntilIdle === 0) agentIdle = true;
				else pollsUntilIdle--;
			}
			return agentIdle;
		},
		hasPendingMessages() {
			calls.push("hasPendingMessages");
			return steering.length + followUp.length > 0;
		},
		abort() {
			calls.push("abort");
			pollsUntilIdle = busyPollsAfterAbort;
			const queued = [...steering, ...followUp];
			steering.length = 0;
			followUp.length = 0;
			const queuedText = queued.join("\n\n");
			currentText = [queuedText, currentText].filter((text) => text.trim()).join("\n\n");
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
		emit(event, data) {
			for (const handler of events.get(event) ?? []) handler(data, ctx);
		},
	};
}

test("interrupt shortcut aborts, polls for idle, then sends the editor text once", async () => {
	const harness = createHarness({ editorText: "do X instead" });
	registerInterruptSteer(harness.pi);
	const shortcut = harness.shortcuts.get("ctrl+alt+enter");

	assert.ok(shortcut);
	assert.equal("waitForIdle" in harness.ctx, false);
	await shortcut.handler(harness.ctx);

	assert.deepEqual(harness.sent, [{ content: "do X instead", options: undefined }]);
	assert.equal(harness.editorText, "");
	assert.equal(harness.calls.filter((call) => call === "abort").length, 1);
	const abortIndex = harness.calls.indexOf("abort");
	const sendIndex = harness.calls.indexOf("sendUserMessage");
	const messageStartIndex = harness.calls.indexOf("message_start");
	const clearIndex = harness.calls.indexOf("setEditorText");
	assert.equal(harness.calls.slice(abortIndex + 1, sendIndex).filter((call) => call === "isIdle").length, 3);
	assert.ok(abortIndex < sendIndex);
	assert.ok(harness.calls.indexOf("getEditorText") < sendIndex);
	assert.ok(sendIndex < messageStartIndex);
	assert.ok(messageStartIndex < harness.calls.lastIndexOf("getEditorText"));
	assert.ok(harness.calls.lastIndexOf("getEditorText") < clearIndex);
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

test("idle wait timeout leaves Pi-restored text in the editor and warns", async () => {
	const harness = createHarness({
		editorText: "do X instead",
		steering: ["queued steering"],
		neverIdle: true,
	});
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, []);
	assert.equal(harness.editorText, "queued steering\n\ndo X instead");
	assert.equal(harness.calls.includes("sendUserMessage"), false);
	assert.equal(harness.calls.includes("setEditorText"), false);
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "warning");
	assert.match(harness.notifications[0].message, /did not become idle within 5 seconds/);
});

test("idle shortcut sends editor text without aborting", async () => {
	const harness = createHarness({ editorText: "next prompt", idle: true });
	registerInterruptSteer(harness.pi);

	await harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);

	assert.deepEqual(harness.sent, [{ content: "next prompt", options: undefined }]);
	assert.equal(harness.editorText, "");
	assert.equal(harness.calls.includes("abort"), false);
});

test("idle shortcut leaves editor text the user changed before Pi accepted the send", async () => {
	const harness = createHarness({ editorText: "submitted prompt", idle: true, acceptanceDelayMs: 10 });
	registerInterruptSteer(harness.pi);

	const send = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
	harness.ctx.ui.setEditorText("new editor text");
	await send;

	assert.deepEqual(harness.sent, [{ content: "submitted prompt", options: undefined }]);
	assert.equal(harness.editorText, "new editor text");
	assert.deepEqual(harness.notifications, []);
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
	assert.ok(harness.calls.indexOf("abort") < harness.calls.indexOf("sendUserMessage"));
});

test("idle shortcut keeps text when Pi fails asynchronously before accepting it", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({
			editorText: "keep this prompt",
			idle: true,
			sendError: new Error("send failed"),
		});
		registerInterruptSteer(harness.pi);

		const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
		await advanceBy(60_000);
		await pending;

		assert.deepEqual(harness.sent, []);
		assert.equal(harness.editorText, "keep this prompt");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
	});
});

test("post-abort shortcut keeps Pi-restored text when Pi fails asynchronously before accepting it", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({
			editorText: "keep this prompt",
			steering: ["queued steering"],
			followUp: ["queued follow-up"],
			sendError: new Error("send failed"),
		});
		registerInterruptSteer(harness.pi);

		const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
		await advanceBy(120_000);
		await pending;

		assert.deepEqual(harness.sent, []);
		assert.equal(harness.editorText, "queued steering\n\nqueued follow-up\n\nkeep this prompt");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
	});
});

test("an unrelated user message before asynchronous send failure keeps the editor text", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({
			editorText: "keep this prompt",
			idle: true,
			unrelatedMessageText: "queued compaction message",
			sendError: new Error("send failed"),
		});
		registerInterruptSteer(harness.pi);

		const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
		await advanceBy(0);
		await advanceBy(60_000);
		await pending;

		assert.ok(harness.calls.indexOf("message_start") < harness.calls.indexOf("sendFailure"));
		assert.deepEqual(harness.sent, []);
		assert.equal(harness.editorText, "keep this prompt");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
	});
});

test("an unrelated user message is ignored until the matching message starts", async () => {
	for (const acceptanceContentType of ["string", "split-parts"]) {
		await withFakeClock(async ({ advanceBy }) => {
			const harness = createHarness({
				editorText: "matching prompt",
				idle: true,
				unrelatedMessageText: "queued compaction message",
				acceptanceContentType,
				acceptanceDelayMs: 10,
			});
			registerInterruptSteer(harness.pi);

			const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
			await advanceBy(0);
			assert.equal(harness.editorText, "matching prompt");
			assert.deepEqual(harness.notifications, []);

			await advanceBy(10);
			await pending;

			assert.deepEqual(harness.sent, [{ content: "matching prompt", options: undefined }]);
			assert.equal(harness.editorText, "");
			assert.deepEqual(harness.notifications, []);
		});
	}
});

test("a transformed prompt is sent but the editor text is kept with a warning", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({
			editorText: "original prompt",
			idle: true,
			acceptanceText: "transformed prompt",
		});
		registerInterruptSteer(harness.pi);
		const shortcut = harness.shortcuts.get("ctrl+alt+enter");

		const pending = shortcut.handler(harness.ctx);
		await advanceBy(0);
		const clearedBeforeTimeout = harness.editorText === "";
		await advanceBy(60_000);
		await pending;

		assert.deepEqual(harness.sent, [{ content: "transformed prompt", options: undefined }]);
		assert.equal(clearedBeforeTimeout, false);
		assert.equal(harness.editorText, "original prompt");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
		assert.match(harness.notifications[0].message, /has not started the message yet.*text was kept.*check the transcript before sending it again/i);
	});
});

test("a handled prompt without message_start keeps the editor text until the acceptance timeout", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({ editorText: "handled prompt", idle: true, handledPrompt: true });
		registerInterruptSteer(harness.pi);
		let finished = false;
		const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx).then(() => { finished = true; });

		await advanceBy(0);
		await advanceBy(59_999);
		const waitedForFullTimeout = !finished;
		if (waitedForFullTimeout) await advanceBy(1);
		await pending;

		assert.equal(waitedForFullTimeout, true);
		assert.deepEqual(harness.sent, []);
		assert.equal(harness.editorText, "handled prompt");
		assert.match(harness.notifications[0].message, /has not started the message yet.*text was kept.*check the transcript before sending it again/i);
	});
});

test("a user message accepted after five seconds still clears the submitted text", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({ editorText: "late prompt", idle: true, acceptanceDelayMs: 6_000 });
		registerInterruptSteer(harness.pi);

		const pending = harness.shortcuts.get("ctrl+alt+enter").handler(harness.ctx);
		await advanceBy(6_000);
		await pending;

		assert.deepEqual(harness.sent, [{ content: "late prompt", options: undefined }]);
		assert.equal(harness.editorText, "");
		assert.deepEqual(harness.notifications, []);
	});
});

test("a second press while Pi is accepting a prompt does not send it again", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({ editorText: "send once", idle: true, acceptanceDelayMs: 100 });
		registerInterruptSteer(harness.pi);
		const shortcut = harness.shortcuts.get("ctrl+alt+enter");

		const first = shortcut.handler(harness.ctx);
		const second = shortcut.handler(harness.ctx);
		await advanceBy(100);
		await Promise.all([first, second]);

		assert.equal(harness.calls.filter((call) => call === "sendUserMessage").length, 1);
		assert.equal(harness.editorText, "");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "info");
	});
});

test("a second press while waiting for the aborted run to become idle does not abort again", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({ editorText: "send once", acceptanceDelayMs: 0 });
		registerInterruptSteer(harness.pi);
		const shortcut = harness.shortcuts.get("ctrl+alt+enter");

		const first = shortcut.handler(harness.ctx);
		const second = shortcut.handler(harness.ctx);
		await advanceBy(100);
		await Promise.all([first, second]);

		assert.equal(harness.calls.filter((call) => call === "abort").length, 1);
		assert.equal(harness.calls.filter((call) => call === "sendUserMessage").length, 1);
		assert.equal(harness.editorText, "");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "info");
	});
});

test("a preflight failure keeps the editor text and releases the guard after timeout", async () => {
	await withFakeClock(async ({ advanceBy }) => {
		const harness = createHarness({ editorText: "keep after preflight failure", idle: true, preflightFailure: true });
		registerInterruptSteer(harness.pi);
		const shortcut = harness.shortcuts.get("ctrl+alt+enter");
		let finished = false;
		const pending = shortcut.handler(harness.ctx).then(() => { finished = true; });

		await advanceBy(0);
		await advanceBy(59_999);
		const waitedForFullTimeout = !finished;
		if (waitedForFullTimeout) await advanceBy(1);
		await pending;

		assert.equal(waitedForFullTimeout, true);
		assert.deepEqual(harness.sent, []);
		assert.equal(harness.editorText, "keep after preflight failure");
		assert.match(harness.notifications[0].message, /has not started the message yet.*text was kept.*check the transcript before sending it again/i);

		const retry = shortcut.handler(harness.ctx);
		assert.equal(harness.calls.filter((call) => call === "sendUserMessage").length, 2);
		await advanceBy(60_000);
		await retry;
	});
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
		harness.emit("session_start", {});
		harness.emit("session_start", {});
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "warning");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
