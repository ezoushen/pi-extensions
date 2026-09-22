import assert from "node:assert/strict";
import test from "node:test";

import { announce } from "../shared/announce.ts";

function captureStderr(fn) {
	const chunks = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stderr.write = original;
	}
	return chunks.join("");
}

test("hasUI false: the message reaches stderr exactly once across repeated triggers", () => {
	const notified = [];
	const ctx = { hasUI: false, ui: { notify: (message, level) => notified.push([message, level]) } };
	const out = captureStderr(() => {
		announce(ctx, "pi-example: something the operator must see", "warning", "print-mode-unique-reason");
		announce(ctx, "pi-example: something the operator must see", "warning", "print-mode-unique-reason");
		announce(ctx, "pi-example: something the operator must see", "warning", "print-mode-unique-reason");
	});
	assert.equal(out, "pi-example: something the operator must see\n");
	assert.deepEqual(notified, []);
});

test("hasUI true: stderr stays empty and the existing notify path is used unchanged", () => {
	const notified = [];
	const ctx = { hasUI: true, ui: { notify: (message, level) => notified.push([message, level]) } };
	const out = captureStderr(() => {
		announce(ctx, "pi-example: interactive notice", "info", "interactive-unique-reason");
		announce(ctx, "pi-example: interactive notice", "info", "interactive-unique-reason");
	});
	assert.equal(out, "");
	// The interactive path is not de-duplicated by announce itself -- that
	// remains the caller's own responsibility, unchanged from before.
	assert.deepEqual(notified, [
		["pi-example: interactive notice", "info"],
		["pi-example: interactive notice", "info"],
	]);
});

test("hasUI absent (as in every context predating this contract): treated as interactive, not silenced to stderr", () => {
	const notified = [];
	const ctx = { ui: { notify: (message, level) => notified.push([message, level]) } };
	const out = captureStderr(() => {
		announce(ctx, "pi-example: default-context notice", "warning");
	});
	assert.equal(out, "");
	assert.deepEqual(notified, [["pi-example: default-context notice", "warning"]]);
});

test("hasUI false with distinct reasons: each distinct reason reaches stderr once", () => {
	const out = captureStderr(() => {
		announce({ hasUI: false }, "first distinct message", "warning", "reason-a");
		announce({ hasUI: false }, "second distinct message", "warning", "reason-b");
		announce({ hasUI: false }, "first distinct message", "warning", "reason-a");
	});
	assert.equal(out, "first distinct message\nsecond distinct message\n");
});
