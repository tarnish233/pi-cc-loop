/**
 * /cc-tasks: the shared dynamic-provider overlay.
 *
 * The fake APIs omit getCommands(), exercising the conservative fallback.
 * Actual SDK command discovery and selection live in task-commands.test.mjs.
 * These tests use a fake runtime that mirrors the part of Pi 1.5.1 that matters
 * here: every extension gets its own `pi.events` facade over one common bus,
 * and a reload keeps the bus but replaces the extension set. The overlay is
 * driven exactly as Pi drives it (factory -> component -> handleInput/render)
 * without a model request.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule, loadModuleFrom, loadPi, siblingExtensionDir } from "./helpers.mjs";

const loopMod = await loadModule("index.ts");
const tasksMod = await loadModule("tasks.ts");
const monitorDir = siblingExtensionDir("pi-cc-monitor");
const monitorMod = await loadModuleFrom(monitorDir, "index.ts");
const tuiPkg = await import(pathToFileURL(findPiInstall().piTui).href);
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = tuiPkg;

const KEYS = {
	up: "k",
	down: "j",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(20);
	}
	return false;
}

/** Follow the real scroll viewport through every semantic section and log tail. */
function detailText(runtime) {
	const pages = [];
	runtime.render();
	const limit = runtime.state.component.detailLineCount + 1;
	for (let i = 0; i < limit; i++) {
		pages.push(runtime.text());
		const before = runtime.state.component.detailScroll;
		runtime.input("pageDown");
		if (runtime.state.component.detailScroll === before) {
			assert.equal(before, Math.max(0, runtime.state.component.detailLineCount - runtime.state.component.detailViewport));
			return pages.join("\n");
		}
	}
	assert.fail("detail paging never reached the final viewport");
}

/** One Pi session runtime: one bus, any number of extensions with distinct facades. */
function makeRuntime(overrides = {}) {
	const workdir = overrides.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-tasks-"));
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const sent = [];
	const appended = [];
	const notifications = [];
	const busEvents = [];
	const clients = [];
	const state = {
		idle: true,
		pending: false,
		waited: 0,
		aborts: 0,
		columns: 80,
		rows: 24,
		renders: 0,
		customCount: 0,
		options: undefined,
		component: undefined,
		resolveCustom: undefined,
	};

	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.up": KEYS.up,
		"tui.select.down": KEYS.down,
		...(overrides.keybindings ?? {}),
	});
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const tui = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return state.rows;
			},
		},
		requestRender() {
			state.renders += 1;
		},
	};

	function uniqueCommand(name) {
		let candidate = name;
		let suffix = 1;
		while (commands.has(candidate)) candidate = `${name}:${suffix++}`;
		return candidate;
	}

	function addHandler(event, handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		};
	}

	/** A fresh facade per extension, like Pi's createExtensionAPI().events. */
	function createClient() {
		const subscriptions = new Set();
		const client = { disposed: false };
		const events = {
			emit(channel, data) {
				if (client.disposed) throw new Error("stale extension API");
				busEvents.push({ channel, data });
				bus.emit(channel, data);
			},
			on(channel, handler) {
				if (client.disposed) throw new Error("stale extension API");
				const wrapped = (data) => handler(data);
				bus.on(channel, wrapped);
				const entry = { channel, handler: wrapped };
				subscriptions.add(entry);
				return () => {
					if (!subscriptions.delete(entry)) return;
					bus.off(channel, wrapped);
				};
			},
		};
		client.pi = {
			events,
			registerCommand(name, options) {
				commands.set(uniqueCommand(name), options);
			},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerMessageRenderer() {},
			registerToolRenderer() {},
			on: addHandler,
			appendEntry(customType, data) {
				appended.push({ customType, data });
			},
			sendUserMessage(content, options) {
				sent.push({ kind: "user", content, options });
			},
			sendMessage(message, options) {
				sent.push({ kind: "custom", message, options });
			},
			getAllTools() {
				return [...tools.keys()].map((name) => ({ name }));
			},
			getSettings() {
				return {};
			},
			setActiveTools() {
				throw new Error("/cc-tasks must not change the tool set");
			},
		};
		client.dispose = () => {
			client.disposed = true;
			for (const { channel, handler } of subscriptions) bus.off(channel, handler);
			subscriptions.clear();
		};
		clients.push(client);
		return client;
	}

	const ctx = {
		ui: {
			custom(factory, options) {
				state.customCount += 1;
				state.options = options;
				const done = (result) => {
					const component = state.component;
					state.component = undefined;
					try {
						component?.dispose?.();
					} catch {
						// Pi ignores dispose errors too
					}
					const resolve = state.resolveCustom;
					state.resolveCustom = undefined;
					resolve?.(result);
				};
				const component = factory(tui, theme, keybindings, done);
				state.component = component;
				return new Promise((resolve) => {
					state.resolveCustom = resolve;
				});
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
			theme,
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: {
			getEntries: () => [],
			// These tests call schedule_wakeup directly with id "c", so the
			// finalized assistant response is the standalone call it requires.
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c", name: "schedule_wakeup", arguments: {} }],
					},
				},
			],
		},
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		waitForIdle: async () => {
			state.waited += 1;
			state.idle = true;
		},
		abort: () => {
			state.aborts += 1;
		},
	};

	async function dispatch(event, payload = {}) {
		let last;
		for (const handler of [...(handlers.get(event) ?? [])]) last = await handler({ type: event, ...payload }, ctx);
		return last;
	}

	function load(factory) {
		const client = createClient();
		factory(client.pi);
		return client;
	}

	async function start() {
		await dispatch("session_start", { reason: "startup" });
	}

	async function shutdown(reason = "quit") {
		await dispatch("session_shutdown", { reason });
		for (const client of clients) client.dispose();
	}

	async function resetExtensions() {
		await shutdown("reload");
		commands.clear();
		tools.clear();
		handlers.clear();
		clients.length = 0;
		state.options = undefined;
		state.component = undefined;
		state.resolveCustom = undefined;
	}

	function render(width) {
		assert.ok(state.component, "overlay is open");
		const configured = state.options?.overlayOptions;
		const options = typeof configured === "function" ? configured() : configured;
		return state.component.render(width ?? options?.width ?? state.columns);
	}

	function text(width) {
		return render(width).join("\n");
	}

	function input(key) {
		assert.ok(state.component, "overlay is open");
		state.component.handleInput(KEYS[key] ?? key);
	}

	function selectedLine(width) {
		return render(width).find((line) => line.includes("\u25b8")) ?? "";
	}

	return {
		workdir,
		bus,
		state,
		ctx,
		commands,
		tools,
		handlers,
		sent,
		appended,
		notifications,
		busEvents,
		keybindings,
		theme,
		load,
		start,
		shutdown,
		resetExtensions,
		dispatch,
		render,
		text,
		input,
		selectedLine,
		loadBoth(order = ["loop", "monitor"]) {
			for (const name of order) {
				if (name === "loop") load(loopMod.default);
				else load(monitorMod.default);
			}
		},
	};
}

