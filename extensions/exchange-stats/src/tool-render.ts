import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/** Installs a reversible display wrapper; unsupported Pi components stay native. */
export function installToolFold(componentClass: ToolClass, model: ToolFoldModel): { installed: boolean; restore: () => void } {
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
			return [name + argument + stats];
		} catch {
			return original.call(this, width);
		}
	}

	prototype.render = folded;
	return { installed: true, restore() { if (prototype.render === folded) prototype.render = original; } };
}
