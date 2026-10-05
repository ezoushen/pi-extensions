import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToPng, CustomEditor } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, type EditorComponent, getCapabilities, type TUI, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

/**
 * Image thumbnails for pi.
 *
 * Two halves, one contract: every way an image can appear in the prompt
 * editor -- a pasted file path, a `[Image #1]` reference, a markdown image,
 * a file:// URL -- becomes a real image block on the message that is sent,
 * and a small aspect-fill thumbnail in the editor itself while you type.
 *
 * - On submit (`input` event): each image token is replaced by an actual
 *   `ImageContent` block. Path tokens are rewritten to `[image: name]`
 *   anchors; `[Image #N]` references stay verbatim and resolve against the
 *   images this session has already seen (user messages and tool results,
 *   in order of appearance).
 * - In the editor (`setEditorComponent`): a line that is exactly an image
 *   token is replaced in place by an attachment chip plus an aspect-fill
 *   half-block thumbnail; tokens inline with other text render as a chip.
 *   A token the cursor sits inside is left untouched until the cursor
 *   moves away, so cursor arithmetic is never disturbed.
 */

interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

interface TokenMatch {
	start: number;
	end: number;
	raw: string;
	kind: "path" | "reference";
	/** For path tokens: the path as written (before ~ and cwd resolution). */
	path?: string;
	/** For reference tokens: the 1-based image number. */
	ref?: number;
}

const EXT = "png|jpe?g|gif|webp|bmp|avif|tiff?";

