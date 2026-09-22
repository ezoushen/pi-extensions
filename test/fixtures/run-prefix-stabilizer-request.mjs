import { pathToFileURL } from "node:url";

const extensionPath = process.argv[2];
const { default: activate } = await import(pathToFileURL(extensionPath).href);
const handlers = new Map();
activate({ on: (name, handler) => handlers.set(name, handler) });

const beforeProviderRequest = handlers.get("before_provider_request");
if (!beforeProviderRequest) throw new Error("before_provider_request handler was not registered");

const result = beforeProviderRequest(
	{
		payload: {
			system:
				process.env.PREFIX_STABILIZER_TEST_SYSTEM ??
				"Pi docs: /volatile/node_modules/@earendil-works/pi-coding-agent/docs",
		},
	},
	{
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: { notify() {} },
	},
);

process.stdout.write(JSON.stringify(result ?? null));
