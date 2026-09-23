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

/** Holds display state for tool calls, keyed by Pi's tool call ID. */
export class ToolFoldModel {
	private blocks = new Map<string, ToolBlock>();
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
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