const PATTERNS: Array<{ regex: RegExp; build: (m: RegExpExecArray) => TokenMatch | null }> = [
	// ![alt](path) and [x](path) markdown images
	{
		regex: new RegExp(`\\[[^\\]\\n]*\\]\\(\\s*([^)\\s]+\\.(?:${EXT}))\\s*\\)`, "gi"),
		build: (m) => ({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: "path", path: m[1] }),
	},
	// file:///… URLs
	{
		regex: new RegExp(`file://[^\\s"'\\\`<>()]+\\.(?:${EXT})`, "gi"),
		build: (m) => ({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: "path", path: m[0] }),
	},
	// [Image #1], [image: 2], [Image 3]
	{
		regex: /\[\s*image\s*(?:#\s*|:\s*)?(\d+)\s*\]/gi,
		build: (m) => ({
			start: m.index,
			end: m.index + m[0].length,
			raw: m[0],
			kind: "reference",
			ref: Number(m[1]),
		}),
	},
	// "quoted paths" (may contain spaces)
	{
		regex: new RegExp(`"([^"\\n]+\\.(?:${EXT}))"`, "gi"),
		build: (m) => ({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: "path", path: m[1] }),
	},
	// bare paths: absolute, ~/…, ./…, ../…, or any relative path containing a
	// slash. A colon is excluded from candidates so URLs break the match, and
	// trailing punctuation is left outside via the lookahead.
	{
		regex: new RegExp(
			`(?:^|(?<=[\\s(>\\[,;=]))((?:\\.{1,2}/)?[^\\s"'\\\`<>()\\[\\]{};:|*?\\\\]+\\.(?:${EXT}))(?=$|[\\s)\\]},.;:!?])`,
			"gi",
		),
		build: (m) => {
			const candidate = m[1];
			if (candidate === undefined || !candidate.includes("/")) return null; // a bare filename is prose, not a path
			if (!candidate.startsWith("./") && !candidate.startsWith("../")) {
				// reject domain-like candidates (example.com/img.png) but keep
				// plain relative paths (assets/logo.png)
				const firstSegment = candidate.slice(0, candidate.indexOf("/"));
				if (firstSegment.includes(".")) return null;
			}
			const lead = m[0].length - candidate.length;
			return {
				start: m.index + lead,
				end: m.index + m[0].length,
				raw: candidate,
				kind: "path",
				path: candidate,
			};
		},
	},
];

/** Find image tokens in `text`. Non-overlapping, left to right. */
export function findImageTokens(text: string): TokenMatch[] {
	const claimed: Array<[number, number]> = [];
	const tokens: TokenMatch[] = [];
	const overlaps = (start: number, end: number) => claimed.some(([s, e]) => start < e && s < end);
	for (const { regex, build } of PATTERNS) {
		regex.lastIndex = 0;
		for (const m of text.matchAll(regex)) {
			const token = build(m);
			if (token === null) continue;
			if (token.end <= token.start) continue;
			if (overlaps(token.start, token.end)) continue;
			claimed.push([token.start, token.end]);
			tokens.push(token);
		}
	}
	tokens.sort((a, b) => a.start - b.start);
	return tokens;
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	tif: "image/tiff",
	tiff: "image/tiff",
};

const MIME_RE = /^image\/(?:png|jpeg|gif|webp)$/;

const MAX_PROMPT_IMAGE_BYTES = 30 * 1024 * 1024;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const resolutionCache = new Map<string, string | null>();

function mimeTypeForPath(absPath: string): string | undefined {
	return MIME_BY_EXT[absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase()];
}

/** Resolve a token path (~, file://, relative) to an existing file, or null. Cached. */
export function resolveImagePath(candidate: string): string | null {
	const cached = resolutionCache.get(candidate);
	if (cached !== undefined) return cached;
	let p = candidate;
	if (p.startsWith("file://")) {
		try {
			p = fileURLToPath(p);
		} catch {
			p = "";
		}
	}
	if (p.startsWith("~")) p = homedir() + p.slice(1);
	if (p !== "" && !isAbsolute(p)) p = resolve(process.cwd(), p);
	let result: string | null = null;
	try {
		if (p !== "" && statSync(p).isFile()) result = p;
	} catch {
		result = null;
	}
	if (resolutionCache.size > 512) resolutionCache.clear();
	resolutionCache.set(candidate, result);
	return result;
}

/**
 * Load a file as an ImageContent block. Formats outside pi's supported set
 * (png/jpeg/gif/webp) are converted to PNG with pi's own transcoder first.
 */
async function loadImageContent(absPath: string): Promise<ImageContent | null> {
	try {
		const info = await stat(absPath);
		if (!info.isFile() || info.size === 0 || info.size > MAX_PROMPT_IMAGE_BYTES) return null;
		const mime = mimeTypeForPath(absPath);
		if (mime === undefined) return null;
		const bytes = await readFile(absPath);
		const base64 = bytes.toString("base64");
		if (MIME_RE.test(mime)) {
			return { type: "image", data: base64, mimeType: mime };
		}
		const converted = await convertToPng(base64, mime);
		if (converted === null) return null;
		return { type: "image", data: converted.data, mimeType: "image/png" };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Minimal PNG decode (bit depth 8, non-interlaced) for half-block thumbnails
// ---------------------------------------------------------------------------

export interface RawImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

function readUint32be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 24 | (bytes[offset + 1] ?? 0) << 16 | (bytes[offset + 2] ?? 0) << 8 | (bytes[offset + 3] ?? 0)) >>> 0;
}

export function decodePng(bytes: Uint8Array): RawImage | null {
	const sig = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 33) return null;
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== sig[i]) return null;
	}
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	let channels = 0;
	let palette: Uint8Array | undefined;
	let trns: Uint8Array | undefined;
	const idat: Uint8Array[] = [];
	let pos = 8;
	while (pos + 8 <= bytes.length) {
		const len = readUint32be(bytes, pos);
		const type = String.fromCharCode(bytes[pos + 4] ?? 0, bytes[pos + 5] ?? 0, bytes[pos + 6] ?? 0, bytes[pos + 7] ?? 0);
		const dataStart = pos + 8;
		if (dataStart + len + 4 > bytes.length) return null;
		const data = bytes.subarray(dataStart, dataStart + len);
		if (type === "IHDR") {
			width = readUint32be(data, 0);
			height = readUint32be(data, 4);
			bitDepth = data[8] ?? 0;
			colorType = data[9] ?? 0;
			interlace = data[12] ?? 0;
			if (width === 0 || height === 0) return null;
		} else if (type === "PLTE") {
			palette = data;
		} else if (type === "tRNS") {
			trns = data;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		pos = dataStart + len + 4;
	}
	if (bitDepth !== 8 || interlace !== 0 || width === 0) return null;
	switch (colorType) {
		case 0:
			channels = 1;
			break;
		case 2:
			channels = 3;
			break;
		case 3:
			channels = 1;
			break;
		case 4:
			channels = 2;
			break;
		case 6:
			channels = 4;
			break;
		default:
			return null;
	}
	if (colorType === 3 && palette === undefined) return null;
	const stride = width * channels;
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}
	if (raw.length < height * (stride + 1)) return null;
	const filtered = new Uint8Array(height * stride);
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filter = raw[rowStart] ?? 0;
		const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
		const cur = new Uint8Array(stride);
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? (cur[x - channels] ?? 0) : 0;
			const b = prev[x] ?? 0;
			const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
			let val = line[x] ?? 0;
			switch (filter) {
				case 1:
					val = (val + a) & 0xff;
					break;
				case 2:
					val = (val + b) & 0xff;
					break;
				case 3:
					val = (val + ((a + b) >> 1)) & 0xff;
					break;
				case 4: {
					const p = (a + b - c) | 0;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					val = (val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
					break;
				}
				default:
					break;
			}
			cur[x] = val;
		}
		filtered.set(cur, y * stride);
		prev = cur;
	}
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const o = i * channels;
		const t = i * 4;
		if (colorType === 0) {
			const g = filtered[o] ?? 0;
			rgba[t] = g;
			rgba[t + 1] = g;
			rgba[t + 2] = g;
			rgba[t + 3] = 255;
		} else if (colorType === 2) {
			rgba[t] = filtered[o] ?? 0;
			rgba[t + 1] = filtered[o + 1] ?? 0;
			rgba[t + 2] = filtered[o + 2] ?? 0;
			rgba[t + 3] = 255;
		} else if (colorType === 3) {
			const idx = (filtered[o] ?? 0) * 3;
			const alphaIndex = filtered[o] ?? 0;
			rgba[t] = palette?.[idx] ?? 0;
			rgba[t + 1] = palette?.[idx + 1] ?? 0;
			rgba[t + 2] = palette?.[idx + 2] ?? 0;
			rgba[t + 3] = trns !== undefined && alphaIndex < trns.length ? (trns[alphaIndex] ?? 255) : 255;
		} else if (colorType === 4) {
			const g = filtered[o] ?? 0;
			rgba[t] = g;
			rgba[t + 1] = g;
			rgba[t + 2] = g;
			rgba[t + 3] = filtered[o + 1] ?? 0;
		} else {
			rgba[t] = filtered[o] ?? 0;
			rgba[t + 1] = filtered[o + 1] ?? 0;
			rgba[t + 2] = filtered[o + 2] ?? 0;
			rgba[t + 3] = filtered[o + 3] ?? 0;
		}
	}
	return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Aspect-fill half-block art
