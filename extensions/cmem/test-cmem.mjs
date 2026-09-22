import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import cmemExtension from "./cmem.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(packageRoot, "cmem.ts");

function harness() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const notifications = [];
	return {
		pi: {
			on(name, handler) {
				handlers.set(name, handler);
			},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand(name, command) {
				commands.set(name, command);
			},
			appendEntry() {},
		},
		handlers,
		tools,
		commands,
		notifications,
	};
}

function sessionFixture(settings, notifications = []) {
	const root = mkdtempSync(join(tmpdir(), "pi-cmem-test-"));
	const cwd = join(root, "project");
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "pi-cmem.json"), JSON.stringify(settings));
	return {
		root,
		context: {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "session-id" },
			ui: { notify: (message, level) => notifications.push({ message, level }) },
		},
	};
}

test("source owns the PI_CMEM namespace and credits its Apache upstream and neighbour", () => {
	const source = readFileSync(sourcePath, "utf8");
	const oldNamespace = ["PI", "MEM", ""].join("_");
	assert.equal(source.includes(oldNamespace), false);
	assert.match(source, /claude-mem \(Apache-2\.0\)/);
	assert.match(source, /@husniadil\/pi-mem/);
});

test("session start warns once without failing when the worker is unreachable", async () => {
	const notifications = [];
	const setup = sessionFixture({
		workerHost: "127.0.0.1",
		workerPort: 1,
		fallbackPath: join(tmpdir(), "missing-pi-cmem-fallback.py"),
	}, notifications);
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await assert.doesNotReject(() => runtime.handlers.get("session_start")({}, setup.context));
		assert.deepEqual(notifications, [
			{
				level: "warning",
				message:
					"pi-cmem: claude-mem worker unreachable at http://127.0.0.1:1; capture and context injection are unavailable, and recall has no fallback",
			},
		]);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("reachable worker emits no warning and recall uses the unprefixed project name", async () => {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(request.url);
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.end(request.url?.startsWith("/api/search") ? "remembered result" : "ok");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const notifications = [];
	const setup = sessionFixture({
		workerHost: "127.0.0.1",
		workerPort: address.port,
		project: "forest",
	}, notifications);
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		const result = await runtime.tools.get("memory_recall").execute(
			"tool-call",
			{ query: "prior work" },
			undefined,
		);
		assert.deepEqual(notifications, []);
		assert.equal(result.content[0].text, "remembered result");
		const searchRequest = requests.find((url) => url?.startsWith("/api/search"));
		assert.ok(searchRequest);
		assert.equal(new URL(searchRequest, "http://worker").searchParams.get("project"), "forest");
	} finally {
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("workerHost/workerPort are discovered from claude-mem's own settings when not explicitly set", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cmem-discovery-"));
	const claudeMemDir = join(root, "claude-mem");
	mkdirSync(claudeMemDir, { recursive: true });
	// claude-mem writes the port as a JSON string, not a number -- the whole reason
	// this bridge cannot just check `typeof === "number"`.
	writeFileSync(
		join(claudeMemDir, "settings.json"),
		JSON.stringify({ CLAUDE_MEM_WORKER_HOST: "127.0.0.1", CLAUDE_MEM_WORKER_PORT: "1" }),
	);

	const cwd = join(root, "project");
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	// Deliberately no pi-cmem.json: nothing overrides discovery for host/port.

	const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
	process.env.CLAUDE_MEM_DATA_DIR = claudeMemDir;
	const notifications = [];
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")(
			{},
			{
				cwd,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "session-id" },
				ui: { notify: (message, level) => notifications.push({ message, level }) },
			},
		);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /unreachable at http:\/\/127\.0\.0\.1:1\b/);
		assert.match(notifications[0].message, /host and port discovered from claude-mem's own settings/);
	} finally {
		if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
		else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("an explicit workerPort setting overrides discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cmem-discovery-override-"));
	const claudeMemDir = join(root, "claude-mem");
	mkdirSync(claudeMemDir, { recursive: true });
	writeFileSync(
		join(claudeMemDir, "settings.json"),
		JSON.stringify({ CLAUDE_MEM_WORKER_HOST: "127.0.0.1", CLAUDE_MEM_WORKER_PORT: "1" }),
	);

	const notifications = [];
	// workerPort: 2 in project settings must win over the discovered "1".
	const setup = sessionFixture({ workerHost: "127.0.0.1", workerPort: 2 }, notifications);

	const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
	process.env.CLAUDE_MEM_DATA_DIR = claudeMemDir;
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /unreachable at http:\/\/127\.0\.0\.1:2\b/);
		assert.doesNotMatch(notifications[0].message, /discovered/);
	} finally {
		if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
		else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
		rmSync(root, { recursive: true, force: true });
		rmSync(setup.root, { recursive: true, force: true });
	}
});
