/**
 * pi-cc-loop — a Claude Code compatible `/loop` for the Pi coding agent.
 *
 *   /loop 5m check the deploy    fixed interval, driven by a 5-field cron
 *   /loop check the deploy       self-paced: the model picks the next delay
 *   /loop 15m | /loop            the loop.md tasks (or the built-in maintenance
 *                                prompt), on a fixed interval or self-paced
 *   /loop stop | status | list   manage the jobs
 *
 * Two mechanisms, same as Claude Code:
 *
 *   fixed interval  a cron job fires on a timer. The scheduler enqueues the
 *                   prompt at low priority, between turns, and coalesces
 *                   missed intervals into a single tick.
 *   self-paced      `schedule_wakeup` lets the model choose the next delay
 *                   (60-3600s). If the model forgets to reschedule, the runtime
 *                   arms one 20 minute keepalive; if it still forgets, the
 *                   chain ends. Esc on one of its turns cancels it.
 *
 * The tools are named after their Claude Code counterparts:
 *   CronCreate -> cron_create, CronDelete -> cron_delete, CronList -> cron_list,
 *   ScheduleWakeup -> schedule_wakeup
 *
 * Module map: schedule.ts (job store, dispatch, run times), cron.ts (cron
 * syntax, intervals, labels), prompts.ts (model-facing text), loopfile.ts
 * (loop.md), durable.ts (.pi/scheduled_tasks.json and its lock), renderers.ts
 * (tool rows, tick message).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPath, loadConfig, saveConfig, syncPiCcExtensionsExcludes, type PiCcConfig } from "./config.ts";
import {
	describeCron,
	humanSchedule,
	intervalToCron,
	isUnreachable,
	parseCron,
	parseEveryClause,
	parseIntervalToken,
} from "./cron.ts";
import { DurableRuntime, type Placement } from "./durable.ts";
import { displayPrompt, isLoopFileSentinel, LoopFileDelivery, type TickMode } from "./loopfile.ts";
import {
	CRON_CREATE_DESCRIPTION,
	CRON_CREATE_SNIPPET,
	CRON_DELETE_DESCRIPTION,
	CRON_DELETE_SNIPPET,
	CRON_LIST_DESCRIPTION,
	CRON_LIST_SNIPPET,
	cronTickGuidelines,
	LOOP_FILE_SENTINEL,
	loopGuidelines,
	missedJobsMessage,
	monitorGuidelines,
	provenance,
	SCHEDULE_WAKEUP_DESCRIPTION,
	scheduledTaskProvenance,
	SCHEDULE_WAKEUP_SNIPPET,
	scheduleRules,
} from "./prompts.ts";
import { formatClock, formatEta, loopToolRenderers, renderTickMessage } from "./renderers.ts";
import {
	DEFAULT_TIMING,
	generateId,
	LoopScheduler,
	nextRunTime,
	storedJob,
	type LoopJob,
	type TimingConfig,
} from "./schedule.ts";
import { truncate } from "./tool-rows.ts";

const STATE_ENTRY = "pi-cc-loop-state";
export const TICK_MESSAGE_TYPE = "pi-cc-loop-tick";
/** pi-cc-monitor's notification type; its details name the loop a monitor belongs to. */
const MONITOR_EVENT_TYPE = "pi-cc-monitor-event";
const WIDGET_KEY = "pi-cc-loop";
/** Footer status key, shared with every other extension's status line. */
const STATUS_KEY = "loop";
const CONFIG_CHANNEL = "pi-cc:config";
/**
 * Tools this package draws as one-line rows, and therefore also asks
 * pi-cc-extensions to leave alone. `cron_create` is not here: Claude Code shows
 * a normal tool call for CronCreate, with its arguments, and that reads better
 * than a summary line.
 */
const LOOP_TOOL_NAMES = ["cron_delete", "cron_list", "schedule_wakeup"];
const ALL_PI_CC_TOOLS = [...LOOP_TOOL_NAMES, "Monitor", "monitor_stop", "monitor_list"];

/**
 * The event channel this extension publishes on when a chain ends. pi-cc-monitor
 * listens to it and stops any monitor that belongs to the chain, the way
 * Claude Code requires ("call ScheduleWakeup with stop: true and TaskStop any
 * Monitor you armed").
 */
const LOOP_STOPPED_CHANNEL = "loop:stopped";

const MAX_JOBS = 50;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
/** A wakeup just under the 5 minute prompt cache lifetime is pulled inside it. */
const DEFAULT_KEEPALIVE_SECONDS = 1200;
const DEFAULT_MAX_AGE_DAYS = 7;
/** How many stopped prompts are remembered (and persisted). */
const MAX_STOPPED_PROMPTS = 20;