async function stopAll(runtime) {
	try {
		await runtime.shutdown();
	} finally {
		fs.rmSync(runtime.workdir, { recursive: true, force: true });
	}
}

function commandNames(runtime) {
	return [...runtime.commands.keys()];
}

function ccTasksCommands(runtime) {
	return commandNames(runtime).filter((name) => name === "cc-tasks" || name.startsWith("cc-tasks:"));
}

function openTasks(runtime) {
	const command = runtime.commands.get("cc-tasks");
	assert.ok(command, "/cc-tasks is registered");
	const promise = command.handler("", runtime.ctx);
	assert.ok(runtime.state.component, "the overlay factory ran synchronously");
	return promise;
}

async function armMonitor(runtime, params) {
	return runtime.tools
		.get("Monitor")
		.execute("m", params, undefined, undefined, runtime.ctx);
}

async function createCron(runtime, args) {
	return runtime.tools.get("cron_create").execute("c", args, undefined, undefined, runtime.ctx);
}

// ---------------------------------------------------------------- basic UI

test("both load orders expose exactly one /cc-tasks and open a native overlay while busy", async (t) => {
	for (const order of [["monitor", "loop"], ["loop", "monitor"]]) {
		const runtime = makeRuntime();
		t.after(() => stopAll(runtime));
		runtime.loadBoth(order);
		await runtime.start();
		assert.deepEqual(ccTasksCommands(runtime), ["cc-tasks"], `${order.join(" -> ")}: one unambiguous command`);
		assert.equal(runtime.commands.get("pi_cc")?.description?.includes("settings"), true, "/pi_cc still exists");
		assert.ok(runtime.commands.get("loop"), "/loop semantics stay unchanged");

		const armed = await armMonitor(runtime, {
			command: "sleep 30",
			description: "wide \u4e2d\u6587\u65e5\u672c\u8a9e\ud83d\ude80 monitor",
			persistent: true,
		});
		await createCron(runtime, { cron: "*/5 * * * *", prompt: "check the deploy" });

		runtime.state.idle = false;
		runtime.state.pending = true;
		const sentBefore = runtime.sent.length;
		const appendedBefore = runtime.appended.length;
		const overlay = openTasks(runtime);

		assert.equal(runtime.state.options.overlay, true, "native overlay mode, not the editor");
		assert.equal(typeof runtime.state.options.overlayOptions, "function", "width responds to terminal resizing");
		assert.equal(runtime.state.options.overlayOptions().width, 78);
		assert.equal(runtime.state.waited, 0, "opening while busy never waits for idle");
		const all = runtime.text();
		assert.match(all, /Monitor/);
		assert.match(all, /Loop/);
		assert.equal(armed.details.status, undefined);
		assert.match(all, /check the deploy/);
		const creationTimes = runtime.state.component.entries.map((entry) => entry.createdAt);
		assert.ok(creationTimes.every(Number.isFinite), "both real providers expose task creation timestamps");
		assert.deepEqual(creationTimes, [...creationTimes].sort((a, b) => b - a), "All is newest-first in either package load order");
		assert.equal(runtime.sent.length, sentBefore, "no conversation write just to open");
		assert.equal(runtime.appended.length, appendedBefore, "no session entry just to open");

		runtime.input("escape");
		await overlay;
		assert.equal(runtime.state.component, undefined, "Esc closes the overlay");
		assert.equal(runtime.state.aborts, 0, "Esc never reaches the app interrupt");
		assert.equal(runtime.sent.length, sentBefore, "no follow-up turn on close");
		assert.equal(runtime.state.waited, 0);
	}
});