// ---------------------------------------------------------------------------

let palette256: Array<[number, number, number]> | undefined;

function getPalette256(): Array<[number, number, number]> {
	if (palette256 !== undefined) return palette256;
	const palette: Array<[number, number, number]> = [];
	for (let i = 0; i < 16; i++) {
		// Standard ANSI approximation; only used for nearest-match scoring.
		palette.push([(i & 1) !== 0 ? 205 : 0, (i & 2) !== 0 ? 205 : 0, (i & 4) !== 0 ? 205 : 0]);
	}
	const levels = [0, 95, 135, 175, 215, 255];
	for (const r of levels) {
		for (const g of levels) {
			for (const b of levels) {
				palette.push([r, g, b]);
			}
		}
	}
	for (let i = 0; i < 24; i++) {
		const v = 8 + i * 10;
		palette.push([v, v, v]);
	}
	palette256 = palette;
	return palette;
}

function nearest256(r: number, g: number, b: number): number {
	const palette = getPalette256();
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < palette.length; i++) {
		const [pr, pg, pb] = palette[i] ?? [0, 0, 0];
		const dr = pr - r;
		const dg = pg - g;
		const db = pb - b;
		const dist = dr * dr + dg * dg + db * db;
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
			if (dist === 0) break;
		}
	}
	return best;
}

function ansiFg(rgb: [number, number, number] | null, trueColor: boolean): string {
	if (rgb === null) return "";
	const [r, g, b] = rgb;
	return trueColor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${nearest256(r, g, b)}m`;
}

function ansiBg(rgb: [number, number, number] | null, trueColor: boolean): string {
	if (rgb === null) return "";
	const [r, g, b] = rgb;
	return trueColor ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${nearest256(r, g, b)}m`;
}

/**
 * Sample an image into a cols × rows cell grid of half-block lines.
 * "fill" center-crops to cover the box; "fit" maps the whole image.
 */
