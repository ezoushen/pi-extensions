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
const CMEM_ENV_NAMES = [
	"PI_CMEM_DISABLED",
	"PI_CMEM_CAPTURE",
	"PI_CMEM_INJECT",
	"PI_CMEM_WORKER_HOST",
	"PI_CMEM_WORKER_PORT",
	"PI_CMEM_PROJECT",
	"PI_CMEM_FALLBACK_PATH",
	"PI_CMEM_SKIP_TOOLS",
	"PI_CMEM_MAX_OBSERVATION_CHARS",
	"PI_CMEM_INJECT_WHEN",
	"PI_CMEM_MAX_INJECT_CHARS",
	"CLAUDE_MEM_DATA_DIR",
];

function isolateCmemEnvironment(overrides = {}) {
	const previous = new Map(CMEM_ENV_NAMES.map((name) => [name, process.env[name]]));
	for (const name of CMEM_ENV_NAMES) delete process.env[name];
	for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

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
		"PI_CMEM_SKIP_TOOLS",
		"PI_CMEM_MAX_OBSERVATION_CHARS",
		"PI_CMEM_INJECT_WHEN",
		"PI_CMEM_MAX_INJECT_CHARS",
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
		for (let call = 0; call < 3; call += 1) {
			const context = await runtime.handlers.get("context")({ messages: [] });
			assert.equal(context.messages[0].content[0].text, "<pi-cmem-context>\ntest digest\n</pi-cmem-context>");
		}

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
			"injectWhen: \"every-call\" (default)",
			"maxInjectChars: 0 (default)",
			"digests injected: 3; last digest size: 11 characters",
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
		"PI_CMEM_SKIP_TOOLS",
		"PI_CMEM_MAX_OBSERVATION_CHARS",
		"PI_CMEM_INJECT_WHEN",
		"PI_CMEM_MAX_INJECT_CHARS",
		"CLAUDE_MEM_DATA_DIR",
	];
	const previousEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];
	process.env.CLAUDE_MEM_DATA_DIR = join(tmpdir(), "pi-cmem-no-worker-settings");

	const notifications = [];
	const setup = sessionFixture({ workerHost: "127.0.0.1", workerPort: 1, capture: false }, notifications);
	process.env.PI_CMEM_INJECT_WHEN = "each-prompt";
	process.env.PI_CMEM_MAX_INJECT_CHARS = "500";
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
		assert.ok(notifications[1].message.includes('injectWhen: "each-prompt" (environment: PI_CMEM_INJECT_WHEN)'));
		assert.ok(notifications[1].message.includes("maxInjectChars: 500 (environment: PI_CMEM_MAX_INJECT_CHARS)"));
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
		for (const [name, value] of previousEnvironment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("capture skips configured tools and applies the configured observation limit", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});

	const observations = [];
	let resolveBashObservation;
	const bashObservationReceived = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for bash observation")), 2_000);
		resolveBashObservation = () => {
			clearTimeout(timeout);
			resolve();
		};
	});
	const server = createServer(async (request, response) => {
		if (request.url === "/api/health") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test-worker" }));
			return;
		}
		if (request.url === "/api/sessions/observations") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const observation = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			observations.push(observation);
			response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			if (observation.tool_name === "bash") resolveBashObservation();
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});

	const notifications = [];
	let setup;
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		setup = sessionFixture(
			{ workerHost: "127.0.0.1", workerPort: address.port, skipTools: ["read"], maxObservationChars: 300 },
			notifications,
		);

		const runtime = harness();
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		runtime.handlers.get("tool_result")({ toolName: "read", input: {}, content: [{ type: "text", text: "ignored" }] });
		runtime.handlers.get("tool_result")({ toolName: "bash", input: {}, content: [{ type: "text", text: "x".repeat(2_000) }] });
		runtime.handlers.get("tool_result")({ toolName: "memory_recall", input: {}, content: [{ type: "text", text: "ignored" }] });
		await bashObservationReceived;
		await runtime.commands.get("memory-status").handler("", setup.context);

		assert.equal(observations.length, 1);
		assert.equal(observations[0].tool_name, "bash");
		assert.equal(observations[0].tool_response.length, 300);
		assert.ok(observations[0].tool_response.endsWith("[truncated]"));
		assert.ok(notifications.at(-1).message.includes("observations sent: 1; skipped: 2; truncated: 1"));
		const projectSettingsPath = join(setup.context.cwd, CONFIG_DIR_NAME, "pi-cmem.json");
		assert.ok(notifications.at(-1).message.includes(`skipTools: ["read"] (project: ${projectSettingsPath})`));
		assert.ok(notifications.at(-1).message.includes(`maxObservationChars: 300 (project: ${projectSettingsPath})`));
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		if (setup) rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});

