import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { KEYBINDINGS } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { registerExchangeStats } from "./exchange-stats.ts";

initTheme("dark");
const item = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
const snapshot = (content) => ({ role: "assistant", timestamp: 81, content: content.map((part) => ({ ...part })), stopReason: "stop" });

function mount(value) {
 const dir = mkdtempSync(join(tmpdir(), "pi-cursor-"));
 if (value !== undefined) writeFileSync(join(dir, "exchange-stats.json"), JSON.stringify(value));
 const handlers = new Map(), shortcuts = new Map(), statuses = [];
 const editor = { focused: true, input: "", handleInput(char) { this.input += char; } };
 let cursor;
 registerExchangeStats({
  on(name, handler) { handlers.set(name, handler); },
  registerShortcut(key, options) { shortcuts.set(key, options.handler); },
  registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
 }, ToolExecutionComponent, { agentDir: dir, environment: {} });
 const ctx = { hasUI: true, ui: {
  theme: { fg(color, text) { return `\x1b[${color === "accent" ? "35" : "2"}m${text}\x1b[0m`; } },
  setStatus(_key, value) { statuses.push(value); }, notify() {},
  custom(factory) { editor.focused = false; return new Promise((resolve) => { cursor = factory({ requestRender() {} }, ctx.ui.theme, undefined, () => { editor.focused = true; cursor = undefined; resolve(); }); }); },
 } };
 handlers.get("session_start")({}, ctx);
 return { dir, handlers, shortcuts, statuses, editor, ctx, cursor: () => cursor, close() { handlers.get("session_shutdown")(); rmSync(dir, { recursive: true, force: true }); } };
}

test("cursor shortcut is absent by default and its default does not collide with Pi", () => {
 const defaults = Object.values(KEYBINDINGS).flatMap(({ defaultKeys }) => Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys]);
 assert.equal(defaults.includes("ctrl+alt+g"), false);
 const mounted = mount();
 try { assert.equal(mounted.shortcuts.has("ctrl+alt+g"), false); } finally { mounted.close(); }
});

test("cursor moves through transcript process lines, toggles the third and returns focus on Escape", async () => {
 const m = mount({ cursorMode: true });
 try {
  m.handlers.get("before_agent_start")({}, m.ctx);
  const content = [item("first"), { type: "text", text: "between" }, item("second"), { type: "text", text: "between" }, item("third")];
  m.handlers.get("message_update")({ message: snapshot(content), assistantMessageEvent: { type: "text_delta" } }, m.ctx);
  const active = m.shortcuts.get("ctrl+alt+g")(m.ctx);
  const cursor = m.cursor();
  cursor.handleInput("\x1b[B");
  cursor.handleInput("\x1b[B");
  const rows = ["first", "second", "third"].map((id) => new ToolExecutionComponent("bash", id, { command: id }, {}, undefined, { requestRender() {} }, ".").render(80).join("\n"));
  assert.equal(rows.filter((row) => row.includes("\x1b[35m")).length, 1);
  assert.match(m.statuses.at(-1), /Cursor.*third/);
  cursor.handleInput("\r");
  assert.match(new ToolExecutionComponent("bash", "third", { command: "third" }, {}, undefined, { requestRender() {} }, ".").render(80).join("\n"), /▾/);
  cursor.handleInput("\x1b");
  await active;
  assert.equal(m.editor.focused, true);
  m.editor.handleInput("z");
  assert.equal(m.editor.input, "z");
 } finally { m.close(); }
});

test("cursor moves from an open process line to its block title", async () => {
 const m = mount({ cursorMode: true });
 try {
  m.handlers.get("before_agent_start")({}, m.ctx);
  m.handlers.get("message_update")({ message: snapshot([item("first"), item("second")]), assistantMessageEvent: { type: "text_delta" } }, m.ctx);
  m.shortcuts.get("ctrl+alt+f")(m.ctx);
  const active = m.shortcuts.get("ctrl+alt+g")(m.ctx), cursor = m.cursor();
  cursor.handleInput("\x1b[B");
  const first = () => new ToolExecutionComponent("bash", "first", { command: "first" }, {}, undefined, { requestRender() {} }, ".").render(80).join("\n");
  const second = () => new ToolExecutionComponent("bash", "second", { command: "second" }, {}, undefined, { requestRender() {} }, ".").render(80).join("\n");
  assert.equal([first(), second()].filter((row) => row.includes("\x1b[35m")).length, 1);
  assert.match(first(), /\x1b\[35m⚙ bash/);
  cursor.handleInput("\r");
  assert.match(first(), /"command": "first"/);
  cursor.handleInput("\x1b");
  await active;
 } finally { m.close(); }
});
