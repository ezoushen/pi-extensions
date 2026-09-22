import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { announce, type AnnounceContext } from "./announce.ts";

export type SettingProvenance =
	| { source: "default" }
	| { source: "discovered"; name: string }
	| { source: "global"; path: string }
	| { source: "project"; path: string }
	| { source: "environment"; name: string };

export interface SettingDefinition<T> {
	default: T;
	env: string;
	parseEnv?: (value: string) => T;
	/**
	 * Optional: ask a peer service where it lives, layered below our own
	 * explicit settings (global/project/env) but above the documented
	 * default. This is a protocol, not a hard-coded path -- the peer's own
	 * configuration file is itself a configuration file. Must not throw;
	 * `resolveSettings` also guards the call.
	 */
	discover?: () => { value: T } | undefined;
	/** Reported as this setting's provenance when `discover` supplies a value. */
	discoverName?: string;
}

type SettingDefinitions = Record<string, SettingDefinition<unknown>>;

export type ResolvedSettings<Definitions extends SettingDefinitions> = {
	[Key in keyof Definitions]: {
		value: Definitions[Key]["default"];
		provenance: SettingProvenance;
	};
};

export interface SettingsContext extends AnnounceContext {
	cwd: string;
	isProjectTrusted(): boolean;
}

export interface SettingsRuntime {
	agentDir?: string;
	environment?: Record<string, string | undefined>;
}

/** Paths already announced as unreadable/malformed, so a repeatedly-called
 * resolveSettings (every provider request, every handler) warns at most once
 * per file rather than once per call. */
const announcedConfigErrors = new Set<string>();

/**
 * A settings file must never break a turn: an absent, unreadable, or
 * malformed file degrades to the documented defaults, exactly like the rest
 * of this codebase's "must never break a turn" paths (see the `log`/`notify`
 * try/catches in the extensions). The user still needs to know, so this
 * announces once per file via the caller's own notify surface, not a second
 * mechanism.
 */
function readConfig(path: string, ctx?: AnnounceContext): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if (!announcedConfigErrors.has(path)) {
			announcedConfigErrors.add(path);
			const message = error instanceof Error ? error.message : String(error);
			announce(ctx, `settings: could not parse ${path} (${message}); using defaults.`, "warning", `settings-parse:${path}`);
		}
		return {};
	}
}

/**
 * Resolve every declared setting from the global and trusted project files, then
 * the environment. Each value carries the source a caller can report to the user.
 */
export function resolveSettings<Definitions extends SettingDefinitions>(
	name: string,
	definitions: Definitions,
	context: SettingsContext,
	runtime: SettingsRuntime = {},
): ResolvedSettings<Definitions> {
	const environment = runtime.environment ?? process.env;
	const globalPath = join(runtime.agentDir ?? getAgentDir(), `${name}.json`);
	const projectPath = join(context.cwd, CONFIG_DIR_NAME, `${name}.json`);
	const globalConfig = readConfig(globalPath, context);
	const projectConfig = context.isProjectTrusted() ? readConfig(projectPath, context) : {};
	const resolved = {} as ResolvedSettings<Definitions>;

	for (const key of Object.keys(definitions) as Array<keyof Definitions>) {
		const definition = definitions[key];
		let value = definition.default as Definitions[typeof key]["default"];
		let provenance: SettingProvenance = { source: "default" };

		if (definition.discover) {
			try {
				const discovered = definition.discover();
				if (discovered !== undefined) {
					value = discovered.value as Definitions[typeof key]["default"];
					provenance = { source: "discovered", name: definition.discoverName ?? "discovery" };
				}
			} catch {
				/* discovery must never break a turn */
			}
		}

		if (Object.hasOwn(globalConfig, key)) {
			value = globalConfig[key as string] as Definitions[typeof key]["default"];
			provenance = { source: "global", path: globalPath };
		}
		if (Object.hasOwn(projectConfig, key)) {
			value = projectConfig[key as string] as Definitions[typeof key]["default"];
			provenance = { source: "project", path: projectPath };
		}

		const environmentValue = environment[definition.env];
		if (environmentValue !== undefined) {
			value = (definition.parseEnv
				? definition.parseEnv(environmentValue)
				: environmentValue) as Definitions[typeof key]["default"];
			provenance = { source: "environment", name: definition.env };
		}

		resolved[key] = { value, provenance };
	}

	return resolved;
}
