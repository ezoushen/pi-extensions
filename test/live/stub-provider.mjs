// A minimal OpenAI-compatible chat-completions stub for live-session and
// focus-mode model tests. Started and stopped by each caller, on an
// OS-assigned loopback port -- it is a fixture, not a server, and it never
// reaches an inference lane. Every request body is recorded verbatim so the
// test can assert on what pi's extensions actually put on the wire.
import { createServer } from "node:http";

export function startStubProvider(replyForRequest) {
	const requests = [];

	const server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = { unparsable: body };
			}
			requests.push({ path: req.url, receivedAt: Date.now(), body: parsed });

			const id = `chatcmpl-stub-${requests.length}`;
			const created = Math.floor(Date.now() / 1000);
			const model = parsed.model ?? "stub-model";
			// A tool-free reply, long enough (>=40 chars) that compaction-cache's own
			// comparison-text probe can match it back into the live payload it
			// captured. Summarization calls (recognised by their own system prompt)
			// get a plausible summary shape; ordinary turns get a padded
			// acknowledgement. Neither ever calls a tool, so the agent loop always
			// settles after one assistant turn.
			const isSummarization = /structured summary|context checkpoint/i.test(
				JSON.stringify(parsed.messages ?? []),
			);
			const reply = replyForRequest?.(parsed, requests.length);
			const replyText = typeof reply === "string" ? reply : (isSummarization
				? "## Goal\nStub summary of the conversation so far.\n"
				: "Acknowledged (stub reply). Padded so the comparison-text probe (>=40 chars) matches this turn.");

			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const chunk = (delta, finishReason = null, usage) => res.write(
				`data: ${JSON.stringify({
					id, object: "chat.completion.chunk", created, model,
					choices: [{ index: 0, delta, finish_reason: finishReason }],
					...(usage ? { usage } : {}),
				})}\n\n`,
			);
			if (reply && typeof reply === "object") {
				for (const step of reply.steps) {
					if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
					if (res.destroyed) return;
					chunk(step.delta);
				}
				chunk({}, reply.finishReason ?? "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
				res.end("data: [DONE]\n\n");
				return;
			}
			res.write(
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				port,
				baseUrl: `http://127.0.0.1:${port}/v1`,
				requests,
				close: () => new Promise((res2) => server.close(() => res2())),
			});
		});
	});
}
