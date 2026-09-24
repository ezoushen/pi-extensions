import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ToolFoldModel } from "./src/tool-fold.ts";
import { installThinkingFold, installToolFold } from "./src/tool-render.ts";

initTheme("dark");
const ui = { requestRender() {} };
const width = 80;
const snapshot = (timestamp, content) => ({ role: "assistant", timestamp, content, stopReason: "stop" });
const plain = (line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\\\)/g, "");
const selection = "\x1b[48;5;236m";
const theme = () => ({
	fg(color, text) { return `\x1b[38;5;${color === "dim" ? 1 : color === "muted" ? 2 : 3}m${text}\x1b[39m`; },
	bg(_color, text) { return `${selection}${text}\x1b[49m`; },
	italic(text) { return `\x1b[3m${text}\x1b[23m`; },
});

function assistant(message) {
	const component = new AssistantMessageComponent();
	component.updateContent(snapshot(message.timestamp, message.content.map((item) => ({ ...item }))), false);
	return component;
}

function tool(id, name, args, text) {
	const component = new ToolExecutionComponent(name, id, args, {}, undefined, ui, ".");
	component.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return component;
}

function rowsOf(components, atWidth = width) {
	return components.flatMap((component) => component.render(atWidth));
}

test("settled progress guides every row across Pi components and keeps the final answer outside", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const messages = [
		snapshot(1801, [{ type: "thinking", thinking: "First thought." }]),
		snapshot(1802, [{ type: "text", text: "First note.\n\nStill part of the first note." }, { type: "text", text: "Second note." }]),
		snapshot(1803, [{ type: "thinking", thinking: "Middle thought." }, { type: "toolCall", id: "guide-middle", name: "read", arguments: { path: "data.txt" } }]),
		snapshot(1804, [{ type: "text", text: "What I found." }]),
		snapshot(1805, [
			{ type: "thinking", thinking: "Checking the final item." },
			{ type: "toolCall", id: "guide-last", name: "bash", arguments: { command: "run.sh" } },
		]),
		snapshot(1806, [{ type: "text", text: "Final answer." }]),
	];
	for (const message of messages) model.ingest(message);
	model.endExchange(1200);
	const middleProcess = model.processes()[1];
	model.toggleProcess(middleProcess.id);
	model.toggle("guide-middle");
	const nativeMiddle = tool("guide-middle", "read", { path: "data.txt" }, "alpha\nbeta\ngamma");
	const nativeMiddleRows = nativeMiddle.render(width - 6);

	const patches = [
		installThinkingFold(AssistantMessageComponent, model, theme),
		installToolFold(ToolExecutionComponent, model, theme),
	];
	try {
		const components = [
			assistant(messages[0]), assistant(messages[1]), assistant(messages[2]),
			tool("guide-middle", "read", { path: "data.txt" }, "alpha\nbeta\ngamma"),
			assistant(messages[3]), assistant(messages[4]), tool("guide-last", "bash", { command: "run.sh" }, "hello from script"),
			assistant(messages[5]),
		];
		const folded = rowsOf(components).map(plain);
		const foldedProgressAt = folded.findIndex((line) => line.includes("▸ Worked for"));
		const foldedAnswerAt = folded.findIndex((line) => line.includes("Final answer."));
		assert.notEqual(foldedProgressAt, -1);
		assert.equal(foldedAnswerAt - foldedProgressAt - 1, 1, "folded progress keeps one blank row before the answer");
		assert.doesNotMatch(folded.slice(foldedProgressAt, foldedAnswerAt).join("\n"), /First note|Second note|Middle thought|alpha/);
		model.toggleProgress(1);
		const rows = rowsOf(components);
		const rendered = rows.map(plain);
		const row = (needle) => rendered.findIndex((line) => line.includes(needle));
		const progressAt = row("▾ Worked for");
		const firstProcessAt = row("▸ ◈ 1 ⚙ 0");
		const firstNoteAt = row("First note.");
		const firstNoteTailAt = row("Still part of the first note.");
		const secondNoteAt = row("Second note.");
		const middleProcessAt = row("▾ ◈ 1 ⚙ 1");
		const middleThoughtAt = row("◈ Middle thought.");
		const middleToolAt = row("⚙ read  data.txt");
		const bodyAt = row("alpha");
		const nextNoteAt = row("What I found.");
		const lastProcessAt = row("▸ ◈ 1 ⚙ 1");
		const finalAt = row("Final answer.");
		for (const [name, index] of Object.entries({ progressAt, firstProcessAt, firstNoteAt, firstNoteTailAt, secondNoteAt, middleProcessAt, middleThoughtAt, middleToolAt, bodyAt, nextNoteAt, lastProcessAt, finalAt })) assert.notEqual(index, -1, `missing rendered row: ${name}\n${rendered.join("\n")}`);
		assert.match(rendered[progressAt].trim(), /◈ 3 ⚙ 2 · 3 notes$/);
		const outerGuideColumn = rendered[progressAt].indexOf("▾");
		const nestedGuideColumn = rendered[middleProcessAt].indexOf("▾");
		assert.equal(rendered[firstProcessAt].indexOf("├"), outerGuideColumn);
		assert.equal(rendered[firstProcessAt].indexOf("▸"), outerGuideColumn + 2);
		assert.equal(rendered[firstNoteAt].indexOf("│"), outerGuideColumn);
		assert.equal(rendered[secondNoteAt].indexOf("│"), outerGuideColumn);
		assert.equal(rendered[middleProcessAt].indexOf("├"), outerGuideColumn);
		assert.equal(rendered[middleProcessAt].indexOf("▾"), outerGuideColumn + 2);
		assert.equal(rendered[middleThoughtAt].indexOf("├"), nestedGuideColumn);
		assert.equal(rendered[middleThoughtAt].indexOf("◈"), nestedGuideColumn + 2);
		assert.equal(rendered[middleToolAt].indexOf("└"), nestedGuideColumn);
		assert.equal(rendered[middleToolAt].indexOf("⚙"), nestedGuideColumn + 2);
		assert.equal(rendered[bodyAt].indexOf("│"), outerGuideColumn);
		assert.equal(rendered[bodyAt].indexOf("alpha"), nestedGuideColumn + 4);
		assert.equal(rendered[nextNoteAt].indexOf("│"), outerGuideColumn);
		assert.equal(rendered[lastProcessAt].indexOf("└"), outerGuideColumn);
		assert.equal(rendered[lastProcessAt].indexOf("▸"), outerGuideColumn + 2);
		assert.equal(rendered[finalAt].trimStart().startsWith("Final answer."), true);
		const nativeStart = nativeMiddleRows.findIndex((line) => plain(line).trim() !== "");
		const nativeEnd = nativeMiddleRows.findLastIndex((line) => plain(line).trim() !== "");
		const expectedNativeBody = nativeMiddleRows.slice(nativeStart, nativeEnd + 1);

		for (const line of rows) assert.ok(visibleWidth(line) <= width, `row exceeds width: ${plain(line)}`);
		const guideEnd = rows[middleThoughtAt].indexOf("\x1b[39m");
		assert.ok(guideEnd >= 0 && guideEnd < rows[middleThoughtAt].indexOf("\x1b[3m"), "guide glyph is dim and outside title italics");
		assert.equal(rendered[finalAt - 1], "", "the native separator before the final answer is outside the progress guide");
		const expectedBlankness = [...Array(lastProcessAt - progressAt + 1).fill(false), true, false];
		expectedBlankness[firstNoteTailAt - progressAt - 1] = true;
		for (let index = 0; index < expectedNativeBody.length; index++) {
			if (plain(expectedNativeBody[index]).trim() === "") expectedBlankness[middleToolAt + 1 + index - progressAt] = true;
		}
		assert.equal(firstNoteTailAt - firstNoteAt, 2, "the blank row inside a multi-paragraph note remains");
		assert.deepEqual(
			rendered.slice(progressAt, finalAt + 1).map((line) => line.replace(/[│├└]/g, "").trim() === ""),
			expectedBlankness,
			`every row inside unwound progress is compact except note content, followed by one separator and the answer\n${rendered.slice(progressAt, finalAt + 1).map((line, index) => `${index}: ${JSON.stringify(line)}`).join("\n")}`,
		);
		assert.deepEqual(
			rows.slice(middleToolAt + 1, nextNoteAt),
			expectedNativeBody.map((line) => theme().fg("dim", " │    ") + line),
			"opened native output preserves every Pi row apart from its tree gutter",
		);
		for (let index = progressAt + 1; index <= lastProcessAt; index++) {
			const line = rendered[index];
			const guideColumns = [...line.matchAll(/[│├└]/g)].map((match) => match.index);
			assert.ok(guideColumns.includes(outerGuideColumn), `row breaks the outer guide column: ${JSON.stringify(line)}`);
			for (const column of guideColumns.filter((value) => value > outerGuideColumn)) {
				assert.equal(column, nestedGuideColumn, `nested guide is not under its parent control: ${JSON.stringify(line)}`);
			}
		}
		for (const line of rowsOf(components, 40)) assert.ok(visibleWidth(line) <= 40, `narrow row exceeds width: ${plain(line)}`);
	} finally {
		patches.reverse().forEach((patch) => patch.restore());
	}
});