test("Tab/Shift+Tab, named select actions and Esc behave in both directions", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	runtime.loadBoth(["loop", "monitor"]);
	await runtime.start();
	let creationTime = Date.now();
	const clock = t.mock.method(Date, "now", () => ++creationTime);
	await armMonitor(runtime, { command: "sleep 30", description: "first monitor", persistent: true });
	await armMonitor(runtime, { command: "sleep 30", description: "second monitor", persistent: true });
	clock.mock.restore();

	const overlay = openTasks(runtime);
	assert.match(runtime.selectedLine(), /second monitor/);
	runtime.input("down"); // the injected keybinding is "j", not ArrowDown
	assert.match(runtime.selectedLine(), /first monitor/);
	runtime.input("up"); // "k"
	assert.match(runtime.selectedLine(), /second monitor/);

	// Monitor tab, then Loop tab (pi-cc-loop is loaded but has nothing).
	runtime.input("tab");
	assert.match(runtime.text(), /first monitor/);
	runtime.input("tab");
	assert.match(runtime.text(), /No Loop tasks in this session/);
	runtime.input("shiftTab");
	assert.match(runtime.text(), /first monitor/);

	runtime.input("escape");
	await overlay;
	assert.equal(runtime.state.aborts, 0);
});

test("non-TUI modes report text and never touch TUI methods; standalone plugins work", async (t) => {
	const monitorOnly = makeRuntime();
	const loopOnly = makeRuntime();
	t.after(() => stopAll(monitorOnly));
	t.after(() => stopAll(loopOnly));

	monitorOnly.load(monitorMod.default);
	await monitorOnly.start();
	await armMonitor(monitorOnly, { command: "sleep 30", description: "only monitor", persistent: true });
	assert.deepEqual(ccTasksCommands(monitorOnly), ["cc-tasks"]);
	const overlay = openTasks(monitorOnly);
	// One provider has one named view, not two identical All/Monitor tabs.
	assert.match(monitorOnly.text(), /Monitor 1/);
	assert.doesNotMatch(monitorOnly.text(), /All \d|Tab switch|Loop \d/);
	monitorOnly.input("tab");
	assert.match(monitorOnly.text(), /Monitor 1/);
	assert.match(monitorOnly.text(), /only monitor/);
	assert.doesNotMatch(monitorOnly.text(), /All \d|Loop \d/);
	monitorOnly.input("escape");
	await overlay;

	// Print/JSON: no custom(), no notify, no crash.
	monitorOnly.ctx.mode = "print";
	monitorOnly.ctx.hasUI = false;
	await monitorOnly.commands.get("cc-tasks").handler("", monitorOnly.ctx);
	assert.equal(monitorOnly.state.customCount, 1, "only the earlier TUI open");
	assert.equal(monitorOnly.notifications.length, 0);
	// RPC: a textual summary through notify, still no custom().
	monitorOnly.ctx.mode = "rpc";
	monitorOnly.ctx.hasUI = true;
	await monitorOnly.commands.get("cc-tasks").handler("", monitorOnly.ctx);
	assert.equal(monitorOnly.state.customCount, 1);
	assert.match(monitorOnly.notifications.at(-1).message, /only monitor/);

	loopOnly.load(loopMod.default);
	await loopOnly.start();
	await createCron(loopOnly, { cron: "*/5 * * * *", prompt: "loop only" });
	assert.deepEqual(ccTasksCommands(loopOnly), ["cc-tasks"]);
	const loopOverlay = openTasks(loopOnly);
	loopOnly.input("tab");
	assert.match(loopOnly.text(), /loop only/);
	assert.doesNotMatch(loopOnly.text(), /Monitor \d/);
	loopOnly.input("shiftTab");
	assert.match(loopOnly.text(), /loop only/);
	loopOnly.input("escape");
	await loopOverlay;
});

