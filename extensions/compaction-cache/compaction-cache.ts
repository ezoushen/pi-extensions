/**
 * compaction-cache — make Pi's compaction reuse the server's KV prefix cache.
 *
 * Problem (measured on a large-context model behind a prefix-caching server):
 *   Pi builds every summarization request from scratch:
 *       systemPrompt: SUMMARIZATION_SYSTEM_PROMPT
 *       messages:     [ user: "<conversation>…serialized blob…</conversation>\n\nSUMMARIZATION_PROMPT" ]
 *   Nothing in it is a prefix of the live conversation the server still holds in
 *   its KV cache, and vLLM's prefix cache is a strict prefix match on block
 *   hashes — divergence in the first block discards every cached block. Measured
 *   on a 125k-token session: 151,148 prompt tokens, 0 cached, 177s of TTFT.
 *
 * Fix: keep Pi's instructions but move them to the *end* of the live
 * conversation instead of replacing it:
 *       [ live system + live tools ][ live msg1..msgN ][ user: instructions ]
 * Everything before the final turn is byte-identical to the request Pi just
 * sent, because it is literally the same payload object.
 *
 * Why the rewrite happens here and not in `before_provider_request`:
 *   Pi's summarization calls go through `createSummarizationOptions()`, which
 *   never sets `onPayload`, so the `before_provider_request` hook is not fired
 *   for them (verified: only agent turns reach it). Instead this extension runs
 *   the summarization call itself from `session_before_compact` and passes its
 *   own `onPayload`, which the openai-completions provider does honour:
 *       nextParams = await options?.onPayload?.(params, model)
 *
 * Pi keeps ownership of the surrounding contract: the summary is post-processed
 * with the same <read-files>/<modified-files> blocks and `details` payload its
 * own compaction produces. Every guard failure returns undefined, and Pi runs
 * its default compaction — cold, but correct.
 *
 * LOAD ORDER MATTERS — this file must load LAST.
 *   Pi's extension runner keeps the last truthy handler result:
 *       handlerResult && (result = handlerResult, ...)
 *   Another extension that also hooks session_before_compact and returns an
 *   empty compaction result (`return {}`) replaces whatever this extension
 *   returned. Pi sees no `.compaction`, and silently runs its default (cold)
 *   compaction.
 *   Discovery order is: <cwd>/.pi/extensions, then ~/.pi/agent/extensions, then
 *   configured packages — so living in ~/.pi/agent/extensions always loses.
 *   Hence this file sits OUTSIDE the auto-discovered directory and is the final
 *   entry of `packages` in ~/.pi/agent/settings.json.
 *   If it loses the race anyway, the session_compact handler below detects it,
 *   warns once, and disables itself so no further work is wasted.
 *
 * PI_COMPACTION_CACHE=0          disable
 * PI_COMPACTION_CACHE_MODELS='["provider/model"]' override the cost heuristic
 * PI_COMPACTION_CACHE_LOG=<path> append one JSON line per decision
 * PI_COMPACTION_CACHE_DEBUG=1    also log payload skeletons
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { minimatch } from "minimatch";
import {
	resolveSettings,
	type ResolvedSettings,
	type SettingProvenance,
} from "../../shared/settings.ts";
import { announce } from "../../shared/announce.ts";

const SETTING_DEFINITIONS = {
	enabled: {
		default: true,
		env: "PI_COMPACTION_CACHE",
		parseEnv: (value: string) => value !== "0",
	},
	models: {
		default: [] as string[],
		env: "PI_COMPACTION_CACHE_MODELS",
		parseEnv: (value: string) => JSON.parse(value) as string[],
	},
	logPath: { default: "", env: "PI_COMPACTION_CACHE_LOG" },
	debug: {
		default: false,
		env: "PI_COMPACTION_CACHE_DEBUG",
		parseEnv: (value: string) => value === "1",
	},
	scope: { default: "boundary", env: "PI_COMPACTION_CACHE_SCOPE" },
	maxWords: {
		default: 1500,
		env: "PI_COMPACTION_CACHE_MAX_WORDS",
		parseEnv: (value: string) => Number(value),
	},
};

type CompactionCacheSettings = ResolvedSettings<typeof SETTING_DEFINITIONS>;

export interface Applicability {
	active: boolean;
	rule: string;
	reason?: string;
}

/** Verbatim from Pi (core/compaction/compaction.ts) so the summary keeps its shape. */
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above include an earlier summary of this conversation followed by newer messages. Produce a single updated summary. RULES:
- PRESERVE all existing information from the earlier summary
- ADD new progress, decisions, and context from the newer messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

