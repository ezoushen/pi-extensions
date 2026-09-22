/**
 * A single place to reach the user, whether or not there is a UI to notify.
 *
 * `ctx.ui.notify` is a no-op in pi's print (`-p`) and json modes -- there is
 * no UI to render it into -- so every announcement built on it alone is
 * silent there. `ctx.hasUI` (documented in pi's extensions.md) is exactly
 * the signal for "is anyone there to notify": `false` in those two modes.
 * When it is false this falls back to stderr instead, so the operator
 * running pi non-interactively still sees the message.
 *
 * The stderr fallback fires at most once per process per distinct `reason`.
 * That bound is independent of whatever de-dup (if any) a caller already
 * applies before calling `announce` for the interactive path -- a caller
 * may legitimately call this every time (as prefix-stabilizer's drift
 * warning does, deliberately, once per drift), and the stderr fallback
 * still only prints once per reason. Neither bound gates the other: the
 * interactive path is untouched (same notify call, same wording, same
 * caller-owned de-dup), and the stderr path applies its own guard on top.
 */

export interface AnnounceContext {
	hasUI?: boolean;
	ui?: { notify?: (message: string, level?: string) => void };
}

/** Reasons already printed to stderr in this process. */
const stderrAnnounced = new Set<string>();

/**
 * @param reason De-dup key for the stderr fallback only. Defaults to `message`.
 *   Pass an explicit reason when repeated calls share a cause but differ in
 *   wording (e.g. a byte count), so the fallback still recognises them as one.
 */
export function announce(
	ctx: AnnounceContext | undefined,
	message: string,
	level?: string,
	reason: string = message,
): void {
	if (ctx?.hasUI === false) {
		if (stderrAnnounced.has(reason)) return;
		stderrAnnounced.add(reason);
		try {
			process.stderr.write(`${message}\n`);
		} catch {
			/* a notification must never break a turn */
		}
		return;
	}
	try {
		ctx?.ui?.notify?.(message, level);
	} catch {
		/* a notification must never break a turn */
	}
}
