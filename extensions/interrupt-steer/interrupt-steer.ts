import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

const DEFAULT_KEY = "ctrl+alt+enter";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_INTERRUPT_STEER_KEY" } } as const;
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type InterruptContext = ExtensionContext & { waitForIdle(): Promise<void> };

function isShortcutKey(value: unknown): value is ShortcutKey {
	if (typeof value !== "string") return false;
	const parts = value.split("+");
	const base = parts.pop();
	return parts.length > 0 && new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
		base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
}

function sendEditorText(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
	if (!text) {
		announce(ctx, "pi-interrupt-steer: nothing to send", "info");
		return;
	}

	ctx.ui.setEditorText("");
	try {
		pi.sendUserMessage(text);
	} catch {
		ctx.ui.setEditorText(text);
		announce(ctx, "pi-interrupt-steer: could not send the message; text restored to the editor", "warning");
	}
}

export default function registerInterruptSteer(pi: ExtensionAPI, settingsRuntime: SettingsRuntime = {}): void {
	const resolved = resolveSettings("pi-interrupt-steer", KEY_SETTING, {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => false,
	}, settingsRuntime);
	const configuredKey = resolved.key.value;
	const validKey = isShortcutKey(configuredKey);
	const key: ShortcutKey = validKey ? configuredKey : DEFAULT_KEY;
	let warnedAboutKey = false;

	pi.on("session_start", (_event, ctx) => {
		if (!validKey && !warnedAboutKey) {
			announce(ctx, "pi-interrupt-steer: invalid key setting; using ctrl+alt+enter", "warning", "pi-interrupt-steer:invalid-key");
			warnedAboutKey = true;
		}
	});

	pi.registerShortcut(key, {
		description: "Interrupt the current run and send the editor text",
		handler: async (ctx) => {
			const idle = ctx.isIdle();
			const text = ctx.ui.getEditorText();
			if (idle) {
				sendEditorText(pi, ctx, text);
				return;
			}
			if (!text && !ctx.hasPendingMessages()) {
				announce(ctx, "pi-interrupt-steer: nothing to send", "info");
				return;
			}

			ctx.abort();
			// Pi supplies this on TUI shortcut contexts at runtime, though ExtensionContext omits it.
			await (ctx as InterruptContext).waitForIdle();
			sendEditorText(pi, ctx, ctx.ui.getEditorText());
		},
	});
}
