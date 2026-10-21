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

test("the tick is a quiet two-line block, not [pi-cc-loop-tick]", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-loop-tick");
	assert.ok(renderer, "a renderer is registered for the tick message type");

	const message = tickMessage(
		"[loop tick #7 · scheduled by /loop, not typed by the user]\ncheck the deploy and tell me what happened",
		{ jobId: "abc12345" },
	);

	const { text, lines, bgCalls } = render(renderer, message, false);
	assert.equal(lines.length, 2, text);
	assert.ok(lines[0].includes("loop #7"), text);
	assert.match(lines[0], /\d{1,2}:\d{2}/, "the header carries a timestamp");
	assert.equal(lines[1].trim(), "check the deploy and tell me what happened");
	assert.ok(!text.includes("[pi-cc-loop-tick]"), "the machine name is gone");
	assert.ok(!text.includes("↻"), "no arrow glyph");
	assert.equal(bgCalls.count, 0, "no background is painted");
});

test("expanded shows the job metadata", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-loop-tick");
	const message = tickMessage(
		"[loop tick #7 · scheduled by /loop, not typed by the user]\ncheck the deploy",
		{ jobId: "abc12345", cron: "*/5 * * * *" },
	);

	const { text } = render(renderer, message, true);
	assert.ok(text.includes("job abc12345"), text);
	assert.ok(text.includes("cron */5 * * * *"), text);
	assert.ok(text.includes("scheduled by /loop"), text);
});

test("long prompts are capped when collapsed and complete when expanded", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-loop-tick");
	const prompt = ["line one", "line two", "line three", "line four", "line five"].join("\n");
	const message = tickMessage(
		`[loop tick #7 · scheduled by /loop, not typed by the user]\n${prompt}`,
	);

	const collapsed = render(renderer, message, false);
	assert.ok(collapsed.text.includes("line one"), collapsed.text);
	assert.ok(collapsed.text.includes("line three"), collapsed.text);
	assert.ok(collapsed.text.includes("+2 more lines"), collapsed.text);
	assert.ok(!collapsed.text.includes("line four"), collapsed.text);

	const expanded = render(renderer, message, true);
	assert.ok(expanded.text.includes("line four"), expanded.text);
	assert.ok(expanded.text.includes("line five"), expanded.text);
	assert.ok(!expanded.text.includes("more lines"), expanded.text);
});
