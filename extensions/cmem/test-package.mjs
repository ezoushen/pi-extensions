import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("manifest exposes pi-cmem as a public Pi package with its runtime imports as peers", () => {
	assert.equal(manifest.name, "pi-cmem");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies.typebox, "*");
	assert.deepEqual(manifest.pi.extensions, ["./cmem.js"]);
});

test("packed package contains only its files, installs, and loads with Pi", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-cmem-pack-"));
	try {
		const packed = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--pack-destination", temp, packageRoot],
				{ encoding: "utf8" },
			),
		)[0];
		const expectedFiles = ["LICENSE", "cmem.js", "package.json"];
		if (existsSync(join(packageRoot, "README.md"))) expectedFiles.push("README.md");
		assert.deepEqual(packed.files.map((file) => file.path).sort(), expectedFiles.sort());

		const agentDir = join(temp, "agent");
		const tarball = join(temp, packed.filename);
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
				tarball,
			],
			{ encoding: "utf8" },
		);

		const installed = join(agentDir, "node_modules", manifest.name);
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir);
		symlinkSync(installed, join(extensionsDir, manifest.name));

		const piRoot = realpathSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
		const loader = await import(
			pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href
		);
		const { extensions, errors } = await loader.discoverAndLoadExtensions([], repoRoot, agentDir);
		assert.deepEqual(errors, [], `loader reported errors: ${JSON.stringify(errors)}`);
		assert.equal(extensions.length, 1);
		assert.equal(realpathSync(extensions[0].path), realpathSync(join(installed, "cmem.js")));
		for (const event of ["session_start", "before_agent_start", "context", "tool_result", "agent_end"]) {
			assert.ok(extensions[0].handlers.has(event), `missing handler for ${event}`);
		}
		assert.ok(extensions[0].tools.has("memory_recall"));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