${SUMMARIZATION_PROMPT}`;

/** Tools stay in the payload to preserve the prefix, so calling them is forbidden. */
const NO_TOOLS_NOTE = "\n\nDo not call any tool. Output only the summary text.";

/**
 * Pi bounds its summarization *input* (serializeConversation truncates every
 * tool result to 2000 chars). This extension deliberately sends the untruncated
 * conversation, so it has to bound the *output* instead — without a budget a
 * 100k-token session produced a 29,685-character summary, which defeats the
 * point of compacting. Stated as guidance rather than a hard max_tokens cap
 * because hitting the cap yields stopReason "length", which is discarded.
 */
/**
 * Copied from the request Pi's own options built, onto the rewritten one.
 * Everything else comes from the live request so the rendered prompt — and
 * therefore the block hashes — match what the server cached.
 */
const GENERATION_FIELDS = [
	// `model` included deliberately: the rest of the payload is copied from the
	// live request, and if the session switched models since then, live carries
	// the *previous* model id while the call is routed to the current one.
	// Taking it from Pi's request is always right and needs no comparison.
	"model",
	"max_tokens",
	"max_completion_tokens",
	"temperature",
	"top_p",
	"stop",
	"stream",
	"stream_options",
];

type Payload = Record<string, any>;

function log(path: string, entry: Record<string, unknown>): void {
	if (!path) return;
	try {
		appendFileSync(path, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
	} catch {}
}

function provenanceText(provenance: SettingProvenance): string {
	switch (provenance.source) {
		case "default":
			return "default";
		case "discovered":
			return `discovered: ${provenance.name}`;
		case "global":
		case "project":
			return `${provenance.source}: ${provenance.path}`;
		case "environment":
			return `environment: ${provenance.name}`;
	}
}

function settingValueText(value: unknown): string {
	return JSON.stringify(value);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
}

function messagesText(messages: any[]): string {
	return messages.map((m: any) => contentText(m?.content)).join("\n");
}

/**
 * The prompts above are copies of Pi's. A pi upgrade that reworded them would
 * silently change what this extension asks for, so check them against the
 * installed bundle. Returns undefined when the bundle cannot be located, which
 * is not an error — just an unverifiable install.
 */
export function checkPromptDrift(bundleDir: string | undefined, needles: string[]): boolean | undefined {
	if (!bundleDir) return undefined;
	try {
		const files = readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
		for (const file of files) {
			const source = readFileSync(join(bundleDir, file), "utf8");
			if (!source.includes(needles[0])) continue;
			return needles.every((needle) => source.includes(needle));
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** dist/bundle/chunks of the running pi, derived from the launched script. */
export function findBundleDir(argv1: string | undefined): string | undefined {
	if (!argv1) return undefined;
	try {
		return join(dirname(realpathSync(argv1)), "chunks");
	} catch {
		return undefined;
	}
}

/** First completed assistant turn at or after `from`; -1 if there is none. */
export function completedAssistantAt(messages: any[], from: number): number {
	for (let i = Math.max(0, from); i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "assistant" && !(m.tool_calls?.length > 0)) return i;
	}
	return -1;
}

/**
 * Where the material Pi actually wants summarized ends, as an index into the live
 * payload. Pi summarizes `messagesToSummarize` — the *old* slice — and keeps the
 * recent tail verbatim. That slice is itself a prefix of the conversation, so
 * cutting there is still a cache hit while dropping ~29% of the tokens and, more
 * importantly, not asking the model to summarize text compaction is about to keep
 * anyway. Located by content, since one pi message can expand into several wire
 * messages. Returns -1 when it cannot be located, and the caller then sends the
 * whole conversation as before.
 */
export function summaryBoundaryIndex(messages: any[], summarized: any[]): number {
	for (let s = summarized.length - 1; s >= 0; s--) {
		const text = contentText(summarized[s]?.content).trim();
		if (text.length < 40) continue;
		const probe = text.slice(0, 120);
		for (let i = messages.length - 1; i >= 0; i--) {
			if (contentText(messages[i]?.content).includes(probe)) return i;
		}
	}
	return -1;
}

/**
 * Build the prefix-preserving request: the live conversation, plus the
 * summarization instructions as one appended user turn, keeping the generation
 * settings Pi chose for summarization.
 */
export function buildRewrittenPayload(
	livePayload: Payload,
	summarizationParams: Payload,
	instruction: string,
	cutFrom = -1,
): Payload | undefined {
	if (!Array.isArray(livePayload.messages) || livePayload.messages.length === 0) return undefined;

	// The live request ends with a turn the model has not answered yet — its reply
	// came back after the request was sent. Appending the summarization
	// instruction after that pending turn makes the model answer the pending one
	// instead (observed: a session ending in "Reply with exactly: OK" summarized
	// to the literal text "OK"). Cut back to the last completed assistant turn,
	// which is still a strict prefix of what the server cached, so still a hit.
	// Anything dropped survives verbatim in the messages compaction keeps.
	// Scan *forward* from the boundary, never back: cutting before it would drop
	// messages compaction is about to discard, losing them for good. Overshooting
	// into the kept tail is harmless — that text is merely summarized twice.
	const end =
		cutFrom >= 0
			? completedAssistantAt(livePayload.messages, cutFrom)
			: livePayload.messages.findLastIndex(
					(m: any) => m?.role === "assistant" && !(m.tool_calls?.length > 0),
				);
	if (end < 0) return undefined;
	const conversation = livePayload.messages.slice(0, end + 1);

	const lastUser = [...conversation].reverse().find((m: any) => m?.role === "user");
	const instructionMessage =
		lastUser && typeof lastUser.content !== "string"
			? { role: "user", content: [{ type: "text", text: instruction }] }
			: { role: "user", content: instruction };

	const rewritten: Payload = {
		...livePayload,
		messages: [...conversation, instructionMessage],
	};
	for (const field of GENERATION_FIELDS) {
		if (field in summarizationParams) rewritten[field] = summarizationParams[field];
		else delete rewritten[field];
	}
	return rewritten;
}

/**
 * This trades input tokens for cache hits: it sends the whole conversation
 * (measured: 21x more tokens than Pi's truncated blob) and relies on the server
 * serving ~99% of it from cache at no cost. That is only sound where input
 * tokens are free and the server does content-addressed prefix caching — i.e. a
 * self-hosted engine. On a metered endpoint it would be a straight cost
 * regression, so gate on the model's own declared price.
 */
export function inputTokensAreFree(model: any): boolean {
	const cost = model?.cost;
	if (!cost) return false;
	return (cost.input ?? 0) === 0 && (cost.cacheRead ?? 0) === 0;
}

/** Decide applicability using an explicit model matcher or the safe cost heuristic. */
export function modelApplicability(model: any, patterns: string[]): Applicability {
	if (!model) {
		return { active: false, rule: "current model", reason: "there is no current model" };
	}

	const fullId = `${model.provider}/${model.id}`;
	if (patterns.length > 0) {
		const pattern = patterns.find(
			(candidate) =>
				minimatch(fullId, candidate, { nocase: true }) ||
				minimatch(model.id, candidate, { nocase: true }),
		);
		return pattern
			? { active: true, rule: `models matcher (${pattern})` }
			: {
					active: false,
					rule: "models matcher",
					reason: `${fullId} does not match any configured model pattern`,
				};
	}

	if (!model.cost) {
		return {
			active: false,
			rule: "zero-cost heuristic",
			reason: `${fullId} has no cost metadata and no models matcher is configured`,
		};
	}
	if (!inputTokensAreFree(model)) {
		return {
			active: false,
			rule: "zero-cost heuristic",
			reason: `${fullId} has a non-zero input or cache-read price and no models matcher is configured`,
		};
	}
	return { active: true, rule: "zero-cost heuristic" };
}

/** Retry once on a dropped stream; anything else defers to Pi immediately. */
export function isTransient(error: unknown): boolean {
	if (!error) return false;
	const name = (error as any)?.name;
	if (name === "AbortError") return false;
	const message = error instanceof Error ? error.message : String(error);
	return /terminated|socket|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|network/i.test(message);
}

/** Pi's computeFileLists(): written+edited are "modified", reads exclude those. */
export function computeFileLists(fileOps: any): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set<string>([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
	const readFiles = [...(fileOps?.read ?? [])].filter((f: string) => !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

/** Pi's formatFileOperations(). */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/** A correct, self-contained summarization request, used if the rewrite cannot apply. */
function fallbackContext(messages: any[], instruction: string) {
	const serialized = messages
		.map((m: any) => `<${m.role}>\n${contentText(m.content)}\n</${m.role}>`)
		.join("\n");
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `<conversation>\n${serialized}\n</conversation>\n\n${instruction}`,
					},
				],
				timestamp: Date.now(),
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	// Scoped to this extension instance rather than the module: a second load
	// (or a test) must not inherit another instance's captured conversation.
	/** The last ordinary agent request, exactly as it went on the wire. */
	let live: Payload | undefined;
	/** Set when this extension returned a compaction, cleared when Pi reports back. */
	let suppliedCompaction = false;
	/** Latched when Pi reports it used someone else's result despite ours. */
	let lostHandlerRace = false;
	/** Pi's prompt constants are copied above; verify once that they still match. */
	let promptDriftChecked = false;
	/** Decline notices are session-level state, not request-level diagnostics. */
	const announcedDeclines = new Set<string>();

	const settingsFor = (ctx: any) =>
		resolveSettings("compaction-cache", SETTING_DEFINITIONS, {
			cwd: ctx?.cwd ?? process.cwd(),
			isProjectTrusted: () => ctx?.isProjectTrusted?.() ?? false,
			hasUI: ctx?.hasUI,
			ui: ctx?.ui,
		});

	const decline = (
		ctx: any,
		settings: CompactionCacheSettings,
		reason: string,
		message: string,
		details: Record<string, unknown> = {},
	): undefined => {
		log(settings.logPath.value, { skip: reason, ...details });
		if (!announcedDeclines.has(reason)) {
			announcedDeclines.add(reason);
			announce(ctx, `compaction-cache inactive: ${message}.`, "warning", `compaction-cache:decline:${reason}`);
		}
	};

	pi.registerCommand?.("compaction-cache-status", {
		description: "Report compaction-cache applicability and resolved settings",
		handler: async (_args: string, ctx: any) => {
			const settings = settingsFor(ctx);
			const applicability = settings.enabled.value
				? modelApplicability(ctx.model, settings.models.value)
				: { active: false, rule: "enabled setting", reason: "the extension is disabled" };
			const modelName = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no current model";
			const lines = [
				`compaction-cache: ${applicability.active ? "active" : "inactive"} for ${modelName}`,
				`rule: ${applicability.rule}`,
			];
			if (applicability.reason) lines.push(`reason: ${applicability.reason}`);
			for (const [name, setting] of Object.entries(settings)) {
				lines.push(
					`${name} = ${settingValueText(setting.value)} (${provenanceText(setting.provenance)})`,
				);
			}
			announce(ctx, lines.join("\n"), "info");
		},
	});

	// Ordinary agent traffic: remember precisely what the server just cached.
	pi.on("before_provider_request", (event: any, ctx: any) => {
		const payload: Payload = event?.payload;
		if (!payload || !Array.isArray(payload.messages)) return;
		if (Array.isArray(payload.tools) && payload.tools.length > 0) live = payload;
		if (ctx) {
			const settings = settingsFor(ctx);
			if (!settings.debug.value) return;
			log(settings.logPath.value, {
				seen: true,
				n_messages: payload.messages.length,
				n_tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
			});
		}
	});

	// Pi's own verdict on whose compaction was used. If ours was built and then
	// discarded, another extension returned a truthy result after us; stop doing
	// the work rather than paying for a summary nobody uses.
	pi.on("session_compact", (event: any, ctx: any) => {
		const used = event?.fromExtension;
		const settings = settingsFor(ctx);
		log(settings.logPath.value, { finished: true, fromExtension: used, reason: event?.reason });
		if (suppliedCompaction && used === false && !lostHandlerRace) {
			lostHandlerRace = true;
			announcedDeclines.add("lost-handler-race");
			announce(
				ctx,
				"compaction-cache: another extension replaced this one's compaction result. " +
					"Make it the LAST entry of `packages` in ~/.pi/agent/settings.json. " +
					"Disabled for this session.",
				"warning",
				"compaction-cache:lost-handler-race",
			);
		}
		suppliedCompaction = false;
	});
	pi.on("session_compact_failed", (event: any, ctx: any) => {
		suppliedCompaction = false;
		if (ctx) {
			const settings = settingsFor(ctx);
			log(settings.logPath.value, {
				failed: true,
				aborted: event?.aborted,
				errorMessage: event?.errorMessage,
			});
		}
	});

	pi.on("session_before_compact", async (event: any, ctx: any) => {
		const { preparation, customInstructions, signal } = event;
		const settings = settingsFor(ctx);
		if (!settings.enabled.value) {
			return decline(ctx, settings, "disabled", "the enabled setting is false");
		}
		if (lostHandlerRace) {
			return decline(
				ctx,
				settings,
				"lost-handler-race",
				"another extension replaced its compaction result",
			);
		}

		const model = ctx.model;
		const applicability = modelApplicability(model, settings.models.value);
		if (!applicability.active) {
			return decline(
				ctx,
				settings,
				`applicability:${applicability.reason}`,
				applicability.reason as string,
				{ rule: applicability.rule, provider: model?.provider, id: model?.id },
			);
		}
		if (!live) return decline(ctx, settings, "no-live-request", "no live provider request was captured");

		if (!promptDriftChecked) {
			promptDriftChecked = true;
			const intact = checkPromptDrift(findBundleDir(process.argv[1]), [
				SUMMARIZATION_SYSTEM_PROMPT,
				SUMMARIZATION_PROMPT,
			]);
			log(settings.logPath.value, {
				prompt_drift_check: intact === undefined ? "unverifiable" : intact ? "match" : "DRIFTED",
			});
			if (intact === false) {
				announce(
					ctx,
					"compaction-cache: pi's summarization prompts no longer match this extension's copies. " +
						"The summary format may have changed upstream; update compaction-cache.ts.",
					"warning",
					"compaction-cache:prompt-drift",
				);
			}
		}

		const summarized = convertToLlm(preparation.messagesToSummarize ?? []);
		if (summarized.length === 0) {
			return decline(ctx, settings, "nothing-to-summarize", "there are no messages to summarize");
		}

		// The live request must be this conversation — a sub-agent turn would
		// otherwise produce a confident summary of unrelated work. Probe several
		// messages, not just the first: after an earlier compaction the oldest
		// surviving message is often a tool call or tool result carrying no plain
		// text at all, and probing only that one rejects a perfectly good match.
		const liveText = messagesText(live.messages);
		const probes: string[] = [];
		for (const message of summarized) {
			const text = contentText(message?.content).trim();
			if (text.length >= 40) probes.push(text.slice(0, 120));
			if (probes.length >= 5) break;
		}
		if (probes.length === 0) {
			return decline(ctx, settings, "no-probe-text", "the messages contain no usable comparison text");
		}
		if (!probes.some((probe) => liveText.includes(probe))) {
			return decline(
				ctx,
				settings,
				"conversation-mismatch",
				"the captured provider request belongs to a different conversation",
				{ probes: probes.length },
			);
		}

		const base = preparation.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
		const budgetNote =
			settings.maxWords.value > 0
				? `\n\nHard limit: the entire summary must be under ${settings.maxWords.value} words. ` +
					`It replaces the conversation above, so write dense, specific notes, not prose. ` +
					`Drop detail rather than exceed the limit.`
				: "";
		const instruction = `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${base}${focus}${budgetNote}${NO_TOOLS_NOTE}`;

		// Confirm the prefix-preserving request can actually be built before spending
		// a call on it. If it cannot, defer to Pi: on an iterative compaction Pi
		// re-injects preparation.previousSummary as a <previous-summary> block, which
		// prepareCompaction deliberately keeps out of messagesToSummarize. This
		// extension relies instead on the live conversation already carrying that
		// summary as a message — true only when the rewrite applies.
		const boundary =
			settings.scope.value === "full" ? -1 : summaryBoundaryIndex(live.messages, summarized);
		const probe0 = buildRewrittenPayload(live, {}, instruction, boundary);
		if (!probe0) {
			return decline(
				ctx,
				settings,
				"cannot-preserve-prefix",
				"a prefix-preserving summarization request cannot be built",
				{ boundary },
			);
		}
		log(settings.logPath.value, {
			scope: settings.scope.value,
			boundary,
			live_messages: live.messages.length,
			sent_messages: probe0.messages.length,
		});

		const reserve = preparation.settings?.reserveTokens ?? 16384;
		const maxTokens = Math.min(
			Math.floor(0.8 * reserve),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);

		// No local size guard. The live conversation is larger than Pi's blob, and at
		// the auto-compaction threshold it is close to model.contextWindow — but that
		// is Pi's configured window, not the server's limit (600k here against a 262k
		// setting), so guarding on it would disable this exactly when compaction
		// matters most. An oversized prompt is rejected before any prefill, and the
		// catch below falls back to Pi's default.

		let applied = false;
		const call = () =>
			ctx.modelRegistry.complete(
				model,
				fallbackContext(summarized, `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${base}${focus}`),
				{
					maxTokens,
					signal,
					onPayload: (params: Payload) => {
						const rewritten = buildRewrittenPayload(live as Payload, params, instruction, boundary);
						if (!rewritten) return undefined;
						applied = true;
						return rewritten;
					},
				},
			);

		try {
			let response: any;
			try {
				response = await call();
			} catch (error) {
				// Pi's own compaction wraps this in retryAssistantCall; ours does not
				// inherit that policy, so retry a dropped stream once before deferring.
				if (!isTransient(error) || signal?.aborted) throw error;
				log(settings.logPath.value, {
					retrying: true,
					message: error instanceof Error ? error.message : String(error),
				});
				applied = false;
				response = await call();
			}

			// The payload that went out was not the prefix-preserving one, so it also
			// lacks the previous summary. Never persist that; let Pi redo it properly.
			if (!applied) {
				return decline(
					ctx,
					settings,
					"rewrite-not-applied",
					"the provider did not apply the prefix-preserving payload rewrite",
				);
			}
			if (response.stopReason === "error" || response.stopReason === "length") {
				return decline(
					ctx,
					settings,
					`stop-reason:${response.stopReason}`,
					`the summary stopped with ${response.stopReason}`,
					{ stop: response.stopReason },
				);
			}
			if ((response.content ?? []).some((c: any) => c?.type === "toolCall")) {
				return decline(
					ctx,
					settings,
					"model-called-a-tool",
					"the summarizing model called a tool",
				);
			}
			const text = (response.content ?? [])
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			if (!text.trim()) {
				return decline(ctx, settings, "empty-summary", "the summarizing model returned no text");
			}

			const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
			log(settings.logPath.value, {
				compacted: true,
				live_messages: live.messages.length,
				tools: live.tools?.length ?? 0,
				summary_chars: text.length,
				usage: response.usage,
			});
			suppliedCompaction = true;
			return {
				compaction: {
					summary: text + formatFileOperations(readFiles, modifiedFiles),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return decline(ctx, settings, "summarization-error", `summarization failed: ${message}`, {
				message,
			});
		}
	});
}
