import { MouseRegion, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolFoldModel } from "./tool-fold.ts";

interface ToolComponent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: { content?: Array<{ type: string; text?: string }> };
	render(width: number): string[];
}

interface ToolClass {
	prototype: ToolComponent;
}

interface TitleTheme {
	fg(color: "dim", text: string): string;
}

/** Installs a reversible display wrapper; unsupported Pi components stay native. */
export function installToolFold(componentClass: ToolClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const original = prototype?.render;
	if (typeof original !== "function") return { installed: false, restore() {} };

	function folded(this: ToolComponent, width: number): string[] {
		try {
			model.observe(this.toolCallId, this.toolName, this.args, this.result);
			if (model.isOpen(this.toolCallId)) return original.call(this, width);
			const parts = model.titleParts(this.toolCallId);
			if (!parts || width <= 0) return original.call(this, width);
			const name = truncateToWidth(`⚙ ${parts.name}`, width, "");
			const remaining = width - visibleWidth(name);
			const stats = truncateToWidth(`  ${parts.stats}`, remaining, "");
			const argumentWidth = Math.max(0, remaining - visibleWidth(`  ${parts.stats}`));
			const argument = argumentWidth > 2 && parts.argument
				? truncateToWidth(`  ${parts.argument}`, argumentWidth, "…")
				: "";
			const title = name + argument + stats;
			return [getTheme()?.fg("dim", title) ?? title];
		} catch {
			return original.call(this, width);
		}
	}

	prototype.render = folded;
	return { installed: true, restore() { if (prototype.render === folded) prototype.render = original; } };
}


interface Message {
	content: Array<{ type: string; thinking?: string }>;
}

interface AssistantComponent {
	contentContainer: { children: Array<{ constructor: { name: string }; render(width: number): string[] }> };
	hideThinkingBlock: boolean;
	thinkingVisibilityOverrides: Map<number, boolean>;
	outputPad: number;
	isStreaming: boolean;
	updateContent(message: Message, isStreaming?: boolean): void;
}

interface AssistantClass {
	prototype: AssistantComponent;
}

/** Replaces only Pi's thinking children and keeps its text rendering in place. */
export function installThinkingFold(componentClass: AssistantClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const original = prototype?.updateContent;
	if (typeof original !== "function") return { installed: false, restore() {} };
	const open = new WeakMap<AssistantComponent, Set<number>>();

	function foldContent(this: AssistantComponent, message: Message, isStreaming?: boolean): void {
		if (!Array.isArray(message?.content) || !this.contentContainer?.children) {
			original.call(this, message, isStreaming);
			return;
		}
		const hidden = this.hideThinkingBlock;
		const overrides = this.thinkingVisibilityOverrides;
		try {
			// Pi's hide setting must not suppress the native trace used for an open block.
			this.hideThinkingBlock = false;
			this.thinkingVisibilityOverrides = new Map();
			original.call(this, message, isStreaming);
		} finally {
			this.hideThinkingBlock = hidden;
			this.thinkingVisibilityOverrides = overrides;
		}
		const runs: Array<{ index: number; trace: string }> = [];
		for (let index = 0; index < message.content.length;) {
			if (message.content[index].type !== "thinking") { index++; continue; }
			const start = index;
			const parts: string[] = [];
			while (message.content[index]?.type === "thinking") {
				const trace = message.content[index].thinking?.trim();
				if (trace) parts.push(trace);
				index++;
			}
			if (parts.length) runs.push({ index: start, trace: parts.join("\n\n") });
		}
		const children = this.contentContainer.children;
		const regions = children.map((child, index) => child.constructor.name === "MouseRegion" ? index : -1).filter((index) => index >= 0);
		if (regions.length !== runs.length) {
			original.call(this, message, isStreaming);
			return;
		}
		const opened = open.get(this) ?? new Set<number>();
		open.set(this, opened);
		runs.forEach((run, runIndex) => {
			const native = children[regions[runIndex]];
			const onMouse = (event: { type: string; button: string }) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (opened.has(runIndex)) opened.delete(runIndex);
				else opened.add(runIndex);
				folded.call(this, message, isStreaming);
				return { handled: true };
			};
			const component = this;
			const child = opened.has(runIndex) ? (native as MouseRegion).child : {
				render(width: number) {
					const padding = Math.min(component.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
					const title = truncateToWidth(model.thinkingTitle(message, run.index, run.trace, component.isStreaming), width - padding * 2, "…");
					return new Text(getTheme()?.fg("dim", title) ?? title, component.outputPad, 0).render(width);
				},
				invalidate() {},
			};
			children[regions[runIndex]] = new MouseRegion(child, onMouse);
		});
	}

	function folded(this: AssistantComponent, message: Message, isStreaming?: boolean): void {
		try {
			foldContent.call(this, message, isStreaming);
		} catch {
			original.call(this, message, isStreaming);
		}
	}

	prototype.updateContent = folded;
	return { installed: true, restore() { if (prototype.updateContent === folded) prototype.updateContent = original; } };
}
