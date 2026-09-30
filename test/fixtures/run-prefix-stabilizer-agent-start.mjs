import { pathToFileURL } from "node:url";

// Mirrors pi 0.99's before_agent_start contract (core/extensions/runner.js):
// handlers share one mutable systemPromptOptions, a returned systemPrompt is
// stored as forceSystemPrompt, and event.systemPrompt renders the forced text
// when one is set, otherwise the structured sections joined by blank lines.
const extensionPath = process.argv[2];
const { default: activate } = await import(pathToFileURL(extensionPath).href);
const handlers = new Map();
activate({ on: (name, handler) => handlers.set(name, handler) });

const beforeAgentStart = handlers.get("before_agent_start");
if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

const { sections, forced } = JSON.parse(process.env.PREFIX_STABILIZER_TEST_AGENT_START);
const options = { sections, forceSystemPrompt: forced };
const event = {
	type: "before_agent_start",
	prompt: "run the build",
	get systemPrompt() {
		return options.forceSystemPrompt ?? Object.values(options.sections).join("\n\n");
	},
	systemPromptOptions: options,
};
const result = await beforeAgentStart(event, { cwd: process.cwd(), isProjectTrusted: () => false });
if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;

process.stdout.write(JSON.stringify({ forced: options.forceSystemPrompt ?? null }));
