import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
// Every module the bundle can include: the entry and each source module beside it.
const files = ["focus-mode.ts", ...readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".ts")).map((name) => `src/${name}`)];

const checks = [
	["absolute path", /(["'`])\/(?!\/)[^"'`\n]+\1/g],
	["home directory", /(?:~\/|\$HOME\b|\$\{HOME\}|\bhomedir\s*\(|\bprocess\.env\.HOME\b)/g],
	["host", /(?:https?|wss?):\/\/[^\s"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b|\bhost(?:name)?\b\s*[:=]\s*(["'`])[^"'`]+\1/gi],
	["port", /\bport\b\s*[:=]\s*(?:\d{2,5}|["'`]\d{2,5}["'`])/gi],
	["model or provider", /\b(?:models?|providers?)(?:Id|Name)?\b[^\n]{0,60}?(?:===?|!==?|:|=|\.includes\()\s*(["'`])([^"'`$]+)\1/gi],
];

// Each allowance is a hit that names no machine, with the reason it is legitimate.
const allowances = [
	{ file: "focus-mode.ts", category: "model or provider", value: "unknown", reason: "placeholder when Pi reports no model" },
	{ file: "src/tool-render.ts", category: "home directory", value: "~/", reason: "display prefix for paths under the runtime home directory, which is read at run time" },
	{ file: "src/tool-fold.ts", category: "model or provider", value: "trace", reason: "headline source enum beside `\"model\"`" },
	{ file: "src/fold-picker.ts", category: "model or provider", value: "▸", reason: "fold glyph after a ToolFoldModel call" },
	{ file: "src/tool-render.ts", category: "model or provider", value: "dim", reason: "theme color after a ToolFoldModel call" },
];

function sweep(file, source) {
	return checks.flatMap(([category, pattern]) =>
		[...source.matchAll(pattern)]
			.filter((match) => !allowances.some((allowed) => allowed.file === file && allowed.category === category && (match[2] ?? match[0]) === allowed.value))
			.map((match) => ({ file, category, value: match[0].trim() })),
	);
}

test("package sources have zero unexplained machine-specific literals", () => {
	assert.ok(files.length > 1);
	const hits = files.flatMap((file) => sweep(file, readFileSync(join(packageRoot, file), "utf8")));

	assert.deepEqual(hits, []);
	console.log(`CLEAN SWEEP (${files.length} files): 0 unexplained paths, home references, hosts, ports, models, or providers`);
});
