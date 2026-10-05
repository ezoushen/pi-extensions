// The end-to-end proof unit tests cannot give: install the PACKED TARBALL of
// pi-image-thumbnails (not the working tree) into a scratch pi agent
// directory, run a real `pi --mode rpc` session against a stub
// OpenAI-compatible provider this test starts and stops itself on a free
// local port, submit a prompt that names a real PNG on disk, and observe -- on
// the wire, not in a function call -- that the model request carried an image
// block with an `[image: name]` anchor, and that a missing file attached
// nothing.
//
// Hermetic: no inference lane is contacted (only 127.0.0.1, an OS-assigned
// port), and this never touches `~/.pi/agent` -- `PI_CODING_AGENT_DIR` points
// pi at a fresh scratch directory for the run, removed afterwards.
//
// Not part of the default `npm test` glob; run explicitly with
// `npm run test:live` or
// `node --experimental-strip-types --test test/live/image-thumbnails.test.mjs`.
// Requires the `pi` binary from PATH or `PI_BIN`; skips (does not fail) if pi
// cannot be found, since this drives a real external tool this package does
// not vendor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { startStubProvider } from "./stub-provider.mjs";
import { spawnPiRpc } from "./rpc-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE = "image-thumbnails";
const PACKAGE_NAME = "pi-image-thumbnails";

function resolvePiBin() {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function packAndInstall(agentDir) {
	const tarDir = mkdtempSync(join(tmpdir(), "pi-thumbs-live-tarball-"));
	const packed = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", tarDir, join(repoRoot, "extensions", PACKAGE)],
			{ encoding: "utf8" },
		),
	)[0];
	execFileSync(
		"npm",
		["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(tarDir, packed.filename)],
		{ cwd: agentDir, encoding: "utf8" },
	);
	return join(agentDir, "node_modules", PACKAGE_NAME);
}

/** Minimal valid PNG: 2×1, one red pixel and one blue pixel. */
function redBluePng() {
	const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function setupScratchAgent(stubBaseUrl, packagePath) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-thumbs-live-agent-"));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: "stub",
				defaultModel: "free-model",
				defaultProjectTrust: "never",
				packages: [packagePath],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					stub: {
						baseUrl: stubBaseUrl,
						api: "openai-completions",
						apiKey: "stub-key",
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						models: [
							{
								id: "free-model",
								name: "Free Model (stub)",
								reasoning: false,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	return agentDir;
}

function envFor(agentDir) {
	return { ...process.env, PI_CODING_AGENT_DIR: agentDir };
}

const RPC_ARGS = [
	"--mode",
	"rpc",
	"--provider",
	"stub",
	"--model",
	"free-model",
	"--no-session",
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--offline",
];

test("packed tarball, installed into a scratch agent directory, attaches image blocks in a real pi session", async (t) => {
	const piBin = resolvePiBin();
	if (!piBin) {
		t.skip("pi binary not found on PATH or PI_BIN; cannot drive a real session");
		return;
	}

	const stub = await startStubProvider();
	try {
		const packagePath = packAndInstall(tmpdir());
		const agentDir = setupScratchAgent(stub.baseUrl, packagePath);
		try {
			const photo = join(agentDir, "photo.png");
			writeFileSync(photo, redBluePng());
			const photoBase64 = redBluePng().toString("base64");

			const rpc = spawnPiRpc(piBin, RPC_ARGS, envFor(agentDir));
			try {
				await rpc.promptAndWaitIdle(`Describe ${photo} in one word.`, "p1");

				const request = stub.requests.find(
					(r) => typeof r.body === "object" && r.body !== null && Array.isArray(r.body.messages),
				);
				assert.ok(request, "the stub provider received no chat request");
				const content = request.body.messages.find((m) => m.role === "user")?.content;
				assert.ok(Array.isArray(content), "the user message was not multipart");
				const textPart = content.find((part) => part.type === "text");
				const imagePart = content.find((part) => part.type === "image_url");
				assert.match(textPart?.text ?? "", /\[image: photo\.png\]/, "the anchor is missing from the sent text");
				assert.ok(imagePart, "no image block reached the provider");
				assert.equal(
					imagePart.image_url.url,
					`data:image/png;base64,${photoBase64}`,
					"the attached image bytes do not match the file",
				);

				// A missing file must pass through untouched: the NEW user message in
				// turn 2 attaches nothing (earlier history still carries turn 1's image).
				const before = stub.requests.length;
				await rpc.promptAndWaitIdle("no such /tmp/definitely-missing-thumbs-9x.png file", "p2");
				const second = stub.requests.slice(before).find((r) => Array.isArray(r.body?.messages));
				assert.ok(second, "the second turn never reached the provider");
				const userMessages = second.body.messages.filter((m) => m.role === "user");
				const lastUser = userMessages[userMessages.length - 1];
				assert.ok(Array.isArray(lastUser?.content), "the second user message was not multipart");
				assert.equal(
					lastUser.content.some((part) => part.type === "image_url"),
					false,
					"a missing file attached an image block",
				);
				assert.match(lastUser.content.find((part) => part.type === "text")?.text ?? "", /definitely-missing-thumbs-9x\.png/);
				assert.equal(rpc.events.filter((e) => e.type === "extension_error").length, 0);
			} finally {
				await rpc.stop();
			}
		} finally {
			execFileSync("rm", ["-rf", agentDir]);
		}
	} finally {
		await stub.close();
	}
});
