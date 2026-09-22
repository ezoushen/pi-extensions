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
