/**
 * pi-cmem — claude-mem bridge for pi-coding-agent.
 *
 * ONE memory system, ONE tool. Pi talks to the claude-mem worker's HTTP API
 * (the supported surface) instead of reading Chroma's SQLite files directly.
 *
 * The earlier bridge opened the Chroma persistence directory directly. That worked, but it:
 *   - bypassed claude-mem's hybrid search (FTS5 + vector) and its privacy filter,
 *   - coupled us to Chroma's on-disk layout and the `cm__claude-mem` collection name,
 *   - could race the writer process,
 *   - and gave Pi read-only memory: Pi sessions never entered the shared DB, so
 *     work done in Pi was invisible to Claude Code / Codex and to the next Pi run.
 * This bridge goes through the worker (default http://127.0.0.1:37777), like the
 * upstream adapters. A configured Chroma helper remains a degraded fallback for
 * when the worker is down.
 *
 * `@husniadil/pi-mem` is the fuller alternative: it can spawn the worker and offers
 * a three-tool recall workflow. This smaller bridge keeps one `memory_recall` tool,
 * a Chroma fallback, and deliberately does not prefix project names with `pi-`, so
 * one repository does not split into separate memory namespaces across agents.
 *
 * Conflicts deliberately avoided:
 *   - exactly one tool name (`memory_recall`), unchanged from v1
 *   - no `pi-` project prefix: memories merge with the Claude Code / Codex ones for
 *     the same repo, which is the point of cross-engine memory
 *   - `platformSource: "pi-agent"` so rows stay filterable per engine
 *
 * Settings resolve from pi-cmem.json (global, then trusted project) and finally
 * from the environment:
 *
 * Environment switches:
 *   PI_CMEM_DISABLED=1     disable bridge activity
 *   PI_CMEM_CAPTURE=0      recall only, no observation write-back (default: capture on)
 *   PI_CMEM_SKIP_TOOLS=<names> comma-separated pi tool names to omit from capture (default: none)
 *   PI_CMEM_MAX_OBSERVATION_CHARS=<chars> captured response limit (minimum: 200; default: 1000)
 *   PI_CMEM_INJECT=1       enable context digest injection (default: off; costs tokens)
 *   PI_CMEM_INJECT_WHEN=<mode> digest timing: every-call (default), each-prompt, or session-start
 *   PI_CMEM_MAX_INJECT_CHARS=<chars> injected digest limit (default: 0, unlimited)
 *   PI_CMEM_PROJECT=<name> override the project name (default: cwd basename)
 *   PI_CMEM_WORKER_HOST=<host> worker host (default: 127.0.0.1)
 *   PI_CMEM_WORKER_PORT=<port> worker port (default: 37777)
 *   PI_CMEM_FALLBACK_PATH=<path> optional Chroma fallback helper (default: none)
 *
 * Upstream reference: github.com/thedotmack/claude-mem (Apache-2.0). This file is
 * an independent reimplementation of its pi adapter, under the package's MIT licence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { resolveSettings, type ResolvedSettings, type SettingProvenance } from "../../shared/settings.ts";
import { announce } from "../../shared/announce.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLATFORM_SOURCE = "pi-agent";

const DEFAULT_WORKER_PORT = 37777;
const WORKER_TIMEOUT_MS = 8_000;
const CHROMA_TIMEOUT_MS = 30_000;
const MAX_OBSERVATION_CHARS = 1_000;
const MIN_OBSERVATION_CHARS = 200;
const MAX_SEARCH_LIMIT = 100;
const SESSION_COMPLETE_DELAY_MS = 3_000;
type InjectWhen = "every-call" | "each-prompt" | "session-start";

const CLAUDE_MEM_SETTINGS_DESCRIPTION = "claude-mem's own settings (CLAUDE_MEM_WORKER_";

/**
 * claude-mem publishes the worker it started at `~/.claude-mem/settings.json`
 * (or `$CLAUDE_MEM_DATA_DIR/settings.json`). Asking a peer service where it
 * lives is a protocol, not a hard-coded path, and that file is itself a
 * configuration file -- so this is a discovery layer, not a machine
 * dependency. Never throws: an absent or malformed file just means nothing
 * was discovered, same as F1's rule for our own settings files.
 */
