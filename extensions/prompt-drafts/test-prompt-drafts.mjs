import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerPromptDrafts from "./prompt-drafts.ts";

function createHarness({ editorText = "" } = {}) {
	const shortcuts = new Map();
	const commands = new Map();
	const events = new Map();
	const notifications = [];
	const calls = [];
	let currentText = editorText;

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(event, handler) {
			let handlers = events.get(event);
			if (!handlers) events.set(event, handlers = new Set());
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};

	const ctx = {
		hasUI: true,
		ui: {
			getEditorText() {
				calls.push(["getEditorText"]);
				return currentText;
			},
			setEditorText(text) {
				calls.push(["setEditorText", text]);
				currentText = text;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	const emit = (event, payload = { type: event }) => {
		for (const handler of events.get(event) ?? []) handler(payload, ctx);
	};
	const press = (key = "ctrl+s") => shortcuts.get(key)?.handler(ctx);
	const runCommand = (name, args = "") => commands.get(name)?.handler(args, ctx);
	const lastNotification = () => notifications.at(-1)?.message ?? "";
	const sendInput = (text) => emit("input", { type: "input", text, source: "interactive" });

	return { pi, ctx, shortcuts, commands, notifications, calls, emit, press, runCommand, sendInput, lastNotification, getEditorText: () => currentText, setEditorText: (text) => { currentText = text; } };
}

function withConfigFile(content, run) {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-drafts-"));
	const file = join(dir, "pi-prompt-drafts.json");
	if (content !== undefined) writeFileSync(file, JSON.stringify(content));
	try {
		return run({ agentDir: dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("default key is ctrl+s and saving clears the editor", async () => {
	const h = createHarness({ editorText: "hello world" });
	registerPromptDrafts(h.pi, {});
	assert.ok(h.shortcuts.has("ctrl+s"));

	await h.press();
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /draft saved/);
});

test("second press restores the saved draft manually", async () => {
	const h = createHarness({ editorText: "hello world" });
	registerPromptDrafts(h.pi, {});

	await h.press();
	await h.press();
	assert.equal(h.getEditorText(), "hello world");
	assert.match(h.lastNotification(), /draft restored/);

	// with the restored text back in the editor, the key saves again;
	// "no drafts" needs an empty editor
	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /no drafts/);
});

test("whitespace-only editor text is not saved", async () => {
	const h = createHarness({ editorText: "   \n  " });
	registerPromptDrafts(h.pi, {});

	await h.press();
	assert.equal(h.getEditorText(), "   \n  ");
	assert.match(h.lastNotification(), /no drafts/);
});

test("the drafts are a queue: restores hand back the oldest entry first", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("first");
	await h.press();
	h.setEditorText("second");
	await h.press();

	await h.press();
	assert.equal(h.getEditorText(), "first");
	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "second");
});

test("sending any prompt auto-restores the draft into the editor", async () => {
	const h = createHarness({ editorText: "draft" });
	registerPromptDrafts(h.pi, {});

	await h.press();
	h.sendInput("the next thing to do");
	assert.equal(h.getEditorText(), "draft");
	assert.match(h.lastNotification(), /draft restored/);
});

// pi clears the editor before the input event dispatches, so the restore
// lands in the editor it just cleared
test("the restore lands in the editor pi just cleared", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("draft");
	await h.press();
	h.setEditorText("");
	h.sendInput("the next thing to do");
	assert.equal(h.getEditorText(), "draft");
});

test("the draft is kept when the editor has unrelated new text at send time", async () => {
	const h = createHarness({ editorText: "draft" });
	registerPromptDrafts(h.pi, {});

	await h.press();
	h.setEditorText("something new");
	h.sendInput("the next thing to do");
	assert.equal(h.getEditorText(), "something new");
	assert.match(h.lastNotification(), /saved draft is waiting/);

	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "draft");
});

test("sending the saved draft verbatim drops it from the queue", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("ship it");
	await h.press();
	h.sendInput("ship it");

	assert.equal(h.getEditorText(), "");
	assert.doesNotMatch(h.lastNotification(), /restored/);

	// a different send still restores what is left
	h.setEditorText("again");
	await h.press();
	h.sendInput("something else");
	assert.equal(h.getEditorText(), "again");
});

test("an explicit config selection (/model, /thinking) restores the draft", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("draft");
	await h.press();
	h.emit("model_select", { type: "model_select", model: {}, previousModel: {}, source: "set" });
	assert.equal(h.getEditorText(), "draft");
	assert.match(h.lastNotification(), /draft restored/);

	// thinking_level_select has no source field; it always restores
	h.setEditorText("");
	h.setEditorText("second draft");
	await h.press();
	h.emit("thinking_level_select", { type: "thinking_level_select", level: "high", previousLevel: "medium" });
	assert.equal(h.getEditorText(), "second draft");
});

test("ctrl+p cycling and session restore do not surface the draft", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("draft");
	await h.press();
	h.emit("model_select", { type: "model_select", model: {}, previousModel: {}, source: "cycle" });
	h.emit("model_select", { type: "model_select", model: {}, previousModel: {}, source: "restore" });
	assert.equal(h.getEditorText(), "");

	// ...and the draft is intact for the next send
	h.sendInput("anything");
	assert.equal(h.getEditorText(), "draft");
});

test("a config selection with a busy editor skips the restore silently", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("draft");
	await h.press();
	h.setEditorText("typing something");
	h.emit("model_select", { type: "model_select", model: {}, previousModel: {}, source: "set" });
	assert.equal(h.getEditorText(), "typing something");
	assert.doesNotMatch(h.lastNotification(), /waiting|restored/);
});

test("/drafts restores and /drafts clear discards", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	await h.runCommand("drafts");
	assert.match(h.lastNotification(), /no drafts/);

	h.setEditorText("kept");
	await h.press();
	await h.runCommand("drafts", "clear");
	assert.match(h.lastNotification(), /discarded 1 draft/);

	await h.runCommand("drafts");
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /no drafts/);

	await h.runCommand("drafts", "bogus");
	assert.match(h.lastNotification(), /usage/);
});

test("/drafts itself never triggers a restore", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptDrafts(h.pi, {});

	h.setEditorText("kept");
	await h.press();
	await h.runCommand("drafts", "clear");
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /discarded 1 draft/);
});

test("key is configurable via the package config file", () => {
	const h = withConfigFile({ key: "ctrl+alt+p" }, (runtime) => {
		const harness = createHarness();
		registerPromptDrafts(harness.pi, runtime);
		return harness;
	});
	assert.ok(h.shortcuts.has("ctrl+alt+p"));
	assert.ok(!h.shortcuts.has("ctrl+s"));
});

test("an invalid configured key falls back to ctrl+s", () => {
	const h = withConfigFile({ key: "not-a-key" }, (runtime) => {
		const harness = createHarness();
		registerPromptDrafts(harness.pi, runtime);
		return harness;
	});
	assert.ok(h.shortcuts.has("ctrl+s"));
	// the fallback is announced once, on session_start
	h.emit("session_start", { type: "session_start" });
	assert.ok(h.notifications.some(({ message }) => /invalid key setting/.test(message)));
});

test("the environment variable wins over the config file", () => {
	const h = withConfigFile({ key: "ctrl+alt+p" }, (runtime) => {
		const harness = createHarness();
		registerPromptDrafts(harness.pi, { ...runtime, environment: { PI_PROMPT_DRAFTS_KEY: "ctrl+9" } });
		return harness;
	});
	assert.ok(h.shortcuts.has("ctrl+9"));
});