function renderArtLines(img: RawImage, cols: number, rows: number, mode: "fill" | "fit"): string[] {
	const W = Math.max(1, Math.floor(cols));
	const H = Math.max(2, Math.floor(rows) * 2);
	const { width: sw, height: sh, rgba } = img;
	let cropW: number;
	let cropH: number;
	if (mode === "fill") {
		const scale = Math.max(W / sw, H / sh);
		cropW = Math.min(sw, W / scale);
		cropH = Math.min(sh, H / scale);
	} else {
		cropW = sw;
		cropH = sh;
	}
	const cropX = (sw - cropW) / 2;
	const cropY = (sh - cropH) / 2;
	const trueColor = getCapabilities().trueColor !== false;

	const sample = (tx: number, ty: number): [number, number, number] | null => {
		const sx0 = cropX + (tx * cropW) / W;
		const sx1 = cropX + ((tx + 1) * cropW) / W;
		const sy0 = cropY + (ty * cropH) / H;
		const sy1 = cropY + ((ty + 1) * cropH) / H;
		const x0 = Math.max(0, Math.floor(sx0));
		const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil(sx1)));
		const y0 = Math.max(0, Math.floor(sy0));
		const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil(sy1)));
		let r = 0;
		let g = 0;
		let b = 0;
		let aSum = 0;
		let count = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const o = (y * sw + x) * 4;
				const a = (rgba[o + 3] ?? 0) / 255;
				r += (rgba[o] ?? 0) * a;
				g += (rgba[o + 1] ?? 0) * a;
				b += (rgba[o + 2] ?? 0) * a;
				aSum += a;
				count++;
			}
		}
		if (count === 0 || aSum === 0) return null;
		return [Math.round(r / aSum), Math.round(g / aSum), Math.round(b / aSum)];
	};

	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = "";
		let lastFg = "";
		let lastBg = "";
		for (let col = 0; col < W; col++) {
			const top = sample(col, row * 2);
			const bottom = sample(col, row * 2 + 1);
			if (top === null && bottom === null) {
				line += " ";
				lastFg = "";
				lastBg = "";
				continue;
			}
			const fg = ansiFg(top, trueColor);
			const bg = ansiBg(bottom, trueColor);
			if (fg !== lastFg) line += fg;
			if (bg !== lastBg) line += bg;
			line += top === null ? "▄" : "▀";
			lastFg = fg;
			lastBg = bg;
		}
		lines.push(`${line}\x1b[0m`);
	}
	return lines;
}

/**
 * Render an image as half-block art cropped to fill a cols × rows cell box.
 * Each terminal cell covers one source column and two source rows, so the
 * crop is centered on the axis that overflows after cover-scaling.
 */
export function aspectFillArt(img: RawImage, cols: number, rows: number): string[] {
	return renderArtLines(img, cols, rows, "fill");
}

/** Largest cols × rows cell box (≤ maxCols × maxRows) matching the image aspect. */
export function fitCells(img: RawImage, maxCols: number, maxRows: number): { cols: number; rows: number } {
	const capCols = Math.max(1, Math.floor(maxCols));
	const capRows = Math.max(1, Math.floor(maxRows));
	let cols = capCols;
	let rows = Math.max(1, Math.ceil((cols * img.height) / img.width / 2));
	if (rows > capRows) {
		cols = Math.max(1, Math.floor((capRows * 2 * img.width) / img.height));
		rows = Math.max(1, Math.ceil((cols * img.height) / img.width / 2));
	}
	return { cols, rows: Math.min(rows, capRows) };
}

/** Render the whole image, aspect-fit inside a maxCols × maxRows box. */
export function aspectFitArt(img: RawImage, maxCols: number, maxRows: number): string[] {
	const { cols, rows } = fitCells(img, maxCols, maxRows);
	return renderArtLines(img, cols, rows, "fit");
}

// ---------------------------------------------------------------------------
// Thumbnail cache (async decode, sync render)
// ---------------------------------------------------------------------------

interface ThumbEntry {
	sig: string;
	cols: number;
	rows: number;
	status: "pending" | "ready" | "failed";
	lines?: string[];
	widthPx?: number;
	heightPx?: number;
}

const thumbCache = new Map<string, ThumbEntry>();
const thumbLoading = new Set<string>();

/** Anything that can schedule a TUI redraw after async work completes. */
interface RenderSignal {
	requestRender(): void;
}

