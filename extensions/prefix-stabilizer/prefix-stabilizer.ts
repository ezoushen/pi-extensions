/**
 * prefix-stabilizer — keep pi's system prompt byte-stable so the server's KV
 * prefix cache survives across turns and resumes.
 *
 * WHY (measured on a large-context model behind a prefix-caching server)
 *   vLLM's prefix cache is a strict prefix match on 64-token block hashes: one
 *   differing token invalidates every block after it. The system prompt is only
 *   ~5.9k tokens of a 118k context, so ANY change inside it costs 95-100% of
 *   the cache. Measured on this lane:
 *       cold 132k prompt      145.33s   0.00% hit
 *       byte-identical repeat   0.54s  99.95% hit
 *       first 4 chars changed 144.68s   0.00% hit
 *   i.e. the difference between a stable and an unstable prefix is ~270x.
 *
 * WHAT WENT WRONG (the incident this was written for)
 *   Pi renders its system prompt from ordered sections:
 *       preamble 169c | tools 3310c | rules 8175c | docs 1286c | skills 12966c | cwd 41c
 *   `docs` embeds the ABSOLUTE path of pi's own npm install and starts at
 *   char 11,657 = token ~2,649. On 2026-09-20 a session ran
 *   `npm config set prefix ~/.local` and reinstalled pi; resuming rewrote that
 *   path, diverging the prompt at token 2,649 of 118,031. 115,382 tokens
 *   (97.8%) re-prefilled: predicted 115,382/871 tok/s = 132.5s, observed
 *   127.5-137.5s.
 *
 * WHAT THIS DOES (industry practice: stable prefix, volatile tail)
 *   1. Install-path normalisation. A configured package-path suffix is replaced
 *      by a configured stable path. Only an absolute, existing mention is
 *      treated as an install root; a relative or nonexistent mention is left
 *      alone rather than rewritten. Symlink creation at that path is opt-in;
 *      users may instead point it at a path they already control.
 *   2. Deterministic tool order. Pi emits its 35 tools in registration order
 *      (`read, bash, edit, ...`) at token 39 — the worst possible position. If
 *      extension or MCP discovery order ever varies, the whole context dies.
 *      Both the prose <tools> block and the payload's tool-schema array are
 *      sorted by name, so load order stops mattering.
 *   3. Drift detection. The normalised system prompt is fingerprinted per
 *      process; if it changes mid-session the operator is warned once, naming
 *      the cost. The remaining triggers (rules/AGENTS.md edits, adding a skill,
 *      changing cwd) stop being silent ~130s taxes. Each drift is reported,
 *      because each one costs a full re-prefill; a repeated prompt does not
 *      re-warn because its fingerprint is unchanged.
 *
 * LOAD ORDER: list this BEFORE `pi-compaction-cache` in `packages`, so
 * that extension captures the already-normalised payload as its `live` prefix.
 * It only observes in before_provider_request (returns undefined), so the two
 * do not race over the handler result.
 *
 * PI_PREFIX_STABILIZER=0           disable
 * PI_PREFIX_STABILIZER_LOG=<path>  one JSON line per symlink change / drift event
 * PI_PREFIX_STABILIZER_STABLE_PATH=<path> stable replacement (default: ~/.pi/pi-home)
 * PI_PREFIX_STABILIZER_PACKAGE_PATH_SUFFIX=<suffix> install suffix to replace
 * PI_PREFIX_STABILIZER_CREATE_SYMLINK=1 create/update the stable symlink (default: off)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, symlinkSync, readlinkSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSettings } from "../../shared/settings.ts";
import { announce } from "../../shared/announce.ts";

const DISABLED = process.env.PI_PREFIX_STABILIZER === "0";
const LOG_PATH = process.env.PI_PREFIX_STABILIZER_LOG;

const SETTINGS = {
	stablePath: {
		default: join(homedir(), ".pi", "pi-home"),
		env: "PI_PREFIX_STABILIZER_STABLE_PATH",
	},
	packagePathSuffix: {
		default: "node_modules/@earendil-works/pi-coding-agent",
		env: "PI_PREFIX_STABILIZER_PACKAGE_PATH_SUFFIX",
	},
	createSymlink: {
		default: false,
		env: "PI_PREFIX_STABILIZER_CREATE_SYMLINK",
		parseEnv: (value: string) => value === "1" || value.toLowerCase() === "true",
	},
};

/** Path chars we refuse to walk back across when recovering the absolute root. */
const BOUNDARY = /[\s"'`(<\[]/;

function log(o: Record<string, unknown>): void {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
	} catch {
		/* logging must never break a turn */
	}
}