test("invalid capture and injection settings fall back to defaults with one warning each", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});

	const notifications = [];
	const setup = sessionFixture(
		{
			workerHost: "127.0.0.1",
			workerPort: 1,
			skipTools: "read",
			maxObservationChars: 199,
			injectWhen: "per-message",
			maxInjectChars: -1,
		},
		notifications,
	);
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await assert.doesNotReject(() => runtime.handlers.get("session_start")({}, setup.context));
		await runtime.commands.get("memory-status").handler("", setup.context);

		const invalidWarnings = notifications.filter((item) => item.level === "warning" && item.message.includes("invalid "));
		assert.equal(invalidWarnings.length, 4);
		assert.ok(invalidWarnings.some((item) => item.message.includes("invalid skipTools")));
		assert.ok(invalidWarnings.some((item) => item.message.includes("invalid maxObservationChars")));
		assert.ok(invalidWarnings.some((item) => item.message.includes("invalid injectWhen")));
		assert.ok(invalidWarnings.some((item) => item.message.includes("invalid maxInjectChars")));
		assert.ok(notifications.at(-1).message.includes("skipTools: [] (default)"));
		assert.ok(notifications.at(-1).message.includes("maxObservationChars: 1000 (default)"));
		assert.ok(notifications.at(-1).message.includes('injectWhen: "every-call" (default)'));
		assert.ok(notifications.at(-1).message.includes("maxInjectChars: 0 (default)"));
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});

test("invalid observation limit from the environment uses its default with one warning", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		PI_CMEM_SKIP_TOOLS: " read , bash ",
		PI_CMEM_MAX_OBSERVATION_CHARS: "garbage",
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});

	const notifications = [];
	const setup = sessionFixture({ workerHost: "127.0.0.1", workerPort: 1 }, notifications);
	const runtime = harness();
	try {
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		await runtime.commands.get("memory-status").handler("", setup.context);

		const invalidWarnings = notifications.filter((item) => item.level === "warning" && item.message.includes("invalid "));
		assert.equal(invalidWarnings.length, 1);
		assert.ok(invalidWarnings[0].message.includes("invalid maxObservationChars"));
		assert.ok(notifications.at(-1).message.includes('skipTools: ["read","bash"] (environment: PI_CMEM_SKIP_TOOLS)'));
		assert.ok(notifications.at(-1).message.includes("maxObservationChars: 1000 (default)"));
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});

