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





