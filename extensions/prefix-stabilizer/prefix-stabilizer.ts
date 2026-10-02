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
 *   4. Reordered forced prompts. A prompt an extension returns from
 *      before_agent_start is dropped when it only moves pi's own sections, so
 *      runs started by extension messages share the typed-prompt prefix.
 *
 * LOAD ORDER: list this BEFORE `pi-compaction-cache` in `packages`, so
 * that extension captures the already-normalised payload as its `live` prefix.
 * It only observes in before_provider_request (returns undefined), so the two
 * do not race over the handler result. List it AFTER extensions whose
 * reordered prompt it should drop: before_agent_start runs in load order.
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

/**
 * Concatenated leading system-message content of a payload, for fingerprinting.
 * A system message later in the conversation extends the cached prefix rather
 * than invalidating it, so only the system messages before the first other
 * message count.
 */
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
		for (const m of msgs) {
			if (!m || typeof m !== "object" || (m as any).role !== "system") break;
			push((m as any).content);
		}
	// Normalise line endings and trailing whitespace: semantically identical
	// prompts should share a fingerprint (and a cache).
	return parts.join("\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

/** Filler pi appends to its tool list; a relocated copy may leave it out. */
const TOOLS_FILLER = "In addition to the tools above, you may have access to other custom tools depending on the project.";

/**
 * A prompt's sections, order-independent, for comparing content: each `<name>`
 * block through its `</name>`, and each paragraph of untagged text. Lines keep
 * their order inside a section, so only whole sections may move.
 */
function promptSections(text: string): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	let closing: string | null = null;
	const flush = () => {
		if (current.length) sections.push(current.join("\n"));
		current = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (closing) {
			if (line.trim() && line !== TOOLS_FILLER) current.push(line);
			if (line === closing) {
				closing = null;
				flush();
			}
			continue;
		}
		const open = /^<([a-z][a-z0-9_-]*)>$/.exec(line);
		if (open) {
			flush();
			closing = `</${open[1]}>`;
			current.push(line);
		} else if (!line.trim()) flush();
		else if (line !== TOOLS_FILLER) current.push(line);
	}
	flush();
	return sections.sort();
}

// Sections pi builds itself (buildSystemPromptSections in pi's system-prompt.js). Any other
// name was contributed by an extension, which pi only consults in before_agent_start.
const PI_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);
const ENTRY_TYPE = "pi-prefix-stabilizer";

const isPatch = (message: any, index: number): boolean => index > 0 && message?.role === "system" && Boolean(message.sections);
const removesExtensionSection = (message: any): boolean =>
	Object.entries(message.sections).some(([name, value]) => value === null && !PI_SECTIONS.has(name));

/**
 * The request copy of `messages` without the extension-section removals in `dropped`
 * (patch timestamps), without patch entries that set a section to the text it already has,
 * and without the patches this leaves empty. Returns `messages` itself when nothing changes.
 */
function keepExtensionSections(messages: any[], dropped: Set<number>): any[] {
	const current = new Map<string, unknown>();
	let changed = false;
	const out: any[] = [];
	for (const [index, message] of messages.entries()) {
		if (message?.role !== "system" || !message.sections) {
			out.push(message);
			continue;
		}
		const kept: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(message.sections)) {
			if (index > 0 && value === null && !PI_SECTIONS.has(name) && dropped.has(message.timestamp)) continue;
			// Re-adding the text the model already has changes nothing it is told.
			if (index > 0 && value !== null && current.get(name) === value) continue;
			kept[name] = value;
			if (value === null) current.delete(name);
			else current.set(name, value);
		}
		if (Object.keys(kept).length === Object.keys(message.sections).length) {
			out.push(message);
			continue;
		}
		changed = true;
		const { sections: _dropped, ...rest } = message;
		const patched = Object.keys(kept).length ? { ...rest, sections: kept } : rest;
		if (index > 0 && isEmptySystemMessage(patched)) continue;
		out.push(patched);
	}
	return changed ? out : messages;
}