/** Point `stablePath` at `root` unless it already does. */
function ensureSymlink(root: string, stablePath: string): void {
	try {
		// A candidate target that does not exist is never worth pointing at --
		// and never worth removing a working symlink to switch to. Leave
		// whatever is at `stablePath` alone (see normalisePaths: `roots` should
		// already only contain existing absolute paths, but this is the last
		// line of defense against ever replacing a good symlink with a bad one).
		if (!existsSync(root)) {
			log({ symlink_skip: stablePath, invalid_target: root });
			return;
		}
		if (existsSync(stablePath)) {
			let cur: string | null = null;
			try {
				cur = readlinkSync(stablePath);
			} catch {
				cur = null;
			}
			if (cur === root) return;
			rmSync(stablePath, { force: true });
		}
		mkdirSync(dirname(stablePath), { recursive: true });
		symlinkSync(root, stablePath);
		log({ symlink: stablePath, target: root });
	} catch (e) {
		log({ symlink_error: String(e) });
	}
}

/**
 * Replace a matching absolute, existing install path with `stablePath`.
 *
 * A mention is only ever a volatile install path -- worth stabilising -- if
 * it is absolute and actually exists on disk. A relative mention (e.g. found
 * inside a quoted shell command or doc example) or an absolute-looking but
 * nonexistent one (e.g. a mention split by a preceding "/" that is not a
 * path separator for this suffix at all) was never volatile in the first
 * place: rewriting it would change the text's meaning rather than stabilise
 * a fact, and treating it as an install root would hand a bogus target to
 * `ensureSymlink`. Left alone.
 */
function normalisePaths(
	s: string,
	roots: Set<string>,
	packagePathSuffix: string,
	stablePath: string,
): string {
	let out = s;
	let i = out.indexOf(packagePathSuffix);
	while (i >= 0) {
		let start = i;
		while (start > 0 && !BOUNDARY.test(out[start - 1])) start--;
		const candidate = out.slice(start, i + packagePathSuffix.length);
		const isInstallRoot = candidate.startsWith("/") && existsSync(candidate);
		if (!isInstallRoot) {
			i = out.indexOf(packagePathSuffix, i + packagePathSuffix.length);
			continue;
		}
		roots.add(candidate);
		out = out.slice(0, start) + stablePath + out.slice(i + packagePathSuffix.length);
		i = out.indexOf(packagePathSuffix, start + stablePath.length);
	}
	return out;
}

/**
 * Sort the `- name: description` lines inside a <tools> block by name, leaving
 * the header, any trailing prose and the closing tag exactly where they are.
 * Tool descriptions may not contain newlines, which pi's renderer guarantees.
 */
function sortToolsSection(s: string): string {
	if (!s.includes("<tools>")) return s;
	const lines = s.split("\n");
	const idx: number[] = [];
	for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("- ")) idx.push(i);
	if (idx.length < 2) return s;
	const nameOf = (l: string) => l.slice(2).split(":")[0];
	const sorted = idx
		.map((i) => lines[i])
		.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
	idx.forEach((lineNo, k) => {
		lines[lineNo] = sorted[k];
	});
	return lines.join("\n");
}

/** Name of a tool-schema entry, across the shapes providers use. */
function toolName(t: unknown): string {
	if (!t || typeof t !== "object") return "";
	const o = t as Record<string, any>;
	return String(o.name ?? o.function?.name ?? o.custom?.name ?? "");
}

/** Sort the payload's tool-schema array by name so discovery order cannot churn it. */
function sortToolArray(tools: unknown): { v: unknown; changed: boolean } {
	if (!Array.isArray(tools) || tools.length < 2) return { v: tools, changed: false };
	const before = tools.map(toolName);
	const sorted = [...tools].sort((a, b) => {
		const x = toolName(a), y = toolName(b);
		return x < y ? -1 : x > y ? 1 : 0;
	});
	const changed = sorted.some((t, i) => t !== tools[i]);
	void before;
	return { v: changed ? sorted : tools, changed };
}

