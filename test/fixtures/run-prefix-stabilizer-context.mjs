// Drives the stabilizer's run-tracking handlers with a scripted event sequence:
// PREFIX_STABILIZER_TEST_STEPS is a list of
//   { on: "session_start", branch } | { on: "before_agent_start", prompt? } | { on: "agent_start" }
//   | { on: "context", messages } | { on: "agent_end" }
// and the output holds the messages each "context" step would send plus every appendEntry.
import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
const { default: activate } = await import(pathToFileURL(extensionPath).href);
const handlers = new Map();
const entries = [];
activate({
	on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	appendEntry: (customType, data) => entries.push({ customType, data }),
});
if (!handlers.has("context_with_system")) throw new Error("context_with_system handler was not registered");

const contexts = [];
for (const step of JSON.parse(process.env.PREFIX_STABILIZER_TEST_STEPS ?? "[]")) {
	const ctx = { sessionManager: { getBranch: () => step.branch ?? [] } };
	if (step.on === "context") {
		let result;
		for (const handler of handlers.get("context_with_system")) result = await handler({ type: "context_with_system", messages: step.messages }, ctx);
		contexts.push({ messages: result?.messages ?? step.messages, replaced: Boolean(result?.messages), entriesSoFar: entries.length });
		continue;
	}
	const event =
		step.on === "before_agent_start"
			? { type: step.on, prompt: step.prompt ?? "typed", systemPrompt: "", systemPromptOptions: { sections: {} } }
			: { type: step.on, reason: "startup" };
	for (const handler of handlers.get(step.on) ?? []) await handler(event, ctx);
}
process.stdout.write(JSON.stringify({ contexts, entries }));
