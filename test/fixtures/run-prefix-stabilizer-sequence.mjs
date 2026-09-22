import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
const { default: activate } = await import(pathToFileURL(extensionPath).href);
const handlers = new Map();
const notifications = [];
activate({ on: (name, handler) => handlers.set(name, handler) });

const beforeProviderRequest = handlers.get("before_provider_request");
if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");

const context = {
	cwd: process.cwd(),
	isProjectTrusted: () => false,
	ui: { notify: (message) => notifications.push(message) },
};
const payloads = JSON.parse(process.env.PREFIX_STABILIZER_TEST_PAYLOADS ?? "[]").map(
	(payload) => beforeProviderRequest({ payload }, context) ?? payload,
);

process.stdout.write(JSON.stringify({ payloads, notifications }));
