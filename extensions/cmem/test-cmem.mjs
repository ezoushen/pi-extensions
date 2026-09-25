import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import cmemExtension from "./cmem.ts";

// Never read the developer's real pi agent directory. Settings resolve from
// <agentDir>/pi-cmem.json, so an unisolated suite passes or fails depending on
// what happens to be in $HOME. Set before any test resolves a setting.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-cmem-test-agent-"));

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

test("memory-status reports effective setting provenance and session activity", async () => {
	const envNames = [
		"PI_CMEM_DISABLED",
		"PI_CMEM_CAPTURE",
		"PI_CMEM_INJECT",
		"PI_CMEM_WORKER_HOST",
		"PI_CMEM_WORKER_PORT",
		"PI_CMEM_PROJECT",
		"PI_CMEM_FALLBACK_PATH",
		"CLAUDE_MEM_DATA_DIR",
	];
	const previousEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];

	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir);
	const globalSettingsPath = join(agentDir, "pi-cmem.json");
	const globalSettings = { capture: true };
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(globalSettingsPath, JSON.stringify(globalSettings));

	const root = mkdtempSync(join(tmpdir(), "pi-cmem-status-"));
	const claudeMemDir = join(root, "claude-mem");
	mkdirSync(claudeMemDir, { recursive: true });
	const fallbackPath = join(root, "fallback.py");
	const notifications = [];
	const setup = sessionFixture({ inject: true, project: "forest" }, notifications);
	const observations = [];
	let resolveObservation;
	const observationReceived = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for observation")), 2_000);
		resolveObservation = () => {
			clearTimeout(timeout);
			resolve();
		};
	});
	const server = createServer(async (request, response) => {
		if (request.url === "/api/health") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test-worker" }));
			return;
		}
		if (request.url?.startsWith("/api/context/inject")) {
			response.writeHead(200, { "Content-Type": "text/plain" }).end("test digest");
			return;
		}
		if (request.url === "/api/sessions/observations") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			observations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			resolveObservation();
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		writeFileSync(
			join(claudeMemDir, "settings.json"),
			JSON.stringify({ CLAUDE_MEM_WORKER_HOST: "127.0.0.1", CLAUDE_MEM_WORKER_PORT: String(address.port) }),
		);
		process.env.CLAUDE_MEM_DATA_DIR = claudeMemDir;
		process.env.PI_CMEM_FALLBACK_PATH = fallbackPath;

		const runtime = harness();
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		runtime.handlers.get("tool_result")({
			toolName: "read",
			input: { path: "note.txt" },
			content: [{ type: "text", text: "x".repeat(1_001) }],
		});
		runtime.handlers.get("tool_result")({ toolName: "memory_recall", input: {}, content: [{ type: "text", text: "remembered" }] });
		await observationReceived;
		const context = await runtime.handlers.get("context")({ messages: [] });
		assert.equal(context.messages[0].content[0].text, "<pi-cmem-context>\ntest digest\n</pi-cmem-context>");

		await runtime.commands.get("memory-status").handler("", setup.context);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		const message = notifications[0].message;
		const expected = [
			"worker: reachable (version test-worker)",
			"disabled: false (default)",
			`capture: true (global: ${globalSettingsPath})`,
			`inject: true (project: ${join(setup.context.cwd, CONFIG_DIR_NAME, "pi-cmem.json")})`,
			"workerHost: \"127.0.0.1\" (discovered: claude-mem's own settings (CLAUDE_MEM_WORKER_HOST))",
			`workerPort: ${address.port} (discovered: claude-mem's own settings (CLAUDE_MEM_WORKER_PORT))`,
			`project: \"forest\" (project: ${join(setup.context.cwd, CONFIG_DIR_NAME, "pi-cmem.json")})`,
			`fallbackPath: ${JSON.stringify(fallbackPath)} (environment: PI_CMEM_FALLBACK_PATH)`,
			"observations sent: 1; skipped: 1; truncated: 1",
			"digests injected: 1; last digest size: 11 characters",
		];
		for (const fragment of expected) assert.ok(message.includes(fragment), `missing status text: ${fragment}`);
		assert.equal(observations.length, 1);
		assert.equal(observations[0].tool_name, "read");
		assert.equal(observations[0].tool_response.length, 1_000);
		assert.ok(observations[0].tool_response.endsWith("[truncated]"));
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(setup.root, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(globalSettingsPath, { force: true });
		for (const [name, value] of previousEnvironment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("memory-status includes effective settings when the worker is unreachable", async () => {
	const envNames = [
		"PI_CMEM_DISABLED",
		"PI_CMEM_CAPTURE",
		"PI_CMEM_INJECT",
		"PI_CMEM_WORKER_HOST",
		"PI_CMEM_WORKER_PORT",
		"PI_CMEM_PROJECT",
		"PI_CMEM_FALLBACK_PATH",
	];
	const previousEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];

	const notifications = [];
	const setup = sessionFixture({ workerHost: "127.0.0.1", workerPort: 1, capture: false }, notifications);
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		await runtime.commands.get("memory-status").handler("", setup.context);

		assert.equal(notifications.length, 2);
		assert.equal(notifications[1].level, "info");
		assert.match(notifications[1].message, /worker: unreachable @ http:\/\/127\.0\.0\.1:1/);
		assert.ok(notifications[1].message.includes(`capture: false (project: ${join(setup.context.cwd, CONFIG_DIR_NAME, "pi-cmem.json")})`));
		assert.ok(notifications[1].message.includes("disabled: false (default)"));
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
		for (const [name, value] of previousEnvironment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
