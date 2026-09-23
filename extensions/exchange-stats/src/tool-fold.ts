interface ThinkingEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
}

interface ThinkingBlock {
	startedAt: number;
	endedAt?: number;
	characters: number;
	tokens?: number;
}

interface ThinkingMessage {
	timestamp?: number;
}

interface ProcessMessage extends ThinkingMessage {
	content: Array<{ type: string; thinking?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
}

type ProcessBlock =
	| { kind: "thinking"; key: string; message: ThinkingMessage; index: number; trace: string }
	| { kind: "tool"; key: string };

interface Process {
	id: string;
	blocks: ProcessBlock[];
	open: boolean;
}

const MAX_THINKING_MESSAGES = 256;

function elapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Holds display timing for each thinking content item in an assistant message. */
class ThinkingFoldModel {
	private blocks = new Map<number, Map<number, ThinkingBlock>>();
	private untimedBlocks = new WeakMap<object, Map<number, ThinkingBlock>>();
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	private forMessage(message: ThinkingMessage, create: boolean): Map<number, ThinkingBlock> | undefined {
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
			const existing = this.untimedBlocks.get(message);
			if (existing || !create) return existing;
			const blocks = new Map<number, ThinkingBlock>();
			this.untimedBlocks.set(message, blocks);
			return blocks;
		}
		const existing = this.blocks.get(message.timestamp);
		if (existing || !create) return existing;
		// Retain recent completed messages for Pi's history rebuilds without growing per delta.
		if (this.blocks.size >= MAX_THINKING_MESSAGES) this.blocks.delete(this.blocks.keys().next().value!);
		const blocks = new Map<number, ThinkingBlock>();
		this.blocks.set(message.timestamp, blocks);
		return blocks;
	}

	observe(message: ThinkingMessage, event: ThinkingEvent, reasoningTokens?: number): void {
		const blocks = this.forMessage(message, event.type === "thinking_delta");
		if (!blocks) return;
		const at = this.now();
		if (event.type === "thinking_delta" && event.contentIndex !== undefined) {
			const block = blocks.get(event.contentIndex) ?? { startedAt: at, characters: 0 };
			block.characters += event.delta?.length ?? 0;
			if (reasoningTokens !== undefined && reasoningTokens > 0) block.tokens = reasoningTokens;
			blocks.set(event.contentIndex, block);
		} else if (event.type === "thinking_end") {
			const block = event.contentIndex === undefined ? undefined : blocks.get(event.contentIndex);
			if (block && block.endedAt === undefined) block.endedAt = at;
		} else if (event.type !== "thinking_start") {
			for (const block of blocks.values()) {
				if (block.endedAt === undefined) block.endedAt = at;
			}
		}
	}

	settle(message: ThinkingMessage): void {
		for (const block of this.forMessage(message, false)?.values() ?? []) {
			if (block.endedAt === undefined) block.endedAt = this.now();
		}
	}

	title(message: ThinkingMessage, index: number, trace: string, streaming: boolean): string {
		const block = this.forMessage(message, false)?.get(index);
		const ms = block ? Math.max(0, (block.endedAt ?? this.now()) - block.startedAt) : 0;
		if (!streaming || block?.endedAt !== undefined) {
			const words = trace.trim().split(/\s+/).filter(Boolean).length;
			return `◈ Thinking · ${elapsed(ms)} · ${words} ${words === 1 ? "word" : "words"}`;
		}
		const count = block?.tokens ?? Math.max(1, Math.ceil((block?.characters ?? trace.length) / 4));
		const prefix = block?.tokens === undefined ? "~" : "";
		const rate = ms > 0 ? Math.round(count / (ms / 1000)) : 0;
		return `◈ Thinking · ${elapsed(ms)} · ${prefix}${count} tok · ${prefix}${rate} tok/s`;
	}

	timing(message: ThinkingMessage, index: number): { start: number; end?: number } | undefined {
		const block = this.forMessage(message, false)?.get(index);
		return block && { start: block.startedAt, end: block.endedAt };
	}
}

