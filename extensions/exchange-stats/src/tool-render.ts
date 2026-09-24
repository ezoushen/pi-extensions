import { MouseRegion, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
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
	fg(color: "dim" | "accent" | "muted", text: string): string;
	bg?(color: "selectedBg", text: string): string;
	italic?(text: string): string;
}

// One pointer drives every session's transcript, so the hovered fold control is shared.
let hoveredControl: string | undefined;
/** Moves the hover to a progress, process, tool or thinking control, or clears it; true when it changed. */
function setHover(key: string | undefined): boolean {
	if (hoveredControl === key) return false;
	hoveredControl = key;
	return true;
}
const repaint = { handled: true, render: true } as const;

/** Mouse handler for extension-drawn rows that are not fold controls: a move there ends the hover. */
export function endHoverOnMove(event: { type: string }): typeof repaint | undefined {
	return event.type === "move" && setHover(undefined) ? repaint : undefined;
}

/** Styles fold-control text with its D9 color and the active theme's italic style when available. */
function styleControl(theme: TitleTheme | undefined, model: ToolFoldModel, key: string, text: string): string {
	if (!theme) return text;
	const color = model.isCursorHighlighted(key) ? "accent" : hoveredControl === key ? "muted" : "dim";
	const colored = theme.fg(color, text);
	return theme.italic?.(colored) ?? colored;
}

/**
 * Puts a hovered control's rendered rows on the theme's selection background, from its
 * indented start (`leading` columns of plain spaces stay bare) to the right edge.
 */
function hoverRows(theme: TitleTheme | undefined, model: ToolFoldModel, key: string, lines: string[], leading: number): string[] {
	if (!theme) return lines;
	const cursor = model.isCursorHighlighted(key);
	const color = cursor ? "accent" : hoveredControl === key ? "muted" : "dim";
	const colorOpen = theme.fg(color, "\u0000").split("\u0000")[0];
	const italicOpen = theme.italic?.("\u0000").split("\u0000")[0] ?? "";
	const restoredStyle = colorOpen + italicOpen;
	const selected = hoveredControl === key && !cursor && theme.bg;
	if (!selected) return restoredStyle ? lines.map((line) => line.replaceAll("\x1b[0m", `\x1b[0m${restoredStyle}`)) : lines;
	const [open, close] = theme.bg("selectedBg", "\u0000").split("\u0000");
	const bare = " ".repeat(leading);
	return lines.map((line) => {
		const cut = line.startsWith(bare) ? leading : 0;
		// Full resets end the selection and text styles; reopen them before the rest of the row.
		const body = line.slice(cut).replaceAll("\x1b[0m", `\x1b[0m${open}${restoredStyle}`).replaceAll("\x1b[49m", `\x1b[49m${open}`);
		return line.slice(0, cut) + open + body + close;
	});
}

type Patch = { installed: boolean; restore: () => void };
type ToolOwner = { model: ToolFoldModel; getTheme: () => TitleTheme | undefined; getOutputPad: () => number; getHomeDirectory: () => string };
type ThinkingOwner = { model: ToolFoldModel; getTheme: () => TitleTheme | undefined; requestRender: () => void; observeOutputPad: (padding: number) => void };
const toolOwners = new WeakMap<object, { add: (owner: ToolOwner) => Patch }>();
const thinkingOwners = new WeakMap<object, { add: (owner: ThinkingOwner) => Patch }>();

/** Columns a block title sits right of its process line, and its opened output right of the title. */
const BLOCK_INDENT = 2;

function indented(lines: string[], columns: number): string[] {
	const prefix = " ".repeat(columns);
	return lines.map((line) => prefix + line);
}

function truncateProcessLine(text: string, width: number): string {
	return fitThinkingLine(text, width);
}

function progressRow(model: ToolFoldModel, exchange: number, theme: TitleTheme | undefined, padding: number, width: number): string[] {
	const key = `exchange:${exchange}`;
	const text = truncateProcessLine(model.progressLine(exchange), width - padding * 2);
	return hoverRows(theme, model, key, new Text(styleControl(theme, model, key, text), padding, 0).render(width), padding);
}

