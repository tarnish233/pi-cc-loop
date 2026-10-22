/**
 * Rendering tests: the custom message renderer must replace Pi's machine-name
 * title (`[pi-cc-loop-tick]`) with a quiet, readable block.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
function makeTheme() {
	const bgCalls = { count: 0 };
	return {
		bgCalls,
		theme: {
			fg: (_color, text) => text,
			bg: (_color, text) => {
				bgCalls.count += 1;
				return text;
			},
			bold: (text) => text,
		},
	};
}

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-render-"));
	process.chdir(workdir);

	const renderers = new Map();
	const tools = new Map();
	const handlers = new Map();

	const pi = {
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerToolRenderer() {},
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
		events: { emit() {}, on() { return () => {}; } },
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	mod.default(pi);
	return { renderers, tools, handlers };
}

function render(renderer, message, expanded) {
	const { theme, bgCalls } = makeTheme();
	const component = renderer(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(100);
	return { text: lines.join("\n"), lines, bgCalls };
}

function tickMessage(content, details = {}) {
	return {
		role: "custom",
		customType: "pi-cc-loop-tick",
		display: true,
		content,
		details: { tickCount: 7, ...details },
		timestamp: Date.now(),
	};
}







test("clock times read like Claude Code's '6:16pm'", async () => {
	const { formatClock } = await loadModule("renderers.ts");
	assert.equal(formatClock(new Date(2026, 9, 22, 18, 16).getTime()), "6:16pm");
	assert.equal(formatClock(new Date(2026, 9, 22, 0, 5).getTime()), "12:05am");
	assert.equal(formatClock(new Date(2026, 9, 22, 12, 0).getTime()), "12:00pm");
	assert.equal(formatClock(new Date(2026, 9, 22, 9, 3).getTime()), "9:03am");
	assert.equal(formatClock(undefined), "unknown");
});
