import { buildRewrittenPayload, summaryBoundaryIndex, completedAssistantAt } from "./compaction-cache.ts";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log("  PASS", n); } else { fail++; console.log("  FAIL", n, e); } };

const live = {
  model: "test-model",
  stream: true,
  temperature: 1,
  max_tokens: 32768,
  prompt_cache_key: "session-abc",
  chat_template_kwargs: { enable_thinking: true },
  tools: [{ type: "function", function: { name: "read_file" } }],
  messages: [
    { role: "system", content: "You are Pi, a coding agent." },
    { role: "user", content: [{ type: "text", text: "refactor the token bucket" }] },
    { role: "assistant", content: [{ type: "text", text: "I read src/rate_limit.rs" }] },
  ],
};

// What Pi's summarization options would have produced.
const params = { model: "test-model", stream: true, temperature: 0.3, max_tokens: 13107,
                 messages: [{ role: "system", content: "You are a context summarization assistant." }] };

const INSTR = "You are a context summarization assistant.\n\nThe messages above are a conversation to summarize.\n\nDo not call any tool.";

console.log("1. prefix-preserving rewrite");
const out = buildRewrittenPayload(live, params, INSTR);
check("returns a payload", !!out);
check("live messages passed through by reference (byte-identical prefix)",
  out.messages[0] === live.messages[0] && out.messages[1] === live.messages[1] && out.messages[2] === live.messages[2]);
check("appends exactly one turn", out.messages.length === live.messages.length + 1);
const last = out.messages[out.messages.length - 1];
check("appended turn is a user turn", last.role === "user");
check("appended turn mirrors live content shape (array parts)", Array.isArray(last.content));
check("instruction carried verbatim", last.content[0].text === INSTR);
check("tools preserved from live", out.tools === live.tools);
check("prompt-shaping kwargs from LIVE", out.chat_template_kwargs.enable_thinking === true);
check("generation max_tokens from summarization params", out.max_tokens === 13107);
check("generation temperature from summarization params", out.temperature === 0.3);
check("model comes from Pi's request, not the cached live one",
  buildRewrittenPayload({ ...live, model: "an-older-model" }, params, INSTR).model === "test-model");
check("does not mutate the live payload", live.messages.length === 3 && live.max_tokens === 32768);

console.log("2. generation fields absent from params are dropped, not inherited from live");
const out2 = buildRewrittenPayload(live, { max_tokens: 100 }, INSTR);
check("stream dropped", !("stream" in out2));
check("temperature dropped", !("temperature" in out2));
check("max_tokens applied", out2.max_tokens === 100);

console.log("3. string-content conversations get a string-content instruction");
const liveStr = { ...live, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello there" }, { role: "assistant", content: "hi" }] };
const out3 = buildRewrittenPayload(liveStr, params, INSTR);
check("string content", typeof out3.messages[out3.messages.length - 1].content === "string");

console.log("4. trailing unanswered turn is dropped (it would hijack the instruction)");
const pending = { ...live, messages: [
  { role: "system", content: "sys" },
  { role: "user", content: "refactor the token bucket" },
  { role: "assistant", content: "done" },
  { role: "user", content: "Reply with exactly: OK. Do not use any tools." },
] };
const out4 = buildRewrittenPayload(pending, params, INSTR);
check("pending user turn removed", out4.messages.length === 4);
check("ends with the instruction", out4.messages[3].content === INSTR || out4.messages[3].content?.[0]?.text === INSTR);
check("last conversation turn is the assistant", out4.messages[2].role === "assistant");

console.log("5. an assistant turn awaiting tool results is not left dangling");
const midtool = { ...live, messages: [
  { role: "system", content: "sys" },
  { role: "user", content: "read the file" },
  { role: "assistant", content: "sure" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read" } }] },
  { role: "tool", tool_call_id: "c1", content: "file body" },
] };
const out5 = buildRewrittenPayload(midtool, params, INSTR);
check("cuts before the tool-calling assistant", out5.messages.length === 4);
check("no dangling tool_calls", !out5.messages.some(m => m.tool_calls));

console.log("6. a conversation with no completed assistant turn is refused");
check("undefined", buildRewrittenPayload({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }, params, INSTR) === undefined);

console.log("7. empty live payload is refused");
check("undefined", buildRewrittenPayload({ messages: [] }, params, INSTR) === undefined);
check("undefined when no messages", buildRewrittenPayload({}, params, INSTR) === undefined);

console.log("8. boundary cut sends only what Pi wants summarized");
const OLD1 = "First old turn about the token bucket refill deficit in rate_limit.rs ".repeat(2);
const OLD2 = "Second old turn about the burst window and the leaky bucket variant ".repeat(2);
const TAIL = "Recent tail turn that compaction keeps verbatim and must not be summarized ".repeat(2);
const convo = {
  model: "test-model", tools: [{ type: "function", function: { name: "read" } }],
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: OLD1 },
    { role: "assistant", content: "handled first" },
    { role: "user", content: OLD2 },
    { role: "assistant", content: "handled second" },   // <- boundary lands here
    { role: "user", content: TAIL },
    { role: "assistant", content: "handled tail" },
  ],
};
const summarizedMsgs = [ { role: "user", content: [{ type: "text", text: OLD1 }] },
                         { role: "user", content: [{ type: "text", text: OLD2 }] } ];
const b = summaryBoundaryIndex(convo.messages, summarizedMsgs);
check("boundary located at the last summarized message", b === 3, `got ${b}`);
const cut = buildRewrittenPayload(convo, params, INSTR, b);
check("stops after the boundary's assistant turn", cut.messages.length === 5 + 1, `got ${cut.messages.length}`);
check("keeps everything Pi will discard", cut.messages.some(m => String(JSON.stringify(m.content)).includes("Second old turn")));
check("drops the tail Pi keeps verbatim", !cut.messages.some(m => String(JSON.stringify(m.content)).includes("Recent tail turn")));
check("still a strict prefix of the live payload",
  cut.messages.slice(0, 5).every((m, i) => m === convo.messages[i]));

console.log("9. cut never moves backwards past the boundary");
const midtool2 = { ...convo, messages: [
  { role: "system", content: "sys" },
  { role: "user", content: OLD1 },
  { role: "assistant", content: "plain" },                                        // 2
  { role: "user", content: OLD2 },                                                // 3 <- boundary
  { role: "assistant", content: null, tool_calls: [{ id: "c", function: {} }] },  // 4
  { role: "tool", tool_call_id: "c", content: "result" },                         // 5
  { role: "assistant", content: "after the tool" },                               // 6
] };
const cut2 = buildRewrittenPayload(midtool2, params, INSTR, 3);
check("scans forward to index 6, not back to 2", cut2.messages.length === 7 + 1, `got ${cut2.messages.length}`);
check("summarized material retained", cut2.messages.some(m => String(JSON.stringify(m.content)).includes("Second old turn")));
check("no dangling tool_calls", cut2.messages.filter(m => m.tool_calls).length === 1 && cut2.messages.some(m => m.role === "tool"));

console.log("10. undetectable boundary falls back to the whole conversation");
check("boundary -1 on no match", summaryBoundaryIndex(convo.messages, [{ role: "user", content: [{ type: "text", text: "nothing like this exists anywhere xx" }] }]) === -1);
check("cutFrom -1 keeps old behaviour", buildRewrittenPayload(convo, params, INSTR, -1).messages.length === 7 + 1);
check("completedAssistantAt skips tool-calling turns", completedAssistantAt(midtool2.messages, 4) === 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
