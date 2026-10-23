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
	// Pi runs every handler an extension registered for an event, so more
	// than one can exist (the /pi_cc claim adds a second session_shutdown).
	const handlerLists = new Map();
	const busEvents = [];
	const sent = [];
	const appended = [];
	const notifications = [];
	let widgets = [];
	const statuses = new Map();
	const statusCalls = [];
	let registeredToolNames = [];

	// One slot in `handlers` runs every handler registered for that key, the
	// way Pi dispatches an event to all of a session's extensions.
	function addHandler(key, handler) {
		let list = handlerLists.get(key);
		if (!list) {
			list = [];
			handlerLists.set(key, list);
			handlers.set(key, async (e, ctx) => {
				let last;
				for (const fn of [...list]) last = await fn(e, ctx);
				return last;
			});
		}
		list.push(handler);
		return () => {
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		};
	}

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
			// Keep what before_agent_start returns on the event, the way Pi
			// collects it: the run's rules arrive as a returned message.
			const wrapped =
				event === "before_agent_start"
					? async (e, ctx) => {
							const result = await handler(e, ctx);
							e.result = result;
							return result;
						}
					: handler;
			return addHandler(event, wrapped);
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
				// The real bus dispatches to the listeners (loop repaints the
				// footer from a config event); only recording hid that.
				const list = handlerLists.get(`bus:${channel}`);
				if (list) for (const fn of [...list]) fn(data);
			},
			on(channel, handler) {
				return addHandler(`bus:${channel}`, handler);
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
			setStatus: (key, text) => {
				statusCalls.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
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
		/** Footer status text set through ctx.ui.setStatus. */
		status: (key) => statuses.get(key),
		statusCalls,
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

/** The text of a message the extension sent, whichever lane it used. */
export function textOf(sent) {
	return sent?.content ?? sent?.message?.content ?? "";
}

/** The before_agent_start event of a run started by a message the extension sent. */
export function runEvent(sent) {
	// Our messages are ordinary user messages now; monitor events are not.
	if (sent.kind === "user") return { messageType: "user", prompt: sent.content, systemPromptOptions: { promptGuidelines: [] } };
	return { messageType: "custom", message: sent.message, systemPromptOptions: { promptGuidelines: [] } };
}

/** Create a scheduled job the way the model does, through the cron_create tool. */
export async function createCron(h, args) {
	const result = await h.tools.get("cron_create").execute("c", args, undefined, undefined, h.ctx);
	return { ...result.details, result };
}

/** The rules a run got: the hidden message before_agent_start appended to it. */
export function guidelinesOf(event) {
	const message = event.result?.message;
	return typeof message?.content === "string" ? message.content : "";
}

/** What the run changed in the system prompt; it must stay empty, or the prompt cache breaks. */
export function systemGuidelinesOf(event) {
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
	await h.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds, reason: "waiting for the task", prompt }, undefined, undefined, h.ctx);
	// The chain this prompt created (or re-armed), live from the scheduler.
	return h.scheduler().findChain(prompt);
}