interface PersistedState {
	version: 1;
	/** Session-only jobs; durable jobs live in .pi/scheduled_tasks.json. */
	jobs: LoopJob[];
	/** Prompts whose chain was stopped and must not be rescheduled. */
	stopped?: string[];
	/** Whether the status widget is shown. Claude Code has no such widget. */
	widget?: boolean;
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function maxAgeDays(): number {
	return Math.max(0, envNumber("PI_LOOP_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS));
}

function maxAgeMs(): number {
	return maxAgeDays() * 86_400_000;
}

/**
 * Fallback delay used when the model forgot to reschedule a self-paced loop.
 * Set to 0 to disable the fallback: the chain then ends as soon as a turn
 * finishes without a reschedule.
 */
function keepaliveSeconds(): number {
	return Math.max(0, envNumber("PI_LOOP_KEEPALIVE_SECONDS", DEFAULT_KEEPALIVE_SECONDS));
}

/** Claude Code's offsets; `PI_LOOP_JITTER=0` runs jobs exactly on their cron minute. */
function timingConfig(): TimingConfig {
	const fraction = Math.min(1, Math.max(0, envNumber("PI_LOOP_JITTER", DEFAULT_TIMING.recurringFrac)));
	return {
		...DEFAULT_TIMING,
		recurringFrac: fraction,
		oneShotMaxMs: fraction > 0 ? DEFAULT_TIMING.oneShotMaxMs : 0,
	};
}

function durableSyncMs(): number {
	return Math.max(0, envNumber("PI_LOOP_DURABLE_SYNC_MS", 5000));
}

/** Models used to Claude Code may echo the prompt with its `/loop ` prefix. */
function normalizePrompt(prompt: string): string {
	return prompt.trim().replace(/^\/loop\s+/i, "").trim();
}

/** The live scheduler, for tests. */
let activeScheduler: LoopScheduler | null = null;

export function getScheduler(): LoopScheduler | null {
	return activeScheduler;
}

/**
 * Pull the `--durable` and `--max N` flags out of the command line.
 * Flags may appear anywhere; the remaining tokens are the prompt.
 */
function extractFlags(raw: string): { body: string; durable: boolean; maxFires?: number } {
	const tokens = raw.split(/\s+/).filter(Boolean);
	const kept: string[] = [];
	let durable = false;
	let maxFires: number | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.toLowerCase() === "--durable") {
			durable = true;
			continue;
		}
		const inline = /^--max=(\d+)$/i.exec(token);
		if (inline) {
			maxFires = Math.max(1, Number(inline[1]));
			continue;
		}
		if (/^--max$/i.test(token)) {
			const next = tokens[i + 1];
			if (next && /^\d+$/.test(next)) {
				maxFires = Math.max(1, Number(next));
				i++;
			}
			continue;
		}
		kept.push(token);
	}

	return { body: kept.join(" "), durable, maxFires };
}

export default function piCcLoopExtension(pi: ExtensionAPI): void {
	/** Cached context for UI helpers. */
	let lastCtx: ExtensionContext | undefined;
	/**
	 * Prompts whose chain was stopped. A stopped chain must not be resurrected
	 * by a late `schedule_wakeup` call from a turn that a still-running monitor
	 * woke up.
	 */
	const stoppedPrompts = new Set<string>();
	/**
	 * Whether the status widget is shown. Claude Code's main session shows no
	 * loop status at all, so it is off by default; `/loop widget on` turns it on.
	 */
	let widgetEnabled = process.env.PI_LOOP_WIDGET === "1";
	/** Signature of the last persisted state, to avoid redundant session entries. */
	let lastPersistedSignature = "";
	/**
	 * How many times each prompt has been run as a loop tick. The immediate run
	 * of `/loop` and the fires of the job created afterwards share a counter.
	 */
	const tickCounters = new Map<string, number>();
	const loopFile = new LoopFileDelivery();
	let durable: DurableRuntime | undefined;
	/**
	 * What the current run belongs to, derived from its starting message:
	 * `chainId` is the self-paced chain whose tick (or monitor) started it,
	 * `cronId` the fixed-interval job whose tick started it, `armed` the chains
	 * it armed, `tick` the tick number of a /loop run.
	 */
	let currentRun: { chainId?: string; cronId?: string; armed?: Set<string>; tick?: number } = {};

	const scheduler = new LoopScheduler({
		dispatch: (job) => deliverTick(job),
		afterDispatch: (job, finished) => {
			if (job.durable) durable?.afterFire(job, finished);
		},
		onChange: (jobs) => {
			persist(jobs);
			refreshWidget(jobs);
			refreshStatus(jobs);
		},
		canDispatch: () => {
			const ctx = lastCtx;
			if (!ctx) return false;
			try {
				return ctx.isIdle() && !ctx.hasPendingMessages();
			} catch {
				return false;
			}
		},
		timing: timingConfig,
		maxAgeMs,
		onExpire: (job) => {
			const ctx = lastCtx;
			if (ctx) notify(ctx, `loop ${job.id} ran its final time: recurring jobs expire after ${maxAgeDays()} days`);
		},
		onScan: (now) => {
			durable?.maintain(now);
			// The countdown is coarse, so this is a string compare most seconds.
			refreshStatus();
		},
	});
	activeScheduler = scheduler;

	// ---------------------------------------------------------------- helpers

	/** What a job's persisted signature depends on; per-fire bookkeeping is left out. */
	function signatureOf(job: LoopJob): unknown[] {
		if (job.kind === "wakeup") {
			return [job.id, job.kind, job.prompt, job.scheduledFor ?? null, job.keepaliveUsed ?? false, job.chainStartedAt ?? null];
		}
		return [
			job.id,
			job.kind,
			job.cron,
			job.prompt,
			job.recurring,
			job.createdAt,
			job.maxFires ?? null,
			job.maxFires !== undefined ? (job.fireCount ?? 0) : null,
		];
	}

	/**
	 * Save the session's jobs as a session entry. Durable jobs are left out:
	 * they live in .pi/scheduled_tasks.json, and restoring them from a session
	 * would run them twice. A new entry is only written when something that
	 * matters for a restore changed, not on every fire.
	 */
	function persist(jobs: LoopJob[]): void {
		const kept = jobs.filter((job) => !job.durable).map(storedJob);
		const stopped = [...stoppedPrompts];
		const signature = JSON.stringify([kept.map(signatureOf), stopped, widgetEnabled]);
		if (signature === lastPersistedSignature) return;
		lastPersistedSignature = signature;
		try {
			pi.appendEntry(STATE_ENTRY, { version: 1, jobs: kept, stopped, widget: widgetEnabled } satisfies PersistedState);
		} catch {
			// session persistence is best effort
		}
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		} catch {
			// a stale context must never break the loop
		}
	}

	function refreshWidget(jobs: LoopJob[]): void {
		const ctx = lastCtx;
		if (!ctx || !ctx.hasUI) return;
		if (!widgetEnabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		// Absolute times only: the widget is not redrawn every second.
		const lines = jobs.map((job) => {
			const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
			const when = at ? `next ${formatClock(at)}` : job.kind === "wakeup" ? "awaiting reschedule" : "pending";
			const kind = job.kind === "cron" ? `fixed ${job.cron}` : "self-paced";
			return ctx.ui.theme.fg("accent", `loop ${job.id} \u00b7 ${kind} \u00b7 ${when} \u00b7 ${truncate(displayPrompt(job.prompt), 28)}`);
		});
		ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined);
	}

	/**
	 * One line in Pi's footer, the same place other extensions show status.
	 * Claude Code has no loop status in its footer, but the alternative here is
	 * a widget that needs its own row above the editor; a summary is enough for
	 * the common case and `/loop widget on` still gives the detailed view.
	 */
	function statusText(jobs: LoopJob[]): string | undefined {
		if (!jobs.length) return undefined;
		const now = Date.now();
		const next = Math.min(
			...jobs.map((job) => {
				if (job.pending) return now;
				const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
				return at ?? now;
			}),
		);
		return `loop ${jobs.length} \u00b7 next ${formatEta(Math.max(0, next - now))}`;
	}

	let lastStatusText: string | undefined;
	let statusSet = false;

