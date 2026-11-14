import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule, loadModuleFrom, siblingExtensionDir } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-command-sdk-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
process.env.PI_LOOP_SCAN_MS = "600000";
const install = findPiInstall();
const { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(install.piCodingAgent).href);
const { KeybindingsManager, TUI_KEYBINDINGS } = await import(pathToFileURL(install.piTui).href);
const { registerTaskProvider } = await loadModule("tasks.ts");
const loop = (await loadModule("index.ts")).default;
const monitor = (await loadModuleFrom(siblingExtensionDir("pi-cc-monitor"), "index.ts")).default;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function open(order, { prompt = false } = {}) {
	const cwd = fs.mkdtempSync(path.join(root, "project-"));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false } }));
	if (prompt) {
		fs.mkdirSync(path.join(agentDir, "prompts"));
		fs.writeFileSync(path.join(agentDir, "prompts", "tasks.md"), "Existing task prompt template.\n");
	}
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: order });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: true });
	const state = { calls: 0, panel: undefined, resolver: undefined, errors: [], notices: [], beforeBindCommands: [] };
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {});
	const ui = {
		theme: { fg: (_color, text) => text, bold: (text) => text },
		notify: (message) => state.notices.push(message), setStatus() {},
		custom(factory, options) {
			assert.equal(options.overlay, true);
			state.calls++;
			state.panel = factory({ terminal: { rows: 32, columns: 100 }, requestRender() {} }, ui.theme, keybindings, () => {
				state.panel?.dispose(); state.panel = undefined;
				const resolve = state.resolver; state.resolver = undefined; resolve?.();
			});
			return new Promise((resolve) => { state.resolver = resolve; });
		},
	};
	const result = {
		session, state,
		command: (name) => session.extensionRunner.getCommand(name),
		async close() {
			try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
			finally { session.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
			assert.deepEqual(state.errors, []);
		},
	};
	state.beforeBindCommands = panelCommandNames(result);
	await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => state.errors.push(error) });
	return result;
}

const commandNames = (s) => s.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName);
const tasksNames = (s) => commandNames(s).filter((name) => /^tasks(?::\d+)?$/.test(name));
const panelCommandNames = (s) => commandNames(s).filter((name) => s.command(name).description?.startsWith("Open the shared task overlay"));

function assertPanelCommand(s, name) {
	assert.deepEqual(panelCommandNames(s), [name], "our panel has exactly one entry, with no alias or suffix");
	assert.equal(s.command("cc_tasks"), undefined, "the old underscore entry is no longer registered");
}

async function openPanel(s, command, { busy = false } = {}) {
	const ctx = s.session.extensionRunner.createCommandContext();
	if (busy) {
		ctx.isIdle = () => false;
		ctx.waitForIdle = () => { throw new Error("local task panel must not wait for the model"); };
	}
	const pending = s.command(command).handler("", ctx);
	await Promise.resolve();
	assert.ok(s.state.panel);
	return { pending };
}

test("standalone and either package load order expose only /tasks when the name is free", async () => {
	for (const order of [[loop], [monitor], [loop, monitor], [monitor, loop]]) {
		const s = await open(order);
		try {
			assert.deepEqual(s.state.beforeBindCommands, [], "selection waits until command discovery is available");
			assert.deepEqual(tasksNames(s), ["tasks"]);
			assertPanelCommand(s, "tasks");
			assert.equal(s.command("cc-tasks"), undefined);
			const first = await openPanel(s, "tasks", { busy: true });
			const replacement = await openPanel(s, "tasks");
			await first.pending;
			assert.equal(s.state.calls, 2, "reopening replaces, rather than stacks, the task panel");
			s.state.panel.handleInput("\x1b");
			await replacement.pending;
			assert.deepEqual(s.session.messages, [], "opening the local command sends no model message");
			await s.session.extensionRunner.emitResourcesDiscover(s.session.cwd, "reload");
			assertPanelCommand(s, "tasks");
			assert.equal(s.command("cc-tasks"), undefined, "a repeated boundary does not add a fallback");
		} finally { await s.close(); }
	}
});

test("an existing /tasks stays untouched and only /cc-tasks is added in either factory order", async () => {
	let calls = 0;
	const handler = async () => { calls++; };
	const other = (pi) => pi.registerCommand("tasks", { description: "Existing owner", handler });
	for (const packages of [[loop], [monitor], [loop, monitor], [monitor, loop]]) {
		for (const order of [[other, ...packages], [...packages, other]]) {
			const s = await open(order);
			try {
				assert.deepEqual(s.state.beforeBindCommands, []);
				assert.deepEqual(tasksNames(s), ["tasks"]);
				assert.equal(s.command("tasks").handler, handler);
				assertPanelCommand(s, "cc-tasks");
				await s.session.prompt("/tasks");
				assert.equal(s.state.calls, 0, "the existing command does not open our panel");
				const shown = await openPanel(s, "cc-tasks", { busy: true });
				s.state.panel.handleInput("\x1b"); await shown.pending;
				assert.deepEqual(s.session.messages, []);
				await s.session.extensionRunner.emitResourcesDiscover(s.session.cwd, "reload");
				assertPanelCommand(s, "cc-tasks");
			} finally { await s.close(); }
		}
	}
	assert.equal(calls, 8);
});

test("/tasks registered by a later session_start handler is detected before command selection", async () => {
	const handler = async () => {};
	const late = (pi) => pi.on("session_start", () => pi.registerCommand("tasks", { description: "Startup owner", handler }));
	const s = await open([loop, monitor, late]);
	try {
		assert.deepEqual(tasksNames(s), ["tasks"]);
		assert.equal(s.command("tasks").handler, handler);
		assertPanelCommand(s, "cc-tasks");
	} finally { await s.close(); }
});

