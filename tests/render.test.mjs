/**
 * Rendering tests: the custom message renderers must replace Pi's machine-name
 * title (`[pi-cc-loop-tick]`) with a readable, collapsible card.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule, loadPi } from "./helpers.mjs";

// The expand hint needs Pi's theme; the real TUI always has one.
try {
	const { initTheme } = await loadPi();
	initTheme();
} catch {
	// the renderer falls back to a plain hint
}

const mod = await loadModule("index.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
const fakeTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

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
	const component = renderer(message, { expanded, outputPad: 1 }, fakeTheme);
	return component.render(100).join("\n");
}

test("the tick is drawn as a readable card, not [pi-cc-loop-tick]", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-loop-tick");
	assert.ok(renderer, "a renderer is registered for the tick message type");

	const message = {
		role: "custom",
		customType: "pi-cc-loop-tick",
		display: true,
		content: "[loop tick #7 · scheduled by /loop, not typed by the user]\ncheck the deploy and tell me what happened",
		details: { tickCount: 7, jobId: "abc12345" },
	};

	const collapsed = render(renderer, message, false);
	assert.ok(collapsed.includes("↻ loop tick #7"), collapsed);
	assert.ok(collapsed.includes("check the deploy and tell me what happened"), collapsed);
	assert.ok(!collapsed.includes("[pi-cc-loop-tick]"), "the machine name is gone");

	const expanded = render(renderer, message, true);
	assert.ok(expanded.includes("check the deploy and tell me what happened"));
});

test("the collapsed card hints how to expand", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-loop-tick");
	const message = {
		role: "custom",
		customType: "pi-cc-loop-tick",
		display: true,
		content: "[loop tick #1 · scheduled by /loop, not typed by the user]\nping",
		details: { tickCount: 1 },
	};
	const collapsed = render(renderer, message, false);
	assert.ok(/expand/i.test(collapsed), collapsed);
});