function pathTail(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const slash = path.lastIndexOf("/");
	if (slash < 0) return "…" + Array.from(path).reverse().reduce((tail, character) => visibleWidth("…" + character + tail) <= width ? character + tail : tail, "");
	const prefix = path.startsWith("~/") ? "~/…/" : "…/";
	const tail = path.slice(slash + 1);
	let result = prefix + tail;
	if (visibleWidth(result) > width) {
		result = "…";
		for (const character of Array.from(tail).reverse()) {
			if (visibleWidth(result) + visibleWidth(character) > width) break;
			result = "…" + character + result.slice(1);
		}
		return result;
	}
	for (const segment of path.slice(path.startsWith("~/") ? 2 : 0, slash).split("/").reverse()) {
		if (!segment || visibleWidth(prefix + segment + "/" + result.slice(prefix.length)) > width) break;
		result = prefix + segment + "/" + result.slice(prefix.length);
	}
	return result;
}

/** Shares a session-owned display wrapper; unsupported Pi components stay native. */
export function installToolFold(componentClass: ToolClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined, getOutputPad: () => number = () => 1, getHomeDirectory: () => string = homedir): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const shared = prototype && toolOwners.get(prototype);
	if (shared) return shared.add({ model, getTheme, getOutputPad, getHomeDirectory });
	const original = prototype?.render;
	const originalMouse = prototype?.handleMouse;
	const hadOwnMouse = prototype && Object.hasOwn(prototype, "handleMouse");
	if (typeof original !== "function") return { installed: false, restore() {} };

	// Overlapping sessions share this wrapper. A component renders with the latest session
	// whose model knows its tool call id, or with the latest owner when none does yet.
	const ownerFor = (component: ToolComponent): ToolOwner => {
		const all = Array.from(owners);
		return all.findLast((owner) => owner.model.ownsTool(component.toolCallId)) ?? all.at(-1)!;
	};

	// Rows and columns this wrapper drew above and left of Pi's own output at the last render,
	// so clicks inside an opened block reach Pi in Pi's coordinates.
	const nativeOffset = new WeakMap<ToolComponent, { rows: number; columns: number }>();

	function folded(this: ToolComponent, width: number): string[] {
		nativeOffset.delete(this);
		if (owners.size === 0) return original.call(this, width);
		try {
			const { model, getTheme, getOutputPad, getHomeDirectory } = ownerFor(this);
			model.observe(this.toolCallId, this.toolName, this.args, this.result);
			const process = model.processForTool(this.toolCallId);
			const processLead = process && model.isProcessLead(process.id, `tool:${this.toolCallId}`);
			const progress = model.progressForItem(`tool:${this.toolCallId}`);
			const gapBefore = model.hasTextImmediatelyBefore(`tool:${this.toolCallId}`) && (processLead || progress?.lead);
			const padding = Math.min(getOutputPad(), Math.max(0, Math.floor((width - 1) / 2)));
			const progressLine = progress?.lead ? progressRow(model, progress.exchange, getTheme(), padding, width) : [];
			const withGap = (rows: string[]) => gapBefore && rows.length ? ["", ...rows] : rows;
			if (progress && !progress.open) return withGap(progressLine);
			const show = (rows: string[]) => progress ? [...progressLine, ...(progressLine.length && rows.length ? [""] : []), ...indented(rows, BLOCK_INDENT)] : rows;
			if (process && !model.isProcessOpen(process.id) && !model.isProcessLead(process.id, `tool:${this.toolCallId}`)) return [];
			const contentWidth = width - padding * 2 - (progress ? BLOCK_INDENT : 0);
			const processText = process && model.isProcessLead(process.id, `tool:${this.toolCallId}`)
				? truncateProcessLine(model.processLine(process.id), contentWidth) : undefined;
			const processKey = `process:${process?.id}`;
			const processLine = processText === undefined ? []
				: hoverRows(getTheme(), model, processKey, new Text(styleControl(getTheme(), model, processKey, processText), padding, 0).render(width - (progress ? BLOCK_INDENT : 0)), padding);
			if (process && !model.isProcessOpen(process.id)) return withGap(show(processLine));
			const parts = model.titleParts(this.toolCallId);
			if (!parts || width <= 0) return original.call(this, width);
			// Inside a process, titles step in under the process line and opened output steps in under its title.
			const indent = process && width > padding * 2 + BLOCK_INDENT * 2 ? BLOCK_INDENT : 0;
			const titleWidth = contentWidth - indent;
			const name = truncateToWidth(`⚙ ${parts.name}`, titleWidth, "");
			const remaining = titleWidth - visibleWidth(name);
			const stats = truncateToWidth(`  ${parts.stats}`, remaining, "");
			const argumentWidth = Math.max(0, remaining - visibleWidth(`  ${parts.stats}`));
			const home = getHomeDirectory();
			const path = typeof this.args?.path === "string" && (parts.argument === this.args.path || parts.argument === this.args.path.replace(/\s+/g, " ").trim())
				? parts.argument.startsWith(`${home}/`) ? `~${parts.argument.slice(home.length)}` : parts.argument : undefined;
			const argument = argumentWidth > 2 && parts.argument
				? (path === undefined ? truncateToWidth(`  ${parts.argument}`, argumentWidth, "…") : `  ${pathTail(path, argumentWidth - 2)}`).replace(/\x1b\[0m/g, "")
				: "";
			const text = name + argument + stats;
			const styled = styleControl(getTheme(), model, `tool:${this.toolCallId}`, text);
			const title = hoverRows(getTheme(), model, `tool:${this.toolCallId}`, indented(new Text(styled, padding, 0).render(width - indent - (progress ? BLOCK_INDENT : 0)), indent), indent + padding + (progress ? BLOCK_INDENT : 0));
			if (!model.isOpen(this.toolCallId)) return withGap(show([...processLine, ...title]));
			nativeOffset.set(this, { rows: processLine.length + title.length, columns: indent * 2 });
			return withGap(show([...processLine, ...title, ...indented(original.call(this, width - indent * 2 - (progress ? BLOCK_INDENT : 0)), indent * 2)]));
		} catch {
			return original.call(this, width);
		}
	}

	prototype.render = folded;
	function foldedMouse(this: ToolComponent, event: { type: string; button: string; x?: number; y: number; width: number; height: number }) {
		if (owners.size === 0) return originalMouse?.call(this, event);
		const { model } = ownerFor(this);
		const key = `tool:${this.toolCallId}`;
		const progress = model.progressForItem(key);
		const process = model.processForTool(this.toolCallId);
		const processLead = process && model.isProcessLead(process.id, key);
		const gapBefore = model.hasTextImmediatelyBefore(key) && (processLead || progress?.lead);
		const gapRows = gapBefore ? 1 : 0;
		if (progress?.lead && event.y === gapRows) {
			if (event.type === "move") return setHover(`exchange:${progress.exchange}`) ? repaint : undefined;
			if (event.type === "click" && event.button === "left") { model.toggleProgress(progress.exchange); this.ui?.requestRender(); return { handled: true, render: false }; }
		}
		if (progress && !progress.open) return event.type === "move" && setHover(undefined) ? repaint : undefined;
		const rowOffset = gapRows + (progress?.lead ? 1 : 0);
		if (progress || rowOffset) event = { ...event, y: event.y - rowOffset, x: event.x === undefined ? undefined : event.x - (progress ? BLOCK_INDENT : 0),
			width: event.width - (progress ? BLOCK_INDENT : 0), height: event.height - rowOffset };
		const lead = process && model.isProcessLead(process.id, `tool:${this.toolCallId}`);
		if (event.type === "move") {
			// Only the process line and the block title are fold controls; Pi's own rows are not.
			const titleRow = lead ? 1 : 0;
			const key = lead && event.y === 0 ? `process:${process!.id}`
				: event.y === titleRow && (!process || model.isProcessOpen(process.id)) && model.titleParts(this.toolCallId) ? `tool:${this.toolCallId}` : undefined;
			const changed = setHover(key);
			const offset = key ? undefined : nativeOffset.get(this);
			const native = offset && event.y >= offset.rows
				? originalMouse?.call(this, { ...event, y: event.y - offset.rows, x: event.x === undefined ? undefined : event.x - offset.columns, width: event.width - offset.columns, height: event.height - offset.rows })
				: undefined;
			return native ?? (changed ? repaint : undefined);
		}
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
		const offset = nativeOffset.get(this);
		if (!offset) return originalMouse?.call(this, event);
		if (event.y < offset.rows) return undefined;
		return originalMouse?.call(this, {
			...event,
			y: event.y - offset.rows,
			x: event.x === undefined ? undefined : event.x - offset.columns,
			width: event.width - offset.columns,
			height: event.height - offset.rows,
		});
	}
	prototype.handleMouse = foldedMouse;
	const owners = new Set<ToolOwner>();
	const add = (owner: ToolOwner): Patch => {
		if (owners.size === 0) {
			if (prototype.render === original) prototype.render = folded;
			if (prototype.handleMouse === originalMouse) prototype.handleMouse = foldedMouse;
		}
		owners.add(owner);
		return { installed: true, restore() {
			if (!owners.delete(owner) || owners.size > 0) return;
			// A later wrapper may still call ours; keep it dormant and reusable while attached.
			if (prototype.render === folded && prototype.handleMouse === foldedMouse) toolOwners.delete(prototype);
			if (prototype.render === folded) prototype.render = original;
			if (prototype.handleMouse === foldedMouse) {
				if (hadOwnMouse) prototype.handleMouse = originalMouse;
				else delete prototype.handleMouse;
			}
		} };
	};
	toolOwners.set(prototype, { add });
	return add({ model, getTheme, getOutputPad, getHomeDirectory });
}


