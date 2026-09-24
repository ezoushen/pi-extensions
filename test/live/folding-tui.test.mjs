import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

function optionClickProgress(child, value) {
	const rows = value.split("\n");
	const y = rows.findLastIndex((row) => /[▸▾] Worked for/.test(row));
	assert.ok(y >= 0, "screen is missing the progress line");
	const x = rows[y].indexOf("Worked for") + 1;
	send(child, `\x1b[<8;${x};${y + 1}M`);
	send(child, `\x1b[<8;${x};${y + 1}m`);
}

function chunk(toolCallIndex, toolId, path) {
	return { index: toolCallIndex, id: toolId, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } };
}

function expectedFinishLabel(at, now, timeZone) {
	const date = new Date(at);
	const localTime = date.toLocaleTimeString(undefined, {
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone,
	});
	const localDate = date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone });
	const dateKey = (value) => value.toLocaleDateString(undefined, { timeZone });
	return dateKey(date) === dateKey(new Date(now)) ? localTime : localDate + " " + localTime;
}

function exchangeCardRows(value) {
	const rows = value.split("\n").map((line) => line.trim());
	const cardPattern = /^(⏱ (?:\d+(?:\.\d+)?ms|\d+(?:\.\d+)?s|\d+m(?:\d+s)?) · .+ · free-model)(?: (.*))?$/;
	const metricsPattern = /^in \S+ · out \S+(?: · cache .+)?(?: · waiting \S+)? · \$0$/;
	const cards = rows.map((line) => cardPattern.exec(line)).filter(Boolean);
	const latest = cards.at(-1);
	const headline = latest?.[1];
	const metrics = latest?.[2];
	return {
		headline,
		metrics: metrics && metricsPattern.test(metrics) ? metrics : undefined,
		count: cards.length,
	};
}

test("exchangeCardRows reads the headline and metrics from one row", () => {
	const value = "⏱ 2s · 13:38:35 · free-model in 9.5k · out 234 · $0";
	const result = exchangeCardRows(value);
	assert.equal(result.count, 1);
	assert.equal(result.headline, "⏱ 2s · 13:38:35 · free-model");
	assert.equal(result.metrics, "in 9.5k · out 234 · $0");
});

test("exchangeCardRows does not pair the latest headline with earlier metrics", () => {
	const value = [
		"⏱ 1s · 13:38:34 · free-model in 9.5k · out 234 · $0",
		"⏱ 2s · 13:38:35 · free-model",
	].join("\n");
	const result = exchangeCardRows(value);
	assert.equal(result.count, 2);
	assert.equal(result.headline, "⏱ 2s · 13:38:35 · free-model");
	assert.equal(result.metrics, undefined);
});

