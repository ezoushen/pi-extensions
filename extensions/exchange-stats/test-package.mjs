import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("manifest exposes pi-exchange-stats with Pi AI, coding agent and TUI as peers", () => {
	assert.equal(manifest.name, "pi-exchange-stats");
	assert.equal(manifest.main, "./exchange-stats.js");
	assert.deepEqual(manifest.pi.extensions, ["./exchange-stats.js"]);
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	assert.deepEqual(manifest.dependencies ?? {}, {});
});
