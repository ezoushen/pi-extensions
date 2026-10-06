import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerImageThumbnails, { aspectFillArt, decodePng, findImageTokens } from "./image-thumbnails.ts";

/** Encode raw RGBA pixels as a minimal 8-bit non-interlaced PNG. */
function encodePng(width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
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

/** 2×1 image: left pixel red, right pixel blue. */
function redBluePng() {
	return encodePng(2, 1, Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]));
}

function createHarness() {
	const events = new Map();
	const entries = [];
	const entryRenderers = new Map();
	let editorFactory;
	const ui = {
		getEditorComponent: () => editorFactory,
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
		notify: () => {},
		get editorFactory() {
			return editorFactory;
		},
	};
	const pi = {
		on(event, handler) {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
			return () => {};
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		registerEntryRenderer(customType, renderer) {
			entryRenderers.set(customType, renderer);
		},
	};
	return { pi, events, ui, entries, entryRenderers };
}

function makeCtx(ui) {
	return { mode: "tui", hasUI: true, cwd: process.cwd(), isProjectTrusted: () => false, ui };
}

async function runInput(events, text, images = []) {
	const handlers = events.get("input") ?? [];
	let result = { action: "continue" };
	let currentText = text;
	let currentImages = images;
	for (const handler of handlers) {
		const next = await handler({ type: "input", text: currentText, images: currentImages, source: "interactive" }, makeCtx({ notify: () => {} }));
		if (next?.action === "handled") return next;
		if (next?.action === "transform") {
			result = next;
			currentText = next.text;
			if (next.images) currentImages = next.images;
		}
	}
	return result;
}

test("findImageTokens recognizes paths, references, markdown, file URLs, and quotes", () => {
	const text = [
		"look at /tmp/a/shot.png and [Image #1]",
		'mixed "my cat.jpg" plus ![alt](assets/logo.webp)',
		"also file:///tmp/x.bmp and ~/h.png",
	].join("\n");
	const tokens = findImageTokens(text);
	const kinds = tokens.map((t) => [t.kind, t.path ?? t.ref]);
	assert.deepEqual(kinds, [
		["path", "/tmp/a/shot.png"],
		["reference", 1],
		["path", "my cat.jpg"],
		["path", "assets/logo.webp"],
		["path", "file:///tmp/x.bmp"],
		["path", "~/h.png"],
	]);
	// offsets must slice out the raw tokens exactly
	for (const token of tokens) {
		assert.equal(text.slice(token.start, token.end), token.raw);
	}
});

test("findImageTokens leaves prose and extension-less text alone", () => {
	assert.deepEqual(findImageTokens("the file photo.png is not a path"), []);
	assert.deepEqual(findImageTokens("see example.com/img.png for details"), []);
	assert.deepEqual(findImageTokens("plain text, no images"), []);
});

test("findImageTokens keeps trailing punctuation outside the token", () => {
	const tokens = findImageTokens("check /tmp/a.png, please");
	assert.equal(tokens.length, 1);
	assert.equal(tokens[0].raw, "/tmp/a.png");
});

test("decodePng decodes RGBA and detects corruption", () => {
	const png = redBluePng();
	const img = decodePng(png);
	assert.ok(img);
	assert.equal(img.width, 2);
	assert.equal(img.height, 1);
	assert.deepEqual([...img.rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
	assert.equal(decodePng(Buffer.from("not a png")), null);
});

test("aspectFillArt crops to fill and emits half blocks", () => {
	const img = decodePng(redBluePng());
	assert.ok(img);
	const lines = aspectFillArt(img, 4, 1);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("▀"));
	assert.ok(lines[0].includes("\x1b["));
	// wide source, narrow box: crop must not letterbox — every cell is filled
	const wide = decodePng(encodePng(16, 4, new Uint8Array(16 * 4 * 4).fill(200)));
	assert.ok(wide);
	const art = aspectFillArt(wide, 3, 2);
	assert.equal(art.length, 2);
	const stripAnsi = (line) => line.replace(new RegExp("\\x1b\\[[0-9;]*m", "g"), "");
	assert.ok(art.every((line) => stripAnsi(line).length === 3));
});

test("input event attaches existing files and anchors them; missing files pass through", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-thumbs-"));
	try {
		const photo = join(dir, "photo.png");
		writeFileSync(photo, redBluePng());
		const { pi, events } = createHarness();
		registerImageThumbnails(pi);

		const result = await runInput(events, `look at ${photo} please`);
		assert.equal(result.action, "transform");
		assert.equal(result.text, "look at [image: photo.png] please");
		assert.equal(result.images.length, 1);
		assert.equal(result.images[0].type, "image");
		assert.equal(result.images[0].mimeType, "image/png");

		const missing = await runInput(events, "no such /tmp/definitely-missing-9x.png file");
		assert.equal(missing.action, "continue");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("input event resolves [Image #N] against the session registry", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-thumbs-"));
	try {
		const { pi, events } = createHarness();
		registerImageThumbnails(pi);

		// A user message containing an image block registers it as Image #1
		for (const handler of events.get("message_end") ?? []) {
			handler({ type: "message_end", message: { role: "user", content: [
				{ type: "text", text: "here" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			] } });
		}

		const result = await runInput(events, "compare with [Image #1] and [Image #2]");
		assert.equal(result.action, "transform");
		assert.equal(result.text, "compare with [Image #1] and [Image #2]");
		assert.equal(result.images.length, 1); // #2 is unknown and stays text
		assert.equal(result.images[0].data, "abc");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("editor decoration prepends an attachment strip and leaves the prompt text untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-thumbs-"));
	try {
		const photo = join(dir, "photo.png");
		writeFileSync(photo, redBluePng());
		// stable mtime so the cache is deterministic within the test
		utimesSync(photo, new Date(0), new Date(0));
		const { pi, events, ui } = createHarness();
		registerImageThumbnails(pi);

		// A previously-installed editor factory is decorated, not replaced
		ui.setEditorComponent(() => ({
			render: (_width) => ["top", `look at ${photo}`, "bottom"],
		}));

		for (const handler of events.get("session_start") ?? []) {
			handler({ type: "session_start", reason: "startup" }, makeCtx(ui));
		}
		assert.ok(ui.editorFactory, "editor factory registered in tui mode");

		const editor = ui.editorFactory({ requestRender() {} }, { borderColor: (s) => s }, {});
		const rendered = editor.render(40);
		assert.equal(rendered[0], "top");
		assert.equal(rendered[rendered.length - 1], "bottom");
		const stripAnsi = (line) => line.replace(new RegExp("\\x1b\\[[0-9;]*m", "g"), "");
		const plain = rendered.map(stripAnsi);
		// the prompt text is untouched, after the strip
		assert.ok(plain.some((line) => line === `look at ${photo}`), JSON.stringify(plain));
		// the strip names the attachment without emoji or dimensions
		assert.ok(plain.some((line) => line.includes("photo.png") && !line.includes("🖼") && !line.includes("×")), JSON.stringify(plain));
		// the strip carries a half-block thumbnail (async; arrives via requestRender)
		const deadline = Date.now() + 5000;
		let withArt = rendered;
		while (Date.now() < deadline) {
			withArt = editor.render(40);
			if (withArt.some((line) => line.includes("▀"))) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		const artRows = withArt.filter((line) => line.includes("▀"));
		assert.ok(artRows.length > 0 && artRows.length <= 4, `expected at most 4 art rows, got ${artRows.length}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sending a prompt appends a chat preview entry rendered as tiles", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-thumbs-"));
	try {
		const photo = join(dir, "photo.png");
		writeFileSync(photo, redBluePng());
		utimesSync(photo, new Date(0), new Date(0));
		const { pi, events, entries, entryRenderers } = createHarness();
		registerImageThumbnails(pi);

		const result = await runInput(events, `describe ${photo}`);
		assert.equal(result.action, "transform");
		assert.equal(entries.length, 1, "expected one custom entry");
		assert.equal(entries[0].customType, "pi-image-thumbnails");
		assert.equal(entries[0].data.tiles[0].label, "photo.png");

		const renderer = entryRenderers.get("pi-image-thumbnails");
		assert.ok(renderer, "entry renderer registered");
		const stripAnsi = (line) => line.replace(new RegExp("\\x1b\\[[0-9;]*m", "g"), "");
		const theme = { fg: (_token, s) => s };
		// first render: label only (thumbnail decodes); art arrives once cached
		const first = renderer({ customType: "pi-image-thumbnails", data: entries[0].data }, { expanded: false }, theme);
		const deadline = Date.now() + 5000;
		let lines = [];
		while (Date.now() < deadline) {
			lines = first.render(80);
			if (lines.some((line) => line.includes("▀"))) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		const plain = lines.map(stripAnsi);
		assert.ok(plain[0].includes("photo.png"), JSON.stringify(plain));
		const artRows = plain.filter((line) => line.includes("▀"));
		assert.ok(artRows.length > 0 && artRows.length <= 4, `expected <=4 art rows, got ${artRows.length}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