test("pre-existing suffixed /tasks commands are not joined or shadowed", async () => {
	const first = (pi) => pi.registerCommand("tasks", { description: "First owner", handler: async () => {} });
	const second = (pi) => pi.registerCommand("tasks", { description: "Second owner", handler: async () => {} });
	const s = await open([first, loop, monitor, second]);
	try {
		assert.deepEqual(tasksNames(s), ["tasks:1", "tasks:2"]);
		assert.equal(s.command("tasks"), undefined);
		assert.equal(s.command("tasks:1").description, "First owner");
		assert.equal(s.command("tasks:2").description, "Second owner");
		assertPanelCommand(s, "cc-tasks");
	} finally { await s.close(); }
});

test("an existing /tasks prompt template selects only the /cc-tasks fallback", async () => {
	const s = await open([monitor, loop], { prompt: true });
	try {
		assert.deepEqual(tasksNames(s), [], "no extension command shadows the template");
		assert.ok(s.session.promptTemplates.some((template) => template.name === "tasks"));
		assertPanelCommand(s, "cc-tasks");
		const shown = await openPanel(s, "cc-tasks");
		s.state.panel.handleInput("\x1b"); await shown.pending;
		assert.deepEqual(s.session.messages, []);
	} finally { await s.close(); }
});

test("independent SDK runtimes do not share the command selection", async () => {
	const other = (pi) => pi.registerCommand("tasks", { description: "Other owner", handler: async () => {} });
	const reserved = await open([other, loop, monitor]);
	const free = await open([monitor, loop]);
	try {
		assert.equal(reserved.command("tasks").description, "Other owner");
		assertPanelCommand(reserved, "cc-tasks");
		assertPanelCommand(free, "tasks");
		assert.equal(free.command("cc-tasks"), undefined);
		assert.notEqual(reserved.command("tasks").handler, free.command("tasks").handler);
	} finally { await free.close(); await reserved.close(); }
});

test("SDK reload closes the old overlay and reselects exactly one entry for the new runtime", async () => {
	let occupied = false;
	const handler = async () => {};
	const other = (pi) => {
		if (occupied) pi.registerCommand("tasks", { description: "Reload owner", handler });
	};
	const s = await open([loop, monitor, other]);
	try {
		assertPanelCommand(s, "tasks");
		const primary = await openPanel(s, "tasks");
		occupied = true;
		await s.session.reload();
		await primary.pending;
		assert.equal(s.state.panel, undefined, "shutdown disposes the old overlay");
		assert.deepEqual(tasksNames(s), ["tasks"]);
		assert.equal(s.command("tasks").handler, handler);
		assertPanelCommand(s, "cc-tasks");
		const fallback = await openPanel(s, "cc-tasks");
		occupied = false;
		await s.session.reload();
		await fallback.pending;
		assert.equal(s.state.panel, undefined);
		assertPanelCommand(s, "tasks");
		assert.equal(s.command("cc-tasks"), undefined);
		assert.deepEqual(s.session.messages, []);
	} finally { await s.close(); }
});

/** Minimal host for older/missing APIs and repeated resource-boundary tests. */
function registrationHost(getCommands) {
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		events: createEventBus(),
		registerCommand(name, options) {
			assert.equal(commands.has(name), false, "the command must not be registered twice");
			commands.set(name, options);
		},
		on: (event, handler) => handlers.set(event, handler),
	};
	if (getCommands) pi.getCommands = getCommands;
	const registration = registerTaskProvider(pi, { id: "loop", label: "Loop", list: () => [] });
	return {
		commands, registration,
		discover: () => handlers.get("resources_discover")?.({ type: "resources_discover", reason: "startup" }),
	};
}

test("a host without getCommands conservatively registers only /cc-tasks", () => {
	const h = registrationHost();
	try {
		assert.deepEqual([...h.commands.keys()], ["cc-tasks"]);
		h.discover();
		assert.deepEqual([...h.commands.keys()], ["cc-tasks"]);
	} finally { h.registration.close(); }
});

test("a failed ownership query selects only /cc-tasks and never later adds /tasks", () => {
	let failed = true;
	let calls = 0;
	const h = registrationHost(() => {
		calls++;
		if (failed) throw new Error("getCommands is not bound");
		return [];
	});
	try {
		assert.deepEqual([...h.commands.keys()], []);
		assert.equal(calls, 0, "do not query during factory loading");
		h.discover();
		assert.deepEqual([...h.commands.keys()], ["cc-tasks"]);
		failed = false;
		h.discover();
		assert.deepEqual([...h.commands.keys()], ["cc-tasks"]);
		assert.equal(calls, 1, "one entry is selected for this runtime");
	} finally { h.registration.close(); }
});

test("repeated discovery never switches the selected entry within a runtime", () => {
	for (const occupied of [false, true]) {
		let commands = occupied ? [{ name: "tasks" }] : [];
		const h = registrationHost(() => commands);
		try {
			h.discover();
			const selected = occupied ? "cc-tasks" : "tasks";
			assert.deepEqual([...h.commands.keys()], [selected]);
			commands = occupied ? [] : [{ name: "tasks" }];
			h.discover();
			assert.deepEqual([...h.commands.keys()], [selected]);
		} finally { h.registration.close(); }
	}
});

test("a registry closed before discovery cannot register a late command", () => {
	const h = registrationHost(() => []);
	h.registration.close();
	h.discover();
	assert.deepEqual([...h.commands.keys()], []);
});