/** Whether a user message after the last assistant message starts with `prompt`. */
function endsWithPrompt(messages: any[], prompt: string): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return false;
		if (message?.role !== "user") continue;
		const content = message.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";
		if (text.startsWith(prompt)) return true;
	}
	return false;
}

function isEmptySystemMessage(message: any): boolean {
	const content = message.content;
	const hasContent = typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0;
	return !hasContent && !message.sections && !message.toolsAdded?.length && !message.toolsRemoved?.length;
}

export default function activate(pi: ExtensionAPI, bootCtx?: any): void {
	if (DISABLED) return;
	let announced = false;
	let fingerprint: string | null = null;

	// Runs started by an extension message (a background-task notification, for example) skip
	// before_agent_start, so the patch pi writes at their next turn diffs Pi's base prompt
	// against the transcript and records every extension section as removed; the next typed
	// prompt adds the same text back. Each flip changes the prompt the model sees, and for
	// models without mid-conversation system messages pi folds it into the leading system
	// message, losing the whole cached prefix twice. Those removals are left out of the
	// request copy; the transcript is untouched. Each one is recorded in the session as soon
	// as it is dropped, so a resume, reload, fork or /tree sends the same request.
	const droppedRemovals = new Set<number>();
	let pendingPrompt: string | undefined;
	let run: { prompt?: string; typed?: boolean; before?: Set<number> } | undefined;

	const restore = (_event: unknown, ctx: any) => {
		droppedRemovals.clear();
		for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			for (const timestamp of entry.data?.droppedRemovals ?? []) droppedRemovals.add(timestamp);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("agent_start", () => {
		run = { prompt: pendingPrompt };
		pendingPrompt = undefined;
	});
	pi.on("agent_end", () => {
		run = undefined;
	});
	pi.on("context_with_system", (event: any) => {
		const messages: any[] = event?.messages ?? [];
		// A prompt whose before_agent_start ran can still fail before its run starts, or lose
		// the start to a notification; only a run whose first request ends in that prompt is typed.
		if (run && run.typed === undefined) run.typed = run.prompt !== undefined && endsWithPrompt(messages, run.prompt);
		if (run && !run.typed) {
			// Patches already in the run's first request were written before it started.
			run.before ??= new Set(messages.filter(isPatch).map((message) => message.timestamp));
			for (const [index, message] of messages.entries()) {
				if (!isPatch(message, index) || run.before.has(message.timestamp) || droppedRemovals.has(message.timestamp)) continue;
				if (!removesExtensionSection(message)) continue;
				droppedRemovals.add(message.timestamp);
				pi.appendEntry(ENTRY_TYPE, { droppedRemovals: [message.timestamp] });
			}
		}
		const kept = keepExtensionSections(messages, droppedRemovals);
		return kept === messages ? undefined : { messages: kept };
	});

	// Pi 0.99 applies a prompt returned from before_agent_start to that run only,
	// and runs started by extension messages never see it, so the leading prompt
	// alternates and the prefix cache is lost on each switch. A forced prompt
	// that only moves pi's own sections changes nothing the model is told; drop
	// it. Anything else, even lines reordered inside a section, stays forced.
	pi.on("before_agent_start", (event: any) => {
		pendingPrompt = typeof event?.prompt === "string" ? event.prompt : "";
		const options = event?.systemPromptOptions;
		const forced = options?.forceSystemPrompt;
		if (typeof forced !== "string") return;
		delete options.forceSystemPrompt;
		const structured = event.systemPrompt;
		const a = promptSections(forced);
		const b = promptSections(structured);
		if (a.length === b.length && a.every((section, i) => section === b[i])) {
			log({ dropped_reordered_prompt: true });
			return;
		}
		options.forceSystemPrompt = forced;
	});

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