	function refreshStatus(jobs: LoopJob[] = scheduler.list()): void {
		const ctx = lastCtx;
		if (!ctx || !ctx.hasUI) return;
		try {
			// Older Pi versions have no footer status API.
			if (typeof ctx.ui.setStatus !== "function") return;
			const text = loadConfig().footer ? statusText(jobs) : undefined;
			// Every call repaints, even with the same text, so speak only on change.
			if (text === lastStatusText && (text !== undefined || !statusSet)) return;
			lastStatusText = text;
			statusSet = text !== undefined;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// a stale context must never break the loop
		}
	}

	function rememberStopped(prompt: string): void {
		stoppedPrompts.delete(prompt);
		stoppedPrompts.add(prompt);
		while (stoppedPrompts.size > MAX_STOPPED_PROMPTS) {
			const oldest = stoppedPrompts.values().next().value;
			if (oldest === undefined) break;
			stoppedPrompts.delete(oldest);
		}
	}

	/**
	 * End a self-paced chain for good: the job is removed, the prompt is
	 * remembered so a late `schedule_wakeup` cannot resurrect it, and
	 * pi-cc-monitor is told to stop the monitors that belong to it. Without the
	 * last part a monitor that keeps firing wakes the agent, the agent
	 * reschedules, and the loop the user just stopped comes back.
	 */
	function retireChain(chain: LoopJob, reason: string, options: { silent?: boolean } = {}): void {
		rememberStopped(chain.prompt);
		scheduler.remove(chain.id);
		try {
			pi.events.emit(LOOP_STOPPED_CHANNEL, { prompt: chain.prompt, reason });
		} catch {
			// a listener must never break the loop
		}
		const ctx = lastCtx;
		if (ctx && !options.silent) notify(ctx, `loop ${chain.id} ended: ${reason}`, "info");
	}

	function ensureDurable(): DurableRuntime {
		durable ??= createDurable(lastCtx?.cwd ?? process.cwd());
		return durable;
	}

	function createDurable(cwd: string): DurableRuntime {
		return new DurableRuntime({
			cwd,
			scheduler,
			timing: timingConfig,
			maxAgeMs,
			syncMs: durableSyncMs,
			onMissed: reportMissed,
		});
	}

	/** Add a job; a durable job is saved to disk and may run in another session. */
	function addJob(job: LoopJob): Placement {
		if (job.durable) return ensureDurable().add(job);
		scheduler.add(job);
		return { runsHere: true };
	}

	function removeJob(job: LoopJob): void {
		scheduler.remove(job.id);
		if (job.durable) durable?.remove(job.id);
	}

	/** This session's jobs plus the durable jobs it can see but does not run. */
	function listJobs(): Array<LoopJob & { foreignReason?: "other-session" | "other-folder" }> {
		return [...scheduler.list(), ...(durable?.foreignJobs() ?? [])];
	}

	function foreignNote(job: { foreignReason?: string }): string {
		if (job.foreignReason === "other-folder") return "  (copied from another folder: listed, not run here)";
		if (job.foreignReason === "other-session") return "  (run by another Pi session in this project)";
		return "";
	}

