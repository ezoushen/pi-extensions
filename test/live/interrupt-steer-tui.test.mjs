import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startStubProvider } from "./stub-provider.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = join(dirname(fileURLToPath(import.meta.url)), "pty-runner.py");

function executable(name) {
	try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); }
	catch { return undefined; }
}

function screen(terminal) {
	const buffer = terminal.buffer.active;
	return Array.from({ length: terminal.rows }, (_, row) =>
		(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").trimEnd()).join("\n");
}

async function waitForScreen(terminal, predicate, child, description, timeoutMs = 20000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		await new Promise((resolve) => terminal.write("", resolve));
		const value = screen(terminal);
		if (predicate(value)) return value;
		if (child.exitCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${description}; stderr: ${child.stderrText ?? ""}\nfinal screen:\n${screen(terminal)}`);
}

function send(child, value) {
	child.stdin.write(JSON.stringify({ type: "send", data: Buffer.from(value).toString("base64") }) + "\n");
}

function textContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part?.text ?? "").join("");
}

function lastUserText(request) {
	const message = (request.body?.messages ?? request.messages ?? []).findLast((item) => item.role === "user");
	return message ? textContent(message.content) : "";
}

function assertSentOnce(request, expected) {
	const userTexts = (request.body?.messages ?? request.messages ?? [])
		.filter((message) => message.role === "user")
		.map((message) => textContent(message.content));
	assert.equal(userTexts.at(-1), expected);
	assert.equal(userTexts.filter((text) => text === expected).length, 1);
}

function slowResponse(prefix, ending) {
	return { steps: [
		{ delta: { content: `${prefix}_CHUNK_01 ` } },
		...Array.from({ length: 20 }, (_, index) => ({
			delayMs: 250,
			delta: { content: `${prefix}_CHUNK_${String(index + 2).padStart(2, "0")} ` },
		})),
		{ delta: { content: ending } },
	] };
}

async function stopPty(child) {
	if (!child || child.exitCode !== null) return;
	child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
	const stopped = await Promise.race([
		once(child, "exit").then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
	]);
	assert.equal(stopped, true, "PTY runner did not exit after its stop command");
}

test("packed interrupt-steer interrupts and sends from a real Pi 0.87.1 terminal", async (t) => {
	const piBin = process.env.PI_BIN ?? executable("pi");
	const python = executable("python3");
	let Terminal;
	try { ({ Terminal } = (await import("@xterm/headless")).default); }
	catch { t.skip("@xterm/headless capture dependency is unavailable"); return; }
	if (!piBin) { t.skip("pi binary is unavailable"); return; }
	if (!python) { t.skip("python3 PTY capture tool is unavailable on PATH"); return; }
	assert.equal(execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim(), "0.87.1");

	const agentDir = mkdtempSync(join(tmpdir(), "pi-interrupt-steer-agent-"));
	const tarDir = mkdtempSync(join(tmpdir(), "pi-interrupt-steer-pack-"));
	const evidencePath = process.env.PI_INTERRUPT_STEER_EVIDENCE_PATH;
	const terminal = new Terminal({ cols: 110, rows: 48, scrollback: 1000, allowProposedApi: true });
	const snapshots = [];
	let stub;
	let child;
	let errors = "";

	try {
		const toolStartedPath = join(agentDir, "interrupt-steer-tool-started");
		const toolEndedPath = join(agentDir, "interrupt-steer-tool-ended");
		stub = await startStubProvider((request, requestNumber) => {
			const userText = lastUserText(request);
			if (userText === "Start the stream interrupt check.") return slowResponse("STREAM", "STREAM_FINISHED");
			if (userText === "Use the replacement plan.") return "STEERED_RESPONSE_FINISHED";
			if (userText === "Start the legacy key check.") return slowResponse("LEGACY", "LEGACY_STREAM_FINISHED");
			if (userText === "Send this as a legacy follow-up.") return "LEGACY_FOLLOWUP_FINISHED";
			if (userText === "Start the slow tool check." && requestNumber === 5) return { finishReason: "tool_calls", steps: [{
				delta: { tool_calls: [{
					index: 0,
					id: "interrupt-steer-slow-tool",
					type: "function",
					function: { name: "bash", arguments: JSON.stringify({
						command: `touch ${JSON.stringify(toolStartedPath)}; sleep 60; touch ${JSON.stringify(toolEndedPath)}`,
					}) },
				}] },
			}] };
			if (userText === "Start the slow tool check.") return "TOOL_FINISHED_WITHOUT_INTERRUPT";
			if (userText === "Continue with the tool replacement.") return "TOOL_STEERED_RESPONSE_FINISHED";
			return `UNEXPECTED_STUB_REQUEST ${JSON.stringify(userText)}`;
		});

		const packed = JSON.parse(execFileSync("npm", [
			"pack", "--json", "--pack-destination", tarDir, join(root, "extensions/interrupt-steer"),
		], { encoding: "utf8" }))[0];
		execFileSync("npm", [
			"install", "--offline", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund",
			join(tarDir, packed.filename),
		], { cwd: agentDir, encoding: "utf8" });
		const packagePath = join(agentDir, "node_modules/pi-interrupt-steer");
		assert.ok(existsSync(join(packagePath, "interrupt-steer.js")), "packed package entry is missing");
		const readinessPath = join(agentDir, "interrupt-steer-readiness");
		mkdirSync(readinessPath);
		writeFileSync(join(readinessPath, "package.json"), JSON.stringify({
			name: "pi-interrupt-steer-readiness",
			type: "module",
			main: "./readiness.mjs",
			pi: { extensions: ["./readiness.mjs"] },
		}));
		writeFileSync(join(readinessPath, "readiness.mjs"), `export default function (pi) {
	pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("interrupt-steer-live-test", "interrupt-steer-ready"));
}\n`);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "stub",
			defaultModel: "free-model",
			defaultProjectTrust: "never",
			packages: [packagePath, readinessPath],
		}));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: {
			baseUrl: stub.baseUrl,
			api: "openai-completions",
			apiKey: "stub-key",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [{ id: "free-model", name: "Free Model (stub)", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
		} } }));

		child = spawn(python, [runner, piBin, "--provider", "stub", "--model", "free-model", "--tui-mode", "fullscreen",
			"--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"], {
			cwd: agentDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (data) => terminal.write(data));
		child.stderr.on("data", (data) => {
			errors += data.toString("utf8");
			child.stderrText = errors;
		});
		await waitForScreen(terminal, (value) => value.includes("interrupt-steer-ready"), child, "Pi did not start its session");

		send(child, "Start the stream interrupt check.\r");
		const firstResponse = await waitForScreen(terminal,
			(value) => value.includes("STREAM_CHUNK_01") || value.includes("UNEXPECTED_STUB_REQUEST"),
			child, "slow response did not start");
		assert.ok(firstResponse.includes("STREAM_CHUNK_01"), `unexpected stub request: ${JSON.stringify(lastUserText(stub.requests[0]))}`);
		send(child, "Use the replacement plan.");
		const streamTyped = await waitForScreen(terminal, (value) => value.includes("Use the replacement plan."), child, "editor text was not visible during streaming");
		snapshots.push("CSI-u while streaming, before interrupt:\n" + streamTyped);
		send(child, "\x1b[13;7u");
		const streamSteered = await waitForScreen(terminal, (value) => value.includes("STEERED_RESPONSE_FINISHED"), child, "CSI-u did not interrupt and start the replacement response");
		assert.doesNotMatch(streamSteered, /STREAM_FINISHED/);
		assertSentOnce(stub.requests[1], "Use the replacement plan.");
		snapshots.push("CSI-u replacement response:\n" + streamSteered);

		send(child, "Start the legacy key check.\r");
		await waitForScreen(terminal, (value) => value.includes("LEGACY_CHUNK_01"), child, "legacy response did not start");
		send(child, "Send this as a legacy follow-up.");
		await waitForScreen(terminal, (value) => value.includes("Send this as a legacy follow-up."), child, "legacy follow-up text was not visible");
		send(child, "\x1b\r");
		const legacyFollowUp = await waitForScreen(terminal,
			(value) => value.includes("LEGACY_STREAM_FINISHED") && value.includes("LEGACY_FOLLOWUP_FINISHED"),
			child, "ESC CR did not queue a follow-up after the current response");
		assert.ok(legacyFollowUp.indexOf("LEGACY_STREAM_FINISHED") < legacyFollowUp.indexOf("LEGACY_FOLLOWUP_FINISHED"));
		assertSentOnce(stub.requests[3], "Send this as a legacy follow-up.");
		snapshots.push("ESC CR was Pi alt+enter follow-up, after the original response:\n" + legacyFollowUp);

		send(child, "Start the slow tool check.\r");
		const toolDeadline = Date.now() + 10000;
		while (!existsSync(toolStartedPath) && Date.now() < toolDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(existsSync(toolStartedPath), `Pi did not start the bash tool:\n${screen(terminal)}`);
		assert.equal(existsSync(toolEndedPath), false, "slow tool finished before the interrupt");
		const toolActive = screen(terminal);
		assert.ok(stub.requests[4].body.tools.some((tool) => tool.function?.name === "bash"), "Pi did not offer its bash tool");
		send(child, "Continue with the tool replacement.");
		const toolTyped = await waitForScreen(terminal,
			(value) => value.includes("Continue with the tool replacement."),
			child, "editor text was not visible during the tool call");
		snapshots.push("CSI-u during active tool call, before interrupt:\n" + toolTyped);
		send(child, "\x1b[13;7u");
		const toolSteered = await waitForScreen(terminal,
			(value) => value.includes("TOOL_STEERED_RESPONSE_FINISHED"),
			child, "CSI-u did not send the editor text after aborting the tool call");
		assert.doesNotMatch(toolSteered, /TOOL_ENDED/);
		assertSentOnce(stub.requests[5], "Continue with the tool replacement.");
		assert.equal(existsSync(toolEndedPath), false, "the aborted tool ran its command after sleep");
		assert.ok(toolActive.includes("Start the slow tool check."));
		snapshots.push("CSI-u replacement response after tool abort:\n" + toolSteered);

		assert.equal(stub.requests.length, 6, "unexpected provider request count");
		assert.equal(errors, "", errors);
		console.log("KEY ENCODINGS: CSI-u interrupted and sent during streaming and an active tool call; ESC CR queued an alt+enter follow-up after the original response.");
		if (evidencePath) {
			mkdirSync(dirname(evidencePath), { recursive: true });
			writeFileSync(evidencePath, `Pi 0.87.1; package loaded from packed tarball.\n\n${snapshots.join("\n\n")}`);
		}
	} finally {
		await stopPty(child);
		terminal.dispose();
		if (stub) await stub.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tarDir, { recursive: true, force: true });
	}
});