function ensureThumb(absPath: string, cols: number, rows: number, render: RenderSignal): ThumbEntry {
	let sig = "unknown";
	try {
		const st = statSync(absPath);
		sig = `${st.size}:${st.mtimeMs}`;
	} catch {
		/* keep placeholder sig; the load below reports the failure */
	}
	const cached = thumbCache.get(absPath);
	if (cached && cached.sig === sig && cached.cols === cols && cached.rows === rows) return cached;
	if (thumbLoading.has(absPath)) {
		return cached ?? { sig, cols, rows, status: "pending" };
	}
	const entry: ThumbEntry = { sig, cols, rows, status: "pending" };
	thumbCache.set(absPath, entry);
	thumbLoading.add(absPath);
	void (async () => {
		try {
			const bytes = await readFile(absPath);
			const mime = mimeTypeForPath(absPath);
			if (mime === undefined) throw new Error("unsupported extension");
			let pngBase64: string | null = bytes.toString("base64");
			if (mime !== "image/png") {
				const converted = await convertToPng(pngBase64, mime);
				if (converted === null) throw new Error("conversion failed");
				pngBase64 = converted.data;
			}
			if (pngBase64 === null) throw new Error("no image data");
			const img = decodePng(Buffer.from(pngBase64, "base64"));
			if (img === null) throw new Error("decode failed");
			entry.lines = aspectFillArt(img, cols, rows);
			entry.widthPx = img.width;
			entry.heightPx = img.height;
			entry.status = "ready";
		} catch {
			entry.status = "failed";
		} finally {
			thumbLoading.delete(absPath);
			if (thumbCache.size > 64) {
				for (const key of thumbCache.keys()) {
					if (thumbCache.size <= 48) break;
					thumbCache.delete(key);
				}
			}
			render.requestRender();
		}
	})();
	return entry;
}

function attachmentLabel(token: TokenMatch): string {
	if (token.kind === "reference") return `[Image #${token.ref}]`;
	return basename(token.path?.replace(/\/+$/, "") || "image") || "image";
}

/**
 * Compose attachment tiles (filename over a thumbnail) into horizontal bands
 * that fit `width`, with a blank line between the strip and the prompt.
 */
function composeTileBands(
	tiles: Array<{ label: string; art: string[] }>,
	width: number,
	cols: number,
	styler: (text: string) => string,
): string[] {
	const labelCap = Math.max(cols, 12);
	interface Tile {
		width: number;
		lines: string[];
	}
	const packed: Tile[] = [];
	for (const tile of tiles) {
		const label = truncateToWidth(tile.label, labelCap);
		const labelWidth = visibleWidth(label);
		const tileWidth = Math.max(cols, labelWidth);
		const pad = (line: string) => line + " ".repeat(Math.max(0, tileWidth - visibleWidth(line)));
		const lines = [pad(styler(label))];
		for (const row of tile.art) lines.push(pad(row));
		packed.push({ width: tileWidth, lines });
	}
	const gap = " ".repeat(3);
	const out: string[] = [];
	let band: Tile[] = [];
	let bandWidth = 0;
	const flushBand = () => {
		if (band.length === 0) return;
		const rowCount = Math.max(...band.map((tile) => tile.lines.length));
		for (let r = 0; r < rowCount; r++) {
			out.push(truncateToWidth(band.map((tile) => tile.lines[r] ?? "").join(gap), width));
		}
		out.push(""); // blank separator between the strip and the prompt
		band = [];
		bandWidth = 0;
	};
	for (const tile of packed) {
		const nextWidth = band.length === 0 ? tile.width : bandWidth + gap.length + tile.width;
		if (band.length > 0 && nextWidth > width - 2) flushBand();
		band.push(tile);
		bandWidth = band.length === 1 ? tile.width : bandWidth + gap.length + tile.width;
	}
	flushBand();
	return out;
}

/**
 * Build the attachment strip shown above the prompt: for every image token in
 * the visible editor text, a small aspect-fill thumbnail with its filename on
 * top. One attachment per unique image; the prompt text is not modified.
 */
function buildAttachmentStrip(body: string[], width: number, options: DecorateOptions): string[] {
	const items: Array<{ label: string; absPath: string | null }> = [];
	const seen = new Set<string>();
	for (const line of body) {
		const plain = stripTerminalSequences(line.split(CURSOR_MARKER).join(""));
		for (const token of findImageTokens(plain)) {
			let key: string;
			let label: string;
			let absPath: string | null = null;
			if (token.kind === "reference") {
				key = `#${token.ref}`;
				label = attachmentLabel(token);
			} else {
				absPath = resolveImagePath(token.path ?? "");
				if (absPath === null) continue;
				key = absPath;
				label = attachmentLabel(token);
			}
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({ label, absPath });
		}
	}
	if (items.length === 0) return [];
	const tiles: Array<{ label: string; art: string[] }> = [];
	for (const item of items) {
		const entry = item.absPath === null ? undefined : ensureThumb(item.absPath, options.cols, options.rows, options.tui);
		const art = entry?.status === "ready" && entry.lines !== undefined ? entry.lines : [];
		tiles.push({ label: item.label, art });
	}
	return composeTileBands(tiles, width, options.cols, options.styler);
}