// ------------------------------------------------ shared registry & refresh

test("the real Pi event bus answers the probe synchronously across distinct facades", async () => {
	const { createEventBus } = await loadPi();
	const bus = createEventBus();
	const commands = new Map();
	function client() {
		const subscriptions = new Set();
		const events = {
			emit: (channel, data) => bus.emit(channel, data),
			on(channel, handler) {
				// Pi wraps bus handlers in an async safe-handler; the probe must
				// still be answered before emit() returns.
				const safe = async (data) => {
					try {
						await handler(data);
					} catch {
						// Pi reports handler errors without breaking the bus
					}
				};
				bus.on(channel, safe);
				const entry = { channel, safe };
				subscriptions.add(entry);
				return () => {
					if (!subscriptions.delete(entry)) return;
					bus.off(channel, safe);
				};
			},
		};
		const pi = {
			events,
			registerCommand(name, options) {
				let candidate = name;
				let suffix = 1;
				while (commands.has(candidate)) candidate = `${name}:${suffix++}`;
				commands.set(candidate, options);
			},
			on: () => () => {},
		};
		return { pi, close: () => { for (const { channel, safe } of subscriptions) bus.off(channel, safe); subscriptions.clear(); } };
	}
	const a = client();
	const b = client();
	assert.notEqual(a.pi.events, b.pi.events);
	const regA = tasksMod.registerTaskProvider(a.pi, { id: "monitor", label: "Monitor", list: () => [] });
	const regB = tasksMod.registerTaskProvider(b.pi, { id: "loop", label: "Loop", list: () => [] });
	assert.deepEqual([...commands.keys()], ["cc-tasks"], "the second facade joined before emit returned");
	regB.changed();
	regA.close();
	regB.close();
	a.close();
	b.close();
});

test("distinct pi.events facades share one registry; same task id in two providers is two tasks", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	const clientA = runtime.load(() => {});
	const clientB = runtime.load(() => {});
	const a = { id: "same", title: "provider A item", state: "running", active: true };
	const b = { id: "same", title: "provider B item", state: "scheduled", active: true };
	let aLabel = "A";
	const regA = tasksMod.registerTaskProvider(clientA.pi, {
		id: "monitor",
		label: "Monitor",
		list: () => [a],
	});
	const regB = tasksMod.registerTaskProvider(clientB.pi, {
		id: "loop",
		label: "Loop",
		list: () => [b],
	});
	assert.notEqual(clientA.pi.events, clientB.pi.events, "the facades are distinct objects");
	assert.deepEqual(ccTasksCommands(runtime), ["cc-tasks"], "the second facade joined instead of registering again");

	const overlay = openTasks(runtime);
	const all = runtime.text();
	assert.match(all, /provider A item/);
	assert.match(all, /provider B item/);
	assert.match(runtime.selectedLine(), /provider A item/);
	runtime.input("down");
	assert.match(runtime.selectedLine(), /provider B item/);

	// A burst of change notices is coalesced; the selected identity survives.
	const rendersBefore = runtime.state.renders;
	for (let i = 0; i < 25; i++) {
		aLabel = `A${i}`;
		regA.changed();
		regB.changed();
	}
	assert.equal(runtime.state.renders, rendersBefore, "no redraw per raw change");
	await sleep(350);
	assert.ok(runtime.state.renders > rendersBefore, "one coalesced refresh happened");
	assert.ok(runtime.state.renders - rendersBefore <= 2, "not one redraw per change");
	assert.match(runtime.selectedLine(), /provider B item/, "selection is keyed by provider + id");

	runtime.input("escape");
	await overlay;
	regA.close();
	regB.close();
});

// --------------------------------------------------------------- stop flows

