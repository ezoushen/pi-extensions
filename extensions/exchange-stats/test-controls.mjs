import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { KEYBINDINGS } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { registerExchangeStats } from "./exchange-stats.ts";

initTheme("dark");
test("fold defaults do not collide with Pi 0.87.1 default keybindings", () => {
 const defaults = Object.values(KEYBINDINGS).flatMap(({ defaultKeys }) => Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys]);
 for (const key of ["ctrl+alt+f", "ctrl+alt+e", "ctrl+alt+s"]) assert.equal(defaults.includes(key), false, key);
});
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content: content.map((item) => ({ ...item })), stopReason: "stop" });
const toolItem = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });

function mount(settingsRuntime = {}) {
 const handlers = new Map();
 const shortcuts = new Map();
 const warnings = [];
 const statuses = [];
 let picker;
 registerExchangeStats({
  on(name, handler) { handlers.set(name, handler); },
  registerShortcut(key, options) { shortcuts.set(key, options.handler); },
  registerEntryRenderer() {}, appendEntry() {}, registerCommand() {},
 }, ToolExecutionComponent, settingsRuntime);
 const ctx = { hasUI: true, model: { id: "test" }, ui: {
  setStatus(key, value) { statuses.push([key, value]); }, notify(message) { warnings.push(message); },
  custom(factory) { picker = factory({ requestRender() { statuses.push(["render"]); } }, { fg(color, text) { assert.equal(color, "dim"); return `\x1b[2m${text}\x1b[0m`; } }, undefined, () => {}); return Promise.resolve(); },
 } };
 handlers.get("session_start")({}, ctx);
 return { handlers, shortcuts, warnings, statuses, ctx, picker: () => picker, close() { handlers.get("session_shutdown")(); } };
}
function feed(mounted, timestamp, content) {
 const message = snapshot(timestamp, content);
 mounted.handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta" } }, mounted.ctx);
 mounted.handlers.get("message_end")({ message: snapshot(timestamp, content) }, mounted.ctx);
}
const renderTool = (id) => new ToolExecutionComponent("bash", id, { command: id }, {}, undefined, { requestRender() {} }, ".");

test("latest process and exchange shortcuts toggle the intended fold states with one render each", () => {
 const m = mount();
 try {
  m.handlers.get("before_agent_start")({}, m.ctx);
  feed(m, 11, [toolItem("one"), { type: "text", text: "middle" }, toolItem("two"), { type: "text", text: "more" }, toolItem("three")]);
  const latest = renderTool("three");
  assert.match(latest.render(80).join("\n"), /▸/);
  let count = m.statuses.length;
  m.shortcuts.get("ctrl+alt+f")(m.ctx);
  assert.equal(m.statuses.length, count + 1);
  assert.match(latest.render(80).join("\n"), /▾.*⚙ bash.*three/s);
  m.shortcuts.get("ctrl+alt+f")(m.ctx);
  assert.match(latest.render(80).join("\n"), /▸/);
  m.shortcuts.get("ctrl+alt+f")(m.ctx);
  count = m.statuses.length;
  m.shortcuts.get("ctrl+alt+e")(m.ctx);
  assert.equal(m.statuses.length, count + 1);
  for (const id of ["one", "two", "three"]) assert.match(renderTool(id).render(80).join("\n"), /▾.*⚙ bash/s);
  m.shortcuts.get("ctrl+alt+e")(m.ctx);
  for (const id of ["one", "two", "three"]) assert.match(renderTool(id).render(80).join("\n"), /▸/);
 } finally { m.close(); }
});

test("picker toggles one older tool block and renders dim rows with an undimmed cursor", async () => {
 const m = mount();
 try {
  m.handlers.get("before_agent_start")({}, m.ctx);
  feed(m, 21, [toolItem("old-a"), toolItem("old-b")]);
  m.handlers.get("agent_settled")({}, m.ctx);
  m.handlers.get("before_agent_start")({}, m.ctx);
  feed(m, 22, [toolItem("new")]);
  await m.shortcuts.get("ctrl+alt+s")(m.ctx);
  const picker = m.picker();
  assert.match(picker.render(80)[0], /\x1b\[2m/);
  assert.match(picker.render(80)[1], /^>\x1b\[2m/);
  m.ctx.ui.theme = { fg(color, text) { assert.equal(color, "dim"); return `\x1b[38;2;90;90;90m${text}\x1b[0m`; } };
  assert.match(picker.render(80)[1], /^>\x1b\[38;2;90;90;90m/);
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  picker.handleInput("\x1b[B");
  const oldA = renderTool("old-a"), oldB = renderTool("old-b"), newer = renderTool("new");
  const before = [oldA, oldB, newer].map((component) => component.render(80).join("\n"));
  const count = m.statuses.length;
  picker.handleInput("\r");
  assert.equal(m.statuses.length, count + 1);
  assert.notEqual(oldA.render(80).join("\n"), before[0]);
  assert.deepEqual([oldB, newer].map((component) => component.render(80).join("\n")), before.slice(1));
 } finally { m.close(); }
});

test("settings override a default key and malformed value warns once", () => {
 const dir = mkdtempSync(join(tmpdir(), "pi-fold-keys-"));
 try {
  writeFileSync(join(dir, "exchange-stats.json"), JSON.stringify({ processKey: "ctrl+alt+x", exchangeKey: 7 }));
  const m = mount({ agentDir: dir, environment: {} });
  try {
   assert.equal(m.shortcuts.has("ctrl+alt+x"), true);
   assert.equal(m.shortcuts.has("ctrl+alt+f"), false);
   assert.equal(m.shortcuts.has("ctrl+alt+e"), true);
   assert.equal(m.warnings.length, 1);
   m.handlers.get("session_start")({}, m.ctx);
   assert.equal(m.warnings.length, 1);
  } finally { m.close(); }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fullscreen mouse dispatch toggles a process line and a block title once", () => {
 const m = mount();
 let renders = 0;
 try {
  m.handlers.get("before_agent_start")({}, m.ctx);
  feed(m, 31, [{ type: "thinking", thinking: "checking" }, toolItem("click")]);
  const assistant = new AssistantMessageComponent();
  assistant.updateContent(snapshot(31, [{ type: "thinking", thinking: "checking" }, toolItem("click")]), false);
  const region = assistant.contentContainer.children.find((child) => child.constructor.name === "MouseRegion");
  assert.ok(region);
  const click = (y) => ({ type: "click", button: "left", x: 0, y, width: 80, height: 2, screenX: 0, screenY: y, shift: false, alt: false, ctrl: false });
  region.render(80);
  const count = m.statuses.length;
  assert.equal(region.handleMouse(click(0)).handled, true);
  assert.equal(m.statuses.length, count + 1);
  assert.match(assistant.render(80).join("\n"), /▾.*Thinking/s);
  const tool = new ToolExecutionComponent("bash", "click", { command: "click" }, {}, undefined, { requestRender() { renders++; } }, ".");
  const before = tool.render(80).join("\n");
  assert.match(before, /⚙ bash/);
  assert.equal(tool.handleMouse(click(0)).handled, true);
  assert.equal(renders, 1);
  assert.notEqual(tool.render(80).join("\n"), before);
 } finally { m.close(); }
});