function decorateEditorLines(lines: string[], width: number, options: DecorateOptions): string[] {
	if (lines.length < 2) return lines;
	const head = lines[0] ?? "";
	const tail = lines[lines.length - 1] ?? "";
	const body = lines.slice(1, -1);
	const strip = buildAttachmentStrip(body, width, options);
	if (strip.length === 0) return lines;
	return [head, ...strip, ...body, tail];
}

// ---------------------------------------------------------------------------
// Editor decoration
// ---------------------------------------------------------------------------

interface DecorateOptions {
	cols: number;
	rows: number;
	tui: RenderSignal;
	/** Theme styler for attachment labels. */
	styler: (text: string) => string;
}


/**
 * Patch an editor instance so image tokens render as an attachment strip above
 * the prompt. Works with any Editor subclass: the original render is captured
 * first and the strip is inserted between its borders.
 */
function attachThumbnails(editor: EditorComponent, tui: TUI, options: Omit<DecorateOptions, "tui">): EditorComponent {
	const baseRender = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		const lines = baseRender(width);
		try {
			return decorateEditorLines(lines, width, { ...options, tui });
		} catch {
			return lines;
		}
	};
	return editor;
}

// ---------------------------------------------------------------------------
// Session image registry for [Image #N] references
// ---------------------------------------------------------------------------

interface RegistryImage {
	data: string;
	mimeType: string;
}

function collectImages(message: unknown, registry: RegistryImage[]): void {
	const m = message as { role?: string; content?: unknown } | undefined;
	if (m === undefined || m === null || (m.role !== "user" && m.role !== "toolResult")) return;
	const content = m.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = block as { type?: string; data?: string; mimeType?: string } | undefined;
		if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
			registry.push({ data: b.data, mimeType: b.mimeType });
		}
	}
	if (registry.length > 100) registry.splice(0, registry.length - 100);
}

// ---------------------------------------------------------------------------
// Chat previews: user-message tiles (custom entry) and result image blocks
// ---------------------------------------------------------------------------

const ENTRY_TYPE = "pi-image-thumbnails";
interface EntryTile {
	path: string;
	label: string;
}
interface EntryData {
	tiles: EntryTile[];
}

/** cols/rows for chat tiles; refreshed from settings on each session start. */
let chatTileSize = { cols: 10, rows: 4 };
const noopRender: RenderSignal = { requestRender() {} };
/** Cap for model-output image blocks in the transcript (rows). */
const RESULT_MAX_ROWS = 10;

/**
 * Component rendering one image block from a tool result, aspect-fit inside a
 * box of maxRows rows. Art is cached per width; decoding is synchronous for
 * PNG and cached asynchronous otherwise. Holds the content itself so it can
 * re-schedule a decode after the module cache evicts it, and asks the host to
 * repaint when the pixels land.
 */
class ResultImageBlock {
	artCache = new Map();
	key: string;
	data: string;
	mimeType: string;
	maxRows: number;
	repaint: () => void;
	constructor(key: string, data: string, mimeType: string, maxRows: number, repaint: () => void) {
		this.key = key;
		this.data = data;
		this.mimeType = mimeType;
		this.maxRows = maxRows;
		this.repaint = repaint;
	}
	render(width: number): string[] {
		const maxCols = Math.max(4, Math.min(width - 4, 80));
		const cacheKey = `${maxCols}x${this.maxRows}`;
		const cached = this.artCache.get(cacheKey);
		if (cached !== undefined) return cached;
		const raw = getRawImage(this.key, this.data, this.mimeType, this.repaint);
		if (raw === undefined) return []; // still decoding; repaint fires when it lands
		const art = aspectFitArt(raw, maxCols, this.maxRows);
		this.artCache.set(cacheKey, art);
		return art;
	}
	invalidate(): void {}
}