	/** Durable one-shots that came due while no session ran them: ask before running. */
	function reportMissed(jobs: LoopJob[]): void {
		const lines = jobs.map((job) => {
			const due = nextRunTime(job, job.createdAt, timingConfig());
			const when = due
				? ` (was due ${new Date(due).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`
				: "";
			return `- job ${job.id}${when}: ${displayPrompt(job.prompt)}`;
		});
		try {
			// Attached to the next turn rather than starting one at startup.
			pi.sendMessage(
				{
					customType: TICK_MESSAGE_TYPE,
					content: missedJobsMessage(lines),
					display: true,
					details: { missed: true, jobIds: jobs.map((job) => job.id) },
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// best effort
		}
		const ctx = lastCtx;
		if (ctx) {
			notify(
				ctx,
				`${jobs.length} durable one-shot job${jobs.length === 1 ? " was" : "s were"} missed while Pi was closed; you will be asked before ${jobs.length === 1 ? "it runs" : "they run"}`,
				"warning",
			);
		}
	}

	/** The text the model gets for a prompt: the loop.md sentinel expands at fire time. */
	function resolvePrompt(prompt: string, mode: TickMode): string {
		return isLoopFileSentinel(prompt) ? loopFile.resolve(lastCtx?.cwd ?? process.cwd(), mode) : prompt;
	}

	/**
	 * Deliver a scheduled tick. `followUp` is the low-priority lane: Claude
	 * Code's "A scheduled prompt fires between your turns, not while Claude is
	 * mid-response."
	 */
	function deliverTick(job: LoopJob): void {
		const tick = Math.max(tickCounters.get(job.prompt) ?? 0, job.tickCount ?? 0) + 1;
		tickCounters.set(job.prompt, tick);
		job.tickCount = tick;
		const body = resolvePrompt(job.prompt, job.kind === "cron" ? "cron" : "wakeup");
		// before_agent_start finds the job through `details.jobId` and gives a
		// self-paced tick its chain guidelines. A fixed-interval tick also says,
		// right here, that it fires its own next tick.
		const stamp =
			job.kind === "cron"
				? scheduledTaskProvenance(job.id, humanSchedule(job.cron ?? "* * * * *"))
				: provenance(tick);
		pi.sendMessage(
			{
				customType: TICK_MESSAGE_TYPE,
				content: `${stamp}\n${body}`,
				display: true,
				details: { jobId: job.id, kind: job.kind, tickCount: tick, cron: job.cron, scheduledAt: Date.now() },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		if (job.maxFires !== undefined && (job.fireCount ?? 0) >= job.maxFires) {
			const ctx = lastCtx;
			if (ctx) notify(ctx, `loop ${job.id} reached its cap of ${job.maxFires} fires`, "info");
		}
	}

	/**
	 * Run the prompt right away, the way Claude Code's skill does ("Then
	 * immediately execute the parsed prompt now").
	 *
	 * `guidelines` are the instructions for this one run. They travel on the
	 * message (`details` never reaches the model) and before_agent_start adds
	 * them to the run the message starts, so they cannot leak into another run.
	 * The caller waits until the agent is idle, so the message starts its own run.
	 */
	function runNow(ctx: ExtensionContext, prompt: string, job: LoopJob | undefined, guidelines: string[]): void {
		const tick = (tickCounters.get(prompt) ?? 0) + 1;
		tickCounters.set(prompt, tick);
		if (job && scheduler.get(job.id)) {
			scheduler.update(job.id, { tickCount: tick, fireCount: (job.fireCount ?? 0) + 1, lastFiredAt: Date.now() });
		}
		const body = resolvePrompt(prompt, job?.kind === "cron" ? "cron" : "wakeup");
		const stamp =
			job?.kind === "cron"
				? scheduledTaskProvenance(job.id, humanSchedule(job.cron ?? "* * * * *"))
				: provenance(tick);
		pi.sendMessage(
			{
				customType: TICK_MESSAGE_TYPE,
				content: `${stamp}\n${body}`,
				display: true,
				details: {
					jobId: job?.id,
					kind: job?.kind,
					tickCount: tick,
					immediate: true,
					scheduledAt: Date.now(),
					guidelines,
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		lastCtx = ctx;
	}

	/** True when the pi-cc-monitor extension registered its Monitor tool. */
	function monitorToolAvailable(): boolean {
		try {
			return pi.getAllTools().some((tool) => tool.name === "Monitor");
		} catch {
			return false;
		}
	}

	/** The tool names to exclude from pi-cc-extensions' global styling. */
	function piCcToolNames(): string[] {
		return monitorToolAvailable() ? ALL_PI_CC_TOOLS : LOOP_TOOL_NAMES;
	}

	/**
	 * A run finished without an abort: self-paced chains whose tick the model
	 * did not reschedule get their one keepalive, or end.
	 */
	function settleChains(ctx: ExtensionContext): void {
		const now = Date.now();
		for (const chain of scheduler.byKind("wakeup")) {
			// The keepalive turn is the model's last chance to reschedule.
			if (chain.keepaliveTurn) {
				retireChain(chain, "keepalive budget exhausted (the model did not reschedule twice)");
				continue;
			}
			if (!chain.awaitingReschedule) continue;

			const limit = maxAgeMs();
			if (limit > 0 && now - (chain.chainStartedAt ?? chain.createdAt) >= limit) {
				retireChain(chain, `reached its ${maxAgeDays()}-day limit`);
				continue;
			}
			if (chain.keepaliveUsed) continue;

			const fallback = keepaliveSeconds();
			if (fallback <= 0) {
				retireChain(chain, "the model did not reschedule (keepalive disabled)");
				continue;
			}
			scheduler.update(chain.id, {
				scheduledFor: now + fallback * 1000,
				keepaliveUsed: true,
				awaitingReschedule: false,
			});
			notify(
				ctx,
				`loop ${chain.id}: the model did not reschedule \u2014 keepalive armed (${Math.round(fallback / 60)} min)`,
				"warning",
			);
		}
	}

	/**
	 * Esc interrupted a turn that belongs to a self-paced loop (its tick, the
	 * /loop run that armed it, or a turn its monitor woke): cancel that loop,
	 * with Claude Code's notice ("A `Pending wakeup cancelled` notice confirms
	 * that the loop won't fire again").
	 *
	 * Claude Code cancels every self-paced loop on any Esc, idle or not. Here
	 * an interrupted unrelated turn leaves the loops alone; `/loop stop` stops
	 * them. Fixed-interval jobs keep running either way, as in Claude Code.
	 */
	function cancelCurrentLoop(ctx: ExtensionContext): void {
		const ids = new Set([...(currentRun.chainId ? [currentRun.chainId] : []), ...(currentRun.armed ?? [])]);
		const chains = [...ids]
			.map((id) => scheduler.get(id))
			.filter((chain): chain is LoopJob => chain?.kind === "wakeup");
		if (!chains.length) return;
		for (const chain of chains) retireChain(chain, "pending wakeup cancelled (Esc)", { silent: true });
		notify(ctx, `Pending wakeup cancelled \u00b7 loop ${chains.map((chain) => chain.id).join(", ")} ended`, "info");
	}

	// ---------------------------------------------------------------- command

	pi.registerCommand("loop", {
		description:
			"Run a prompt repeatedly. Usage: /loop [interval] <prompt> | /loop <prompt> | /loop [interval] | /loop stop [id] | /loop status | /loop settings",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const raw = args.trim();

			const [head, ...rest] = raw.split(/\s+/);
			switch ((head ?? "").toLowerCase()) {
				case "stop":
					await stopLoops(ctx, rest.join(" "));
					return;
				case "status":
				case "list":
				case "jobs":
					showStatus(ctx);
					return;
				case "widget": {
					const arg = (rest[0] ?? "").toLowerCase();
					if (arg !== "on" && arg !== "off") {
						notify(ctx, `Usage: /loop widget on|off (currently ${widgetEnabled ? "on" : "off"})`, "info");
						return;
					}
					widgetEnabled = arg === "on";
					persist(scheduler.list());
					refreshWidget(scheduler.list());
					notify(ctx, `Loop status widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "footer":
				case "statusline": {
					const arg = (rest[0] ?? "").toLowerCase();
					if (!arg) {
						notify(ctx, `Usage: /loop footer on|off (currently ${loadConfig().footer ? "on" : "off"})`, "info");
						return;
					}
					setSetting(ctx, "footer", arg);
					return;
				}
				case "settings":
				case "config": {
					const [key, value] = rest;
					if (!key) {
						showSettings(ctx);
						return;
					}
					const name = key.toLowerCase();
					if (name === "messages" || name === "message") {
						setSetting(ctx, "messages", value);
						return;
					}
					if (name === "tools" || name === "tool" || name === "rows") {
						setSetting(ctx, "tools", value);
						return;
					}
					if (name === "footer" || name === "status") {
						setSetting(ctx, "footer", value);
						return;
					}
					notify(ctx, "Usage: /loop settings [messages|tools|footer] [on|off]", "info");
					return;
				}
				case "help":
				case "--help":
				case "-h":
					showHelp(ctx);
					return;
				default:
					break;
			}

			// Flags are stripped before parsing so they never interfere with the
			// interval token.
			const flags = extractFlags(raw);
			const body = flags.body;

			let intervalSeconds: number | null = null;
			let prompt = body;

			const intervalOnly = parseIntervalToken(body);
			if (intervalOnly !== null) {
				// "/loop 15m": the loop.md tasks (or maintenance) on a fixed schedule.
				intervalSeconds = intervalOnly;
				prompt = "";
			} else {
				// Rule 1: leading interval token, e.g. "5m check the deploy"
				const leading = /^(\S+)\s+([\s\S]+)$/.exec(body);
				if (leading) {
					const parsed = parseIntervalToken(leading[1]);
					if (parsed !== null) {
						intervalSeconds = parsed;
						prompt = leading[2].trim();
					}
				}
				// Rule 2: trailing "every N units", e.g. "check the deploy every 20m"
				if (intervalSeconds === null) {
					const every = parseEveryClause(body);
					if (every) {
						intervalSeconds = every.interval;
						prompt = every.prompt;
					}
				}
			}

			// Rule 3: no interval -> the model decides (self-paced unless it asks for one)
			await startLoop(ctx, intervalSeconds, prompt, flags.durable, flags.maxFires);
		},
	});

	async function startLoop(
		ctx: ExtensionCommandContext,
		intervalSeconds: number | null,
		prompt: string,
		durableFlag: boolean,
		maxFires: number | undefined,
	): Promise<void> {
		// Claude Code queues a /loop typed while it is busy. Wait for the current
		// turn rather than steering into it: the immediate run has to start its
		// own turn, or its instructions would never reach the model.
		if (!ctx.isIdle()) {
			notify(ctx, "/loop starts when the current turn finishes", "info");
			await ctx.waitForIdle();
		}

		// Without a prompt the loop runs the loop.md tasks, resolved at each fire.
		const finalPrompt = prompt || LOOP_FILE_SENTINEL;
		// Starting a chain again clears the stop marker: the user asked for it.
		stoppedPrompts.delete(finalPrompt);
		// A new loop starts by sending the full task list again.
		if (isLoopFileSentinel(finalPrompt)) loopFile.reset();

		if (intervalSeconds === null) {
			let guidelines: string[];
			if (!prompt) {
				// A bare /loop is self-paced, like Claude Code's.
				guidelines = [loopGuidelines(finalPrompt)];
				if (monitorToolAvailable()) guidelines.push(monitorGuidelines(finalPrompt));
			} else {
				// The interval could not be parsed from the command line. Claude
				// Code's /loop is a skill, so the model reads the input and works
				// the schedule out itself; the rules below let it do the same here.
				let rules = scheduleRules(finalPrompt);
				if (durableFlag) {
					rules += "\n- The user asked for the job to survive a restart: create it with `durable: true`.";
				}
				if (maxFires !== undefined) {
					rules += `\n- The user asked for the job to stop after ${maxFires} fires: create it with \`maxFires: ${maxFires}\`.`;
				}
				guidelines = [rules];
				if (monitorToolAvailable()) {
					guidelines.push(`If you choose the open-ended mode:\n${monitorGuidelines(finalPrompt)}`);
				}
			}
			runNow(ctx, finalPrompt, undefined, guidelines);
			return;
		}

		const spec = intervalToCron(intervalSeconds);
		if (!spec || !parseCron(spec.cron)) {
			notify(ctx, `Invalid interval: ${intervalSeconds}s`, "error");
			return;
		}
		if (scheduler.size >= MAX_JOBS) {
			notify(ctx, `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`, "error");
			return;
		}

		const job: LoopJob = {
			id: generateId(),
			kind: "cron",
			cron: spec.cron,
			prompt: finalPrompt,
			recurring: true,
			createdAt: Date.now(),
			durable: durableFlag,
			maxFires,
			label: humanSchedule(spec.cron),
			source: "loop_command",
		};
		let placement: Placement;
		try {
			placement = addJob(job);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
			return;
		}
		const nextAt = job.nextFireAt ?? nextRunTime(job, job.createdAt, timingConfig()) ?? undefined;

		const days = maxAgeDays();
		notify(
			ctx,
			`Scheduled ${job.id} (${job.label}, next run ${formatClock(nextAt)}) \u00b7 ${spec.cron} \u00b7 expires in ${days}d \u00b7 cancel with /loop stop ${job.id}` +
				(spec.note ? ` \u00b7 ${spec.note}` : "") +
				(placement.runsHere ? "" : ` \u00b7 runs in the Pi session holding the project lock (pid ${placement.holderPid ?? "?"})`),
			"info",
		);
		// Claude Code's /loop skill has a fixed-interval mode whose instructions
		// never mention ScheduleWakeup: create the job, confirm, run the prompt
		// now. Saying it here keeps the model from reading the self-paced habit
		// into the loop's first run.
		const note =
			`A recurring /loop job was created: id ${job.id}, cron \`${spec.cron}\` (${spec.human}), ` +
			`next run ${formatClock(nextAt)}, auto-expires after ${days} days (it runs one final time, then it is deleted). ` +
			`The job lives in this session only unless the user asked for a durable one. ` +
			`The user cancels it with \`/loop stop ${job.id}\`. ` +
			`The schedule fires every tick by itself: do not call \`schedule_wakeup\` for this loop, now or on a later tick.` +
			(spec.note ? ` The requested interval was adjusted: ${spec.note}.` : "");

		runNow(ctx, finalPrompt, job, [note]);
	}

	async function stopLoops(ctx: ExtensionContext, target: string): Promise<void> {
		if (target) {
			const job = scheduler.get(target);
			if (job) {
				if (job.kind === "wakeup") {
					retireChain(job, "stopped by the user");
				} else {
					removeJob(job);
					notify(ctx, `Cancelled loop ${target}`, "info");
				}
				return;
			}
			if (durable?.remove(target)) {
				notify(ctx, `Cancelled durable job ${target}`, "info");
				return;
			}
			notify(ctx, `No loop with id ${target}`, "warning");
			return;
		}
		const jobs = scheduler.list();
		if (!jobs.length) {
			notify(ctx, "No active loops", "info");
			return;
		}
		for (const job of jobs) {
			// Retiring also tells pi-cc-monitor to stop the chain's monitors.
			if (job.kind === "wakeup") retireChain(job, "stopped by the user");
			else removeJob(job);
		}
		notify(ctx, `Cancelled ${jobs.length} loop${jobs.length === 1 ? "" : "s"}`, "info");
	}

	function showStatus(ctx: ExtensionContext): void {
		const jobs = listJobs();
		if (!jobs.length) {
			notify(ctx, "No active loops", "info");
			return;
		}
		const lines = jobs.map((job) => {
			const prompt = truncate(displayPrompt(job.prompt), 60);
			if (job.kind === "cron") {
				const cap = job.maxFires !== undefined ? ` \u00b7 ${job.fireCount ?? 0}/${job.maxFires} fires` : "";
				const label = job.label ?? describeCron(job.cron ?? "");
				return `${job.id}  cron  ${job.cron}  (${label})  next ${formatClock(job.nextFireAt)}${cap}${job.durable ? "  durable" : ""}${foreignNote(job)}  ${prompt}`;
			}
			const at = job.scheduledFor;
			const when = at && at > Date.now() ? `next ${formatClock(at)}` : "awaiting reschedule";
			return `${job.id}  self-paced  ${when}  ${prompt}`;
		});
		notify(ctx, lines.join("\n"), "info");
	}

	function showHelp(ctx: ExtensionContext): void {
		const help = [
			"/loop [interval] <prompt>   run <prompt> every <interval> (e.g. 30s, 5m, 2h, 1d)",
			"/loop <prompt>              self-paced: the agent picks the next delay",
			"/loop [interval]            the .pi/loop.md tasks, or the built-in maintenance prompt",
			"/loop stop [id]             cancel one loop, or all of them",
			"/loop status                list the active loops",
			"/loop widget on|off         show or hide the detailed panel above the editor",
			"/loop footer on|off         show or hide the one-line summary in the footer",
			"/loop settings              show UI settings",
			"/loop settings messages on|off   compact two-line markers",
			"/loop settings tools on|off      one-line tool results",
			"",
			"Esc on a self-paced loop's own turn cancels that loop; fixed-interval loops keep running.",
			"Flags: --durable  write the job to .pi/scheduled_tasks.json so it survives a restart.",
			"       --max N   stop the loop after N fires.",
		].join("\n");
		notify(ctx, help, "info");
	}

	function showSettings(ctx: ExtensionContext): void {
		const config = loadConfig();
		const lines = [
			`pi-cc settings \u00b7 ${configPath()}`,
			`  messages:  ${config.compactMessages ? "compact" : "card"}`,
			`  tool rows: ${config.compactToolRows ? "compact" : "default"}`,
			`  footer:    ${config.footer ? "summary" : "hidden"}`,
			"",
			"Usage: /loop settings messages on|off",
			"       /loop settings tools on|off",
			"       /loop settings footer on|off",
		];
		notify(ctx, lines.join("\n"), "info");
	}

	function setSetting(ctx: ExtensionContext, key: "messages" | "tools" | "footer", raw: string | undefined): void {
		const value = (raw ?? "").toLowerCase();
		const on = value === "on" || value === "true" || value === "1";
		const off = value === "off" || value === "false" || value === "0";
		if (!on && !off) {
			showSettings(ctx);
			return;
		}
		const patch: Partial<PiCcConfig> =
			key === "messages" ? { compactMessages: on } : key === "tools" ? { compactToolRows: on } : { footer: on };
		const next = saveConfig(patch);
		let compatChanged = false;
		if (key === "tools") {
			compatChanged = syncPiCcExtensionsExcludes(piCcToolNames(), on);
		}
		try {
			pi.events.emit(CONFIG_CHANNEL, next);
		} catch {
			// another extension must not break the command
		}
		const label = key === "messages" ? "Compact message style" : key === "tools" ? "Compact tool rows" : "Footer summary";
		notify(ctx, `${label} ${on ? "enabled" : "disabled"}`, "info");
		if (key === "footer") refreshStatus();
		if (compatChanged) {
			notify(ctx, "pi-cc-extensions excludeRenderers updated \u00b7 /reload to apply", "info");
		}
	}

	// ------------------------------------------------------------------ tools

	pi.registerTool({
		name: "cron_create",
		// Claude Code's tool names: the row reads "CronCreate(*/5 * * * *: ...)".
		label: "CronCreate",
		description: CRON_CREATE_DESCRIPTION,
		promptSnippet: CRON_CREATE_SNIPPET,
		parameters: Type.Object({
			cron: Type.String({
				description:
					'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes).',
			}),
			prompt: Type.String({ description: "The prompt to enqueue at each fire time." }),
			recurring: Type.Optional(
				Type.Boolean({
					description:
						"true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete.",
				}),
			),
			durable: Type.Optional(
				Type.Boolean({
					description:
						"true = persist to .pi/scheduled_tasks.json and survive restarts. false (default) = this session only. Use true only when the user asks the task to survive across sessions.",
				}),
			),
			maxFires: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Stop the job after this many fires. Claude Code has no such cap; it is an addition here.",
				}),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!parseCron(params.cron)) {
				throw new Error(`Invalid cron expression '${params.cron}'. Expected 5 fields: M H DoM Mon DoW.`);
			}
			if (isUnreachable(params.cron)) {
				throw new Error(`Cron expression '${params.cron}' does not match any date within the next year.`);
			}
			if (scheduler.size >= MAX_JOBS) {
				throw new Error(`Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`);
			}
			if (!params.prompt?.trim()) {
				throw new Error("prompt must not be empty.");
			}

			const recurring = params.recurring ?? true;
			const job: LoopJob = {
				id: generateId(),
				kind: "cron",
				cron: params.cron.trim(),
				prompt: params.prompt,
				recurring,
				createdAt: Date.now(),
				durable: params.durable ?? false,
				maxFires: params.maxFires,
				// Continue the tick numbering of the /loop run that led here.
				tickCount: tickCounters.get(params.prompt) ?? currentRun.tick ?? 0,
				label: humanSchedule(params.cron),
				source: "cron_create",
			};
			const placement = addJob(job);
			const nextAt = job.nextFireAt ?? nextRunTime(job, job.createdAt, timingConfig()) ?? undefined;

			const lines = [`Scheduled ${job.id} (${job.label}, next run ${formatClock(nextAt)})`];
			if (job.durable) {
				lines.push(
					placement.runsHere
						? "Durable: saved to .pi/scheduled_tasks.json, survives restarts."
						: `Durable: saved to .pi/scheduled_tasks.json. Another Pi session in this project (pid ${placement.holderPid ?? "?"}) holds the scheduler lock and runs it.`,
				);
			} else {
				lines.push("Session-only: restored if this session is resumed, gone otherwise.");
			}
			if (recurring) {
				lines.push(`Recurring jobs auto-expire after ${maxAgeDays()} days: the job runs one final time, then it is deleted.`);
			}
			lines.push(`Cancel it with cron_delete { "id": "${job.id}" }.`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					id: job.id,
					cron: job.cron,
					recurring: job.recurring,
					durable: job.durable,
					nextFireAt: nextAt,
					prompt: job.prompt,
					runsHere: placement.runsHere,
				},
			};
		},
	});

	pi.registerTool({
		name: "cron_delete",
		label: "CronDelete",
		description: CRON_DELETE_DESCRIPTION,
		promptSnippet: CRON_DELETE_SNIPPET,
		parameters: Type.Object({
			id: Type.String({ description: "The job id returned by cron_create, or the id of a self-paced loop." }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const job = scheduler.get(params.id);
			if (job) {
				// A self-paced chain ends the same way /loop stop ends it.
				if (job.kind === "wakeup") retireChain(job, "cancelled with cron_delete");
				else removeJob(job);
			} else if (!durable?.remove(params.id)) {
				return {
					content: [{ type: "text" as const, text: `No scheduled job with id ${params.id}.` }],
					details: { cancelled: false, id: params.id },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Cancelled job ${params.id}.` }],
				details: { cancelled: true, id: params.id },
			};
		},
	});

	pi.registerTool({
		name: "cron_list",
		label: "CronList",
		description: CRON_LIST_DESCRIPTION,
		promptSnippet: CRON_LIST_SNIPPET,
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const jobs = listJobs();
			if (!jobs.length) {
				return {
					content: [{ type: "text" as const, text: "No scheduled jobs." }],
					details: { jobs: [] },
				};
			}
			const text = jobs
				.map((job) => {
					const prompt = truncate(displayPrompt(job.prompt), 80);
					if (job.kind === "cron") {
						return `${job.id}  cron ${job.cron}  ${humanSchedule(job.cron ?? "")}  recurring=${job.recurring}  next ${formatClock(job.nextFireAt)}${job.durable ? "  durable" : ""}${foreignNote(job)}  ${prompt}`;
					}
					return `${job.id}  self-paced  next ${job.scheduledFor ? formatClock(job.scheduledFor) : "unscheduled"}  ${prompt}`;
				})
				.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { jobs: jobs.map((job) => storedJob(job)) },
			};
		},
	});

	pi.registerTool({
		name: "schedule_wakeup",
		label: "ScheduleWakeup",
		description: SCHEDULE_WAKEUP_DESCRIPTION,
		promptSnippet: SCHEDULE_WAKEUP_SNIPPET,
		parameters: Type.Object({
			delaySeconds: Type.Optional(
				Type.Number({
					description: "Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless stop is true.",
				}),
			),
			reason: Type.Optional(
				Type.String({ description: "One short sentence explaining the chosen delay. Shown to the user." }),
			),
			prompt: Type.Optional(
				Type.String({
					description: `The /loop input to fire on wake-up, verbatim, so the next firing repeats the task. For a bare /loop pass the literal sentinel "${LOOP_FILE_SENTINEL}".`,
				}),
			),
			stop: Type.Optional(
				Type.Boolean({
					description: "Set to true to end the self-paced loop immediately. Omit every other field.",
				}),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;

			if (params.stop === true) {
				// Stop the loop this turn belongs to; otherwise the named one, or all.
				const current = currentRun.chainId ? scheduler.get(currentRun.chainId) : undefined;
				const named = params.prompt ? scheduler.findChain(normalizePrompt(params.prompt)) : undefined;
				const chains = current ? [current] : named ? [named] : scheduler.byKind("wakeup");
				for (const chain of chains) retireChain(chain, "stopped by the agent");
				return {
					content: [
						{
							type: "text" as const,
							text: chains.length
								? `Loop ended. ${chains.length} pending wakeup(s) cancelled.`
								: "Loop ended. Nothing was pending.",
						},
					],
					details: { stopped: true, cancelledWakeups: chains.length },
				};
			}

			if (typeof params.delaySeconds !== "number" || Number.isNaN(params.delaySeconds)) {
				throw new Error("delaySeconds is required unless stop is true.");
			}
			const prompt = params.prompt ? normalizePrompt(params.prompt) : "";
			if (!prompt) {
				throw new Error("prompt is required unless stop is true.");
			}

			if (currentRun.cronId) {
				// Not an error: the request is already satisfied by the schedule.
				// Returning it as a result (instead of throwing) keeps the transcript
				// calm and tells the model nothing is missing.
				const cronJob = scheduler.get(currentRun.cronId);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`No wakeup needed: this tick belongs to the fixed-interval /loop ${currentRun.cronId}` +
								`${cronJob?.cron ? ` (${humanSchedule(cronJob.cron)})` : ""}, which fires its own next tick. ` +
								`Nothing was scheduled. To end the loop, call cron_delete with id ${currentRun.cronId}.`,
						},
					],
					details: { suppressed: "fixed-interval", id: currentRun.cronId, stopped: false },
				};
			}

			// Claude Code rounds and clamps; only a change after rounding counts as clamped.
			const requested = params.delaySeconds;
			const rounded = Number.isFinite(requested) ? Math.round(requested) : requested > 0 ? MAX_DELAY_SECONDS : MIN_DELAY_SECONDS;
			let delay = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, rounded));
			const wasClamped = !Number.isFinite(requested) || delay !== rounded;

			const now = Date.now();
			// A tick of a chain re-arms that chain even if the model reworded the prompt.
			let chain =
				scheduler.findChain(prompt) ?? (currentRun.chainId ? scheduler.get(currentRun.chainId) : undefined);
			if (chain) {
				const limit = maxAgeMs();
				if (limit > 0 && now - (chain.chainStartedAt ?? chain.createdAt) >= limit) {
					retireChain(chain, `reached its ${maxAgeDays()}-day limit`);
					return {
						content: [
							{
								type: "text" as const,
								text:
									`The /loop has reached its ${maxAgeDays()}-day limit and has ended. Do not reschedule it; ` +
									"tell the user they can start a new /loop.",
							},
						],
						details: { stopped: true, agedOut: true, id: chain.id, cancelledWakeups: 1 },
					};
				}
			} else {
				if (stoppedPrompts.has(prompt)) {
					throw new Error(
						`The /loop chain for "${prompt}" was stopped and must not be rescheduled. ` +
							"Do not call schedule_wakeup for it again. If the work should continue, ask the user to start a new /loop.",
					);
				}
				chain = {
					id: generateId(),
					kind: "wakeup",
					prompt,
					recurring: false,
					createdAt: now,
					chainStartedAt: now,
					durable: false,
					tickCount: tickCounters.get(prompt) ?? currentRun.tick ?? 0,
					source: "schedule_wakeup",
				};
				addJob(chain);
			}

			// The run that arms a chain belongs to it: Esc in this run cancels it.
			(currentRun.armed ??= new Set()).add(chain.id);
			const scheduledFor = now + delay * 1000;
			scheduler.update(chain.id, {
				scheduledFor,
				keepaliveUsed: false,
				keepaliveTurn: false,
				awaitingReschedule: false,
				reason: params.reason,
			});

			const note = wasClamped ? ` (clamped from ${requested}s)` : "";
			return {
				content: [{ type: "text" as const, text: `Next iteration scheduled in ${delay}s${note} for loop ${chain.id}.` }],
				details: {
					id: chain.id,
					scheduledFor,
					clampedDelaySeconds: delay,
					wasClamped,
					stopped: false,
				},
				// Claude Code ends the turn when ScheduleWakeup returns (on models
				// that support it); the guidelines ask for the update first. Pi only
				// ends the turn when every tool in the batch agrees.
				terminate: true,
			};
		},
	});

	// ---------------------------------------------------------------- rendering

	if (typeof pi.registerToolRenderer === "function") {
		const renderers = loopToolRenderers();
		// The resolver runs every time a row renders, so the setting applies
		// without re-registering anything.
		pi.registerToolRenderer((toolName, next) => {
			if (!loadConfig().compactToolRows) return next();
			return renderers[toolName] ?? next();
		});
	}

	pi.registerMessageRenderer(TICK_MESSAGE_TYPE, renderTickMessage);

	// ----------------------------------------------------------------- events

	/**
	 * Give a run the instructions of the loop message that started it, and
	 * remember which chain (if any) the run belongs to.
	 *
	 * A monitor event does not touch the chain: like Claude Code, the pending
	 * wakeup stays armed as the fallback heartbeat, and the model re-arms it if
	 * it wants a different time.
	 */
	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		currentRun = {};
		if (event.messageType !== "custom") return;

		if (event.message.customType === MONITOR_EVENT_TYPE) {
			// A monitor bound to a loop woke the agent: the run belongs to that loop.
			const loopPrompt = (event.message.details as { loopPrompt?: unknown } | undefined)?.loopPrompt;
			const chain = typeof loopPrompt === "string" ? scheduler.findChain(loopPrompt) : undefined;
			if (chain) currentRun.chainId = chain.id;
			return;
		}
		if (event.message.customType !== TICK_MESSAGE_TYPE) return;

		const details = (event.message.details ?? {}) as {
			jobId?: string;
			guidelines?: unknown;
			immediate?: boolean;
			tickCount?: number;
		};
		const notes = Array.isArray(details.guidelines)
			? details.guidelines.filter((note): note is string => typeof note === "string")
			: [];
		if (details.immediate && typeof details.tickCount === "number") currentRun.tick = details.tickCount;

		const job = details.jobId ? scheduler.get(details.jobId) : undefined;
		if (job?.kind === "wakeup") {
			// A self-paced tick has to schedule the next iteration.
			currentRun.chainId = job.id;
			notes.push(loopGuidelines(job.prompt));
			// Only mention the Monitor tool when it is actually installed.
			if (monitorToolAvailable()) notes.push(monitorGuidelines(job.prompt));
		} else if (job?.kind === "cron") {
			// A fixed interval fires its own next tick; this run must not arm one.
			currentRun.cronId = job.id;
			notes.push(cronTickGuidelines(job.id, humanSchedule(job.cron ?? "* * * * *")));
		}

		if (!notes.length) return;
		const options = event.systemPromptOptions;
		options.promptGuidelines = [...(options.promptGuidelines ?? []), ...notes];
	});

	/**
	 * The run is over and Pi will not continue on its own. Esc on a loop's own
	 * turn cancels that loop; chains whose tick was not rescheduled get their
	 * keepalive. Then a pending tick may go out.
	 */
	pi.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		if ((event as { aborted?: boolean } | undefined)?.aborted) cancelCurrentLoop(ctx);
		settleChains(ctx);
		currentRun = {};
		scheduler.notifyIdle();
	});

	/** After a compaction, send the full loop.md tasks again on the next tick. */
	pi.on("session_compact", async () => {
		loopFile.reset();
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		durable?.stop();
		restoreState(ctx, (event as { reason?: string } | undefined)?.reason);
		durable = createDurable(ctx.cwd);
		durable.start();
		scheduler.start();
		if (syncPiCcExtensionsExcludes(piCcToolNames(), loadConfig().compactToolRows)) {
			notify(ctx, "pi-cc-extensions excludeRenderers updated \u00b7 /reload to apply", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		// Pi clears extension statuses when it unloads, but a reload should not
		// leave a stale count behind until then.
		try {
			lastCtx?.ui?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			// the context may already be invalid
		}
		scheduler.stop();
		durable?.stop();
		durable = undefined;
		scheduler.clear(false);
	});

	// -------------------------------------------------------------- restoring

	/**
	 * Restore the session's jobs from its last state entry, following Claude
	 * Code's resume rules: "restores the tasks scheduled with CronCreate,
	 * except recurring tasks that have expired and one-shot tasks whose
	 * scheduled time has passed. A self-paced /loop isn't restored". A restored
	 * recurring job does not catch up on missed runs.
	 *
	 * `/reload` is different: the process keeps running, so a self-paced
	 * wakeup that is still in the future is kept (Claude Code re-arms a pending
	 * wakeup when its process restarts in time).
	 */
	function restoreState(ctx: ExtensionContext, reason: string | undefined): void {
		scheduler.clear(false);
		lastPersistedSignature = "";

		const entries = ctx.sessionManager.getEntries();
		let data: PersistedState | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.jobs) {
				data = entry.data;
				break;
			}
		}
		if (!data) {
			refreshWidget(scheduler.list());
			return;
		}

		for (const prompt of data.stopped ?? []) rememberStopped(prompt);
		if (typeof data.widget === "boolean") widgetEnabled = data.widget;

		const now = Date.now();
		const limit = maxAgeMs();
		let droppedChains = 0;
		let droppedOneShots = 0;
		for (const saved of data.jobs) {
			// Durable jobs come from .pi/scheduled_tasks.json, never from a session.
			if (saved.durable) continue;
			const job = storedJob(saved);
			if (job.kind === "wakeup") {
				if (reason === "reload" && job.scheduledFor !== undefined && job.scheduledFor > now) {
					scheduler.restore(job);
				} else {
					droppedChains++;
				}
				continue;
			}
			if (!job.recurring) {
				const due = nextRunTime(job, job.createdAt, timingConfig());
				if (due === null || due <= now) {
					droppedOneShots++;
					continue;
				}
			} else if (limit > 0 && now - job.createdAt >= limit) {
				continue;
			}
			scheduler.restore(job);
			scheduler.arm(job, now);
		}

		const notes: string[] = [];
		if (droppedChains) {
			notes.push(
				`${droppedChains} self-paced loop${droppedChains === 1 ? " was" : "s were"} not restored: run /loop again to restart ${droppedChains === 1 ? "it" : "them"}`,
			);
		}
		if (droppedOneShots) {
			notes.push(
				`${droppedOneShots} one-shot job${droppedOneShots === 1 ? "" : "s"} dropped: the scheduled time passed while the session was closed`,
			);
		}
		if (notes.length) notify(ctx, notes.join(" \u00b7 "), "warning");
		scheduler.refresh();
	}
}
