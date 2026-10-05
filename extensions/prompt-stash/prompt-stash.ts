import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

const DEFAULT_KEY = "ctrl+s";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_PROMPT_STASH_KEY" } } as const;

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

function isShortcutKey(value: unknown): value is ShortcutKey {
	if (typeof value !== "string") return false;
	const parts = value.split("+");
	const base = parts.pop();
	return parts.length > 0 && new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
		base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
}

interface ContentPart {
	type: string;
	text?: string;
}

function messageText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

/**
 * Ctrl+S stash for the prompt editor, in the style of Claude Code's message
 * queueing: press the stash key to set aside the text you are typing, keep
 * typing or wait, and get it back -- automatically when the current run ends,
 * or with the same key at any time.
 *
 * The stash is a small stack: each press with text in the editor pushes, each
 * press with an empty editor pops the most recent entry. A prompt the user
 * sends verbatim is dropped from the stack, so an auto-restore can never
 * duplicate something that was already submitted.
 */
export default function registerPromptStash(pi: ExtensionAPI, settingsRuntime: SettingsRuntime = {}): void {
	const resolved = resolveSettings("pi-prompt-stash", KEY_SETTING, {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => false,
	}, settingsRuntime);
	const configuredKey = resolved.key.value;
	const validKey = isShortcutKey(configuredKey);
	const key: ShortcutKey = validKey ? configuredKey : DEFAULT_KEY;
	let warnedAboutKey = false;

	/** Stashed prompts, most recent last. In-memory per pi process. */
	const stash: string[] = [];

	const pop = (ctx: ExtensionContext): boolean => {
		const text = stash.pop();
		if (text === undefined) {
			announce(ctx, "pi-prompt-stash: nothing stashed.", "info", "pi-prompt-stash:empty");
			return false;
		}
		if (ctx.ui.getEditorText().trim()) {
			stash.push(text);
			announce(ctx, "pi-prompt-stash: the editor is not empty, so the stash was kept. Clear the editor and restore again.", "warning", "pi-prompt-stash:editor-busy");
			return false;
		}
		ctx.ui.setEditorText(text);
		announce(ctx, "pi-prompt-stash: prompt restored to the editor.", "info", "pi-prompt-stash:restored");
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		// Stashes do not follow the user across sessions; an old prompt
		// surfacing in a new conversation would be a surprise, not a feature.
		stash.length = 0;
		if (!validKey && !warnedAboutKey) {
			announce(ctx, "pi-prompt-stash: invalid key setting; using ctrl+s", "warning", "pi-prompt-stash:invalid-key");
			warnedAboutKey = true;
		}
	});

	// A stashed prompt loses its point once the user sends that exact text
	// anyway -- dropping it here is what keeps the auto-restore from
	// re-filling the editor with an already-submitted message.
	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		const text = messageText(event.message.content as string | ContentPart[]);
		const index = stash.lastIndexOf(text);
		if (index !== -1) stash.splice(index, 1);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (stash.length === 0) return;
		if (ctx.ui.getEditorText().trim()) {
			announce(ctx, "pi-prompt-stash: a stashed prompt is waiting; press the stash key to restore it.", "info", "pi-prompt-stash:waiting");
			return;
		}
		const text = stash.pop();
		if (text === undefined) return;
		ctx.ui.setEditorText(text);
		announce(ctx, "pi-prompt-stash: stashed prompt restored to the editor; press enter to send it.", "info", "pi-prompt-stash:auto-restored");
	});

	pi.registerShortcut(key, {
		description: "Stash the editor prompt (press again with an empty editor to restore; pops automatically when a run ends)",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText();
			if (text.trim()) {
				stash.push(text);
				ctx.ui.setEditorText("");
				announce(ctx, `pi-prompt-stash: prompt stashed. It pops automatically when the current run ends, or press ${key} to restore it now.`, "info", "pi-prompt-stash:stashed");
				return;
			}
			pop(ctx);
		},
	});

	pi.registerCommand("stash", {
		description: "Restore the stashed prompt (`/stash clear` discards it)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			if (arg === "") {
				pop(ctx);
				return;
			}
			if (arg === "clear") {
				const count = stash.length;
				stash.length = 0;
				let message = "pi-prompt-stash: nothing stashed.";
				if (count === 1) message = "pi-prompt-stash: discarded 1 stashed prompt.";
				if (count > 1) message = `pi-prompt-stash: discarded ${count} stashed prompts.`;
				announce(ctx, message, "info", "pi-prompt-stash:cleared");
				return;
			}
			announce(ctx, "pi-prompt-stash: usage: /stash [clear]", "info", "pi-prompt-stash:usage");
		},
	});
}