interface Message {
	timestamp?: number;
	content: Array<{ type: string; thinking?: string; text?: string }>;
}

interface AssistantComponent {
	contentContainer: { children: Array<{ constructor: { name: string }; render(width: number): string[] }> };
	lastMessage?: Message;
	hideThinkingBlock: boolean;
	thinkingVisibilityOverrides: Map<number, boolean>;
	outputPad: number;
	isStreaming: boolean;
	updateContent(message: Message, isStreaming?: boolean): void;
	handleMouse?(event: { type: string }): unknown;
}

interface AssistantClass {
	prototype: AssistantComponent;
}

/** Shares a session-owned wrapper that replaces only thinking children and keeps text in place. */
export function installThinkingFold(componentClass: AssistantClass, model: ToolFoldModel, getTheme: () => TitleTheme | undefined = () => undefined, requestRender: () => void = () => {}, observeOutputPad: (padding: number) => void = () => {}): { installed: boolean; restore: () => void } {
	const prototype = componentClass?.prototype;
	const shared = prototype && thinkingOwners.get(prototype);
	if (shared) return shared.add({ model, getTheme, requestRender, observeOutputPad });
	const original = prototype?.updateContent;
	if (typeof original !== "function") return { installed: false, restore() {} };
	const originalMouse = prototype.handleMouse;
	const hadOwnMouse = Object.hasOwn(prototype, "handleMouse");
	// Set by a thinking region when a move lands on one of its fold controls.
	let claimedMove = false;
	const textControls = new WeakMap<AssistantComponent, Array<{ child: AssistantComponent["contentContainer"]["children"][number]; key: string }>>();

	// The owner is the session that ingested a message with this timestamp. Timestamps are
	// milliseconds and can coincide across sessions; then the latest claimant whose
	// ingested thinking or tool calls match this message's content wins. Claimants with
	// identical content at the same timestamp, and a message no session has ingested
	// yet, fall back to the latest candidate.
	const ownerFor = (message: Message): ThinkingOwner => {
		const all = Array.from(owners);
		const claimants = all.filter((owner) => owner.model.ownsMessage(message));
		if (claimants.length > 1) return claimants.findLast((owner) => owner.model.ingestedContentOf(message)) ?? claimants.at(-1)!;
		return claimants[0] ?? all.at(-1)!;
	};

	function foldContent(this: AssistantComponent, message: Message, isStreaming?: boolean): void {
		const { model, getTheme, requestRender, observeOutputPad } = ownerFor(message);
		observeOutputPad(this.outputPad);
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
		textControls.set(this, []);
		const regions = children.map((child, index) => child.constructor.name === "MouseRegion" ? index : -1).filter((index) => index >= 0);
		const texts = message.content.flatMap((part, index) => part.type === "text" && part.text?.trim() ? [index] : []);
		const markdown = children.map((child, index) => child.constructor.name === "Markdown" ? index : -1).filter((index) => index >= 0);
		if (regions.length !== runs.length || markdown.length !== texts.length) {
			original.call(this, message, isStreaming);
			return;
		}
		texts.forEach((index, textIndex) => {
			const native = children[markdown[textIndex]];
			const key = `text:${message.timestamp}:${index}`;
			const originalRender = native.render.bind(native);
			const component = this;
			native.render = (width: number) => {
				const progress = model.progressForItem(key);
				if (!progress) return originalRender(width);
				const line = progress.lead ? progressRow(model, progress.exchange, getTheme(), component.outputPad, width) : [];
				const rows = indented(originalRender(width - BLOCK_INDENT), BLOCK_INDENT);
				return progress.open ? [...line, ...(line.length && rows.length ? [""] : []), ...rows] : line;
			};
			const controls = textControls.get(this) ?? [];
			controls.push({ child: native, key });
			textControls.set(this, controls);
		});
		const progressKeys = [
			...texts.map((index) => `text:${message.timestamp}:${index}`),
			...runs.map((run) => `thinking:${message.timestamp}:${run.index}`),
		];
		const messageProgress = () => progressKeys.map((key) => model.progressForItem(key)).find(Boolean);
		const hasProgressLead = () => progressKeys.some((key) => model.progressForItem(key)?.lead);
		const hasFinalText = () => texts.some((index) => !model.progressForItem(`text:${message.timestamp}:${index}`));
		const initialSpacer = children[0];
		if (initialSpacer?.constructor.name === "Spacer") {
			children[0] = {
				constructor: initialSpacer.constructor,
				render(width: number) {
					const progress = messageProgress();
					if (progress && !progress.open && !hasProgressLead() && !hasFinalText()) return [];
					return initialSpacer.render(width);
				},
			};
		}
		runs.forEach((run, runIndex) => {
			const native = children[regions[runIndex]];
			const process = model.processForThinking(message, run.index);
			const lead = process && model.isProcessLead(process.id, `thinking:${message.timestamp}:${run.index}`);
			const key = `thinking:${message.timestamp}:${run.index}`;
			const gapBefore = model.hasTextImmediatelyBefore(key) && (lead || model.progressForItem(key)?.lead);
			const preceding = children[regions[runIndex] - 1];
			if (process && !lead && preceding?.constructor.name === "Spacer") {
				children[regions[runIndex] - 1] = {
					constructor: preceding.constructor,
					render(width: number) { return model.isProcessOpen(process.id) ? preceding.render(width) : []; },
				};
			}
			const separatorIndex = regions[runIndex] + 1;
			const separator = children[separatorIndex];
			if (separator?.constructor.name === "Spacer") {
				const following = children[separatorIndex + 1];
				const finalText = textControls.get(this)?.find((control) => control.child === following);
				children[separatorIndex] = {
					constructor: separator.constructor,
					render(width: number) {
						const progress = model.progressForItem(key);
						if (progress && !progress.open && (!finalText || model.progressForItem(finalText.key))) return [];
						return separator.render(width);
					},
				};
			}
			const onMouse = (event: { type: string; button: string; y: number }) => {
				const progress = model.progressForItem(key);
				const gapRows = gapBefore ? 1 : 0;
				if (progress?.lead && event.y === gapRows) {
					if (event.type === "move") { claimedMove = true; return setHover(`exchange:${progress.exchange}`) ? repaint : undefined; }
					if (event.type === "click" && event.button === "left") { model.toggleProgress(progress.exchange); folded.call(this, message, isStreaming); requestRender(); return { handled: true, render: false }; }
				}
				if (progress && !progress.open) return undefined;
				const y = event.y - gapRows - (progress?.lead ? 1 : 0);
				if (event.type === "move") {
					const titleRow = lead ? 1 : 0;
					const key = lead && y === 0 ? `process:${process!.id}`
						: y === titleRow && (!process || model.isProcessOpen(process.id)) ? `thinking:${message.timestamp}:${run.index}` : undefined;
					claimedMove = key !== undefined;
					return setHover(key) ? repaint : undefined;
				}
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (process && lead && y === 0) model.toggleProcess(process.id);
				else if (process && !model.isProcessOpen(process.id)) model.toggleProcess(process.id);
				else model.toggleThinking(message, run.index);
				folded.call(this, message, isStreaming);
				requestRender();
				return { handled: true, render: false };
			};
			const component = this;
			const child = {
				render(width: number) {
					const current = model.progressForItem(key);
					const progressLine = current?.lead ? progressRow(model, current.exchange, getTheme(), component.outputPad, width) : [];
					const withGap = (rows: string[]) => gapBefore && rows.length ? ["", ...rows] : rows;
					if (current && !current.open) return withGap(progressLine);
					if (process && !model.isProcessOpen(process.id) && !lead) return [];
					const innerWidth = width - (current ? BLOCK_INDENT : 0);
					const padding = Math.min(component.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
					const processText = lead ? truncateProcessLine(model.processLine(process!.id), innerWidth - padding * 2) : undefined;
					const processLine = processText === undefined ? []
						: hoverRows(getTheme(), model, `process:${process!.id}`, new Text(styleControl(getTheme(), model, `process:${process!.id}`, processText), component.outputPad, 0).render(innerWidth), component.outputPad);
					const show = (rows: string[]) => current ? [...progressLine, ...(progressLine.length && rows.length ? [""] : []), ...indented(rows, BLOCK_INDENT)] : rows;
					if (process && !model.isProcessOpen(process.id)) return withGap(show(processLine));
					const indent = process && width > padding * 2 + BLOCK_INDENT * 2 ? BLOCK_INDENT : 0;
					const title = fitThinkingLine(model.thinkingTitle(message, run.index, run.trace, component.isStreaming), innerWidth - indent - padding * 2);
					const styled = styleControl(getTheme(), model, `thinking:${message.timestamp}:${run.index}`, title);
					const body = model.isThinkingOpen(message, run.index) ? indented((native as MouseRegion).child.render(innerWidth - indent * 2), indent * 2) : [];
					const titleRows = hoverRows(getTheme(), model, `thinking:${message.timestamp}:${run.index}`,
						indented(new Text(styled, component.outputPad, 0).render(innerWidth - indent), indent), indent + component.outputPad);
					return withGap(show([...processLine, ...titleRows, ...body]));
				},
				invalidate() {},
			};
			children[regions[runIndex]] = new MouseRegion(child, onMouse);
		});
	}

	function folded(this: AssistantComponent, message: Message, isStreaming?: boolean): void {
		if (owners.size === 0) { original.call(this, message, isStreaming); return; }
		try {
			foldContent.call(this, message, isStreaming);
		} catch {
			original.call(this, message, isStreaming);
		}
	}

	prototype.updateContent = folded;
	// A move over ordinary text or an opened trace ends the fold-control hover.
	function hoverMouse(this: AssistantComponent, event: { type: string }) {
		claimedMove = false;
		const pointer = event as { type: string; button?: string; y?: number; width?: number };
		if (owners.size > 0 && pointer.y !== undefined && pointer.width !== undefined) {
			let row = 0;
			for (const child of this.contentContainer.children) {
				const control = textControls.get(this)?.find((item) => item.child === child);
				const owner = this.lastMessage ? ownerFor(this.lastMessage) : undefined;
				const progress = control && owner?.model.progressForItem(control.key);
				if (progress?.lead && pointer.y === row) {
					if (event.type === "move") return setHover(`exchange:${progress.exchange}`) ? repaint : undefined;
					if (event.type === "click" && pointer.button === "left") {
						owner?.model.toggleProgress(progress.exchange);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						owner?.requestRender();
						return { handled: true, render: false };
					}
				}
				row += child.render(pointer.width).length;
			}
		}
		const result = originalMouse?.call(this, event);
		if (event.type === "move" && owners.size > 0 && !claimedMove && setHover(undefined)) return result ?? repaint;
		return result;
	}
	prototype.handleMouse = hoverMouse;
	const owners = new Set<ThinkingOwner>();
	const add = (owner: ThinkingOwner): Patch => {
		owners.add(owner);
		return { installed: true, restore() {
			if (!owners.delete(owner) || owners.size > 0) return;
			// A later wrapper may still call ours; keep it dormant and reusable while attached.
			if (prototype.updateContent === folded) thinkingOwners.delete(prototype);
			if (prototype.updateContent === folded) prototype.updateContent = original;
			if (prototype.handleMouse === hoverMouse && !thinkingOwners.has(prototype)) {
				if (hadOwnMouse) prototype.handleMouse = originalMouse;
				else delete prototype.handleMouse;
			}
		} };
	};
	thinkingOwners.set(prototype, { add });
	return add({ model, getTheme, requestRender, observeOutputPad });
}