test("x/y stops the selected self-paced loop, cascades to its Monitor, and cannot resurrect it", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	runtime.loadBoth(["loop", "monitor"]);
	await runtime.start();

	const armedLoop = await runtime.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 600, reason: "waiting for CI", prompt: "watch CI" }, undefined, undefined, runtime.ctx);
	const armedMonitor = await armMonitor(runtime, {
		command: "sleep 30",
		description: "CI monitor",
		loopPrompt: "watch CI",
		persistent: true,
	});

	const overlay = openTasks(runtime);
	runtime.input("tab"); // Monitor
	runtime.input("tab"); // Loop
	assert.match(runtime.text(), /watch CI/);
	runtime.input("x");
	assert.match(runtime.text(), /Stop Loop/);
	runtime.input("y");
	await sleep(50);

	const jobs = await runtime.tools.get("cron_list").execute("l", {}, undefined, undefined, runtime.ctx);
	assert.deepEqual(jobs.details.jobs, [], "the loop job is gone");
	const monitors = await runtime.tools.get("monitor_list").execute("l", {}, undefined, undefined, runtime.ctx);
	assert.equal(monitors.details.monitors[0].id, armedMonitor.details.taskId);
	assert.equal(monitors.details.monitors[0].status, "stopped", "the bound Monitor went down with the loop");
	assert.ok(
		runtime.busEvents.some((event) => event.channel === "loop:stopped" && event.data.prompt === "watch CI"),
		"the monitor cascade was announced",
	);
	assert.equal(runtime.state.aborts, 0, "stopping a schedule never aborts the agent");
	assert.equal(runtime.state.waited, 0);

	await assert.rejects(
		() =>
			runtime.tools
				.get("schedule_wakeup")
				.execute("c", { delaySeconds: 600, reason: "late", prompt: "watch CI" }, undefined, undefined, runtime.ctx),
		/was stopped and must not be rescheduled/,
		"a late wakeup cannot resurrect it",
	);

	runtime.input("escape");
	await overlay;
});

test("stopping a Monitor from the overlay uses monitor_stop's lifecycle and notice; ended tasks are disabled", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	runtime.load(monitorMod.default);
	await runtime.start();
	const armed = await armMonitor(runtime, { command: "sleep 30", description: "stoppable", persistent: true });
	const overlay = openTasks(runtime);
	runtime.input("tab"); // Monitor tab
	runtime.input("x");
	runtime.input("y");
	await sleep(30);
	const monitors = await runtime.tools.get("monitor_list").execute("l", {}, undefined, undefined, runtime.ctx);
	assert.equal(monitors.details.monitors[0].status, "stopped");
	assert.ok(
		runtime.sent.some(
			(entry) => entry.kind === "custom" && entry.message?.customType === "Monitor" && entry.message.content.includes("[Monitor stopped]"),
		),
		"the usual terminal notification was sent",
	);
	assert.ok(armed.details.taskId);

	// The ended record stays visible, with the stop action disabled.
	assert.match(runtime.text(), /stoppable/);
	runtime.input("x");
	assert.match(runtime.text(), /nothing to stop/i);
	runtime.input("escape");
	await overlay;
});

test("a durable job another runtime owns is shown as foreign; stopping it removes only the store entry", async (t) => {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-tasks-durable-"));
	const owner = makeRuntime({ cwd: workdir });
	const other = makeRuntime({ cwd: workdir });
	t.after(() => stopAll(owner));
	t.after(() => stopAll(other));

	owner.load(loopMod.default);
	await owner.start();
	const created = await createCron(owner, { cron: "*/5 * * * *", prompt: "durable from A", durable: true });
	assert.equal(created.details.runsHere, true);

	other.load(loopMod.default);
	await other.start();
	const overlay = openTasks(other);
	other.input("tab"); // Monitor
	other.input("tab"); // Loop
	assert.match(other.text(), /foreign/);
	assert.match(other.text(), /durable from A/);
	other.input("enter");
	const detail = other.text();
	assert.match(detail, /foreign \(other session\)/);
	assert.match(detail, /run by another Pi session/);
	assert.doesNotMatch(detail, /run by this session/);
	other.input("x");
	other.input("y");
	await sleep(30);
	const data = JSON.parse(fs.readFileSync(path.join(workdir, ".pi", "scheduled_tasks.json"), "utf8"));
	assert.deepEqual(data.jobs, [], "the durable store entry was cancelled");
	assert.equal(other.state.aborts, 0, "no session's turn was aborted");
	other.input("escape");
	await overlay;
	fs.rmSync(workdir, { recursive: true, force: true });
});

// ------------------------------------------------------- live LoopJob state