test("packed exchange-stats folds streamed reasoning and native tool output in a real Pi terminal", async (t) => {
	const piBin = process.env.PI_BIN ?? executable("pi");
	const python = executable("python3");
	let Terminal;
	try { ({ Terminal } = (await import("@xterm/headless")).default); }
	catch { t.skip("@xterm/headless capture dependency is unavailable"); return; }
	if (!piBin) { t.skip("pi binary is unavailable"); return; }
	if (!python) { t.skip("python3 PTY capture tool is unavailable on PATH"); return; }

	const timeZone = "Asia/Taipei";
	const agentDir = mkdtempSync(join(tmpdir(), "pi-fold-tui-"));
	const tarDir = mkdtempSync(join(tmpdir(), "pi-fold-pack-"));
	const evidencePath = process.env.PI_EXCHANGE_STATS_EVIDENCE_PATH;
	let stub;
	let child;
	let ansiCapture = "";
	const terminal = new Terminal({ cols: 110, rows: 48, scrollback: 1000, allowProposedApi: true });
	try {
		const firstPath = join(agentDir, "first.txt");
		const secondPath = join(agentDir, "second.txt");
		writeFileSync(firstPath, "FIRST_NATIVE_OUTPUT\n");
		writeFileSync(secondPath, "SECOND_NATIVE_OUTPUT\n");
		stub = await startStubProvider((request, requestNumber) => {
			if (requestNumber === 1) return { steps: [
				{ delta: { reasoning_content: "I am checking one result. " } },
				{ delayMs: 300, delta: { content: "The single-step result is ready.\n" } },
			] };
			if (requestNumber === 2) {
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

		child = spawn(python, [runner, piBin, "--provider", "stub", "--model", "free-model", "--tui-mode", "fullscreen", "--no-session",
			"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"], {
			cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TERM: "xterm-256color", TZ: timeZone }, stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (data) => {
			if (evidencePath) ansiCapture += data.toString("utf8");
			terminal.write(data);
		});
		let errors = "";
		child.stderr.on("data", (data) => { errors += data; });
		await waitForScreen(terminal, (value) => value.includes("⏱ ready") && value.includes("free-model"), child);
		send(child, "Give one short result.\r");
		const singleSettled = await waitForScreen(terminal, (value) =>
			value.includes("The single-step result is ready.") && exchangeCardRows(value).headline && exchangeCardRows(value).metrics &&
			/▸ Worked for .*◈ 1 ⚙ 0/.test(value), child, 20000);
		const singleProgress = singleSettled.split("\n").find((line) => line.includes("▸ Worked for"));
		assert.ok(singleProgress, "single-step screen is missing its folded progress line");
		assert.match(singleProgress, /◈ 1 ⚙ 0/);
		assert.doesNotMatch(singleProgress, /notes?/);

		send(child, "Check both files and summarize them.\r");
		const firstLive = await waitForScreen(terminal, (value) => /▸.*◈.*\d(?:\.\d)?s/.test(value), child, 15000);
		const secondLive = await waitForScreen(terminal, (value) => {
			const first = firstLive.match(/▸.*◈.*?(\d+(?:\.\d+)?)s/);
			const current = value.match(/▸.*◈.*?(\d+(?:\.\d+)?)s/);
			return first && current && Number(current[1]) > Number(first[1]);
		}, child, 15000);
		assert.match(secondLive, /▸.*◈/);
		const settled = await waitForScreen(terminal, (value) =>
			value.includes("Both file contents are available.") && exchangeCardRows(value).count >= 2 && exchangeCardRows(value).metrics &&
			/▸ Worked for .*◈/.test(value), child, 20000);
		const { headline: exchangeHeadline, metrics: exchangeMetrics } = exchangeCardRows(settled);
		assert.ok(exchangeHeadline, "settled screen is missing the exchange card headline");
		assert.ok(exchangeMetrics, "settled screen is missing the exchange card metrics");
		assert.doesNotMatch(exchangeHeadline, /Exchange \d/);
		assert.doesNotMatch(exchangeMetrics, /\b(?:turns?|prompts?|tools|thinking|total)\b/);
		const capturedAt = Date.now();
		// PTY redraw can cross a second boundary after the exchange has settled.
		const expectedTimes = [0, 1_000].map((delta) => expectedFinishLabel(capturedAt - delta, capturedAt, timeZone));
		assert.ok(expectedTimes.some((value) => exchangeHeadline.includes(value)), "exchange finish time did not match the local clock: " + exchangeHeadline);

		optionClickProgress(child, settled);
		const optionOpened = await waitForScreen(terminal, (value) =>
			value.includes("▾ Worked for") && value.includes("▾ ◈ 1 ⚙ 0") && value.includes("▾ ◈ 1 ⚙ 2") &&
			value.includes("first.txt") && value.includes("second.txt"), child);
		assert.doesNotMatch(optionOpened, /FIRST_NATIVE_OUTPUT|SECOND_NATIVE_OUTPUT/);
		optionClickProgress(child, optionOpened);
		const optionFolded = await waitForScreen(terminal, (value) =>
			value.includes("▸ Worked for") && !value.includes("▾ ◈ 1 ⚙ 0") && !value.includes("▾ ◈ 1 ⚙ 2"), child);
		assert.doesNotMatch(settled, /FIRST_NATIVE_OUTPUT|SECOND_NATIVE_OUTPUT/);
		assert.doesNotMatch(settled, /Turn 1|Turn 2/);

		// Pi's own result renderer requires its global details view for read output.
		send(child, "\x0f");
		send(child, "\x1b\x05");
		send(child, "\x1b\x06");
		const levelTwo = await waitForScreen(terminal, (value) => value.includes("first.txt") && value.includes("second.txt"), child);
		assert.match(levelTwo, /◈/);
		assert.match(levelTwo, /├/);
		assert.match(levelTwo, /└/);
		assert.match(levelTwo, /│/);
		assert.doesNotMatch(levelTwo, /FIRST_NATIVE_OUTPUT|SECOND_NATIVE_OUTPUT/);
		send(child, "\x1b\x13");
		await waitForScreen(terminal, (value) => value.includes("Fold exchange / process / block"), child);
		for (let i = 0; i < 7; i++) { send(child, "\x1b[B"); await new Promise((resolve) => setTimeout(resolve, 80)); }
		send(child, "\r");
		send(child, "\x1b");
		const opened = await waitForScreen(terminal, (value) => value.includes("FIRST_NATIVE_OUTPUT"), child);
		assert.doesNotMatch(opened, /SECOND_NATIVE_OUTPUT/);
		assert.match(opened, /▸ ◈ 1 ⚙ 0/);
		assert.match(opened, /second\.txt/);
		assert.match(opened, /I will read both files/);
		assert.match(opened, /Both file contents are available/);
		assert.ok(exchangeCardRows(opened).headline, "opened screen is missing the exchange card headline");
		assert.match(opened, /├/);
		assert.match(opened, /└/);
		assert.match(opened, /│/);
		if (evidencePath) {
			mkdirSync(dirname(evidencePath), { recursive: true });
			writeFileSync(evidencePath, `option-click unwound the multi-step exchange:\n${optionOpened}\n\noption-click folded progress again:\n${optionFolded}\n\npicker-opened native output:\n${opened}\n`);
			assert.match(ansiCapture, /\x1b\[3m/, "live ANSI capture does not include italic styling");
		}
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