test("each-prompt injects one hidden custom message and skips the context hook", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});
	let digestCalls = 0;
	const server = createServer((request, response) => {
		if (request.url === "/api/health") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test-worker" }));
			return;
		}
		if (request.url?.startsWith("/api/context/inject")) {
			digestCalls += 1;
			response.writeHead(200, { "Content-Type": "text/plain" }).end(`digest-${digestCalls}`);
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});
	let setup;
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		setup = sessionFixture(
			{ workerHost: "127.0.0.1", workerPort: address.port, capture: false, inject: true, injectWhen: "each-prompt" },
			[],
		);
		const runtime = harness();
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);

		const first = await runtime.handlers.get("before_agent_start")({ prompt: "first prompt" }, setup.context);
		const second = await runtime.handlers.get("before_agent_start")({ prompt: "second prompt" }, setup.context);
		assert.deepEqual(first, {
			message: {
				customType: "pi-cmem-context",
				content: "<pi-cmem-context>\ndigest-1\n</pi-cmem-context>",
				display: false,
			},
		});
		assert.deepEqual(second, {
			message: {
				customType: "pi-cmem-context",
				content: "<pi-cmem-context>\ndigest-2\n</pi-cmem-context>",
				display: false,
			},
		});
		for (let call = 0; call < 3; call += 1) {
			assert.equal(await runtime.handlers.get("context")({ messages: [] }), undefined);
		}
		assert.equal(digestCalls, 2);
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		if (setup) rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});

test("session-start injects once per active Pi session", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});
	let digestCalls = 0;
	const server = createServer((request, response) => {
		if (request.url === "/api/health") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test-worker" }));
			return;
		}
		if (request.url?.startsWith("/api/context/inject")) {
			digestCalls += 1;
			response.writeHead(200, { "Content-Type": "text/plain" }).end(`digest-${digestCalls}`);
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});
	let setup;
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		setup = sessionFixture(
			{ workerHost: "127.0.0.1", workerPort: address.port, capture: false, inject: true, injectWhen: "session-start" },
			[],
		);
		let activeSessionId = "session-a";
		setup.context.sessionManager.getSessionId = () => activeSessionId;
		const runtime = harness();
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);

		const first = await runtime.handlers.get("before_agent_start")({ prompt: "first prompt" }, setup.context);
		const second = await runtime.handlers.get("before_agent_start")({ prompt: "second prompt" }, setup.context);
		assert.equal(first.message.content, "<pi-cmem-context>\ndigest-1\n</pi-cmem-context>");
		assert.equal(second, undefined);

		activeSessionId = "session-b";
		const afterSwitch = await runtime.handlers.get("before_agent_start")({ prompt: "first prompt after switch" }, setup.context);
		assert.equal(afterSwitch.message.content, "<pi-cmem-context>\ndigest-2\n</pi-cmem-context>");
		for (let call = 0; call < 3; call += 1) {
			assert.equal(await runtime.handlers.get("context")({ messages: [] }), undefined);
		}
		assert.equal(digestCalls, 2);
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		if (setup) rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});

test("maxInjectChars truncates a digest and marks the injected text", async () => {
	const restoreEnvironment = isolateCmemEnvironment({
		CLAUDE_MEM_DATA_DIR: join(tmpdir(), "pi-cmem-no-worker-settings"),
	});
	const digest = "x".repeat(3_000);
	const server = createServer((request, response) => {
		if (request.url === "/api/health") {
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test-worker" }));
			return;
		}
		if (request.url?.startsWith("/api/context/inject")) {
			response.writeHead(200, { "Content-Type": "text/plain" }).end(digest);
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});
	let setup;
	try {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		setup = sessionFixture(
			{
				workerHost: "127.0.0.1",
				workerPort: address.port,
				capture: false,
				inject: true,
				injectWhen: "each-prompt",
				maxInjectChars: 500,
			},
			[],
		);
		const runtime = harness();
		cmemExtension(runtime.pi);
		await runtime.handlers.get("session_start")({}, setup.context);
		const result = await runtime.handlers.get("before_agent_start")({ prompt: "prompt" }, setup.context);

		assert.equal(result.message.content, `<pi-cmem-context>\n${"x".repeat(500)} [truncated]\n</pi-cmem-context>`);
		assert.equal(result.message.content.length, 500 + " [truncated]".length + "<pi-cmem-context>\n".length + "\n</pi-cmem-context>".length);
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		if (setup) rmSync(setup.root, { recursive: true, force: true });
		restoreEnvironment();
	}
});