/** Structural copy-on-write over strings: untouched subtrees keep their identity. */
function walk(
	v: unknown,
	roots: Set<string>,
	packagePathSuffix: string,
	stablePath: string,
): { v: unknown; n: number } {
	if (typeof v === "string") {
		let s = v;
		if (s.includes(packagePathSuffix)) {
			s = normalisePaths(s, roots, packagePathSuffix, stablePath);
		}
		s = sortToolsSection(s);
		return s === v ? { v, n: 0 } : { v: s, n: 1 };
	}
	if (Array.isArray(v)) {
		let n = 0;
		const out = v.map((x) => {
			const r = walk(x, roots, packagePathSuffix, stablePath);
			n += r.n;
			return r.v;
		});
		return n ? { v: out, n } : { v, n: 0 };
	}
	if (v && typeof v === "object") {
		let n = 0;
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			const r = walk(val, roots, packagePathSuffix, stablePath);
			n += r.n;
			out[k] = r.v;
		}
		return n ? { v: out, n } : { v, n: 0 };
	}
	return { v, n: 0 };
}

/** Concatenated system-message content of a payload, for fingerprinting. */
function systemText(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	const push = (c: unknown) => {
		if (typeof c === "string") parts.push(c);
		else if (Array.isArray(c))
			for (const b of c) if (b && typeof b === "object" && typeof (b as any).text === "string") parts.push((b as any).text);
	};
	for (const f of ["system", "instructions"]) if (typeof payload[f] === "string") parts.push(payload[f] as string);
	const msgs = payload.messages;
	if (Array.isArray(msgs))
		for (const m of msgs)
			if (m && typeof m === "object" && (m as any).role === "system") push((m as any).content);
	// Normalise line endings and trailing whitespace: semantically identical
	// prompts should share a fingerprint (and a cache).
	return parts.join("\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

export default function activate(pi: ExtensionAPI, bootCtx?: any): void {
	if (DISABLED) return;
	let announced = false;
	let fingerprint: string | null = null;

	pi.on("before_provider_request", (event: any, ctx?: any) => {
		const payload: Record<string, unknown> | undefined = event?.payload;
		if (!payload) return;
		const settings = resolveSettings("pi-prefix-stabilizer", SETTINGS, {
			cwd: ctx?.cwd ?? process.cwd(),
			isProjectTrusted: () => ctx?.isProjectTrusted?.() ?? false,
			hasUI: ctx?.hasUI,
			ui: ctx?.ui,
		});
		const stablePath = settings.stablePath.value;
		const packagePathSuffix = settings.packagePathSuffix.value;

		const roots = new Set<string>();
		const out: Record<string, unknown> = { ...payload };
		let n = 0;

		for (const field of ["messages", "system", "instructions"]) {
			if (!(field in payload)) continue;
			const r = walk(payload[field], roots, packagePathSuffix, stablePath);
			if (r.n) {
				out[field] = r.v;
				n += r.n;
			}
		}
		const ts = sortToolArray(payload.tools);
		if (ts.changed) {
			out.tools = ts.v;
			n += 1;
		}
		if (settings.createSymlink.value) {
			for (const root of roots) if (root !== stablePath) ensureSymlink(root, stablePath);
		}
		if (n && !announced) {
			announced = true;
			log({ first_rewrite: true, replacements: n, roots: [...roots] });
		}

		// Fingerprint the NORMALISED prompt, so benign reordering never warns.
		const fp = createHash("sha1").update(systemText(n ? out : payload)).digest("hex").slice(0, 12);
		if (fingerprint === null) {
			fingerprint = fp;
		} else if (fp !== fingerprint) {
			// Every drift costs a full re-prefill, so every drift is reported.
			// Repeats of the same prompt do not re-warn: the fingerprint is stable.
			const msg =
				"prefix-stabilizer: the system prompt changed mid-session " +
				`(${fingerprint} -> ${fp}). The server's KV prefix cache is invalidated from ` +
				"that point on, so this turn re-prefills the whole context. Usual causes: a " +
				"package/MCP server added or removed, rules/AGENTS.md edited, a skill added, or cwd changed.";
			log({ drift: true, from: fingerprint, to: fp });
			announce(
				{ hasUI: ctx?.hasUI ?? bootCtx?.hasUI, ui: ctx?.ui ?? bootCtx?.ui },
				msg,
				undefined,
				"prefix-stabilizer:drift",
			);
			fingerprint = fp;
		}

		if (!n) return;
		return out;
	});
}
