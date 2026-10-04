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

// Optional session_start carrying pre-recorded pi-prefix-stabilizer custom
// entries, fed through the same restore() handler the extension registers on
// session_start/tree, so before_provider_request sees the droppedRemovals it
// would after a resume. Lets a test assert that removals already known are
// stripped before fingerprinting.
const recordedStart = process.env.PREFIX_STABILIZER_TEST_SESSION_START;
if (recordedStart) {
	const startHandler = handlers.get("session_start");
	if (startHandler)
		await startHandler(
			{},
			{ sessionManager: { getEntries: () => JSON.parse(recordedStart) } },
		);
}

const payloads = JSON.parse(process.env.PREFIX_STABILIZER_TEST_PAYLOADS ?? "[]").map(
	(payload) => beforeProviderRequest({ payload }, context) ?? payload,
);

process.stdout.write(JSON.stringify({ payloads, notifications }));