test("the detail shows the actual jittered run time, pending/idle and active/rescheduling state", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	const client = runtime.load(loopMod.default);
	await runtime.start();
	const scheduler = loopMod.getScheduler(client.pi);
	assert.ok(scheduler);
	const created = await createCron(runtime, { cron: "*/5 * * * *", prompt: "watch the deploy" });
	const job = scheduler.get(created.details.id);
	const at = job.nextFireAt;
	const date = new Date(at);
	const hour = date.getHours();
	const expectedClock = `${hour % 12 === 0 ? 12 : hour % 12}:${String(date.getMinutes()).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;

	const overlay = openTasks(runtime);
	runtime.input("tab");
	runtime.input("tab");
	runtime.input("enter");
	let detail = runtime.text();
	assert.match(detail, new RegExp(`${at} ms`), "the exact nextFireAt is shown");
	assert.match(detail, new RegExp(expectedClock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the already-jittered time is shown");
	assert.match(detail, /fixed interval \(cron\)/);

	// Due while busy: pending means waiting for idle, not a second tick.
	runtime.state.idle = false;
	job.nextFireAt = Date.now() - 1;
	scheduler.tick();
	assert.equal(job.pending, true);
	await sleep(350);
	runtime.input("escape");
	const list = runtime.text();
	assert.match(list, /pending/);
	assert.match(list, /waiting for idle/);
	runtime.input("enter");
	detail = runtime.text();
	assert.match(detail, /waiting for the agent to go idle/);

	// A self-paced tick that fired but was not rescheduled is active.
	const wake = await runtime.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 600, reason: "waiting for CI", prompt: "watch CI" }, undefined, undefined, runtime.ctx);
	const chain = scheduler.get(wake.details.id);
	runtime.state.idle = true;
	job.pending = false;
	job.nextFireAt = Date.now() + 600_000;
	chain.scheduledFor = Date.now() - 1;
	scheduler.tick();
	assert.equal(chain.awaitingReschedule, true);
	await sleep(350);
	runtime.input("escape"); // back to list
	assert.equal(runtime.state.component.selected().id, created.details.id, "refresh retained the cron selection");
	runtime.input("up"); // the newer wakeup is now the first Loop row
	assert.equal(runtime.state.component.selected().id, wake.details.id);
	runtime.input("enter");
	detail = runtime.text();
	assert.match(detail, /active/);
	assert.match(detail, /waiting for CI/, "the reason is shown");
	assert.match(detail, /Fires\s+1/);

	runtime.input("escape");
	runtime.input("escape");
	await overlay;
});

// ----------------------------------------------------------- logs & widths

test("detail logs are bounded, sanitized tails; missing logs are a note, and reading feeds no event stream", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	runtime.load(monitorMod.default);
	await runtime.start();
	const armed = await armMonitor(runtime, {
		command:
			"printf '\\033[31mRED\\033[0m \\001CLEAR\\n'; printf 'ERR \\033[32mGREEN\\033[0m\\n' >&2; sleep 30",
		description: "noisy log",
		persistent: true,
	});
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.readFileSync(armed.details.outputPath, "utf8").includes("RED") && fs.existsSync(armed.details.stderrPath) && fs.readFileSync(armed.details.stderrPath, "utf8").includes("GREEN")));

	const eventsBefore = runtime.sent.filter((entry) => entry.message?.customType === "Monitor").length;
	const overlay = openTasks(runtime);
	runtime.input("tab");
	runtime.input("enter");
	const detail = detailText(runtime);
	assert.ok(detail.includes("RED"), "visible text survives");
	assert.ok(detail.includes("CLEAR"));
	assert.ok(detail.includes("GREEN"), "stderr is readable too");
	assert.match(detail, /RED CLEAR/, "actual sanitized stdout, not just the command text");
	assert.match(detail, /ERR GREEN/, "actual sanitized stderr tail");
	const clean = tuiPkg.stripTerminalSequences(detail);
	assert.ok(!clean.includes("\x1b"), "no ANSI escape from a log reaches the screen");
	assert.ok(!clean.includes("\x01"), "no control character from a log reaches the screen");
	assert.equal(
		runtime.sent.filter((entry) => entry.message?.customType === "Monitor").length,
		eventsBefore,
		"reading logs did not feed Monitor's event stream",
	);
	const cachedLog = runtime.state.component.logs[0];
	await sleep(1100);
	assert.strictEqual(runtime.state.component.logs[0], cachedLog, "an unchanged file reuses its parsed tail across clock refreshes");

	// Grow the log past the byte cap while the overlay is open. The next
	// throttled refresh keeps only the bounded tail.
	fs.appendFileSync(armed.details.outputPath, `${"A".repeat(20_000)}\nlast line\n`);
	await sleep(1500);
	const bounded = detailText(runtime);
	assert.match(bounded, /last \d+ lines?/, "the tail is labelled with its actual line count");
	assert.ok(bounded.includes("last line"), "the most recent line survives the byte cap");
	assert.ok(!tuiPkg.stripTerminalSequences(bounded).includes("\x1b"));
	assert.notStrictEqual(runtime.state.component.logs[0], cachedLog, "a changed file is parsed again");

	fs.appendFileSync(armed.details.outputPath, `${"B".repeat(300)} FINAL-MARKER\n`);
	await sleep(1100);
	assert.match(detailText(runtime), /FINAL-MARKER/, "width wrapping keeps the end of a long line reachable through scrolling");
	runtime.input("escape");
	runtime.input("escape");
	await overlay;

	// Direct tail unit: byte and line bounds are enforced.
	const big = path.join(runtime.workdir, "big.log");
	fs.writeFileSync(big, `${"x".repeat(10_000)}\n${Array.from({ length: 40 }, (_, i) => `line ${i}\u001b[31m`).join("\n")}\n`);
	const tail = tasksMod.readLogTail(big, 512, 5);
	assert.ok(tail.truncated);
	assert.ok(tail.text.split("\n").length <= 5);
	assert.ok(!tail.text.includes("\x1b"));
	assert.match(tail.note, /last \d+ lines?/);

	// A deleted log is a note, not a crash.
	fs.rmSync(armed.details.outputPath, { force: true });
	const reopened = openTasks(runtime);
	await sleep(1100);
	runtime.input("tab");
	runtime.input("enter");
	assert.match(detailText(runtime), /log not created yet|\(empty\)/);
	runtime.input("escape");
	runtime.input("escape");
	await reopened;
});

test("narrow widths, resize, wide characters, theme invalidation and Esc detail-first all hold", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	runtime.loadBoth(["loop", "monitor"]);
	await runtime.start();
	await armMonitor(runtime, {
		command: "sleep 30",
		description: "\u4e2d\u6587\u65e5\u672c\u8a9e\ud83d\ude80 monitor with a long description",
		persistent: true,
	});
	await createCron(runtime, { cron: "*/5 * * * *", prompt: "\u6bcf5\u5206\u949f\u68c0\u67e5\u4e00\u6b21\u90e8\u7f72" });

	runtime.state.columns = 30;
	runtime.state.rows = 12;
	const narrow = 25;
	const overlay = openTasks(runtime);
	let lines = runtime.render(narrow);
	assert.ok(lines.length > 0);
	for (const line of lines) assert.ok(visibleWidth(line) <= narrow, `line fits ${narrow}: ${JSON.stringify(line)}`);
	assert.match(runtime.text(narrow), /Monitor/);

	// Resize: the component renders to the new width, no stale cache.
	runtime.state.columns = 80;
	runtime.state.rows = 24;
	lines = runtime.render(68);
	for (const line of lines) assert.ok(visibleWidth(line) <= 68);
	runtime.state.component.invalidate();
	lines = runtime.render(68);
	for (const line of lines) assert.ok(visibleWidth(line) <= 68);

	runtime.input("enter");
	assert.match(runtime.text(68), /Task detail|detail/i);
	runtime.input("escape");
	assert.ok(runtime.state.component, "the first Esc closed only the detail");
	runtime.input("escape");
	await overlay;
	assert.equal(runtime.state.component, undefined);
	assert.equal(runtime.state.aborts, 0);
});

test("PageUp and PageDown move by whole pages in both directions at start, middle and end", async (t) => {
	const runtime = makeRuntime({
		keybindings: { "tui.select.pageUp": "u", "tui.select.pageDown": "d" },
	});
	t.after(() => stopAll(runtime));
	runtime.load(loopMod.default);
	await runtime.start();
	let creationTime = Date.now();
	const clock = t.mock.method(Date, "now", () => ++creationTime);
	for (let i = 0; i < 31; i++) {
		await createCron(runtime, { cron: "*/5 * * * *", prompt: `job ${String(i).padStart(2, "0")}` });
	}
	clock.mock.restore();
	const overlay = openTasks(runtime);
	const selected = () => runtime.selectedLine(68);
	assert.match(selected(), /job 30/, "initial selection is the newest row");

	// Start: PageUp cannot go above the first row, PageDown jumps one page.
	runtime.input("u");
	assert.match(selected(), /job 30/);
	runtime.input("d"); // keybinding "d"; the compact card caps the body at 12 rows
	assert.match(selected(), /job 18/, "PageDown advances by one page");
	runtime.input("u"); // keybinding "u"
	assert.match(selected(), /job 30/, "PageUp reverses PageDown instead of moving farther down");

	// Middle: page down then page up returns to the same middle row.
	for (let i = 0; i < 5; i++) runtime.input("down");
	assert.match(selected(), /job 25/);
	runtime.input("d");
	assert.match(selected(), /job 13/);
	runtime.input("u");
	assert.match(selected(), /job 25/);

	// End: PageDown clamps at the last task, PageUp moves back one page.
	runtime.input("u");
	for (let i = 0; i < 3; i++) runtime.input("d");
	assert.match(selected(), /job 00/, "PageDown clamps at the oldest task");
	runtime.input("d");
	assert.match(selected(), /job 00/);
	runtime.input("u");
	assert.match(selected(), /job 12/, "PageUp moves up exactly one page from the end");

	runtime.input("escape");
	await overlay;
});

test("height and width stay bounded to the native overlay budget in every layout", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stopAll(runtime));
	const client = runtime.load(() => {});
	const log = path.join(runtime.workdir, "tall.log");
	fs.writeFileSync(log, `${Array.from({ length: 120 }, (_, i) => `log line ${i}`).join("\n")}\n`);
	const registration = tasksMod.registerTaskProvider(client.pi, {
		id: "monitor",
		label: "Monitor",
		list: () => [{ id: "tall", title: "tall task", state: "running", active: true }],
		detail: () => ({
			rows: Array.from({ length: 40 }, (_, i) => ({ label: `Row ${i}`, value: `value ${i}` })),
			logs: [{ label: "stdout", path: log }],
			note: "many detail lines",
		}),
	});
	const overlay = openTasks(runtime);
	runtime.input("enter");

	for (const width of [100, 42, 16, 5, 4, 1]) {
		for (const height of [36, 18, 10, 9, 6, 3]) {
			runtime.state.columns = width;
			runtime.state.rows = height;
			const allowed = Math.max(1, Math.min(Math.floor(height * 0.9), height - 2));
			const check = (lines, phase) => {
				assert.ok(lines.length <= allowed, `${width}x${height} ${phase}: ${lines.length} lines <= ${allowed}`);
				assert.ok(
					lines.every((line) => visibleWidth(line) <= width),
					`${width}x${height} ${phase}: every line fits width`,
				);
			};
			check(runtime.render(width), "initial");
			runtime.input("pageDown");
			check(runtime.render(width), "page down");
			runtime.input("pageUp");
			check(runtime.render(width), "page up");
		}
	}

	// Focus/Esc stay intact after all the resizes: detail first, then overlay.
	runtime.state.columns = 100;
	runtime.state.rows = 36;
	runtime.render(100);
	runtime.input("escape");
	assert.ok(runtime.state.component, "first Esc returns from detail");
	runtime.input("escape");
	await overlay;
	assert.equal(runtime.state.component, undefined);
	registration.close();
});

// --------------------------------------------------- runtimes and cleanup

test("two SDK-style runtimes do not mix task state or commands, reload creates a fresh registry, and shutdown closes the overlay", async (t) => {
	const a = makeRuntime();
	const b = makeRuntime();
	t.after(() => stopAll(a));
	t.after(() => stopAll(b));
	a.loadBoth(["loop", "monitor"]);
	b.loadBoth(["monitor", "loop"]);
	await a.start();
	await b.start();
	assert.deepEqual(ccTasksCommands(a), ["cc-tasks"]);
	assert.deepEqual(ccTasksCommands(b), ["cc-tasks"]);

	await armMonitor(a, { command: "sleep 30", description: "only in A", persistent: true });
	const overlayA = openTasks(a);
	assert.match(a.text(), /only in A/);
	const overlayB = openTasks(b);
	assert.match(b.text(), /No tasks/);
	a.input("escape");
	await overlayA;

	// A shutdown closes A's open overlay and leaves B alone.
	const overlayA2 = openTasks(a);
	assert.ok(a.state.component);
	await a.shutdown();
	await overlayA2;
	assert.equal(a.state.component, undefined, "shutdown closed the overlay");
	const rendersAfterShutdown = a.state.renders;
	// The old registry is disposed; no stale timer repaints the closed overlay.
	await sleep(350);
	assert.equal(a.state.renders, rendersAfterShutdown);
	assert.match(b.text(), /No tasks/, "B still works");

	// A reload in the same Pi runtime reuses the bus but must register a fresh
	// /cc-tasks: the disposed registry cannot capture the new extension set.
	await a.resetExtensions();
	a.loadBoth(["loop", "monitor"]);
	await a.start();
	assert.deepEqual(ccTasksCommands(a), ["cc-tasks"], "reload has one fresh command");
	const reloadOverlay = openTasks(a);
	assert.match(a.text(), /No tasks/, "old state did not leak into the reloaded runtime");
	a.input("escape");
	await reloadOverlay;

	b.input("escape");
	await overlayB;
});