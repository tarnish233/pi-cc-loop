/**
 * Cross-extension integration test: pi-cc-loop and pi-cc-monitor loaded into
 * one process, sharing one event bus.
 *
 * This is the scenario that used to break: a /loop chain armed a Monitor, the
 * user ran /loop stop, the Monitor kept firing, the agent woke up and called
 * schedule_wakeup again, and the loop came back from the dead.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule, loadModuleFrom, siblingExtensionDir } from "./helpers.mjs";

const loopMod = await loadModule("index.ts");
const monitorMod = await loadModuleFrom(siblingExtensionDir("pi-cc-monitor"), "index.ts");

/** One ExtensionAPI shared by both extensions, with a real event bus. */
function makeSharedPi() {
	const handlers = new Map();
	const bus = new Map();
	const tools = new Map();
	const commands = new Map();
	const sent = [];

	const pi = {
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		registerToolRenderer: () => {},
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry: () => {},
		sendUserMessage: (content, options) => sent.push({ kind: "user", content, options }),
		sendMessage: (message, options) => sent.push({ kind: "custom", message, options }),
		events: {
			emit: (channel, data) => {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on: (channel, handler) => {
				const list = bus.get(channel) ?? [];
				list.push(handler);
				bus.set(channel, list);
				return () => {
					const current = bus.get(channel) ?? [];
					const index = current.indexOf(handler);
					if (index >= 0) current.splice(index, 1);
				};
			},
		},
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
	};

	return { pi, tools, commands, sent, handlers };
}

function makeCtx(workdir) {
	return {
		ui: {
			notify: (message, level) => {},
			setWidget: () => {},
			theme: { fg: (_c, t) => t },
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

test("/loop stop takes the chain's monitor down with it", async () => {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-integ-"));
	process.chdir(workdir);

	const shared = makeSharedPi();
	const { pi, tools, commands } = shared;

	loopMod.default(pi);
	monitorMod.default(pi);

	const ctx = makeCtx(workdir);

	// 1. the model starts a self-paced loop
	const armedLoop = await tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 60, prompt: "每10秒钟打印一次hello world" }, undefined, undefined, ctx);

	// 2. the agent arms a Monitor that belongs to the chain
	const armed = await tools
		.get("Monitor")
		.execute(
			"c",
			{
				command: "while true; do echo hello world; sleep 10; done",
				description: "hello world every 10 seconds",
				loopPrompt: "每10秒钟打印一次hello world",
			},
			undefined,
			undefined,
			ctx,
		);
	assert.ok(armed.details.taskId);

	// 3. the agent schedules the fallback heartbeat
	await tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 60, prompt: "每10秒钟打印一次hello world" }, undefined, undefined, ctx);

	// 4. the user asks to stop, and the model calls cron_delete (as /loop stop does now)
	const sentBeforeStop = shared.sent.length;
	await tools.get("cron_delete").execute("d", { id: armedLoop.details.id }, undefined, undefined, ctx);

	// 5. the monitor that belonged to the chain is stopped too
	const list = await tools.get("monitor_list").execute("c", {}, undefined, undefined, ctx);
	assert.equal(list.details.monitors.length, 1);
	assert.equal(
		list.details.monitors[0].status,
		"stopped",
		"the monitor must go down with the loop, otherwise it keeps waking the agent",
	);

	// 5b. silently: nothing wakes the agent right after the user stopped the loop
	await new Promise((resolve) => setTimeout(resolve, 500));
	const afterStop = shared.sent
		.slice(sentBeforeStop)
		.filter((entry) => entry.message?.customType === "pi-cc-monitor-event");
	assert.deepEqual(
		afterStop.map((entry) => entry.message.content),
		[],
		"the stopped loop's monitor sends no closing notice",
	);

	// 6. a late schedule_wakeup cannot resurrect the chain
	await assert.rejects(
		() =>
			tools
				.get("schedule_wakeup")
				.execute("c", { delaySeconds: 60, prompt: "每10秒钟打印一次hello world" }, undefined, undefined, ctx),
		/was stopped and must not be rescheduled/,
	);

	// 7. and no chain is left behind
	const scheduler = loopMod.getScheduler();
	assert.equal(scheduler.list().length, 0, "no loop job is left");
});
