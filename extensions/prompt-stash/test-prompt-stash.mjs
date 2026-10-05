import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerPromptStash from "./prompt-stash.ts";

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

	return { pi, ctx, shortcuts, commands, notifications, calls, emit, press, runCommand, lastNotification, getEditorText: () => currentText, setEditorText: (text) => { currentText = text; } };
}

function withConfigFile(content, run) {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-stash-"));
	const file = join(dir, "pi-prompt-stash.json");
	if (content !== undefined) writeFileSync(file, JSON.stringify(content));
	try {
		return run({ agentDir: dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("default key is ctrl+s and stashing clears the editor", async () => {
	const h = createHarness({ editorText: "hello world" });
	registerPromptStash(h.pi, {});
	assert.ok(h.shortcuts.has("ctrl+s"));

	await h.press();
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /prompt stashed/);
});

test("second press restores the stashed prompt manually", async () => {
	const h = createHarness({ editorText: "hello world" });
	registerPromptStash(h.pi, {});

	await h.press();
	await h.press();
	assert.equal(h.getEditorText(), "hello world");
	assert.match(h.lastNotification(), /prompt restored/);

	// with the restored text back in the editor, the key stashes again;
	// "nothing stashed" needs an empty editor
	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /nothing stashed/);
});

test("whitespace-only editor text does not stash", async () => {
	const h = createHarness({ editorText: "   \n  " });
	registerPromptStash(h.pi, {});

	await h.press();
	assert.equal(h.getEditorText(), "   \n  ");
	assert.match(h.lastNotification(), /nothing stashed/);
});

test("stash stacks and pops most-recent first", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptStash(h.pi, {});

	h.setEditorText("first");
	await h.press();
	h.setEditorText("second");
	await h.press();

	await h.press();
	assert.equal(h.getEditorText(), "second");
	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "first");
});

test("agent_end auto-restores when the editor is empty", async () => {
	const h = createHarness({ editorText: "draft" });
	registerPromptStash(h.pi, {});

	await h.press();
	h.emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(h.getEditorText(), "draft");
	assert.match(h.lastNotification(), /stashed prompt restored/);
});

test("agent_end keeps the stash when the editor has new text", async () => {
	const h = createHarness({ editorText: "draft" });
	registerPromptStash(h.pi, {});

	await h.press();
	h.setEditorText("something new");
	h.emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(h.getEditorText(), "something new");
	assert.match(h.lastNotification(), /stashed prompt is waiting/);

	h.setEditorText("");
	await h.press();
	assert.equal(h.getEditorText(), "draft");
});

test("sending the stashed text verbatim drops it from the stash", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptStash(h.pi, {});

	h.setEditorText("ship it");
	await h.press();
	h.emit("message_start", {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text: "ship it" }], timestamp: 0 },
	});
	h.emit("agent_end", { type: "agent_end", messages: [] });

	assert.equal(h.getEditorText(), "");
	assert.doesNotMatch(h.lastNotification(), /restored/);

	// assistant messages and different text leave the stash alone
	h.setEditorText("again");
	await h.press();
	h.emit("message_start", {
		type: "message_start",
		message: { role: "assistant", content: "again", timestamp: 0 },
	});
	h.emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(h.getEditorText(), "again");
});

test("/stash restores and /stash clear discards", async () => {
	const h = createHarness({ editorText: "" });
	registerPromptStash(h.pi, {});

	await h.runCommand("stash");
	assert.match(h.lastNotification(), /nothing stashed/);

	h.setEditorText("kept");
	await h.press();
	await h.runCommand("stash", "clear");
	assert.match(h.lastNotification(), /discarded 1 stashed prompt/);

	await h.runCommand("stash");
	assert.equal(h.getEditorText(), "");
	assert.match(h.lastNotification(), /nothing stashed/);

	await h.runCommand("stash", "bogus");
	assert.match(h.lastNotification(), /usage/);
});

test("key is configurable via the package config file", () => {
	const h = withConfigFile({ key: "ctrl+alt+p" }, (runtime) => {
		const harness = createHarness();
		registerPromptStash(harness.pi, runtime);
		return harness;
	});
	assert.ok(h.shortcuts.has("ctrl+alt+p"));
	assert.ok(!h.shortcuts.has("ctrl+s"));
});

test("an invalid configured key falls back to ctrl+s", () => {
	const h = withConfigFile({ key: "not-a-key" }, (runtime) => {
		const harness = createHarness();
		registerPromptStash(harness.pi, runtime);
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
		registerPromptStash(harness.pi, { ...runtime, environment: { PI_PROMPT_STASH_KEY: "ctrl+9" } });
		return harness;
	});
	assert.ok(h.shortcuts.has("ctrl+9"));
});