function readClaudeMemSetting(key: string): unknown {
	const dir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
	try {
		const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		return raw[key];
	} catch {
		return undefined;
	}
}

function discoverWorkerHost(): { value: string } | undefined {
	const value = readClaudeMemSetting("CLAUDE_MEM_WORKER_HOST");
	return typeof value === "string" && value ? { value } : undefined;
}

function discoverWorkerPort(): { value: number } | undefined {
	// claude-mem writes this as a JSON *string* ("37701"), not a number. The
	// upstream pi-agent-memory bridge checks `typeof === "number"`, so it
	// never matches, falls back to its own default, and every call fails.
	// Accept both shapes.
	const value = readClaudeMemSetting("CLAUDE_MEM_WORKER_PORT");
	if (typeof value === "number" && Number.isFinite(value)) return { value };
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return { value: parsed };
	}
	return undefined;
}

const SETTING_DEFINITIONS = {
	disabled: { default: false, env: "PI_CMEM_DISABLED", parseEnv: (value: string) => value === "1" },
	capture: { default: true, env: "PI_CMEM_CAPTURE", parseEnv: (value: string) => value !== "0" },
	inject: { default: false, env: "PI_CMEM_INJECT", parseEnv: (value: string) => value === "1" },
	workerHost: {
		default: "127.0.0.1",
		env: "PI_CMEM_WORKER_HOST",
		discover: discoverWorkerHost,
		discoverName: `${CLAUDE_MEM_SETTINGS_DESCRIPTION}HOST)`,
	},
	workerPort: {
		default: DEFAULT_WORKER_PORT,
		env: "PI_CMEM_WORKER_PORT",
		parseEnv: Number,
		discover: discoverWorkerPort,
		discoverName: `${CLAUDE_MEM_SETTINGS_DESCRIPTION}PORT)`,
	},
	project: { default: "", env: "PI_CMEM_PROJECT" },
	fallbackPath: { default: "", env: "PI_CMEM_FALLBACK_PATH" },
	skipTools: {
		default: [] as string[],
		env: "PI_CMEM_SKIP_TOOLS",
		parseEnv: (value: string) => value.split(",").map((tool) => tool.trim()).filter(Boolean),
	},
	maxObservationChars: { default: MAX_OBSERVATION_CHARS, env: "PI_CMEM_MAX_OBSERVATION_CHARS", parseEnv: Number },
	injectWhen: { default: "every-call" as InjectWhen, env: "PI_CMEM_INJECT_WHEN" },
	maxInjectChars: { default: 0, env: "PI_CMEM_MAX_INJECT_CHARS", parseEnv: Number },
};

const SETTABLE_SETTINGS = [
	"capture",
	"inject",
	"injectWhen",
	"skipTools",
	"maxObservationChars",
	"maxInjectChars",
	"project",
] as const;

type SettableSetting = (typeof SETTABLE_SETTINGS)[number];
type SessionOverrideValues = {
	capture: boolean;
	inject: boolean;
	injectWhen: InjectWhen;
	skipTools: string[];
	maxObservationChars: number;
	maxInjectChars: number;
	project: string;
};
type EffectiveSettings = {
	[Key in keyof typeof SETTING_DEFINITIONS]: {
		value: (typeof SETTING_DEFINITIONS)[Key]["default"];
		provenance: SettingProvenance | { source: "session override" };
	};
};

function parseSessionOverride(setting: SettableSetting, value: string): { key: SettableSetting; value: SessionOverrideValues[SettableSetting] } | { error: string } {
	switch (setting) {
		case "capture":
		case "inject":
			if (value === "on") return { key: setting, value: true };
			if (value === "off") return { key: setting, value: false };
			return { error: `${setting} must be on or off.` };
		case "injectWhen":
			if (["every-call", "each-prompt", "session-start"].includes(value)) {
				return { key: setting, value: value as InjectWhen };
			}
			return { error: "injectWhen must be every-call, each-prompt, or session-start." };
		case "skipTools":
			return { key: setting, value: value.split(",").map((tool) => tool.trim()).filter(Boolean) };
		case "maxObservationChars": {
			const chars = Number(value);
			if (Number.isInteger(chars) && chars >= MIN_OBSERVATION_CHARS) return { key: setting, value: chars };
			return { error: `maxObservationChars must be an integer of at least ${MIN_OBSERVATION_CHARS}.` };
		}
		case "maxInjectChars": {
			const chars = Number(value);
			if (Number.isInteger(chars) && chars >= 0) return { key: setting, value: chars };
			return { error: "maxInjectChars must be a non-negative integer." };
		}
		case "project":
			return { key: setting, value };
	}
}

