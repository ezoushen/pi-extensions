import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Fits a thinking line while keeping its duration and stats at the right edge. */
export function fitThinkingLine(text: string, width: number): string {
	// A thinking title's glyph, not a `◈ n` count in a process or progress line.
	const start = Math.max(-1, ...[...text.matchAll(/◈ (?!\d+(?: |$))/g)].map((match) => match.index));
	const suffixStart = start < 0 ? -1 : text.indexOf(" · ", start);
	if (suffixStart < 0) return truncateToWidth(text, width, "…").replace(/\x1b\[0m(?=…)/g, "");
	const suffix = text.slice(suffixStart);
	if (visibleWidth(suffix) >= width) return truncateToWidth(text, width, "…").replace(/\x1b\[0m(?=…)/g, "");
	const available = Math.max(0, width - visibleWidth(suffix));
	if (visibleWidth(text) <= width) return text;
	return truncateToWidth(text.slice(0, suffixStart), available, "…").replace(/\x1b\[0m(?=…)/g, "") + suffix;
}
