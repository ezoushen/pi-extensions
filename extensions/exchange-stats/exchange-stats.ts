/**
 * exchange-stats.ts — exchange timing and cost, with one-line tool and thinking titles.
 * Per-turn card detail remains available on demand.
 *
 * An *exchange* is one uninterrupted work span: from a prompt you submitted until
 * pi has nothing left to do automatically. A *turn* is a single model response
 * plus the tools it invoked, so a turn ends every time the model finishes
 * speaking, and the turn loop repeats while the model keeps calling tools. One
 * exchange therefore contains one or more turns.
 *
 * The exchange is the primary unit: the status line always shows the running or
 * last exchange, and a card is appended to the transcript when each one settles.
 * Turn detail is secondary and appears when the card is expanded, showing where
 * the time went — model time against tool time, per turn, with the tools named.
 *
 * Design notes worth keeping:
 *
 * - Timing runs from `before_agent_start` to `agent_settled`, not `agent_end`.
 *   After `agent_end` pi may still auto-retry, auto-compact and retry, or drain a
 *   queued follow-up, so ending there would split one work span into several
 *   partial measurements.
 * - A prompt submitted while a run is already in flight continues the same
 *   exchange rather than starting a new one, because pi does not settle in
 *   between the two. `promptCount` records that it happened instead of restarting
 *   the timer and losing the earlier segment.
 * - Throughput is per turn (that turn's output tokens over that turn's wall time),
 *   not per exchange. Tool execution is part of the exchange's wall time, so
 *   dividing output by the whole exchange reports model speed as slower than it
 *   was, by the share of time tools held.
 * - A turn's model time is `durationMs - toolMs`. Tools run after the model has
 *   finished emitting its call, so the two spans do not overlap; this is an
 *   estimate from event timestamps, not an instrumented measurement.
 * - `toolMs` is the union of tool spans, not the sum of their durations. Parallel
 *   tool calls overlap, so summing would double-count wall time and could drive
 *   model time to zero; each tool's own duration is still listed by name.
 * - Time pi spends waiting on an extension prompt (a permission dialog, a
 *   question) is accumulated separately. It stays inside the wall-clock duration
 *   but is reported, so a round that was slow because a dialog sat unanswered is
 *   visible as such.
 * - A session card aggregates totals and carries no per-turn detail; it reports
 *   `turnCount` rather than a `turns` array so both card kinds render alike.
 * - Stats are local to this process and are written to the session file as custom
 *   entries, which do not participate in LLM context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, keyHint, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";
import { Box, Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "exchange-stats";
const STATUS_KEY = "exchange";
/** How often the live status line refreshes while an exchange is running. */
const TICK_MS = 1_000;
/** Above this share of wall time, tool execution is called out in the summary. */
const TOOL_SHARE_NOTE = 0.25;

interface TokenTotals {
	input: number;
	output: number;
	/** Reasoning/thinking tokens; already included in `output` when reported. */
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const emptyTotals = (): TokenTotals => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
});

interface ToolSpan {
	name: string;
	ms: number;
	isError: boolean;
}

/**
 * A tool execution with both endpoints retained. Kept apart from `ToolSpan`
 * because overlapping parallel runs have to be merged before they are summed.
 */
interface ToolRun {
	name: string;
	start: number;
	end: number;
	isError: boolean;
}

interface TurnRecord extends TokenTotals {
	index: number;
	durationMs: number;
	toolMs: number;
	/** `durationMs - toolMs`, see the module note on decomposition. */
	modelMs: number;
	/** Output tokens over this turn's wall time. */
	outputPerSec: number;
	tools: ToolSpan[];
}

interface ExchangeRecord extends TokenTotals {
	kind: "exchange" | "session";
	/** 1-based exchange number; on a session card, the exchange count. */
	index: number;
	/** Prompts folded into the span: above one means a mid-run follow-up. */
	promptCount: number;
	/** Turns in the span. Held separately because a session card has no detail. */
	turnCount: number;
	/** Per-turn detail; always empty on a session card. */
	turns: TurnRecord[];
	startedAt: number;
	endedAt: number;
	durationMs: number;
	waitingMs: number;
	/** Wall time tools held across the span. */
	toolMs: number;
	model: string;
	stopReason: string;
}