/** Base64 content key: cheap, deterministic, collision-safe for our purposes. */
function contentKey(data: string): string {
	return `${data.length}:${data.slice(0, 24)}:${data.slice(-24)}`;
}

const rawImageCache = new Map();
const rawImagePending = new Set();
const rawImageWaiters = new Map();

/**
 * Get the decoded pixels for base64 image content. Without content, looks up
 * the cache only; with content, schedules the decode and calls `onReady` once
 * the pixels land (also after a cache eviction re-decode).
 */
function getRawImage(key: string, data?: string, mimeType?: string, onReady?: () => void): RawImage | undefined {
	const cached = rawImageCache.get(key);
	if (cached !== undefined) return cached ?? undefined;
	if (onReady !== undefined) {
		const waiters = rawImageWaiters.get(key) ?? [];
		waiters.push(onReady);
		rawImageWaiters.set(key, waiters);
	}
	if (rawImagePending.has(key) || data === undefined || mimeType === undefined) return undefined;
	rawImagePending.add(key);
	void (async () => {
		try {
			let pngBase64: string | null = data;
			if (mimeType !== "image/png") {
				const converted = await convertToPng(data, mimeType);
				if (converted === null) throw new Error("conversion failed");
				pngBase64 = converted.data;
			}
			const img = decodePng(Buffer.from(pngBase64 ?? "", "base64"));
			rawImageCache.set(key, img);
		} catch {
			rawImageCache.set(key, null);
		} finally {
			rawImagePending.delete(key);
			const waiters = rawImageWaiters.get(key) ?? [];
			rawImageWaiters.delete(key);
			for (const waiter of waiters) {
				try {
					waiter();
				} catch {
					/* a dead component must not break the others */
				}
			}
			if (rawImageCache.size > 16) {
				for (const k of rawImageCache.keys()) {
					if (rawImageCache.size <= 12) break;
					rawImageCache.delete(k);
				}
			}
		}
	})();
	return undefined;
}

/** Resolve the tile art for entry data; schedules async decode on first view. */
function tileLinesFor(tilesData: EntryTile[]): Array<{ label: string; art: string[] }> {
	const tiles: Array<{ label: string; art: string[] }> = [];
	for (const tile of tilesData) {
		if (typeof tile?.path !== "string" || tile.path === "") continue;
		const thumb = ensureThumb(tile.path, chatTileSize.cols, chatTileSize.rows, noopRender);
		const art = thumb.status === "ready" && thumb.lines !== undefined ? thumb.lines : [];
		tiles.push({ label: tile.label, art });
	}
	return tiles;
}

/**
 * Transcript component for a user-message preview: re-composes on every render
 * so tiles that were still decoding appear as soon as they are ready.
 */