function withSessionOverrides(
	settings: ResolvedSettings<typeof SETTING_DEFINITIONS>,
	overrides: Partial<SessionOverrideValues>,
): EffectiveSettings {
	const effective = { ...settings } as EffectiveSettings;
	const values = effective as unknown as Record<string, unknown>;
	for (const key of SETTABLE_SETTINGS) {
		const value = overrides[key];
		if (value !== undefined) values[key] = { value, provenance: { source: "session override" } };
	}
	return effective;
}

let disabled = false;
let captureEnabled = true;
let injectEnabled = false;
let host = "127.0.0.1";
let port = DEFAULT_WORKER_PORT;
let configuredProject = "";
let fallbackChromaScript = "";
let skipTools: string[] = [];
let maxObservationChars = MAX_OBSERVATION_CHARS;
let injectWhen: InjectWhen = "every-call";
let maxInjectChars = 0;

function baseUrl(): string {
	return `http://${host}:${port}`;
}

/**
 * Project scope. Deliberately the bare cwd basename, matching what Claude Code and
 * Codex already write, so one repo is one memory namespace across engines.
 */
function projectName(cwd: string): string {
	if (configuredProject) return configuredProject;
	return basename(cwd) || "unknown";
}

// ---------------------------------------------------------------------------
// Worker HTTP helpers
// ---------------------------------------------------------------------------

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function workerGetText(path: string, signal?: AbortSignal): Promise<string | null> {
	const timeout = withTimeout(WORKER_TIMEOUT_MS);
	try {
		// The caller's signal must not REPLACE the 8 s cap: a stalled worker held a recall for 9 min (2026-09-15).
		const res = await fetch(`${baseUrl()}${path}`, { signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	} finally {
		timeout.clear();
	}
}

async function workerPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
	const timeout = withTimeout(WORKER_TIMEOUT_MS);
	try {
		const res = await fetch(`${baseUrl()}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: timeout.signal,
		});
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	} finally {
		timeout.clear();
	}
}

/** Capture must never slow the agent down or surface errors into the transcript. */
function workerPostFireAndForget(path: string, body: unknown): void {
	fetch(`${baseUrl()}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}).catch(() => {
		/* worker down / queue full: memory is best-effort, the turn is not */
	});
}

function workerAlive(): Promise<boolean> {
	return workerGetText("/api/health").then((v) => v !== null);
}

// ---------------------------------------------------------------------------
// Recall: worker first, Chroma fallback
// ---------------------------------------------------------------------------

async function searchViaWorker(query: string, limit: number, project: string, signal?: AbortSignal): Promise<string | null> {
	const params = new URLSearchParams({ query, limit: String(limit), project });
	const text = await workerGetText(`/api/search?${params.toString()}`, signal);
	return text && text.trim() ? text : null;
}

/**
 * v1 path, kept as a degraded fallback. Reads Chroma directly via the helper
 * script, so it works while the worker is stopped. Returns plain text.
 */
async function searchViaChromaScript(query: string, limit: number, signal?: AbortSignal): Promise<string> {
	if (!fallbackChromaScript || !existsSync(fallbackChromaScript)) {
		throw new Error(`memory recall unavailable: worker unreachable at ${baseUrl()} and no Chroma fallback is configured`);
	}
	const { stdout } = await execFileAsync(
		"python3",
		[fallbackChromaScript, query, "--limit", String(limit)],
		{
			timeout: CHROMA_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			signal,
			// Run from $HOME, not the session cwd: a stray module in the working directory
			// (e.g. an enum.py left in /tmp) shadows Python's stdlib and crashes chromadb's import.
			cwd: homedir(),
		},
	);
	return stdout.trim() || "No matching memories found.";
}

// ---------------------------------------------------------------------------
// Capture state
// ---------------------------------------------------------------------------

let contentSessionId: string | null = null;
let baseContentSessionId: string | null = null;
let sessionStartProject = "unknown";
let sessionProject = "unknown";
let sessionCwd = process.cwd();
let workerHealthy = true;

function observationPayload(toolName: string, input: unknown, responseText: string) {
	const truncated = responseText.length > maxObservationChars;
	return {
		truncated,
		payload: {
			contentSessionId,
			tool_name: toolName,
			tool_input: input ?? {},
			tool_response: truncated ? `${responseText.slice(0, maxObservationChars - 12)} [truncated]` : responseText,
			cwd: sessionCwd,
			platformSource: PLATFORM_SOURCE,
		},
	};
}

function setSessionProject(project: string, pi: ExtensionAPI): void {
	if (project === sessionProject) return;
	sessionProject = project;
	if (!baseContentSessionId) return;
	contentSessionId = project === sessionStartProject ? baseContentSessionId : `${baseContentSessionId}:${project}`;
	pi.appendEntry("pi-cmem-session", { contentSessionId, project: sessionProject, worker: baseUrl() });
}

type SessionCounters = {
	observationsSent: number;
	observationsSkipped: number;
	observationsTruncated: number;
	digestsInjected: number;
	lastDigestSize: number | null;
};

function newSessionCounters(): SessionCounters {
	return { observationsSent: 0, observationsSkipped: 0, observationsTruncated: 0, digestsInjected: 0, lastDigestSize: null };
}

function provenanceLabel(provenance: SettingProvenance | { source: "session override" }): string {
	switch (provenance.source) {
		case "default":
			return "default";
		case "session override":
			return "session override";
		case "discovered":
			return `discovered: ${provenance.name}`;
		case "global":
			return `global: ${provenance.path}`;
		case "project":
			return `project: ${provenance.path}`;
		case "environment":
			return `environment: ${provenance.name}`;
	}
}

function settingsLines(settings: EffectiveSettings | undefined): string {
	return (Object.keys(SETTING_DEFINITIONS) as Array<keyof typeof SETTING_DEFINITIONS>)
		.map((key) => {
			const setting = settings?.[key];
			if (!setting) return `  ${key}: unresolved`;
			return `  ${key}: ${JSON.stringify(setting.value)} (${provenanceLabel(setting.provenance)})`;
		})
		.join("\n");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

function formatInjectedDigest(digest: string): string {
	const content = maxInjectChars > 0 && digest.length > maxInjectChars
		? `${digest.slice(0, maxInjectChars)} [truncated]`
		: digest;
	return `<pi-cmem-context>\n${content}\n</pi-cmem-context>`;
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: unknown } | undefined;
		if (msg?.role === "assistant") return textOf(msg.content);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piCmemExtension(pi: ExtensionAPI) {
	let preflightAnnounced = false;
	let resolvedSettings: ResolvedSettings<typeof SETTING_DEFINITIONS> | undefined;
	let sessionOverrides: Partial<SessionOverrideValues> = {};
	let sessionCounters = newSessionCounters();
	const currentSettings = () => resolvedSettings ? withSessionOverrides(resolvedSettings, sessionOverrides) : undefined;
	const applyCurrentSettings = () => {
		const settings = currentSettings();
		if (!settings) return;
		disabled = settings.disabled.value;
		captureEnabled = !disabled && settings.capture.value;
		injectEnabled = !disabled && settings.inject.value;
		host = settings.workerHost.value;
		port = settings.workerPort.value;
		configuredProject = settings.project.value;
		fallbackChromaScript = settings.fallbackPath.value;
		skipTools = settings.skipTools.value;
		maxObservationChars = settings.maxObservationChars.value;
		injectWhen = settings.injectWhen.value;
		maxInjectChars = settings.maxInjectChars.value;
	};

	// --- session_start: resolve this project's settings and check the worker ---
	pi.on("session_start", async (_event, ctx) => {
		sessionOverrides = {};
		const resolved = resolveSettings("pi-cmem", SETTING_DEFINITIONS, ctx);
		if (!Array.isArray(resolved.skipTools.value) || resolved.skipTools.value.some((tool) => typeof tool !== "string")) {
			announce(
				ctx,
				"pi-cmem: invalid skipTools setting; expected an array of tool names; using default [].",
				"warning",
				"pi-cmem-invalid-skipTools",
			);
			resolved.skipTools = { value: [], provenance: { source: "default" } };
		}
		if (!Number.isInteger(resolved.maxObservationChars.value) || resolved.maxObservationChars.value < MIN_OBSERVATION_CHARS) {
			announce(
				ctx,
				`pi-cmem: invalid maxObservationChars setting; expected an integer of at least ${MIN_OBSERVATION_CHARS}; using default ${MAX_OBSERVATION_CHARS}.`,
				"warning",
				"pi-cmem-invalid-maxObservationChars",
			);
			resolved.maxObservationChars = { value: MAX_OBSERVATION_CHARS, provenance: { source: "default" } };
		}
		if (!(["every-call", "each-prompt", "session-start"] as string[]).includes(String(resolved.injectWhen.value))) {
			announce(
				ctx,
				"pi-cmem: invalid injectWhen setting; expected every-call, each-prompt, or session-start; using default every-call.",
				"warning",
				"pi-cmem-invalid-injectWhen",
			);
			resolved.injectWhen = { value: "every-call", provenance: { source: "default" } };
		}
		if (!Number.isInteger(resolved.maxInjectChars.value) || resolved.maxInjectChars.value < 0) {
			announce(
				ctx,
				"pi-cmem: invalid maxInjectChars setting; expected a non-negative integer; using default 0 (unlimited).",
				"warning",
				"pi-cmem-invalid-maxInjectChars",
			);
			resolved.maxInjectChars = { value: 0, provenance: { source: "default" } };
		}
		resolvedSettings = resolved;
		sessionCounters = newSessionCounters();
		applyCurrentSettings();
		preflightAnnounced = false;
		sessionCwd = ctx.cwd;
		sessionProject = projectName(ctx.cwd);
		if (disabled) return;

		// Keep Pi's session id as the base: resumed sessions reuse its worker row, while a
		// project override derives a separate row from it. Pi session ids are UUIDv7, the same
		// shape claude and codex already write. Falls back to a synthetic id if unavailable.
		const piSession =
			typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		sessionStartProject = sessionProject;
		baseContentSessionId = piSession || `pi-${sessionProject}-${Date.now()}`;
		contentSessionId = baseContentSessionId;
		workerHealthy = await workerAlive();
		if (!workerHealthy && !preflightAnnounced) {
			const recallCost = fallbackChromaScript && existsSync(fallbackChromaScript)
				? "recall uses the slower Chroma fallback"
				: "recall has no fallback";
			// Name a discovered value explicitly: a stale hard-coded default and a
			// value discovered from claude-mem's own settings both reach here, and
			// the operator needs to know which one this actually is before
			// misattributing the cause.
			const discoveredKeys = [
				resolved.workerHost.provenance.source === "discovered" && "host",
				resolved.workerPort.provenance.source === "discovered" && "port",
			].filter((key): key is string => typeof key === "string");
			const discoveryNote = discoveredKeys.length
				? ` (${discoveredKeys.join(" and ")} discovered from claude-mem's own settings)`
				: "";
			announce(
				ctx,
				`pi-cmem: claude-mem worker unreachable at ${baseUrl()}${discoveryNote}; capture and context injection are unavailable, and ${recallCost}`,
				"warning",
				"pi-cmem:worker-unreachable",
			);
			preflightAnnounced = true;
		}
		// Unconditional: the transcript-watch `pi` schema (if it is ever reinstated) keys its
		// session_init off this entry, and PI_CMEM_CAPTURE=0 must not break that linkage.
		// Field is named `project`, not v1's `projectName`.
		pi.appendEntry("pi-cmem-session", { contentSessionId, project: sessionProject, worker: baseUrl() });
	});

	// --- before_agent_start: register THIS turn's prompt ---
	// claude-mem's session_init is per-prompt, not per-session: re-posting the same
	// contentSessionId bumps promptNumber on the same session row (verified: 1→2→3 on one
	// sessionDbId), and the worker only performs its own context injection from the second
	// init onward. A once-per-session guard therefore lost every prompt after the first for
	// the privacy filter, the searchable prompts class, and worker-side injection. The Codex
	// schema in transcript-watch.json maps every user message to session_init for the same
	// reason.
	pi.on("before_agent_start", async (event, ctx) => {
		if (captureEnabled && contentSessionId) {
			const res = await workerPost("/api/sessions/init", {
				contentSessionId,
				project: sessionProject,
				prompt: event.prompt || "pi session",
				platformSource: PLATFORM_SOURCE,
			});
			workerHealthy = res !== null;
		}
		if (!injectEnabled || injectWhen === "every-call" || !contentSessionId || !workerHealthy) return;

		if (
			injectWhen === "session-start" &&
			ctx.sessionManager.getBranch().some(
				(entry) => entry.type === "custom_message" && entry.customType === "pi-cmem-context",
			)
		) return;
		const digest = await workerGetText(`/api/context/inject?projects=${encodeURIComponent(sessionProject)}`);
		if (!digest || !digest.trim()) return;
		sessionCounters.digestsInjected += 1;
		sessionCounters.lastDigestSize = digest.length;
		return {
			message: {
				customType: "pi-cmem-context",
				content: formatInjectedDigest(digest),
				display: false,
			},
		};
	});

	// --- context: opt-in digest injection ---
	pi.on("context", async (event) => {
		if (!injectEnabled || injectWhen !== "every-call" || !contentSessionId || !workerHealthy) return;
		const digest = await workerGetText(`/api/context/inject?projects=${encodeURIComponent(sessionProject)}`);
		if (!digest || !digest.trim()) return;
		sessionCounters.digestsInjected += 1;
		sessionCounters.lastDigestSize = digest.length;
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: formatInjectedDigest(digest) }],
				},
			],
		};
	});

	// --- tool_result: capture, skipping our own tool to avoid a recall feedback loop ---
	pi.on("tool_result", (event) => {
		if (!captureEnabled || !contentSessionId || !workerHealthy) return;
		const toolName = event.toolName;
		if (!toolName || toolName === "memory_recall" || skipTools.includes(toolName)) {
			sessionCounters.observationsSkipped += 1;
			return;
		}
		const observation = observationPayload(toolName, event.input, textOf(event.content));
		sessionCounters.observationsSent += 1;
		if (observation.truncated) sessionCounters.observationsTruncated += 1;
		workerPostFireAndForget("/api/sessions/observations", observation.payload);
	});

	// --- agent_end: summarize then close, delayed so in-flight observations land ---
	pi.on("agent_end", async (event) => {
		if (!captureEnabled || !contentSessionId || !workerHealthy) return;
		await workerPost("/api/sessions/summarize", {
			contentSessionId,
			last_assistant_message: lastAssistantText(event.messages),
			platformSource: PLATFORM_SOURCE,
		});
		const sid = contentSessionId;
		setTimeout(() => {
			workerPostFireAndForget("/api/sessions/complete", { contentSessionId: sid, platformSource: PLATFORM_SOURCE });
		}, SESSION_COMPLETE_DELAY_MS);
	});

	// --- session_compact: keep the same claude-mem session across compaction ---
	pi.on("session_compact", () => {
		/* no-op by design: the Pi session continues, so the claude-mem session must too */
	});

	pi.on("session_shutdown", () => {
		contentSessionId = null;
		baseContentSessionId = null;
	});

	// --- the one and only recall tool (name unchanged from v1) ---
	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search cross-session persistent memory (claude-mem: shared across Claude Code, Codex and Pi). " +
			"Use when the user asks about previous work, or when you need context on how something was done before.",
		promptSnippet: "Search cross-session persistent memory of past work",
		promptGuidelines: [
			"Use memory_recall before asking the user to re-explain earlier work or past decisions.",
			"Batch related questions into one query, then fetch only the relevant results.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural language search query" }),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default 5, max 100)" }),
			),
			project: Type.Optional(
				Type.String({ description: "Restrict to one project name (default: current repo, then all projects)" }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 5)), MAX_SEARCH_LIMIT);
			const query = String(params.query ?? "").trim();
			if (!query) throw new Error("memory_recall: query must not be empty");

			const scoped = params.project || sessionProject;

			// 1. worker (hybrid FTS5 + Chroma, privacy-filtered), scoped to this project
			const scoped_ = await searchViaWorker(query, limit, scoped, signal);
			if (scoped_) return { content: [{ type: "text" as const, text: scoped_ }], details: {} };

			// 2. worker, cross-engine / cross-project (project may be unset for a fresh dir)
			const unscoped = await workerGetText(
				`/api/search?query=${encodeURIComponent(query)}&limit=${limit}`,
				signal,
			);
			if (unscoped && unscoped.trim()) return { content: [{ type: "text" as const, text: unscoped }], details: {} };

			// 3. Chroma direct read, only if the worker is unreachable
			if (await workerAlive()) {
				return { content: [{ type: "text" as const, text: "No matching memories found." }], details: {} };
			}
			return {
				content: [{ type: "text" as const, text: await searchViaChromaScript(query, limit, signal) }],
				details: { source: "chroma-fallback" },
			};
		},
	});

	// --- session-only settings overrides ---
	pi.registerCommand("memory-set", {
		description: "Override pi-cmem settings for this session",
		getArgumentCompletions: (argumentPrefix) => {
			if (/\s/.test(argumentPrefix)) return null;
			const prefix = argumentPrefix.trim();
			return SETTABLE_SETTINGS
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ value: key, label: key }));
		},
		handler: async (args, ctx) => {
			if (!resolvedSettings) {
				announce(ctx, "pi-cmem: settings are unavailable until the session starts.", "warning");
				return;
			}

			const input = args.trim();
			if (!input) {
				const lines = SETTABLE_SETTINGS
					.filter((key) => sessionOverrides[key] !== undefined)
					.map((key) => `  ${key}: ${JSON.stringify(sessionOverrides[key])}`);
				announce(ctx, lines.length ? `pi-cmem session overrides:\n${lines.join("\n")}` : "pi-cmem: no session overrides.", "info");
				return;
			}

			if (input === "reset") {
				sessionOverrides = {};
				applyCurrentSettings();
				setSessionProject(projectName(sessionCwd), pi);
				announce(ctx, "pi-cmem: session overrides reset.", "info");
				return;
			}

			const separator = input.search(/\s/);
			const key = separator < 0 ? input : input.slice(0, separator);
			const value = separator < 0 ? "" : input.slice(separator).trim();
			if (!SETTABLE_SETTINGS.includes(key as SettableSetting)) {
				const reason = Object.hasOwn(SETTING_DEFINITIONS, key)
					? `${key} cannot be changed during a session.`
					: `unknown setting "${key}".`;
				announce(ctx, `pi-cmem: ${reason}`, "warning");
				return;
			}
			if (!value) {
				announce(ctx, `pi-cmem: missing value for ${key}.`, "warning");
				return;
			}

			const result = parseSessionOverride(key as SettableSetting, value);
			if ("error" in result) {
				announce(ctx, `pi-cmem: ${result.error}`, "warning");
				return;
			}

			sessionOverrides = { ...sessionOverrides, [result.key]: result.value };
			applyCurrentSettings();
			if (result.key === "project") setSessionProject(projectName(sessionCwd), pi);
			announce(ctx, `pi-cmem: ${result.key} set to ${JSON.stringify(result.value)} for this session.`, "info");
		},
	});

	// --- health ---
	pi.registerCommand("memory-status", {
		description: "Show effective pi-cmem settings and session activity",
		handler: async (_args, ctx) => {
			const health = await workerGetText("/api/health");
			let version = "?";
			try {
				if (health) version = String((JSON.parse(health) as { version?: string }).version ?? "?");
			} catch {
				/* non-JSON health: still reachable */
			}
			announce(
				ctx,
				[
					"pi-cmem:",
					health
						? `worker: reachable (version ${version}) @ ${baseUrl()}`
						: `worker: unreachable @ ${baseUrl()}`,
					`project: ${sessionProject} | session: ${contentSessionId ?? "none"}`,
					"settings:",
					settingsLines(currentSettings()),
					"session counters:",
					`  observations sent: ${sessionCounters.observationsSent}; skipped: ${sessionCounters.observationsSkipped}; truncated: ${sessionCounters.observationsTruncated}`,
					`  digests injected: ${sessionCounters.digestsInjected}; last digest size: ${sessionCounters.lastDigestSize === null ? "none" : `${sessionCounters.lastDigestSize} characters`}`,
				].join("\n"),
				"info",
			);
		},
	});
}
