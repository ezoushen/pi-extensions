import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").join("\n");
}

async function waitForScreen(terminal, predicate, child, timeoutMs = 20000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		await new Promise((resolve) => terminal.write("", resolve));
		const value = screen(terminal);
		if (predicate(value)) return value;
		if (child.exitCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`screen did not reach expected state; final screen:\n${screen(terminal)}`);
}

function send(child, value) {
	child.stdin.write(JSON.stringify({ type: "send", data: Buffer.from(value).toString("base64") }) + "\n");
}

function chunk(toolCallIndex, toolId, path) {
	return { index: toolCallIndex, id: toolId, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } };
}

test("packed exchange-stats folds streamed reasoning and native tool output in a real Pi terminal", async (t) => {
	const piBin = process.env.PI_BIN ?? executable("pi");
	const python = executable("python3");
	let Terminal;
	try { ({ Terminal } = (await import("@xterm/headless")).default); }
	catch { t.skip("@xterm/headless capture dependency is unavailable"); return; }
	if (!piBin) { t.skip("pi binary is unavailable"); return; }
	if (!python) { t.skip("python3 PTY capture tool is unavailable on PATH"); return; }

	const agentDir = mkdtempSync(join(tmpdir(), "pi-fold-tui-"));
	const tarDir = mkdtempSync(join(tmpdir(), "pi-fold-pack-"));
	let stub;
	let child;
	const terminal = new Terminal({ cols: 110, rows: 48, scrollback: 1000, allowProposedApi: true });
	try {
		const firstPath = join(agentDir, "first.txt");
		const secondPath = join(agentDir, "second.txt");
		writeFileSync(firstPath, "FIRST_NATIVE_OUTPUT\n");
		writeFileSync(secondPath, "SECOND_NATIVE_OUTPUT\n");
		stub = await startStubProvider((request, requestNumber) => {
			if (requestNumber === 1) {
				assert.ok(request.tools?.some((tool) => tool.function?.name === "read"), "Pi did not offer read tool");
				return { finishReason: "tool_calls", steps: [
					{ delta: { reasoning_content: "I am inspecting the first item. " } },
					{ delayMs: 1200, delta: { reasoning_content: "The first inspection continues. " } },
					{ delayMs: 1200, delta: { reasoning_content: "The second item is next. " } },
					{ delayMs: 600, delta: { content: "I will read both files.\n" } },
					{ delta: { tool_calls: [chunk(0, "call_first", firstPath), chunk(1, "call_second", secondPath)] } },
				] };
			}
			return { steps: [
				{ delta: { reasoning_content: "Both files were read. " } },
				{ delayMs: 300, delta: { content: "Both file contents are available.\n" } },
			] };
		});
		const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", tarDir, join(root, "extensions/exchange-stats")], { encoding: "utf8" }))[0];
		execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", join(tarDir, packed.filename)], { cwd: agentDir, encoding: "utf8" });
		const packagePath = join(agentDir, "node_modules/pi-exchange-stats");
		assert.ok(existsSync(join(packagePath, "exchange-stats.js")));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "stub", defaultModel: "free-model", defaultProjectTrust: "never",
			packages: [packagePath],
		}));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: {
			baseUrl: stub.baseUrl, api: "openai-completions", apiKey: "stub-key",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [{ id: "free-model", name: "Free Model (stub)", reasoning: true, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
		} } }));

		child = spawn(python, [runner, piBin, "--provider", "stub", "--model", "free-model", "--no-session",
			"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"], {
			cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (data) => terminal.write(data));
		let errors = "";
		child.stderr.on("data", (data) => { errors += data; });
		await waitForScreen(terminal, (value) => value.includes("⏱ ready") && value.includes("free-model"), child);
		send(child, "Check both files and summarize them.\r");
		const firstLive = await waitForScreen(terminal, (value) => /▸.*◈.*\d(?:\.\d)?s/.test(value), child, 15000);
		const secondLive = await waitForScreen(terminal, (value) => {
			const first = firstLive.match(/▸.*◈.*?(\d+(?:\.\d+)?)s/);
			const current = value.match(/▸.*◈.*?(\d+(?:\.\d+)?)s/);
			return first && current && Number(current[1]) > Number(first[1]);
		}, child, 15000);
		assert.match(secondLive, /▸.*◈/);
		const settled = await waitForScreen(terminal, (value) =>
			value.includes("Both file contents are available.") && value.includes("Exchange 1") &&
			(value.match(/▸.*◈/g)?.length ?? 0) >= 2, child, 20000);
		assert.match(settled, /I will read both files/);
		assert.doesNotMatch(settled, /FIRST_NATIVE_OUTPUT|SECOND_NATIVE_OUTPUT/);
		assert.doesNotMatch(settled, /Turn 1|Turn 2/);

		// Pi's own result renderer requires its global details view for read output.
		send(child, "\x0f");
		send(child, "\x1b\x06");
		const levelTwo = await waitForScreen(terminal, (value) => value.includes("first.txt") && value.includes("second.txt"), child);
		assert.match(levelTwo, /◈/);
		assert.doesNotMatch(levelTwo, /FIRST_NATIVE_OUTPUT|SECOND_NATIVE_OUTPUT/);
		send(child, "\x1b\x13");
		await waitForScreen(terminal, (value) => value.includes("Fold exchange / process / block"), child);
		for (let i = 0; i < 4; i++) { send(child, "\x1b[B"); await new Promise((resolve) => setTimeout(resolve, 80)); }
		send(child, "\r");
		send(child, "\x1b");
		const opened = await waitForScreen(terminal, (value) => value.includes("FIRST_NATIVE_OUTPUT"), child);
		assert.doesNotMatch(opened, /SECOND_NATIVE_OUTPUT/);
		assert.match(opened, /▸ ◈1 ⚙0/);
		assert.match(opened, /second\.txt/);
		assert.match(opened, /I will read both files/);
		assert.match(opened, /Both file contents are available/);
		assert.match(opened, /Exchange 1/);
		assert.ok(!errors, errors);
	} finally {
		if (child && child.exitCode === null) {
			child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
			await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
			if (child.exitCode === null) child.kill("SIGTERM");
		}
		terminal.dispose();
		if (stub) await stub.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tarDir, { recursive: true, force: true });
	}
});