interface StatusContext {
	hasUI: boolean;
	ui: { setStatus(key: string, value: string): void };
}

function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const s = ms / 1_000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0";
	return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`;
}

function fmtRate(tokensPerSec: number): string {
	if (!Number.isFinite(tokensPerSec) || tokensPerSec <= 0) return "—";
	return tokensPerSec < 1_000
		? `${Math.round(tokensPerSec)} tok/s`
		: `${(tokensPerSec / 1_000).toFixed(1)}k tok/s`;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/**
 * Names the tool holding the turn open right now. With parallel calls the tool
 * running longest is reported and the rest collapsed into a count, because the
 * status line has room for one.
 */
function openToolText(spans: Map<string, { name: string; start: number }>, now: number): string | undefined {
	let longest: { name: string; start: number } | undefined;
	for (const span of spans.values()) {
		if (!longest || now - span.start > now - longest.start) longest = span;
	}
	if (!longest) return undefined;
	const extra = spans.size > 1 ? ` (+${spans.size - 1})` : "";
	return `${longest.name} ${fmtDuration(now - longest.start)}${extra}`;
}

function expandHint(): string {
	try {
		return ` (${keyHint("app.tools.expand", "to expand")})`;
	} catch {
		return " (expand for per-turn detail)";
	}
}

/** Replays a turn's tool spans as `bash 11.3s, read 0.2s`. */
function toolBreakdown(turn: TurnRecord): string {
	return turn.tools
		.map((tool: ToolSpan) => `${tool.name} ${fmtDuration(tool.ms)}${tool.isError ? " (failed)" : ""}`)
		.join(", ");
}

/**
 * Wall-clock time covered by at least one tool. Parallel calls overlap, so adding
 * their individual durations would count the same instant twice.
 */
function unionMs(runs: ToolRun[]): number {
	if (runs.length === 0) return 0;
	const sorted = [...runs].sort((a: ToolRun, b: ToolRun) => a.start - b.start);
	let total = 0;
	let start = sorted[0].start;
	let end = sorted[0].end;
	for (const run of sorted.slice(1)) {
		if (run.start > end) {
			total += end - start;
			start = run.start;
			end = run.end;
		} else if (run.end > end) {
			end = run.end;
		}
	}
	return total + (end - start);
}

export function registerExchangeStats(pi: ExtensionAPI, toolComponent: typeof ToolExecutionComponent = ToolExecutionComponent) {
	const toolFold = new ToolFoldModel();
	let themeContext: { ui: { theme?: { fg(color: "dim", text: string): string } } } | undefined;
	const getTitleTheme = () => themeContext?.ui.theme;
	const toolPatch = installToolFold(toolComponent, toolFold, getTitleTheme);
	const thinkingPatch = installThinkingFold(AssistantMessageComponent, toolFold, getTitleTheme);
	let warnedAboutToolFold = false;
	let warnedAboutThinkingFold = false;
	const sessionTotals = {
		...emptyTotals(),
		exchanges: 0,
		turnCount: 0,
		durationMs: 0,
		toolMs: 0,
		waitingMs: 0,
	};
	let sessionStartedAt = 0;

	let running = false;
	let startedAt = 0;
	let promptCount = 0;
	let exchangeIndex = 0;
	let model = "unknown";
	let stopReason = "stop";
	let turns: TurnRecord[] = [];
	let totals = emptyTotals();
	let waitingMs = 0;
	let waitingStart: number | undefined;
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let liveRefresh: (() => void) | undefined;

	/** Tool spans still open in the turn in progress, keyed by toolCallId. */
	let activeTurn: { index: number; startedAt: number; spans: Map<string, { name: string; start: number }> } | undefined;
	let activeToolRuns: ToolRun[] = [];

	function setStatus(text: string, ctx: StatusContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** Live line: elapsed, turns finished, and the tool currently running. */
	function liveStatusText(): string {
		const now = Date.now();
		const parts = [`⏱ ${fmtDuration(now - startedAt)}`];
		if (turns.length > 0) parts.push(`${plural(turns.length, "turn")} done`);
		const toolText = activeTurn ? openToolText(activeTurn.spans, now) : undefined;
		if (toolText) parts.push(toolText);
		else if (activeTurn) parts.push(`turn ${activeTurn.index}`);
		return parts.join(" · ");
	}

	function stopLiveTimer(): void {
		if (liveTimer) clearInterval(liveTimer);
		liveTimer = undefined;
		liveRefresh = undefined;
	}

	function resetExchangeState(): void {
		running = false;
		startedAt = 0;
		promptCount = 0;
		turns = [];
		totals = emptyTotals();
		waitingMs = 0;
		waitingStart = undefined;
		activeTurn = undefined;
		activeToolRuns = [];
		stopLiveTimer();
	}

	// ---- Transcript card: exchange summary, per-turn detail when expanded ----

	pi.registerEntryRenderer<ExchangeRecord>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!data) {
			box.addChild(new Text(theme.fg("dim", "(no stats)"), 0, 0));
			return box;
		}

		const isSession = data.kind === "session";
		const headline = isSession
			? `📊 Session · ${plural(data.turnCount, "turn")} across ${plural(data.index, "exchange")}`
			: `⏱ Exchange ${data.index} · ${fmtDuration(data.durationMs)}`;
		box.addChild(
			new Text(
				theme.fg("accent", theme.bold(headline)) +
					theme.fg("dim", `  ${data.model}`) +
					(!expanded && !isSession ? theme.fg("dim", expandHint()) : ""),
				0,
				0,
			),
		);

		const summary: string[] = [];
		if (isSession) {
			summary.push(`active ${fmtDuration(data.durationMs)}`);
		} else {
			summary.push(plural(data.turnCount, "turn"), plural(data.promptCount, "prompt"));
		}
		if (data.toolMs > 0) summary.push(`tools ${fmtDuration(data.toolMs)}`);
		summary.push(`out ${fmtTokens(data.output)}`, fmtCost(data.cost));
		if (data.waitingMs > 0) summary.push(`waiting ${fmtDuration(data.waitingMs)}`);
		box.addChild(new Text(theme.fg("dim", summary.join(" · ")), 0, 0));

		if (expanded) {
			for (const turn of data.turns) {
				const detail: string[] = [`model ${fmtDuration(turn.modelMs)}`];
				if (turn.toolMs > 0) detail.push(`tools ${fmtDuration(turn.toolMs)} (${toolBreakdown(turn)})`);
				detail.push(`out ${fmtTokens(turn.output)}`, fmtRate(turn.outputPerSec));
				box.addChild(
					new Text(
						`  ${theme.fg("dim", `#${String(turn.index).padStart(2, " ")}`)}  ` +
							theme.fg("text", fmtDuration(turn.durationMs).padStart(8, " ")) +
							theme.fg("dim", `  ${detail.join(" · ")}`),
						0,
						0,
					),
				);
			}

			if (isSession && data.turnCount > 0) {
				// A session card has no per-turn rows, so its own averages stand in.
				box.addChild(
					new Text(
						theme.fg("dim", `avg ${fmtDuration(data.durationMs / data.turnCount)} per turn`),
						0,
						0,
					),
				);
			}

			const tokenParts = [
				`in ${fmtTokens(data.input)}`,
				`out ${fmtTokens(data.output)}`,
				`cache r ${fmtTokens(data.cacheRead)} / w ${fmtTokens(data.cacheWrite)}`,
				`total ${fmtTokens(data.totalTokens)}`,
				fmtCost(data.cost),
			];
			if (data.reasoning > 0) tokenParts.splice(2, 0, `thinking ${fmtTokens(data.reasoning)}`);
			box.addChild(new Text(theme.fg("dim", tokenParts.join(" · ")), 0, 0));

			if (data.startedAt > 0) {
				const from = new Date(data.startedAt).toLocaleTimeString();
				const to = new Date(data.endedAt).toLocaleTimeString();
				box.addChild(new Text(theme.fg("dim", `${from} → ${to}  stop: ${data.stopReason}`), 0, 0));
			}
		}

		return box;
	});

	// ---- Lifecycle ----

	pi.on("session_start", (_event, ctx) => {
		themeContext = ctx;
		if (!toolPatch.installed && !warnedAboutToolFold) {
			announce(ctx, "exchange-stats: tool folding unavailable; Pi tool rows remain native", "warning");
			warnedAboutToolFold = true;
		}
		if (!thinkingPatch.installed && !warnedAboutThinkingFold) {
			announce(ctx, "exchange-stats: thinking folding unavailable; Pi thinking remains native", "warning");
			warnedAboutThinkingFold = true;
		}
		resetExchangeState();
		sessionStartedAt = Date.now();
		setStatus("⏱ ready", ctx);
	});

	pi.on("session_shutdown", () => {
		themeContext = undefined;
		toolPatch.restore();
		thinkingPatch.restore();
		resetExchangeState();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		toolFold.observeThinking(event.message, event.assistantMessageEvent, event.message.usage?.reasoning);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") toolFold.settleThinking(event.message);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (running) {
			// A follow-up arrived mid-run; pi will not settle until it drains, so this
			// continues the current span instead of restarting it.
			promptCount++;
			return;
		}

		running = true;
		startedAt = Date.now();
		promptCount = 1;
		exchangeIndex++;
		turns = [];
		totals = emptyTotals();
		waitingMs = 0;
		waitingStart = undefined;
		activeTurn = undefined;
		activeToolRuns = [];
		model = ctx.model?.id ?? "unknown";
		stopReason = "stop";

		stopLiveTimer();
		setStatus(liveStatusText(), ctx);
		liveRefresh = () => setStatus(liveStatusText(), ctx);
		liveTimer = setInterval(() => {
			try {
				liveRefresh?.();
			} catch {
				// /new or /reload invalidates the runner while a run is in flight; a stale
				// status update is not worth failing the turn over.
				stopLiveTimer();
			}
		}, TICK_MS);
	});

	pi.on("turn_start", (event, _ctx) => {
		if (!running) return;
		activeTurn = { index: event.turnIndex ?? turns.length + 1, startedAt: Date.now(), spans: new Map() };
		activeToolRuns = [];
	});

	pi.on("tool_execution_start", (event, _ctx) => {
		toolFold.start(event.toolCallId, event.toolName);
		if (!running || !activeTurn) return;
		activeTurn.spans.set(event.toolCallId, { name: event.toolName, start: Date.now() });
	});

	pi.on("tool_execution_end", (event, _ctx) => {
		toolFold.end(event.toolCallId, Boolean(event.isError), event.result);
		if (!running || !activeTurn) return;
		const open = activeTurn.spans.get(event.toolCallId);
		if (open) {
			activeTurn.spans.delete(event.toolCallId);
			activeToolRuns.push({
				name: event.toolName ?? open.name,
				start: open.start,
				end: Date.now(),
				isError: Boolean(event.isError),
			});
			return;
		}
		// A tool whose start arrived outside a turn: still record it, so tool time is
		// not silently understated. A zero-length span adds nothing to the union.
		const at = Date.now();
		activeToolRuns.push({ name: event.toolName, start: at, end: at, isError: Boolean(event.isError) });
	});

	pi.on("turn_end", (event, _ctx) => {
		if (!running || !activeTurn) return;
		const endedAt = Date.now();

		// A span still open at turn end would otherwise count toward the turn duration
		// but be missing from the breakdown.
		for (const [id, open] of activeTurn.spans) {
			activeToolRuns.push({ name: open.name, start: open.start, end: endedAt, isError: false });
			activeTurn.spans.delete(id);
		}

		const usage = event.message?.role === "assistant" ? event.message.usage : undefined;
		const durationMs = endedAt - activeTurn.startedAt;
		const toolMs = unionMs(activeToolRuns);
		const output = usage?.output ?? 0;

		turns.push({
			index: activeTurn.index,
			durationMs,
			toolMs,
			modelMs: Math.max(0, durationMs - toolMs),
			outputPerSec: durationMs > 0 ? output / (durationMs / 1_000) : 0,
			tools: activeToolRuns.map((run: ToolRun) => ({ name: run.name, ms: run.end - run.start, isError: run.isError })),
			input: usage?.input ?? 0,
			output,
			reasoning: usage?.reasoning ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			totalTokens: usage?.totalTokens ?? 0,
			cost: usage?.cost?.total ?? 0,
		});

		totals.input += usage?.input ?? 0;
		totals.output += output;
		totals.reasoning += usage?.reasoning ?? 0;
		totals.cacheRead += usage?.cacheRead ?? 0;
		totals.cacheWrite += usage?.cacheWrite ?? 0;
		totals.totalTokens += usage?.totalTokens ?? 0;
		totals.cost += usage?.cost?.total ?? 0;

		if (event.message?.stopReason) stopReason = event.message.stopReason;
		activeTurn = undefined;
		activeToolRuns = [];
	});

	// Time pi spends blocked on an extension prompt stays inside the wall clock but
	// is tracked apart, so it can be reported instead of mistaken for work.
	pi.on("ui_prompt_start", (_event, _ctx) => {
		if (!running || waitingStart !== undefined) return;
		waitingStart = Date.now();
	});

	pi.on("ui_prompt_end", (_event, _ctx) => {
		if (waitingStart === undefined) return;
		waitingMs += Date.now() - waitingStart;
		waitingStart = undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!running) return;
		const endedAt = Date.now();
		if (waitingStart !== undefined) {
			waitingMs += endedAt - waitingStart;
			waitingStart = undefined;
		}

		const durationMs = endedAt - startedAt;
		const toolMs = turns.reduce((sum: number, turn: TurnRecord) => sum + turn.toolMs, 0);
		const record: ExchangeRecord = {
			...totals,
			kind: "exchange",
			index: exchangeIndex,
			promptCount,
			turnCount: turns.length,
			turns,
			startedAt,
			endedAt,
			durationMs,
			waitingMs,
			toolMs,
			model,
			stopReason,
		};

		stopLiveTimer();

		sessionTotals.input += totals.input;
		sessionTotals.output += totals.output;
		sessionTotals.reasoning += totals.reasoning;
		sessionTotals.cacheRead += totals.cacheRead;
		sessionTotals.cacheWrite += totals.cacheWrite;
		sessionTotals.totalTokens += totals.totalTokens;
		sessionTotals.cost += totals.cost;
		sessionTotals.exchanges++;
		sessionTotals.turnCount += turns.length;
		sessionTotals.durationMs += durationMs;
		sessionTotals.toolMs += toolMs;
		sessionTotals.waitingMs += waitingMs;

		try {
			pi.appendEntry<ExchangeRecord>(ENTRY_TYPE, record);
		} catch {
			// Entry persistence is unavailable in print/JSON mode and on a stale runner
			// after /new; the status line below still reports the span.
		}

		const parts = [`⏱ ${fmtDuration(durationMs)}`, plural(turns.length, "turn")];
		if (toolMs > 0 && durationMs > 0 && toolMs / durationMs >= TOOL_SHARE_NOTE) {
			parts.push(`tools ${fmtDuration(toolMs)}`);
		}
		parts.push(`out ${fmtTokens(totals.output)}`, fmtCost(totals.cost));
		if (waitingMs > 0) parts.push(`waiting ${fmtDuration(waitingMs)}`);
		setStatus(parts.join(" · "), ctx);

		resetExchangeState();
	});

	pi.registerCommand("exstats", {
		description: "Append a cumulative session timing card",
		handler: () => {
			const record: ExchangeRecord = {
				...sessionTotals,
				kind: "session",
				index: sessionTotals.exchanges,
				promptCount: sessionTotals.exchanges,
				turnCount: sessionTotals.turnCount,
				turns: [],
				startedAt: sessionStartedAt,
				endedAt: Date.now(),
				durationMs: sessionTotals.durationMs,
				waitingMs: sessionTotals.waitingMs,
				toolMs: sessionTotals.toolMs,
				model: `${plural(sessionTotals.turnCount, "turn")} tracked`,
				stopReason: "session",
			};
			try {
				pi.appendEntry<ExchangeRecord>(ENTRY_TYPE, record);
			} catch {
				// See the agent_settled note on runtimes without entry persistence.
			}
		},
	});
}

export default registerExchangeStats;
