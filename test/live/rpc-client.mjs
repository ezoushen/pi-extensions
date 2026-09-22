// A tiny client for `pi --mode rpc`, used only by the live-session test in
// this directory. Sends JSON-line commands on stdin, collects JSON-line
// events/responses from stdout. Real RPC framing (LF-delimited JSONL) per
// docs/rpc.md, not a generic line reader.
import { spawn } from "node:child_process";

export function spawnPiRpc(piBin, args, env) {
	const child = spawn(piBin, args, { stdio: ["pipe", "pipe", "pipe"], env });
	const events = [];
	const stderr = [];
	let buf = "";

	child.stdout.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.trim()) {
				try {
					events.push(JSON.parse(line));
				} catch {
					/* non-JSON stdout noise, ignored */
				}
			}
		}
	});
	child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

	function send(cmd) {
		child.stdin.write(JSON.stringify(cmd) + "\n");
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Wait for a response with the given id, or a matching event predicate. */
	async function waitFor(predicate, timeoutMs = 20000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const found = events.find(predicate);
			if (found) return found;
			await sleep(50);
		}
		throw new Error(`timed out waiting for event (${timeoutMs}ms); stderr=${stderr.join("")}`);
	}

	async function promptAndWaitIdle(message, id) {
		send({ id, type: "prompt", message });
		await waitFor((e) => e.id === id && e.type === "response");
		await waitFor((e) => e.type === "agent_settled", 20000);
	}

	async function stop() {
		child.stdin.end();
		await sleep(300);
		child.kill("SIGTERM");
		await sleep(300);
		if (!child.killed) child.kill("SIGKILL");
	}

	return { events, stderr, send, waitFor, promptAndWaitIdle, stop, child };
}