test("a streaming process guides block titles and continues through an opened non-last body", () => {
	const model = new ToolFoldModel(() => 1000);
	model.beginExchange(1);
	const message = snapshot(1901, [
		{ type: "thinking", thinking: "Checking the first item." },
		{ type: "toolCall", id: "stream-open", name: "read", arguments: { path: "first.txt" } },
	]);
	const nextMessage = snapshot(1902, [
		{ type: "thinking", thinking: "Checking the second item." },
		{ type: "toolCall", id: "stream-last", name: "read", arguments: { path: "last.txt" } },
	]);
	model.ingest(message);
	model.ingest(nextMessage);
	model.toggleProcess(model.processes()[0].id);
	model.toggle("stream-open");
	const patches = [installThinkingFold(AssistantMessageComponent, model, theme), installToolFold(ToolExecutionComponent, model, theme)];
	try {
		const assistantComponent = assistant(message);
		const nextAssistant = assistant(nextMessage);
		const firstTool = tool("stream-open", "read", { path: "first.txt" }, "first line\nsecond line");
		const lastTool = tool("stream-last", "read", { path: "last.txt" }, "last line");
		const groups = [assistantComponent.render(width), firstTool.render(width), nextAssistant.render(width), lastTool.render(width)];
		const rendered = groups.flatMap((group) => group).map(plain);
		const row = (needle) => rendered.findIndex((line) => line.includes(needle));
		const processAt = row("▾ ◈ 2 ⚙ 2");
		const thoughtAt = row("◈ Checking the first item.");
		const firstTitleAt = row("⚙ read  first.txt");
		const bodyAt = row("first line");
		const nextThoughtAt = row("◈ Checking the second item.");
		const lastTitleAt = row("⚙ read  last.txt");
		for (const index of [processAt, thoughtAt, firstTitleAt, bodyAt, nextThoughtAt, lastTitleAt]) assert.notEqual(index, -1);
		assert.equal(rendered[processAt].trimStart().startsWith("▾ "), true, "the process control is the layer root");
		const processGlyphColumn = rendered[processAt].indexOf("▾");
		assert.equal(rendered[thoughtAt].indexOf("├"), processGlyphColumn);
		assert.equal(rendered[firstTitleAt].indexOf("├"), processGlyphColumn);
		assert.equal(rendered[firstTitleAt].indexOf("⚙"), processGlyphColumn + 2);
		assert.equal(rendered[bodyAt].indexOf("│"), processGlyphColumn);
		assert.equal(rendered[nextThoughtAt].indexOf("├"), processGlyphColumn);
		assert.equal(rendered[lastTitleAt].indexOf("└"), processGlyphColumn);
		for (const line of groups.flat()) assert.ok(visibleWidth(line) <= width, `row exceeds width: ${plain(line)}`);

		const firstRows = firstTool.render(width);
		const titleRow = firstRows.findIndex((line) => plain(line).includes("⚙ read  first.txt"));
		assert.ok(titleRow >= 0);
		firstTool.handleMouse({ type: "move", button: "none", x: 5, y: titleRow, width, height: firstRows.length });
		const hovered = plain(firstTool.render(width)[titleRow]);
		assert.ok(hovered.startsWith(" ├"));
		assert.ok(firstTool.render(width)[titleRow].indexOf(selection) > firstTool.render(width)[titleRow].indexOf("\x1b[39m"), "hover background starts after the gutter");
		for (const component of [assistantComponent, firstTool, nextAssistant, lastTool]) {
			for (const line of component.render(40)) assert.ok(visibleWidth(line) <= 40, `narrow row exceeds width: ${plain(line)}`);
		}
	} finally {
		patches.reverse().forEach((patch) => patch.restore());
	}
});
