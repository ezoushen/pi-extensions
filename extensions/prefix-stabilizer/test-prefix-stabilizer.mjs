import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
const source = join(packageRoot, "prefix-stabilizer.ts");
const requestFixture = join(repoRoot, "test", "fixtures", "run-prefix-stabilizer-request.mjs");
const sequenceFixture = join(repoRoot, "test", "fixtures", "run-prefix-stabilizer-sequence.mjs");

function snapshot(root, current = root) {
	return readdirSync(current, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(current, entry.name);
			const name = relative(root, path);
			if (entry.isDirectory()) return [`directory:${name}`, ...snapshot(root, path)];
			if (entry.isSymbolicLink()) return [`symlink:${name}->${readlinkSync(path)}`];
			return [`file:${name}`];
		})
		.sort();
}

test("default settings leave a scratch home tree unchanged after a request", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-home-"));
	const before = snapshot(home);
	const environment = { ...process.env, HOME: home };
	delete environment.PI_CODING_AGENT_DIR;
	delete environment.PI_PREFIX_STABILIZER_STABLE_PATH;
	delete environment.PI_PREFIX_STABILIZER_PACKAGE_PATH_SUFFIX;
	delete environment.PI_PREFIX_STABILIZER_CREATE_SYMLINK;
	try {
		execFileSync(process.execPath, ["--experimental-strip-types", requestFixture, source], {
			cwd: home,
			env: environment,
			encoding: "utf8",
		});
		assert.deepEqual(snapshot(home), before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("configured stable path and package suffix control normalization", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-config-"));
	const agentDir = join(home, ".pi", "agent");
	// An install root is only ever stabilised if it actually exists on disk.
	const installRoot = join(home, "volatile", "custom", "modules", "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(installRoot, { recursive: true });
	writeFileSync(
		join(agentDir, "pi-prefix-stabilizer.json"),
		JSON.stringify({
			stablePath: "/configured/stable-pi",
			packagePathSuffix: "custom/modules/pi-agent",
		}),
	);
	const environment = {
		...process.env,
		HOME: home,
		PREFIX_STABILIZER_TEST_SYSTEM: `Docs: ${installRoot}/docs`,
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", requestFixture, source],
			{ cwd: home, env: environment, encoding: "utf8" },
		);
		const result = JSON.parse(output);
		assert.match(result.system, /\/configured\/stable-pi\/docs/);
		assert.doesNotMatch(result.system, /volatile\/custom\/modules\/pi-agent/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("configured opt-in creates the stable symlink at the configured path", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-symlink-"));
	const agentDir = join(home, ".pi", "agent");
	const stablePath = join(home, "configured", "pi-home");
	const installRoot = join(home, "volatile", "custom", "modules", "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(installRoot, { recursive: true });
	writeFileSync(
		join(agentDir, "pi-prefix-stabilizer.json"),
		JSON.stringify({
			stablePath,
			packagePathSuffix: "custom/modules/pi-agent",
			createSymlink: true,
		}),
	);
	const environment = {
		...process.env,
		HOME: home,
		PREFIX_STABILIZER_TEST_SYSTEM: `Docs: ${installRoot}/docs`,
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		execFileSync(process.execPath, ["--experimental-strip-types", requestFixture, source], {
			cwd: home,
			env: environment,
			encoding: "utf8",
		});
		assert.ok(lstatSync(stablePath).isSymbolicLink());
		assert.equal(readlinkSync(stablePath), installRoot);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a relative mention is left alone and never overwrites an existing good symlink", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-relative-"));
	const agentDir = join(home, ".pi", "agent");
	const stablePath = join(home, "configured", "pi-home");
	const goodRoot = join(home, "real-install");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(goodRoot, { recursive: true });
	mkdirSync(dirname(stablePath), { recursive: true });
	symlinkSync(goodRoot, stablePath);
	writeFileSync(
		join(agentDir, "pi-prefix-stabilizer.json"),
		JSON.stringify({
			stablePath,
			packagePathSuffix: "node_modules/@earendil-works/pi-coding-agent",
			createSymlink: true,
		}),
	);
	const environment = {
		...process.env,
		HOME: home,
		// No leading "/": a relative mention, e.g. from a quoted shell command.
		PREFIX_STABILIZER_TEST_SYSTEM: "run: node_modules/@earendil-works/pi-coding-agent/bin/pi.js",
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", requestFixture, source],
			{ cwd: home, env: environment, encoding: "utf8" },
		);
		// A relative mention is not an install root: nothing is rewritten, so
		// the extension declines the payload entirely (returns undefined/null).
		assert.equal(JSON.parse(output), null);
		assert.ok(lstatSync(stablePath).isSymbolicLink());
		assert.equal(readlinkSync(stablePath), goodRoot);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a bare-slash mention is left alone and never overwrites an existing good symlink", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-bareslash-"));
	const agentDir = join(home, ".pi", "agent");
	const stablePath = join(home, "configured", "pi-home");
	const goodRoot = join(home, "real-install");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(goodRoot, { recursive: true });
	mkdirSync(dirname(stablePath), { recursive: true });
	symlinkSync(goodRoot, stablePath);
	writeFileSync(
		join(agentDir, "pi-prefix-stabilizer.json"),
		JSON.stringify({
			stablePath,
			packagePathSuffix: "node_modules/@earendil-works/pi-coding-agent",
			createSymlink: true,
		}),
	);
	const environment = {
		...process.env,
		HOME: home,
		// Absolute-looking, but "/node_modules/..." does not exist on this machine.
		PREFIX_STABILIZER_TEST_SYSTEM: "Docs: /node_modules/@earendil-works/pi-coding-agent/docs",
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", requestFixture, source],
			{ cwd: home, env: environment, encoding: "utf8" },
		);
		assert.equal(JSON.parse(output), null);
		assert.ok(lstatSync(stablePath).isSymbolicLink());
		assert.equal(readlinkSync(stablePath), goodRoot);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("an absolute but nonexistent mention is left alone and never overwrites an existing good symlink", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-nonexistent-"));
	const agentDir = join(home, ".pi", "agent");
	const stablePath = join(home, "configured", "pi-home");
	const goodRoot = join(home, "real-install");
	const bogusRoot = join(home, "does-not-exist", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(goodRoot, { recursive: true });
	mkdirSync(dirname(stablePath), { recursive: true });
	symlinkSync(goodRoot, stablePath);
	writeFileSync(
		join(agentDir, "pi-prefix-stabilizer.json"),
		JSON.stringify({
			stablePath,
			packagePathSuffix: "node_modules/@earendil-works/pi-coding-agent",
			createSymlink: true,
		}),
	);
	const environment = {
		...process.env,
		HOME: home,
		PREFIX_STABILIZER_TEST_SYSTEM: `Docs: ${bogusRoot}/docs`,
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", requestFixture, source],
			{ cwd: home, env: environment, encoding: "utf8" },
		);
		assert.equal(JSON.parse(output), null);
		assert.ok(lstatSync(stablePath).isSymbolicLink());
		assert.equal(readlinkSync(stablePath), goodRoot);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

function runSequence(payloads) {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-sequence-"));
	const environment = {
		...process.env,
		HOME: home,
		PREFIX_STABILIZER_TEST_PAYLOADS: JSON.stringify(payloads),
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		return JSON.parse(
			execFileSync(
				process.execPath,
				["--experimental-strip-types", sequenceFixture, source],
				{ cwd: home, env: environment, encoding: "utf8" },
			),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("tool order is normalized before fingerprinting and emits no drift warning", () => {
	const alpha = { type: "function", function: { name: "alpha" } };
	const zebra = { type: "function", function: { name: "zebra" } };
	const first = {
		system: "<tools>\n- zebra: z\n- alpha: a\n</tools>",
		tools: [zebra, alpha],
	};
	const second = {
		system: "<tools>\n- alpha: a\n- zebra: z\n</tools>",
		tools: [alpha, zebra],
	};
	const result = runSequence([first, second]);
	assert.deepEqual(result.notifications, []);
	assert.deepEqual(result.payloads[0], result.payloads[1]);
});

test("a genuine normalized system change warns once until the prompt changes again", () => {
	const result = runSequence([
		{ system: "system prompt A" },
		{ system: "system prompt B" },
		{ system: "system prompt B" },
	]);
	assert.equal(result.notifications.length, 1);
	assert.match(result.notifications[0], /system prompt changed mid-session/);
});

test("a system message sent later in the conversation keeps the cached prefix and does not warn", () => {
	const head = { role: "system", content: "system prompt A" };
	const result = runSequence([
		{ messages: [head, { role: "user", content: "run the build" }] },
		{
			messages: [
				head,
				{ role: "user", content: "run the build" },
				{ role: "assistant", content: "started" },
				{ role: "system", content: "<section>shell policy removed</section>" },
				{ role: "user", content: "task finished" },
			],
		},
	]);
	assert.deepEqual(result.notifications, []);
});

test("a changed leading system message still warns", () => {
	const result = runSequence([
		{ messages: [{ role: "system", content: "system prompt A" }, { role: "user", content: "hi" }] },
		{ messages: [{ role: "system", content: "system prompt B" }, { role: "user", content: "hi" }] },
	]);
	assert.equal(result.notifications.length, 1);
	assert.match(result.notifications[0], /system prompt changed mid-session/);
});

const agentStartFixture = join(repoRoot, "test", "fixtures", "run-prefix-stabilizer-agent-start.mjs");

function runAgentStart(sections, forced) {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-agent-start-"));
	const environment = {
		...process.env,
		HOME: home,
		PREFIX_STABILIZER_TEST_AGENT_START: JSON.stringify({ sections, forced }),
	};
	delete environment.PI_CODING_AGENT_DIR;
	try {
		return JSON.parse(
			execFileSync(process.execPath, ["--experimental-strip-types", agentStartFixture, source], {
				cwd: home,
				env: environment,
				encoding: "utf8",
			}),
		).forced;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const structuredSections = {
	preamble: "You are an expert coding assistant.",
	tools: "<tools>\n- read: Read file contents\n- bash: Execute bash commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>",
	rules: "<rules>\n- Use read to examine files\n</rules>",
	cwd: "<cwd>\n/work\n</cwd>",
};

test("a forced prompt that only moves pi's own sections is dropped so every run keeps one prefix", () => {
	// The shape pi-permission-system 35-36 returns: tools and rules moved after
	// cwd, and the "In addition to the tools above" filler left out.
	const relocated = [
		structuredSections.preamble,
		structuredSections.cwd,
		"<tools>\n- read: Read file contents\n- bash: Execute bash commands\n</tools>",
		structuredSections.rules,
	].join("\n\n");
	assert.equal(runAgentStart(structuredSections, relocated), null);
});

test("a forced prompt that adds an instruction stays forced", () => {
	const extended = `${Object.values(structuredSections).join("\n\n")}\n\nAlways answer in French.`;
	assert.equal(runAgentStart(structuredSections, extended), extended);
});

test("a forced prompt that reorders lines inside a section stays forced", () => {
	const sections = { ...structuredSections, rules: "<rules>\n- Prefer rg\n- Never use grep\n</rules>" };
	const swapped = Object.values({ ...sections, rules: "<rules>\n- Never use grep\n- Prefer rg\n</rules>" }).join(
		"\n\n",
	);
	assert.equal(runAgentStart(sections, swapped), swapped);
});

test("a forced prompt that withholds a tool stays forced", () => {
	const narrowed = Object.values({
		...structuredSections,
		tools: "<tools>\n- read: Read file contents\n</tools>",
	}).join("\n\n");
	assert.equal(runAgentStart(structuredSections, narrowed), narrowed);
});

const contextFixture = join(repoRoot, "test", "fixtures", "run-prefix-stabilizer-context.mjs");

function runSteps(steps) {
	const home = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-context-"));
	const environment = { ...process.env, HOME: home, PREFIX_STABILIZER_TEST_STEPS: JSON.stringify(steps) };
	delete environment.PI_CODING_AGENT_DIR;
	try {
		return JSON.parse(
			execFileSync(process.execPath, ["--experimental-strip-types", contextFixture, source], {
				cwd: home,
				env: environment,
				encoding: "utf8",
			}),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// The transcript shape pi 1.0 records: a leading system message with every section, then
// patches by name (null = removed). A run started by an extension message (a
// background-task notification) skips before_agent_start, so the patch pi writes at its
// next turn removes every extension section; the next typed prompt adds the same text back.
const harness = "<automattic_harness>\nread the adapter first\n</automattic_harness>";
const shellPolicy = "<pi_background_shell_policy>\nuse posix sh\n</pi_background_shell_policy>";
const skills = "<skills>\n- tdd: test first\n</skills>";
const leading = {
	role: "system",
	content: "",
	sections: { preamble: "You are pi.", tools: "<tools>\n- read\n</tools>", skills, automattic_harness: harness, pi_background_shell_policy: shellPolicy },
	timestamp: 1,
};
const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const toolResult = (timestamp) => ({ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp });
const notification = (timestamp) => ({ role: "custom", customType: "background-task-notification", content: "task done", display: true, timestamp });
const patch = (sections, timestamp) => ({ role: "system", content: "", sections, timestamp });
const flip = (timestamp) => patch({ automattic_harness: null, pi_background_shell_policy: null }, timestamp);
const sectionsAfter = (messages) => {
	const current = {};
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) delete current[name];
			else current[name] = value;
		}
	}
	return current;
};

// A typed run, then a notification run that makes one tool call: its second turn carries the flip.
const typedThenNotified = [user("start the review", 2), assistant("started", 3), notification(4), assistant("reading", 5), toolResult(6)];
const notificationRun = (afterFlip = []) => [
	{ on: "agent_start" },
	{ on: "context", messages: [leading, ...typedThenNotified.slice(0, 3)] },
	{ on: "context", messages: [leading, ...typedThenNotified, flip(7), ...afterFlip] },
	{ on: "agent_end" },
];

test("a run started by an extension message does not remove extension sections from the request", () => {
	const { contexts, entries } = runSteps(notificationRun());
	assert.deepEqual(sectionsAfter(contexts[1].messages), leading.sections);
	assert.deepEqual(entries, [{ customType: "pi-prefix-stabilizer", data: { droppedRemovals: [7] } }]);
});

test("a follow-up queued during that run does not bring the removal back", () => {
	// Pi sends a queued follow-up right after the patch of the turn that picks it up.
	const { contexts } = runSteps(notificationRun([user("is it done?", 8)]));
	assert.deepEqual(sectionsAfter(contexts[1].messages), leading.sections);
});

test("a flip and its re-add on the next typed prompt leave nothing for the model to see", () => {
	const history = [leading, ...typedThenNotified, flip(7), assistant("checked", 8)];
	const { contexts } = runSteps([
		...notificationRun(),
		{ on: "before_agent_start", prompt: "did codex finish?" },
		{ on: "agent_start" },
		{ on: "context", messages: [...history, patch({ automattic_harness: harness, pi_background_shell_policy: shellPolicy }, 9), user("did codex finish?", 10)] },
		{ on: "agent_end" },
	]);
	const sent = contexts[2].messages;
	assert.deepEqual(sent.filter((message) => message.role === "system"), [leading]);
	assert.deepEqual(sent.filter((message) => message.role !== "system"), [...typedThenNotified, assistant("checked", 8), user("did codex finish?", 10)]);
});

test("the dropped removal is recorded as soon as it is dropped", () => {
	// A /tree or fork to a message later in the same run must already find the record.
	const { contexts } = runSteps(notificationRun());
	assert.equal(contexts[1].entriesSoFar, 1);
});

test("a typed prompt that never started its run does not mark the next notification run as typed", () => {
	// before_agent_start ran, then the prompt failed (or lost a race with the notification).
	const { contexts } = runSteps([{ on: "before_agent_start", prompt: "start the review" }, ...notificationRun()]);
	assert.deepEqual(sectionsAfter(contexts[1].messages), leading.sections);
});

test("a removal during a typed run reaches the model", () => {
	const { contexts } = runSteps([
		{ on: "before_agent_start", prompt: "stop the harness" },
		{ on: "agent_start" },
		{ on: "context", messages: [leading, user("stop the harness", 2)] },
		{ on: "context", messages: [leading, user("stop the harness", 2), assistant("ok", 3), toolResult(4), patch({ automattic_harness: null }, 5)] },
		{ on: "agent_end" },
	]);
	assert.equal(contexts[1].replaced, false);
});

test("a removal of a section pi builds itself reaches the model even in a notification run", () => {
	// Pi drops its own skills section when read and bash are switched off mid-run.
	const { contexts } = runSteps([
		{ on: "agent_start" },
		{ on: "context", messages: [leading, ...typedThenNotified.slice(0, 3)] },
		{ on: "context", messages: [leading, ...typedThenNotified, patch({ skills: null }, 7)] },
		{ on: "agent_end" },
	]);
	assert.equal(contexts[1].replaced, false);
});

test("a resumed session keeps dropping the removals it dropped before", () => {
	const history = [leading, ...typedThenNotified, flip(7), assistant("checked", 8), user("next", 9)];
	const recorded = [{ type: "custom", customType: "pi-prefix-stabilizer", data: { droppedRemovals: [7] } }];
	const resumed = runSteps([{ on: "session_start", branch: recorded }, { on: "context", messages: history }]);
	assert.deepEqual(sectionsAfter(resumed.contexts[0].messages), leading.sections);
	// A session without the record (or from before 0.3.0) is sent as pi recorded it.
	const unrecorded = runSteps([{ on: "session_start", branch: [] }, { on: "context", messages: history }]);
	assert.equal(unrecorded.contexts[0].replaced, false);
});

test("/tree to a message written before the record still finds it", () => {
	// Pi saves a patch and a queued follow-up before the request that records the drop, so
	// selecting that follow-up in /tree leaves the record off the new branch.
	const history = [leading, ...typedThenNotified, flip(7), user("is it done?", 8)];
	const recorded = { type: "custom", customType: "pi-prefix-stabilizer", data: { droppedRemovals: [7] } };
	const { contexts } = runSteps([{ on: "session_tree", branch: [], entries: [recorded] }, { on: "context", messages: history }]);
	assert.deepEqual(sectionsAfter(contexts[0].messages), leading.sections);
});

test("changes the model should see pass through unchanged", () => {
	const messages = [
		leading,
		user("start", 2),
		assistant("ok", 3),
		patch({ tools: "<tools>\n- read\n- bash\n</tools>" }, 4),
		user("go on", 5),
		assistant("ok", 6),
		notification(7),
		// A notification run that changes text (not a removal) and declares a tool.
		{ ...patch({ pi_background_shell_policy: "<pi_background_shell_policy>\nuse zsh\n</pi_background_shell_policy>" }, 8), toolsAdded: [{ name: "bash" }] },
		assistant("done", 9),
		{ role: "system", content: "Context compacted.", timestamp: 10 },
		user("next", 11),
	];
	const { contexts } = runSteps([{ on: "agent_start" }, { on: "context", messages }, { on: "agent_end" }]);
	assert.equal(contexts[0].replaced, false);
	assert.deepEqual(contexts[0].messages, messages);
});

test("packed package installs and registers through pi's loader", async () => {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.name, "pi-prefix-stabilizer");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.deepEqual(manifest.dependencies ?? {}, {});

	const temp = mkdtempSync(join(tmpdir(), "pi-prefix-stabilizer-pack-"));
	try {
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", temp, packageRoot], {
				encoding: "utf8",
			}),
		)[0];
		assert.deepEqual(
			packed.files.map((file) => file.path).sort(),
			["LICENSE", "README.md", "package.json", "prefix-stabilizer.js"],
		);

		const agentDir = join(temp, "agent");
		execFileSync(
			"npm",
			[
				"install",
				"--prefix",
				agentDir,
				"--ignore-scripts",
				"--legacy-peer-deps",
				"--no-audit",
				"--no-fund",
				join(temp, packed.filename),
			],
			{ encoding: "utf8" },
		);

		const installed = join(agentDir, "node_modules", manifest.name);
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir);
		symlinkSync(installed, join(extensionsDir, manifest.name));
		const piRoot = realpathSync(
			join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
		);
		const loader = await import(
			pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href
		);
		const { extensions, errors } = await loader.discoverAndLoadExtensions([], repoRoot, agentDir);
		assert.deepEqual(errors, [], `loader reported errors: ${JSON.stringify(errors)}`);
		assert.equal(extensions.length, 1);
		assert.equal(
			realpathSync(extensions[0].path),
			realpathSync(join(installed, "prefix-stabilizer.js")),
		);
		assert.ok(extensions[0].handlers.has("before_provider_request"));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