class EntryTilesComponent {
	tiles: EntryTile[];
	styler: (text: string) => string;
	constructor(tiles: EntryTile[], styler: (text: string) => string) {
		this.tiles = tiles;
		this.styler = styler;
	}
	render(width: number): string[] {
		return composeTileBands(tileLinesFor(this.tiles), width, chatTileSize.cols, this.styler);
	}
	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export const SETTINGS_DEFINITION = {
	cols: {
		default: 10,
		env: "PI_IMAGE_THUMBS_COLS",
		parseEnv: (value: string) => Math.max(2, Math.min(40, Number.parseInt(value, 10) || 10)),
	},
	rows: {
		default: 4,
		env: "PI_IMAGE_THUMBS_ROWS",
		parseEnv: (value: string) => Math.max(1, Math.min(12, Number.parseInt(value, 10) || 4)),
	},
} as const;

export default function imageThumbnails(pi: ExtensionAPI, settingsRuntime: SettingsRuntime = {}): void {
	const registry: RegistryImage[] = [];
	let installedFactory: EditorFactory | undefined;

	// Chat preview of images the user is sending: a custom entry carrying the
	// tile list renders above the user message; entry data is not sent to the
	// model. Thumbnails decode from the named files (kept lean by not
	// duplicating the base64 the user message already stores).
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as EntryData | undefined;
		const tilesData = data?.tiles;
		if (tilesData === undefined || !Array.isArray(tilesData) || tilesData.length === 0) return undefined;
		return new EntryTilesComponent(tilesData, (s) => theme.fg("dim", s));
	});

	// Chat preview of images the agent produces (tool results): wrap every
	// tool's result renderer so each image block gets a sole aspect-fit image
	// block under it. next() chains to other extensions' resolvers and the
	// built-in renderers, so folding extensions keep working on top.
	// registerToolRenderer postdates pi 0.87; call it only when present.
	const toolRendererHost = pi as ExtensionAPI & {
		// SAFETY: the resolver contract is positional and duck-typed; pi 1.x passes
		// (toolName, next) with renderers shaped like the tool definition's.
		registerToolRenderer?: (
			resolver: (toolName: string, next: () => Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
		) => void;
	};
	toolRendererHost.registerToolRenderer?.((_toolName, next) => {
		const base = next();
		if (base === undefined) return undefined;
		const baseRenderResult = base.renderResult as
			| ((result: { content: Array<{ type: string; data?: string; mimeType?: string }> }, options: unknown, theme: unknown, context: unknown) => unknown)
			| undefined;
		return {
			...base,
			renderResult: (result: { content: Array<{ type: string; data?: string; mimeType?: string }> }, options: unknown, theme: unknown, context: unknown) => {
				const baseComponent = baseRenderResult?.(result, options, theme, context);
				const imageBlocks = result.content.filter((block) => block.type === "image" && typeof block.data === "string");
				if (imageBlocks.length === 0) return baseComponent;
				const repaint = typeof (context as { invalidate?: unknown })?.invalidate === "function"
					? (context as { invalidate: () => void }).invalidate
					: () => {};
				const container = new Container();
				// SAFETY: baseComponent is a pi-tui Component produced by the wrapped
				// renderer; the duck type is guaranteed by the host contract.
				if (baseComponent !== undefined && baseComponent !== null) container.addChild(baseComponent as Container);
			for (const block of imageBlocks) {
				if (typeof block.data !== "string") continue;
				const key = contentKey(block.data);
				// Fast path: PNG decodes synchronously so the art is ready on the
				// first render; the async path only serves other formats.
				if ((block.mimeType ?? "image/png") === "image/png" && rawImageCache.get(key) === undefined) {
					try {
						const raw = decodePng(Buffer.from(block.data, "base64"));
						if (raw !== null) rawImageCache.set(key, raw);
					} catch {
						/* fall through to the async path */
					}
				}
				container.addChild(new ResultImageBlock(key, block.data, block.mimeType ?? "image/png", RESULT_MAX_ROWS, repaint));
			}
				return container;
			},
		};
	});

	pi.on("session_start", () => {
		registry.length = 0;
	});

	pi.on("message_end", (event) => {
		collectImages(event.message, registry);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		const tokens = findImageTokens(event.text);
		if (tokens.length === 0) return { action: "continue" };
		const images: ImageContent[] = [...(event.images ?? [])];
		const tiles: EntryTile[] = [];
		let text = event.text;
		for (const token of tokens.toReversed()) {
			if (token.kind === "reference") {
				const image = token.ref !== undefined && token.ref >= 1 ? registry[token.ref - 1] : undefined;
				if (image === undefined) continue;
				images.unshift({ type: "image", data: image.data, mimeType: image.mimeType });
				continue; // the [Image #N] anchor already reads well in context
			}
			const absPath = resolveImagePath(token.path ?? "");
			if (absPath === null) continue;
			const content = await loadImageContent(absPath);
			if (content === null) continue;
			images.unshift(content);
			tiles.unshift({ path: absPath, label: basename(absPath) });
			text = text.slice(0, token.start) + `[image: ${basename(absPath)}]` + text.slice(token.end);
		}
		if (images.length === (event.images?.length ?? 0) && text === event.text) {
			return { action: "continue" };
		}
		if (tiles.length > 0) {
			const entryData: EntryData = { tiles };
			pi.appendEntry(ENTRY_TYPE, entryData);
		}
		return { action: "transform", text, images };
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const resolved = resolveSettings("pi-image-thumbnails", SETTINGS_DEFINITION, ctx, settingsRuntime);
		const cols = resolved.cols.value;
		const rows = resolved.rows.value;
		chatTileSize = { cols, rows };
		const previous = ctx.ui.getEditorComponent();
		if (previous !== undefined && previous === installedFactory) return; // already installed this runtime
		const factory: EditorFactory = (tui, theme, keybindings) => {
			const editor = previous !== undefined ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			return attachThumbnails(editor, tui, { cols, rows, styler: theme.borderColor });
		};
		installedFactory = factory;
		ctx.ui.setEditorComponent(factory);
	});
}
