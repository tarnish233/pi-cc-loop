/**
 * Settings tests: the shared config file switches the message style and the
 * compact tool rows, without re-registering the tools.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const configFile = process.env.PI_CC_CONFIG_FILE;
const ccstyleConfig = process.env.PI_CC_EXTENSIONS_CONFIG_FILE;
assert.ok(configFile, "the test helper points PI_CC_CONFIG_FILE at a temp file");
assert.ok(ccstyleConfig, "the test helper points PI_CC_EXTENSIONS_CONFIG_FILE at a temp file");
fs.writeFileSync(configFile, JSON.stringify({ compactMessages: true, compactToolRows: true }), "utf8");

const mod = await loadModule("index.ts");

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
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-loop-settings-"));
	process.chdir(workdir);

	const commands = new Map();
	const tools = new Map();
	const renderers = new Map();
	const toolRenderers = [];
	const notifications = [];
	const appended = [];

	const pi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerToolRenderer(resolver) {
			toolRenderers.push(resolver);
		},
		on() {
			return () => {};
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		sendUserMessage() {},
		sendMessage() {},
		events: { emit() {}, on() { return () => {}; } },
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	const ctx = {
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setWidget: () => {},
			theme: { fg: (_color, text) => text },
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};

	mod.default(pi);
	// Simulate pi-cc-monitor being installed so the loop command manages all
	// seven pi-cc tool names.
	tools.set("Monitor", { name: "Monitor" });
	return { commands, tools, renderers, toolRenderers, notifications, appended, ctx };
}

function renderTick(h, expanded = false) {
	const renderer = h.renderers.get("pi-cc-loop-tick");
	const { theme, bgCalls } = makeTheme();
	const message = {
		role: "custom",
		customType: "pi-cc-loop-tick",
		display: true,
		content: "[loop tick #7 · scheduled by /loop, not typed by the user]\ncheck the deploy",
		details: { tickCount: 7, jobId: "abc12345", cron: "*/5 * * * *" },
		timestamp: Date.now(),
	};
	const lines = renderer(message, { expanded, outputPad: 1 }, theme).render(100);
	return { text: lines.join("\n"), lines, bgCalls };
}

/** Resolve the compact renderers for a tool name, if the resolver returns them. */
function resolveTool(h, name) {
	const next = () => undefined;
	const resolvers = h.toolRenderers;
	const resolve = (index) => (index < resolvers.length ? resolvers[index](name, () => resolve(index + 1)) : next());
	return resolve(0);
}

test("the defaults are compact messages and compact tool rows", async () => {
	const h = makeHarness();
	await h.commands.get("loop").handler("settings", h.ctx);
	const shown = h.notifications.at(-1)?.message ?? "";
	assert.match(shown, /messages:\s+compact/);
	assert.match(shown, /tool rows:\s+compact/);

	const tick = renderTick(h);
	assert.equal(tick.lines.length, 2, tick.text);
	assert.equal(tick.bgCalls.count, 0);
	assert.ok(resolveTool(h, "cron_create")?.renderCall, "compact tool renderers are armed");
});

test("settings messages off restores the legacy card and on restores the compact block", async () => {
	const h = makeHarness();
	const loop = h.commands.get("loop");

	await loop.handler("settings messages off", h.ctx);
	let tick = renderTick(h);
	assert.ok(tick.lines.length > 2, tick.text);
	assert.match(tick.text, /Ctrl\+O/, tick.text);
	assert.ok(tick.bgCalls.count > 0);

	await loop.handler("settings messages on", h.ctx);
	tick = renderTick(h);
	assert.equal(tick.lines.length, 2, tick.text);
	assert.equal(tick.bgCalls.count, 0);

	const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
	assert.equal(saved.compactMessages, true);
});

test("settings tools off falls back to the default renderer and on restores the compact rows", async () => {
	const h = makeHarness();
	const loop = h.commands.get("loop");

	assert.ok(resolveTool(h, "cron_create"));
	await loop.handler("settings tools off", h.ctx);
	assert.equal(resolveTool(h, "cron_create"), undefined);

	const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
	assert.equal(saved.compactToolRows, false);

	await loop.handler("settings tools on", h.ctx);
	assert.ok(resolveTool(h, "cron_create"));

	const ccstyle = JSON.parse(fs.readFileSync(ccstyleConfig, "utf8"));
	assert.ok(ccstyle.excludeRenderers.includes("cron_create"), "loop tools are excluded from ccstyle");
	assert.ok(ccstyle.excludeRenderers.includes("Monitor"), "monitor tools are excluded too");
	assert.ok(!ccstyle.excludeRenderers.includes("bash"), "unrelated exclusions are untouched");

	await loop.handler("settings tools off", h.ctx);
	const restored = JSON.parse(fs.readFileSync(ccstyleConfig, "utf8"));
	assert.ok(!restored.excludeRenderers.includes("cron_create"), "loop exclusions are removed again");
	assert.ok(!restored.excludeRenderers.includes("Monitor"), "monitor exclusions are removed again");
});

test("the compact cron_create row is one line and collapses the call row after completion", async () => {
	const h = makeHarness();
	await h.commands.get("loop").handler("settings tools on", h.ctx);
	const renderers = resolveTool(h, "cron_create");
	assert.ok(renderers, "compact renderers are armed");

	const { theme } = makeTheme();
	const call = renderers.renderCall(
		{ cron: "*/1 * * * *", prompt: "每30秒输出一次hello world" },
		theme,
		{ isPartial: false, executionStarted: true },
	);
	assert.deepEqual(call.render(100), [], "the finished call row disappears");

	const result = {
		content: [{ type: "text", text: "Scheduled hu2389lz (Every minute, next run 04:55 PM)" }],
		details: {
			id: "hu2389lz",
			cron: "* * * * *",
			nextFireAt: Date.now(),
			recurring: true,
			durable: false,
			prompt: "每30秒输出一次hello world",
		},
	};
	const rendered = renderers
		.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false, args: {} })
		.render(100)
		.join("\n");
	assert.match(rendered, /^✓ Scheduled hu2389lz · Every minute · next /);
	assert.equal(rendered.split("\n").length, 1);
});
