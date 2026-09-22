import { resolveSettings } from "../../shared/settings.ts";

export function loadSettings(context: { cwd: string; isProjectTrusted(): boolean }) {
	return resolveSettings(
		"consumer",
		{ endpoint: { default: "http://127.0.0.1", env: "PI_CONSUMER_ENDPOINT" } },
		context,
	);
}