interface ToolBlock {
	name: string;
	args?: Record<string, unknown>;
	startedAt?: number;
	endedAt?: number;
	isError: boolean;
	result?: { content?: Array<{ type: string; text?: string }> };
	open: boolean;
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function summary(args?: Record<string, unknown>): string {
	if (!args) return "";
	for (const key of ["command", "path", "pattern"]) {
		if (typeof args[key] === "string") return args[key].replace(/\s+/g, " ").trim();
	}
	const value = Object.values(args).find((item) => typeof item === "string");
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function lineCount(result?: ToolBlock["result"]): number {
	const output = result?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
	if (!output) return 0;
	return output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Holds process membership, fold state, and display timing for assistant blocks. */
export class ToolFoldModel {
	private blocks = new Map<string, ToolBlock>();
	private processList: Process[] = [];
	private processByBlock = new Map<string, Process>();
	private seenContent = new Map<number, Set<number>>();
	private openProcess?: Process;
	private openThinking = new Set<string>();
	private now: () => number;
	private thinking: ThinkingFoldModel;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.thinking = new ThinkingFoldModel(now);
	}

	/** Adds newly visible content in message order; repeated snapshots keep existing membership. */
	ingest(message: ProcessMessage): void {
		if (typeof message?.timestamp !== "number" || !Number.isFinite(message.timestamp) || !Array.isArray(message.content)) return;
		const seen = this.seenContent.get(message.timestamp) ?? new Set<number>();
		this.seenContent.set(message.timestamp, seen);
		for (let index = 0; index < message.content.length; index++) {
			const item = message.content[index];
			if (item.type === "thinking") {
				const start = index;
				const traces: string[] = [];
				while (message.content[index]?.type === "thinking") {
					if (message.content[index].thinking?.trim()) traces.push(message.content[index].thinking!.trim());
					index++;
				}
				index--;
				if (!traces.length) continue;
				const key = `thinking:${message.timestamp}:${start}`;
				const existing = this.processByBlock.get(key)?.blocks.find((block) => block.key === key);
			if (existing?.kind === "thinking") existing.trace = traces.join("\n\n");
				else this.append({ kind: "thinking", key, message: { timestamp: message.timestamp }, index: start, trace: traces.join("\n\n") });
				continue;
			}
			if (seen.has(index)) continue;
			if (item.type === "text") {
				if (!item.text) continue;
				this.openProcess = undefined;
			}
			if (item.type === "toolCall" && item.id) {
				this.append({ kind: "tool", key: `tool:${item.id}` });
				this.observe(item.id, item.name ?? "tool", item.arguments ?? {});
			}
			if (item.type === "toolCall" && !item.id) continue;
			seen.add(index);
		}
	}

	private append(block: ProcessBlock): void {
		if (this.processByBlock.has(block.key)) return;
		if (!this.openProcess) {
			this.openProcess = { id: block.key, blocks: [], open: false };
			this.processList.push(this.openProcess);
		}
		this.openProcess.blocks.push(block);
		this.processByBlock.set(block.key, this.openProcess);
	}

	processes(): ReadonlyArray<Process> { return this.processList; }
	endExchange(): void { this.openProcess = undefined; }
	processForThinking(message: ThinkingMessage, index: number): Process | undefined {
		return this.processByBlock.get(`thinking:${message.timestamp}:${index}`);
	}
	processForTool(id: string): Process | undefined { return this.processByBlock.get(`tool:${id}`); }
	isProcessLead(id: string, key: string): boolean { return this.processList.find((process) => process.id === id)?.blocks[0]?.key === key; }
	toggleProcess(id: string): boolean | undefined {
		const process = this.processList.find((item) => item.id === id);
		if (!process) return undefined;
		process.open = !process.open;
		return process.open;
	}
	isProcessOpen(id: string): boolean { return this.processList.find((item) => item.id === id)?.open ?? false; }
	toggleThinking(message: ThinkingMessage, index: number): boolean {
		const key = `thinking:${message.timestamp}:${index}`;
		if (this.openThinking.has(key)) { this.openThinking.delete(key); return false; }
		this.openThinking.add(key);
		return true;
	}
	isThinkingOpen(message: ThinkingMessage, index: number): boolean { return this.openThinking.has(`thinking:${message.timestamp}:${index}`); }

	processLine(id: string): string {
		const process = this.processList.find((item) => item.id === id);
		if (!process) return "";
		let first: number | undefined;
		let last: number | undefined;
		let activity = "";
		for (const block of process.blocks) {
			const tool = block.kind === "tool" ? this.blocks.get(block.key.slice(5)) : undefined;
			const timing = block.kind === "thinking"
				? this.thinking.timing(block.message, block.index)
				: tool?.startedAt === undefined ? undefined : { start: tool.startedAt, end: tool.endedAt };
			if (!timing) continue;
			first = first === undefined ? timing.start : Math.min(first, timing.start);
			last = Math.max(last ?? timing.start, timing.end ?? this.now());
			if (timing.end === undefined) activity = block.kind === "tool"
				? `⚙ ${tool?.name ?? "tool"} running ${elapsed(this.now() - timing.start)}`
				: this.thinking.title(block.message, block.index, block.trace, true);
		}
		const count = `◈${process.blocks.filter((block) => block.kind === "thinking").length} ⚙${process.blocks.filter((block) => block.kind === "tool").length}`;
		const total = first === undefined || last === undefined ? "0ms" : elapsed(Math.max(0, last - first));
		return `${process.open ? "▾" : "▸"} ${count} · ${activity || total}`;
	}

	observe(id: string, name: string, args: Record<string, unknown>, result?: ToolBlock["result"]): void {
		const block = this.blocks.get(id);
		if (block) {
			block.args = args;
			if (result) block.result = result;
		} else {
			this.blocks.set(id, { name, args, result, isError: false, open: false });
		}
	}

	start(id: string, name: string, at = this.now()): void {
		const block = this.blocks.get(id) ?? { name, isError: false, open: false };
		block.name = name;
		block.startedAt = at;
		this.blocks.set(id, block);
	}

	end(id: string, isError: boolean, result?: ToolBlock["result"], at = this.now()): void {
		const block = this.blocks.get(id) ?? { name: "tool", isError: false, open: false };
		block.endedAt = at;
		block.isError = isError;
		if (result) block.result = result;
		this.blocks.set(id, block);
	}

	observeThinking(message: ThinkingMessage, event: ThinkingEvent, reasoningTokens?: number): void {
		this.thinking.observe(message, event, reasoningTokens);
	}

	settleThinking(message: ThinkingMessage): void {
		this.thinking.settle(message);
	}

	thinkingTitle(message: ThinkingMessage, index: number, trace: string, streaming: boolean): string {
		return this.thinking.title(message, index, trace, streaming);
	}

	toggle(id: string): boolean | undefined {
		const block = this.blocks.get(id);
		if (!block) return undefined;
		block.open = !block.open;
		return block.open;
	}

	isOpen(id: string): boolean {
		return this.blocks.get(id)?.open ?? false;
	}

	titleParts(id: string): { name: string; argument: string; stats: string } | undefined {
		const block = this.blocks.get(id);
		if (!block) return undefined;
		const argument = summary(block.args);
		const elapsed = block.startedAt === undefined ? undefined : Math.max(0, (block.endedAt ?? this.now()) - block.startedAt);
		const status = block.endedAt === undefined ? "running" : block.isError ? "✗" : "✓";
		const count = lineCount(block.result);
		const lines = block.endedAt === undefined ? "" : ` · ${count} ${count === 1 ? "line" : "lines"}`;
		return { name: block.name, argument, stats: `${status} ${duration(elapsed)}${lines}` };
	}
}
