import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
const { default: activate } = await import(pathToFileURL(extensionPath).href);
const handlers = new Map();
activate({ on: (name, handler) => handlers.set(name, handler) });

const contextWithSystem = handlers.get("context_with_system");
if (!contextWithSystem) throw new Error("context_with_system handler was not registered");

const messages = JSON.parse(process.env.PREFIX_STABILIZER_TEST_MESSAGES ?? "[]");
const result = await contextWithSystem({ type: "context_with_system", messages }, {});
process.stdout.write(JSON.stringify({ messages: result?.messages ?? messages, replaced: Boolean(result?.messages) }));
