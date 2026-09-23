import assert from "node:assert/strict";
import test from "node:test";
import { HeadlineScheduler } from "./src/headline-scheduler.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};

test("live thinking requests at token or time thresholds, never overlaps, and settles once", async () => {
	let now = 0;
	const calls = [];
	let active = 0;
	let mostActive = 0;
	const scheduler = new HeadlineScheduler({
		now: () => now,
		summarize: (trace) => {
			active++;
			mostActive = Math.max(mostActive, active);
			const call = { at: now, trace, pending: deferred() };
			calls.push(call);
			return call.pending.promise.finally(() => { active--; });
		},
		onHeadline() {}, onFailure() {},
	});
	const key = "42:0";
	for (let second = 0; second <= 20; second++) {
		now = second * 1000;
		scheduler.observe(key, "x".repeat(Math.max(1, second * 200)));
		scheduler.tick();
		await flush();
		if (second === 7 || second === 14) { calls.at(-1).pending.resolve("Checking progress"); await flush(); }
	}
	assert.deepEqual(calls.map((call) => call.at), [6000, 12000, 18000]);
	scheduler.settle(key);
	assert.equal(calls.length, 3);
	calls.at(-1).pending.resolve("Finishing the trace");
	await flush();
	assert.equal(calls.length, 4);
	assert.equal(mostActive, 1);
	assert.equal(calls.at(-1).at, 20000);
	calls.at(-1).pending.resolve("Final headline");
	await flush();
	scheduler.settle(key);
	assert.equal(calls.length, 4);
	scheduler.dispose();
});

test("a timed-out older snapshot cannot replace a newer result", async () => {
	let now = 0;
	const calls = [];
	const headlines = [];
	const scheduler = new HeadlineScheduler({
		now: () => now, timeoutMs: 5,
		summarize: () => { const call = deferred(); calls.push(call); return call.promise; },
		onHeadline: (_key, headline) => headlines.push(headline), onFailure() {},
	});
	scheduler.observe("1:0", "x".repeat(1600));
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 15));
	now = 6000;
	scheduler.observe("1:0", "y".repeat(3200));
	await flush();
	assert.equal(calls.length, 2);
	calls[1].resolve("Newer result");
	await flush();
	calls[0].resolve("Older result");
	await flush();
	assert.deepEqual(headlines.at(-1), "≈ Newer result");
	scheduler.dispose();
});

test("rejection and timeout keep the fallback and announce once", async () => {
	let now = 0;
	const headlines = [];
	const failures = [];
	const scheduler = new HeadlineScheduler({
		now: () => now, timeoutMs: 5,
		summarize: () => Promise.reject(new Error("broken")),
		onHeadline: (_key, headline) => headlines.push(headline),
		onFailure: (reason) => failures.push(reason),
	});
	scheduler.observe("1:0", "x".repeat(1600));
	await flush();
	now = 6000;
	scheduler.observe("1:0", "x".repeat(3200));
	await flush();
	assert.deepEqual(headlines, [undefined, undefined]);
	assert.deepEqual(failures, ["error"]);
	scheduler.dispose();

	const timed = new HeadlineScheduler({
		now: () => now, timeoutMs: 5, summarize: () => new Promise(() => {}),
		onHeadline: (_key, headline) => headlines.push(headline),
		onFailure: (reason) => failures.push(reason),
	});
	timed.observe("2:0", "x".repeat(1600));
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(headlines.at(-1), undefined);
	assert.equal(failures.at(-1), "timeout");
	timed.dispose();
});
