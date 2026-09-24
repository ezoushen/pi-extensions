import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

const DEFAULT_KEY = "ctrl+alt+enter";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_INTERRUPT_STEER_KEY" } } as const;
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
const IDLE_WAIT_TIMEOUT_MS = 5_000;
const IDLE_POLL_INTERVAL_MS = 25;

async function waitUntilIdle(ctx: ExtensionContext): Promise<boolean> {
	const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
	while (!ctx.isIdle()) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(IDLE_POLL_INTERVAL_MS, remaining)));
	}
	return true;
}

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
			if (!await waitUntilIdle(ctx)) {
				announce(ctx, "pi-interrupt-steer: agent did not become idle within 5 seconds; text left in the editor", "warning");
				return;
			}
			sendEditorText(pi, ctx, ctx.ui.getEditorText());
		},
	});
}
