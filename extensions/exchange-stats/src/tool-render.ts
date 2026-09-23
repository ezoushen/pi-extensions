import { MouseRegion, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolFoldModel } from "./tool-fold.ts";
import { fitThinkingLine } from "./thinking-width.ts";

interface ToolComponent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: { content?: Array<{ type: string; text?: string }> };
	render(width: number): string[];
	handleMouse?(event: { type: string; button: string; y: number; width: number; height: number }): unknown;
	ui?: { requestRender(): void };
}

interface ToolClass {
	prototype: ToolComponent;
}

interface TitleTheme {
	fg(color: "dim", text: string): string;
}

function truncateProcessLine(text: string, width: number): string {
	return fitThinkingLine(text, width);
}

/** Installs a reversible display wrapper; unsupported Pi components stay native. */
export function installToolFold(componentClass: ToolClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const original = prototype?.render;
	const originalMouse = prototype?.handleMouse;
	const hadOwnMouse = prototype && Object.hasOwn(prototype, "handleMouse");
	if (typeof original !== "function") return { installed: false, restore() {} };

	function folded(this: ToolComponent, width: number): string[] {
		try {
			model.observe(this.toolCallId, this.toolName, this.args, this.result);
			const process = model.processForTool(this.toolCallId);
			if (process && !model.isProcessOpen(process.id) && !model.isProcessLead(process.id, `tool:${this.toolCallId}`)) return [];
			const processText = process && model.isProcessLead(process.id, `tool:${this.toolCallId}`)
				? truncateProcessLine(model.processLine(process.id), width) : undefined;
			const processLine = processText === undefined ? [] : [getTheme()?.fg("dim", processText) ?? processText];
			if (process && !model.isProcessOpen(process.id)) return processLine;
			if (model.isOpen(this.toolCallId)) return [...processLine, ...original.call(this, width)];
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
			return [...processLine, getTheme()?.fg("dim", title) ?? title];
		} catch {
			return original.call(this, width);
		}
	}

	prototype.render = folded;
	function foldedMouse(this: ToolComponent, event: { type: string; button: string; y: number; width: number; height: number }) {
		const process = model.processForTool(this.toolCallId);
		if (event.type === "click" && event.button === "left" && event.y === 0 && process && model.isProcessLead(process.id, `tool:${this.toolCallId}`)) {
			model.toggleProcess(process.id);
			this.ui?.requestRender();
			return { handled: true, render: false };
		}
		const titleY = process && model.isProcessLead(process.id, `tool:${this.toolCallId}`) ? 1 : 0;
		if (event.type === "click" && event.button === "left" && event.y === titleY && (!process || model.isProcessOpen(process.id))) {
			if (model.toggle(this.toolCallId) !== undefined) {
				this.ui?.requestRender();
				return { handled: true, render: false };
			}
		}
		return originalMouse?.call(this, event);
	}
	prototype.handleMouse = foldedMouse;
	return { installed: true, restore() {
		if (prototype.render === folded) prototype.render = original;
		if (prototype.handleMouse === foldedMouse) {
			if (hadOwnMouse) prototype.handleMouse = originalMouse;
			else delete prototype.handleMouse;
		}
	} };
}


interface Message {
	timestamp?: number;
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
export function installThinkingFold(componentClass: AssistantClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined, requestRender: () => void = () => {}): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const original = prototype?.updateContent;
	if (typeof original !== "function") return { installed: false, restore() {} };

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
		runs.forEach((run, runIndex) => {
			const native = children[regions[runIndex]];
			const process = model.processForThinking(message, run.index);
			const lead = process && model.isProcessLead(process.id, `thinking:${message.timestamp}:${run.index}`);
			const preceding = children[regions[runIndex] - 1];
			if (process && !lead && preceding?.constructor.name === "Spacer") {
				children[regions[runIndex] - 1] = {
					constructor: preceding.constructor,
					render(width: number) { return model.isProcessOpen(process.id) ? preceding.render(width) : []; },
				};
			}
			const onMouse = (event: { type: string; button: string; y: number }) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (process && lead && event.y === 0) model.toggleProcess(process.id);
				else if (process && !model.isProcessOpen(process.id)) model.toggleProcess(process.id);
				else model.toggleThinking(message, run.index);
				folded.call(this, message, isStreaming);
				requestRender();
				return { handled: true, render: false };
			};
			const component = this;
			const child = {
				render(width: number) {
					if (process && !model.isProcessOpen(process.id) && !lead) return [];
					const padding = Math.min(component.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
					const processText = lead ? truncateProcessLine(model.processLine(process!.id), width - padding * 2) : undefined;
					const processLine = processText === undefined ? []
						: new Text(getTheme()?.fg("dim", processText) ?? processText, component.outputPad, 0).render(width);
					if (process && !model.isProcessOpen(process.id)) return processLine;
					if (model.isThinkingOpen(message, run.index)) return [...processLine, ...(native as MouseRegion).child.render(width)];
					const title = fitThinkingLine(model.thinkingTitle(message, run.index, run.trace, component.isStreaming), width - padding * 2);
					return [...processLine, ...new Text(getTheme()?.fg("dim", title) ?? title, component.outputPad, 0).render(width)];
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
