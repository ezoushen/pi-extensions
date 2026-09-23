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

function elapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Holds display timing for each thinking content item in an assistant message. */
class ThinkingFoldModel {
	private blocks = new WeakMap<object, Map<number, ThinkingBlock>>();
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	observe(message: object, event: ThinkingEvent, reasoningTokens?: number): void {
		const blocks = this.blocks.get(message) ?? new Map<number, ThinkingBlock>();
		this.blocks.set(message, blocks);
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

	settle(message: object): void {
		for (const block of this.blocks.get(message)?.values() ?? []) {
			if (block.endedAt === undefined) block.endedAt = this.now();
		}
	}

	title(message: object, index: number, trace: string, streaming: boolean): string {
		const block = this.blocks.get(message)?.get(index);
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

/** Holds display state for tool calls and assistant thinking runs. */
export class ToolFoldModel {
	private blocks = new Map<string, ToolBlock>();
	private now: () => number;
	private thinking: ThinkingFoldModel;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.thinking = new ThinkingFoldModel(now);
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

	observeThinking(message: object, event: ThinkingEvent, reasoningTokens?: number): void {
		this.thinking.observe(message, event, reasoningTokens);
	}

	settleThinking(message: object): void {
		this.thinking.settle(message);
	}

	thinkingTitle(message: object, index: number, trace: string, streaming: boolean): string {
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
