import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { resolveSettings } from "../shared/settings.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture({ global = {}, project = {}, trusted = true, environment = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(agentDir, "example.json"), JSON.stringify(global));
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "example.json"), JSON.stringify(project));
	return {
		root,
		context: { cwd, isProjectTrusted: () => trusted },
		runtime: { agentDir, environment },
	};
}

test("environment overrides project, global, and default with its provenance", () => {
	const setup = fixture({
		global: { port: 1 },
		project: { port: 2 },
		environment: { PI_EXAMPLE_PORT: "3" },
	});
	try {
		assert.deepEqual(
			resolveSettings(
				"example",
				{ port: { default: 0, env: "PI_EXAMPLE_PORT", parseEnv: Number } },
				setup.context,
				setup.runtime,
			),
			{
				port: {
					value: 3,
					provenance: { source: "environment", name: "PI_EXAMPLE_PORT" },
				},
			},
		);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("untrusted project settings are ignored in favor of global or default values", () => {
	const setup = fixture({
		trusted: false,
		global: { endpoint: "global" },
		project: { endpoint: "project", mode: "project" },
	});
	try {
		assert.deepEqual(
			resolveSettings(
				"example",
				{
					endpoint: { default: "default", env: "PI_EXAMPLE_ENDPOINT" },
					mode: { default: "default", env: "PI_EXAMPLE_MODE" },
				},
				setup.context,
				setup.runtime,
			),
			{
				endpoint: {
					value: "global",
					provenance: { source: "global", path: join(setup.runtime.agentDir, "example.json") },
				},
				mode: { value: "default", provenance: { source: "default" } },
			},
		);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("trusted project settings override global settings", () => {
	const setup = fixture({
		global: { endpoint: "global" },
		project: { endpoint: "project" },
	});
	try {
		assert.deepEqual(
			resolveSettings(
				"example",
				{ endpoint: { default: "default", env: "PI_EXAMPLE_ENDPOINT" } },
				setup.context,
				setup.runtime,
			),
			{
				endpoint: {
					value: "project",
					provenance: {
						source: "project",
						path: join(setup.context.cwd, CONFIG_DIR_NAME, "example.json"),
					},
				},
			},
		);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("missing configuration returns every documented default with default provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-settings-empty-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	try {
		assert.deepEqual(
			resolveSettings(
				"example",
				{
					endpoint: { default: "http://127.0.0.1", env: "PI_EXAMPLE_ENDPOINT" },
					enabled: { default: false, env: "PI_EXAMPLE_ENABLED" },
				},
				{ cwd, isProjectTrusted: () => true },
				{ agentDir, environment: {} },
			),
			{
				endpoint: { value: "http://127.0.0.1", provenance: { source: "default" } },
				enabled: { value: false, provenance: { source: "default" } },
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an untrusted project configuration file is not read", () => {
	const setup = fixture({ trusted: false, global: { endpoint: "global" } });
	writeFileSync(join(setup.context.cwd, CONFIG_DIR_NAME, "example.json"), "not json");
	try {
		assert.deepEqual(
			resolveSettings(
				"example",
				{ endpoint: { default: "default", env: "PI_EXAMPLE_ENDPOINT" } },
				setup.context,
				setup.runtime,
			),
			{
				endpoint: {
					value: "global",
					provenance: { source: "global", path: join(setup.runtime.agentDir, "example.json") },
				},
			},
		);
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("a malformed global settings file degrades to defaults instead of throwing, and warns once", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-extension-settings-malformed-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// A trailing comma: valid-looking JSON that JSON.parse rejects.
	writeFileSync(join(agentDir, "example.json"), '{"endpoint": "from-file",}');
	try {
		const notices = [];
		const context = {
			cwd,
			isProjectTrusted: () => true,
			ui: { notify: (message, level) => notices.push([message, level]) },
		};
		const runtime = { agentDir, environment: {} };
		const definitions = { endpoint: { default: "default", env: "PI_EXAMPLE_ENDPOINT" } };

		// The call must complete -- not throw -- and fall back to the default.
		assert.deepEqual(resolveSettings("example", definitions, context, runtime), {
			endpoint: { value: "default", provenance: { source: "default" } },
		});
		assert.equal(notices.length, 1);
		assert.match(notices[0][0], /example\.json/);
		assert.equal(notices[0][1], "warning");

		// A second call against the same malformed file does not warn again.
		resolveSettings("example", definitions, context, runtime);
		assert.equal(notices.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a package consumer bundles shared settings without an escaping relative import", () => {
	const outputRoot = mkdtempSync(join(tmpdir(), "pi-extension-settings-bundle-"));
	const output = join(outputRoot, "consumer.js");
	try {
		execFileSync(
			join(repoRoot, "node_modules", ".bin", "esbuild"),
			[
				join(repoRoot, "test", "fixtures", "settings-consumer.ts"),
				"--bundle",
				"--platform=node",
				"--format=esm",
				"--packages=external",
				`--outfile=${output}`,
			],
			{ encoding: "utf8" },
		);

		const source = readFileSync(output, "utf8");
		const specifiers = [
			...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g),
		].map((match) => match[2]);
		const escaping = specifiers
			.filter((specifier) => specifier.startsWith("."))
			.filter((specifier) => {
				const destination = resolve(dirname(output), specifier);
				const pathFromPackage = relative(outputRoot, destination);
				return pathFromPackage === ".." || pathFromPackage.startsWith(`..${sep}`);
			});
		assert.deepEqual(escaping, []);
	} finally {
		rmSync(outputRoot, { recursive: true, force: true });
	}
});
