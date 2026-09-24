import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("manifest exposes pi-focus-mode with only imported Pi packages as peers", () => {
	assert.equal(manifest.name, "pi-focus-mode");
	assert.equal(manifest.description, "Keep Pi exchanges focused with foldable progress and stats.");
	assert.equal(manifest.main, "./focus-mode.js");
	assert.equal(manifest.exports, "./focus-mode.js");
	assert.deepEqual(manifest.files, ["focus-mode.js", "README.md", "LICENSE"]);
	assert.deepEqual(manifest.pi.extensions, ["./focus-mode.js"]);
	assert.equal(manifest.repository.directory, "extensions/focus-mode");
	assert.equal(manifest.homepage, "https://github.com/ezoushen/pi-extensions/tree/main/extensions/focus-mode#readme");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], undefined);
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	assert.deepEqual(manifest.dependencies ?? {}, {});
});
