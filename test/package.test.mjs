import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "extensions", "compaction-cache");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const entry = join(packageRoot, manifest.pi.extensions[0]);

test("manifest exposes a public pi package with pi core as peers", () => {
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies.typebox, undefined);
  assert.equal(
    Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@earendil-works/")).length,
    0,
  );
});

test("bundled entry has no relative import outside its package", () => {
  const source = readFileSync(entry, "utf8");
  const specifiers = [
    ...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g),
  ].map((match) => match[2]);
  const escaping = specifiers
    .filter((specifier) => specifier.startsWith("."))
    .filter((specifier) => {
      const destination = resolve(dirname(entry), specifier);
      const pathFromPackage = relative(packageRoot, destination);
      return pathFromPackage === ".." || pathFromPackage.startsWith(`..${sep}`);
    });
  assert.deepEqual(escaping, []);
});

test("packed package contains only its files, installs, and loads with pi", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-compaction-cache-pack-"));
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", temp, packageRoot],
        { encoding: "utf8" },
      ),
    )[0];
    assert.deepEqual(
      packed.files.map((file) => file.path).sort(),
      ["LICENSE", "README.md", "compaction-cache.js", "package.json"],
    );

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

    const piRoot = realpathSync(
      join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
    );
    const loader = await import(
      pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href
    );
    const { extensions, errors } = await loader.discoverAndLoadExtensions(
      [],
      repoRoot,
      agentDir,
    );
    assert.deepEqual(errors, [], `loader reported errors: ${JSON.stringify(errors)}`);
    assert.equal(extensions.length, 1);
    assert.equal(realpathSync(extensions[0].path), realpathSync(join(installed, "compaction-cache.js")));
    for (const event of [
      "before_provider_request",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
    ]) {
      assert.ok(extensions[0].handlers.has(event), `missing handler for ${event}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
