/**
 * Handler-level tests: drive the real session_before_compact handler with a fake
 * pi/ctx. Both bugs found in review lived here, not in the payload builder.
 */
import ext, { inputTokensAreFree, isTransient, computeFileLists, formatFileOperations } from "./compaction-cache.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never read the developer's real pi agent directory. Settings resolve from
// <agentDir>/compaction-cache.json, so an unisolated suite passes or fails depending
// on what happens to be in $HOME. Set before any test resolves a setting.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-compaction-cache-test-agent-"));

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log("  PASS", n); } else { fail++; console.log("  FAIL", n, e); } };

const CONVO = "Refactor the token bucket in src/rate_limit.rs and keep burst behaviour identical. ".repeat(3);
const FREE = { id: "test-model", provider: "test-provider", maxTokens: 32768, contextWindow: 262144,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function livePayload() {
  return { model: "test-model", stream: true, max_tokens: 32768,
           tools: [{ type: "function", function: { name: "read" } }],
           messages: [ { role: "system", content: "You are Pi." },
                       { role: "user", content: CONVO },
                       { role: "assistant", content: "I read src/rate_limit.rs" } ] };
}

function preparation(over = {}) {
  return { firstKeptEntryId: "entry-9", tokensBefore: 1234, messagesToSummarize: [
             { role: "user", content: [{ type: "text", text: CONVO }] } ],
           turnPrefixMessages: [], isSplitTurn: false,
           fileOps: { read: new Set(["a.ts", "b.ts"]), edited: new Set(["b.ts"]), written: new Set() },
           settings: { reserveTokens: 16384 }, ...over };
}

/** Wire the extension up and return its handlers. */
function mount() {
  const handlers = {};
  ext({ on: (name, fn) => { (handlers[name] ||= []).push(fn); } });
  return {
    request: (p) => handlers["before_provider_request"][0]({ payload: p }),
    compact: (ev, ctx) => handlers["session_before_compact"][0](ev, ctx),
    compacted: (ev, ctx) => handlers["session_compact"][0](ev, ctx),
  };
}

/** A modelRegistry whose complete() invokes onPayload like the real provider. */
function registry({ content = [{ type: "text", text: "## Goal\nship it" }], stopReason = "stop",
                    callOnPayload = true, throwTimes = 0, error = new Error("terminated") } = {}) {
  const state = { payloads: [], calls: 0 };
  return { state, modelRegistry: { complete: async (_m, _c, opts) => {
    state.calls++;
    if (state.calls <= throwTimes) throw error;
    if (callOnPayload) { const p = await opts.onPayload({ model: "test-model", max_tokens: 13107 }); state.payloads.push(p); }
    return { content, stopReason, usage: { input: 1, output: 2 } };
  } } };
}

const notices = [];
const ctxWith = (reg, model = FREE) => ({ model, modelRegistry: reg.modelRegistry,
  ui: { notify: (m, l) => notices.push([l, m]) } });
const evt = (over = {}) => ({ preparation: preparation(), reason: "manual", signal: undefined, ...over });

console.log("1. happy path returns a compaction Pi can persist");
{
  const m = mount(); m.request(livePayload());
  const reg = registry();
  const r = await m.compact(evt(), ctxWith(reg));
  check("returns a compaction", !!r?.compaction);
  check("summary present", r.compaction.summary.startsWith("## Goal"));
  check("file blocks appended", r.compaction.summary.includes("<read-files>\na.ts\n</read-files>"));
  check("modified files exclude re-reads", r.compaction.summary.includes("<modified-files>\nb.ts\n</modified-files>"));
  check("firstKeptEntryId passed through", r.compaction.firstKeptEntryId === "entry-9");
  check("tokensBefore passed through", r.compaction.tokensBefore === 1234);
  check("details carried", r.compaction.details.modifiedFiles.join() === "b.ts");
  const sent = reg.state.payloads[0];
  check("rewrite went on the wire", Array.isArray(sent?.messages) && sent.messages.length === 4);
  check("wire payload kept live tools", sent.tools.length === 1);
  check("wire payload took max_tokens from Pi", sent.max_tokens === 13107);
  check("instruction carries a word budget", String(sent.messages[3].content).includes("under 1500 words"));
}

console.log("2. defers when the rewrite cannot be applied (previous summary would be lost)");
{
  const m = mount();
  // No completed assistant turn: mid tool-loop.
  m.request({ ...livePayload(), messages: [ { role: "system", content: "s" }, { role: "user", content: CONVO } ] });
  const reg = registry();
  const r = await m.compact(evt({ preparation: preparation({ previousSummary: "earlier summary" }) }), ctxWith(reg));
  check("returns undefined", r === undefined);
  check("no call was spent", reg.state.calls === 0);
}

console.log("3. defers when onPayload never fires (payload lacked the previous summary)");
{
  const m = mount(); m.request(livePayload());
  const reg = registry({ callOnPayload: false });
  const r = await m.compact(evt(), ctxWith(reg));
  check("returns undefined", r === undefined);
}

console.log("4. defers on a metered model (cost regression guard)");
{
  const m = mount(); m.request(livePayload());
  const reg = registry();
  const paid = { ...FREE, provider: "anthropic", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  const r = await m.compact(evt(), ctxWith(reg, paid));
  check("returns undefined", r === undefined);
  check("no call was spent", reg.state.calls === 0);
}

console.log("5. defers when the model calls a tool, or truncates, or returns nothing");
for (const [name, opts] of [["tool call", { content: [{ type: "toolCall", name: "read" }] }],
                            ["length stop", { stopReason: "length" }],
                            ["empty text", { content: [{ type: "text", text: "  " }] }]]) {
  const m = mount(); m.request(livePayload());
  const r = await m.compact(evt(), ctxWith(registry(opts)));
  check(name, r === undefined);
}

console.log("6. retries a dropped stream exactly once, then succeeds");
{
  const m = mount(); m.request(livePayload());
  const reg = registry({ throwTimes: 1 });
  const r = await m.compact(evt(), ctxWith(reg));
  check("returns a compaction", !!r?.compaction);
  check("called twice", reg.state.calls === 2);
}

console.log("7. a non-transient error is not retried and defers");
{
  const m = mount(); m.request(livePayload());
  const reg = registry({ throwTimes: 5, error: new Error("400 invalid schema") });
  const r = await m.compact(evt(), ctxWith(reg));
  check("returns undefined", r === undefined);
  check("called once", reg.state.calls === 1);
}

console.log("8. defers when no live request was seen, or the conversation differs");
{
  const m = mount();
  check("no live request", (await m.compact(evt(), ctxWith(registry()))) === undefined);
  const m2 = mount();
  m2.request({ ...livePayload(), messages: [ { role: "system", content: "s" },
      { role: "user", content: "totally unrelated sub-agent work about YAML frontmatter parsing xx" },
      { role: "assistant", content: "ok" } ] });
  check("conversation mismatch", (await m2.compact(evt(), ctxWith(registry()))) === undefined);
}

console.log("9. losing the handler race disables the extension and warns once");
{
  const m = mount(); m.request(livePayload());
  const ctx = ctxWith(registry());
  const first = await m.compact(evt(), ctx);
  check("first compaction produced a result", !!first?.compaction);
  notices.length = 0;
  m.compacted({ fromExtension: false, reason: "manual" }, ctx);   // Pi used someone else's
  check("warned the user once", notices.length === 1 && notices[0][0] === "warning");
  const reg2 = registry();
  const second = await m.compact(evt(), ctxWith(reg2));
  check("subsequent compactions defer", second === undefined);
  check("no further calls spent", reg2.state.calls === 0);
}

console.log("10. pure helpers");
check("free model accepted", inputTokensAreFree(FREE));
check("metered model rejected", !inputTokensAreFree({ cost: { input: 3, cacheRead: 0 } }));
check("missing cost rejected", !inputTokensAreFree({}));
check("terminated is transient", isTransient(new Error("terminated")));
check("abort is not transient", isTransient(Object.assign(new Error("x"), { name: "AbortError" })) === false);
check("400 is not transient", !isTransient(new Error("400 bad request")));
check("read excludes modified", computeFileLists({ read: new Set(["a", "b"]), edited: new Set(["b"]), written: new Set() }).readFiles.join() === "a");
check("empty file ops render nothing", formatFileOperations([], []) === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
