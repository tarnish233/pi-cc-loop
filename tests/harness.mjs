/**
 * A fake ExtensionAPI + ExtensionContext so pi-cc-loop can be driven in
 * isolation. Shared by the loop test files.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule } from "./helpers.mjs";

export const mod = await loadModule("index.ts");
const factory = mod.default;

export function makeHarness(workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-loop-t-"))) {
	// Every harness gets its own working directory by default so durable state
	// never leaks between test cases.
	process.chdir(workdir);

	const commands = new Map();
	const tools = new Map();
	const renderers = new Map();
	const toolRenderers = [];
	const handlers = new Map();
	const busEvents = [];
	const sent = [];
	const appended = [];
	const notifications = [];
	let widgets = [];
	let registeredToolNames = [];

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
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		sendUserMessage(content, options) {
			sent.push({ kind: "user", content, options });
		},
		sendMessage(message, options) {
			sent.push({ kind: "custom", message, options });
		},
		events: {
			emit(channel, data) {
				busEvents.push({ channel, data });
			},
			on(channel, handler) {
				handlers.set(`bus:${channel}`, handler);
				return () => handlers.delete(`bus:${channel}`);
			},
		},
		getAllTools() {
			return registeredToolNames.map((name) => ({ name }));
		},
	};

	// The agent starts idle; tests flip these to simulate a busy agent.
	const state = { idle: true, pending: false, waited: 0 };

	const ctx = {
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setWidget: (_key, content) => {
				widgets = content ?? [];
			},
			theme: { fg: (_color, text) => text },
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		abort: () => {},
		// Command contexts can wait for the current turn to finish.
		waitForIdle: async () => {
			state.waited += 1;
			state.idle = true;
		},
	};

	const lastState = () =>
		appended.filter((e) => e.customType === "pi-cc-loop-state").pop()?.data ?? { jobs: [] };

	return {
		pi,
		toolRenderers,
		ctx,
		state,
		commands,
		tools,
		renderers,
		handlers,
		sent,
		appended,
		notifications,
		busEvents,
		lastState,
		/** Pretend another extension registered a tool. */
		setRegisteredTools(names) {
			registeredToolNames = names;
		},
		/** The scheduler the extension just created. */
		scheduler: () => mod.getScheduler(),
		get widgets() {
			return widgets;
		},
	};
}

/** Create the extension and run session_start, with the scan loop disabled. */
export async function start(h, event = {}) {
	process.env.PI_LOOP_SCAN_MS = "600000";
	process.env.PI_LOOP_DURABLE_SYNC_MS = "0";
	factory(h.pi);
	// Keep this harness's own scheduler: another harness may be created later.
	const scheduler = mod.getScheduler();
	h.scheduler = () => scheduler;
	await h.handlers.get("session_start")(event, h.ctx);
	return h;
}

/** The persisted state entries, as a later session would read them. */
export function stateEntries(h) {
	return h.appended
		.filter((entry) => entry.customType === "pi-cc-loop-state")
		.map((entry) => ({ type: "custom", customType: entry.customType, data: JSON.parse(JSON.stringify(entry.data)) }));
}

/** Make every job due right now. */
export function makeDue(h, jobId) {
	const job = h.scheduler().get(jobId);
	assert.ok(job, "job exists");
	if (job.kind === "cron") job.nextFireAt = Date.now() - 1;
	else job.scheduledFor = Date.now() - 1;
}

/** The before_agent_start event of a run started by a message the extension sent. */
export function runEvent(sent) {
	return { messageType: "custom", message: sent.message, systemPromptOptions: { promptGuidelines: [] } };
}

export function guidelinesOf(event) {
	return event.systemPromptOptions.promptGuidelines.join("\n");
}

/** Mark a turn as started and finished, the way pi would. */
export async function runTurn(h, { aborted = false, start } = {}) {
	// `start` is the sent message that started the run (a tick, a monitor event).
	if (start) await h.handlers.get("before_agent_start")(runEvent(start), h.ctx);
	await h.handlers.get("agent_start")?.({}, h.ctx);
	await h.handlers.get("agent_end")?.({}, h.ctx);
	await h.handlers.get("agent_settled")({ type: "agent_settled", aborted }, h.ctx);
}

/**
 * Start a self-paced loop the way it now works: `/loop` hands the prompt to
 * the model, the model decides the cadence and calls `schedule_wakeup`, which
 * creates the chain.
 */
export async function startSelfPaced(h, prompt = "check the deploy", delaySeconds = 60) {
	await h.commands.get("loop").handler(prompt, h.ctx);
	await h.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds, prompt }, undefined, undefined, h.ctx);
	// The chain this prompt created (or re-armed), live from the scheduler.
	return h.scheduler().findChain(prompt);
}
