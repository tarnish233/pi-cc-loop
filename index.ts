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
import path from "node:path";
import { configPath, invalidateConfig, loadConfig } from "./config.ts";
import { cleanRuntimeTemps } from "./temp-files.ts";
import {
	humanSchedule,
	isUnreachable,
	parseCron,
} from "./cron.ts";
import { DURABLE_FILE, LOCK_FILE, DurableRuntime, type Placement } from "./durable.ts";
import { displayPrompt, isLoopFileSentinel, LoopFileDelivery } from "./loopfile.ts";
import {
	CRON_CREATE_DESCRIPTION,
	CRON_CREATE_SNIPPET,
	CRON_DELETE_DESCRIPTION,
	CRON_DELETE_SNIPPET,
	CRON_LIST_DESCRIPTION,
	CRON_LIST_SNIPPET,
	LOOP_FILE_SENTINEL,
	loopGuidelines,
	missedJobsMessage,
	monitorGuidelines,
	provenance,
	RULES_PROVENANCE,
	RUN_NOW_HINT,
	SCHEDULE_WAKEUP_DESCRIPTION,
	scheduledTaskProvenance,
	SCHEDULE_WAKEUP_SNIPPET,
	loopCommandGuidelines,
} from "./prompts.ts";
import { formatClock, formatEta, renderScheduledMessage } from "./renderers.ts";
import { CONFIG_CHANNEL, registerSettingsCommand } from "./settings.ts";
import { registerTaskProvider, type TaskDetail, type TaskItem, type TaskStopResult } from "./tasks.ts";
import {
	DEFAULT_TIMING,
	generateId,
	LoopScheduler,
	nextRunTime,
	storedJob,
	type LoopJob,
	type TimingConfig,
} from "./schedule.ts";
import { formatDateTime as dateTime, releaseNotificationHover, setNotificationTui, truncate } from "./render.ts";

const STATE_ENTRY = "pi-cc-loop-state";
/** pi-cc-monitor's notification type; its details name the loop a monitor belongs to. */
const MONITOR_EVENT_TYPE = "Monitor";
/** Footer status key, shared with every other extension's status line. */
const STATUS_KEY = "loop";

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
/** The one fallback wakeup a self-paced chain gets when the model forgot to reschedule. */
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

/** Pi only terminates a batch when every call agrees; never arm from a mixed or nested call. */
function requireStandaloneWakeup(toolCallId: string, ctx: Pick<ExtensionContext, "sessionManager">): void {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 1 && calls[0].id === toolCallId && calls[0].name === "schedule_wakeup") return;
		break;
	}
	throw new Error(
		"No wakeup was scheduled: schedule_wakeup must be called directly as the only tool call in its assistant response, " +
			"not through codemode or in a batch. Finish other tools and write your update first, then call it alone.",
	);
}

/** A stored job as a codemode script sees it: every field, minus those holding no value (the value is JSON). */
function jobValue(job: LoopJob): Record<string, string | number | boolean> {
	return Object.fromEntries(Object.entries(storedJob(job)).filter(([, value]) => value !== undefined)) as Record<
		string,
		string | number | boolean
	>;
}

/**
 * The scheduler of one extension instance, keyed by its own `pi` object. Tests
 * and the task-panel provider use this instead of a process-global "last
 * scheduler": several sessions or subagents in one process must not mix.
 */
const schedulers = new WeakMap<ExtensionAPI, LoopScheduler>();

export function getScheduler(pi: ExtensionAPI): LoopScheduler | undefined {
	return schedulers.get(pi);
}

export default function piCcLoopExtension(pi: ExtensionAPI): void {
	/** Cached context for UI helpers. */
	let lastCtx: ExtensionContext | undefined;
	let tempCleanupTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Prompts whose chain was stopped. A stopped chain must not be resurrected
	 * by a late `schedule_wakeup` call from a turn that a still-running monitor
	 * woke up.
	 */
	const stoppedPrompts = new Set<string>();
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
	 * it armed, `tick` the tick number of a /loop run, `loopRequest` set when a
	 * typed /loop started it (its rules already say to do the task now),
	 * `cancelled` set when the run's own chain was stopped while it was running.
	 */
	let currentRun: { chainId?: string; cronId?: string; armed?: Set<string>; tick?: number; loopRequest?: boolean; cancelled?: boolean } = {};

	const scheduler = new LoopScheduler({
		dispatch: (job) => deliverTick(job),
		afterDispatch: (job, finished) => {
			if (job.durable) durable?.afterFire(job, finished);
		},
		onChange: (jobs) => {
			persist(jobs);
			refreshStatus(jobs);
			tasks.changed();
		},
		canDispatch: (job) => {
			const ctx = lastCtx;
			if (!ctx) return false;
			try {
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
				return !job.durable || durable?.canDispatch() === true;
			} catch {
				return false;
			}
		},
		timing: timingConfig,
		maxAgeMs,
		onExpire: (job) => {
			const text = `Loop ${job.id} ended: it ran its final time and recurring jobs expire after ${maxAgeDays()} days. Do not reschedule it.`;
			const ctx = lastCtx;
			if (ctx) notify(ctx, text, "info");
			wakeOutcome(text);
		},
		onDispatchError: (job, error) => {
			const outcome = job.kind === "wakeup" || !job.recurring ? "it remains due for retry" : "this tick was skipped without consuming a fire";
			const text = `Loop ${job.id} failed to deliver (${error.message}). ${outcome}. Do not assume this tick ran.`;
			const ctx = lastCtx;
			if (ctx) notify(ctx, text, "warning");
			wakeOutcome(text);
		},
		onScan: (now) => {
			durable?.maintain(now);
			// The countdown is coarse, so this is a string compare most seconds.
			refreshStatus();
		},
	});
	schedulers.set(pi, scheduler);

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
		const signature = JSON.stringify([kept.map(signatureOf), stopped]);
		if (signature === lastPersistedSignature) return;
		lastPersistedSignature = signature;
		try {
			pi.appendEntry(STATE_ENTRY, { version: 1, jobs: kept, stopped } satisfies PersistedState);
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

	/**
	 * Rules for a message we are about to send, keyed by its text. A user
	 * message carries no details, so the run's guidelines wait here for
	 * before_agent_start to pick them up.
	 */
	const queuedRuns: Array<{ content: string; guidelines: string[] }> = [];

	function queueRun(run: (typeof queuedRuns)[number]): void {
		queuedRuns.push(run);
		if (queuedRuns.length > 8) queuedRuns.shift();
	}

	function takeQueuedRun(content: string): (typeof queuedRuns)[number] | undefined {
		const index = queuedRuns.findIndex((run) => run.content === content);
		return index < 0 ? undefined : queuedRuns.splice(index, 1)[0];
	}

	/**
	 * One line in Pi's footer, the same place other extensions show status.
	 * Claude Code has no loop status in its footer; a one-line summary is enough
	 * to know that something is armed and when it next fires.
	 */
	function statusText(jobs: LoopJob[]): string | undefined {
		if (!jobs.length) return undefined;
		const label = jobs.length === 1 ? "loop" : "loops";
		if (jobs.some((job) => job.pending)) return `${jobs.length} ${label} \u00b7 waiting`;
		const scheduled = jobs
			.map((job) => job.kind === "cron" ? job.nextFireAt : job.scheduledFor)
			.filter((at): at is number => at !== undefined);
		if (!scheduled.length) return `${jobs.length} ${label} \u00b7 active`;
		const next = Math.min(...scheduled);
		return `${jobs.length} ${label} \u00b7 next ${formatEta(Math.max(0, next - Date.now()))}`;
	}

	let lastStatusText: string | undefined;

	function refreshStatus(jobs: LoopJob[] = scheduler.list()): void {
		const ctx = lastCtx;
		if (!ctx || !ctx.hasUI) return;
		try {
			// Older Pi versions have no footer status API.
			if (typeof ctx.ui.setStatus !== "function") return;
			const text = loadConfig().footer ? statusText(jobs) : undefined;
			// Every call repaints, even with the same text, so speak only on change.
			if (text === lastStatusText) return;
			lastStatusText = text;
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
		// The run whose chain this was must not arm again, even under a reworded
		// prompt: the stopped-prompt memory only matches the exact text.
		if (currentRun.chainId === chain.id || currentRun.armed?.has(chain.id)) {
			currentRun.cancelled = true;
		}
		scheduler.remove(chain.id);
		try {
			pi.events.emit(LOOP_STOPPED_CHANNEL, { prompt: chain.prompt, reason });
		} catch {
			// a listener must never break the loop
		}
		const text = `Loop ${chain.id} stopped (${reason}). Any Monitor bound to this loop was stopped with it. Do not reschedule this loop or re-arm those monitors unless the user asks.`;
		const ctx = lastCtx;
		if (ctx && !options.silent) notify(ctx, text, "info");
		// Esc already cancelled the reply; waking would restart it. Every other stop wakes.
		if (!options.silent) wakeOutcome(text);
	}

	/** End, failure and stop have no launch parameter that can silence them. */
	function wakeOutcome(text: string): void {
		try {
			pi.sendMessage(
				{ customType: "pi-cc-loop-outcome", content: text, display: true, details: { ended: true } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// a stale session must not break stop or expiry
		}
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
					details: { missed: true, prompt: lines.join("\n") },
				},
				{ deliverAs: "followUp" },
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

	/**
	 * A scheduled fire is a custom message, not a user message: the provenance
	 * line in its content is addressed to the model, and only a custom message
	 * can draw something else for the reader (`renderScheduledMessage`).
	 */
	const TICK_MESSAGE_TYPE = "pi-cc-loop-tick";

	/**
	 * The per-run rules, appended to the run as a hidden message instead of
	 * being written into the system prompt. Providers that cannot carry a system
	 * message mid-conversation get the leading system prompt rebuilt from every
	 * change, so a rule that comes and goes with each tick would invalidate the
	 * whole cached prefix on the way into the run and again on the way out.
	 * Claude Code does the same: its /loop instructions are part of the message.
	 */
	const RULES_MESSAGE_TYPE = "pi-cc-loop-rules";

	function rulesFor(guidelines: string[], receipt?: number) {
		if (!guidelines.length) return undefined;
		return {
			message: {
				customType: RULES_MESSAGE_TYPE,
				content: [RULES_PROVENANCE, ...guidelines].join("\n\n"),
				display: false,
				// A primitive token, not the body: message_end acknowledges the
				// supplement only once Pi has finalized the message into the run.
				...(receipt !== undefined ? { details: { loopFileReceipt: receipt } } : {}),
			},
		};
	}

	/** The text the model gets for a prompt: the loop.md sentinel expands at fire time. */
	function resolvePrompt(prompt: string): string {
		return isLoopFileSentinel(prompt) ? loopFile.resolve(lastCtx?.cwd ?? process.cwd()) : prompt;
	}

	/**
	 * Deliver a scheduled tick. `followUp` is the low-priority lane: Claude
	 * Code's "A scheduled prompt fires between your turns, not while Claude is
	 * mid-response."
	 */
	function deliverTick(job: LoopJob): void {
		const tick = Math.max(tickCounters.get(job.prompt) ?? 0, job.tickCount ?? 0) + 1;
		const body = resolvePrompt(job.prompt);
		// A fixed-interval tick is what it is - a scheduled task - and a
		// self-paced tick keeps the loop framing. The rules for the run are
		// rebuilt from `details` in before_agent_start.
		const cadence = job.kind === "cron" ? humanSchedule(job.cron ?? "* * * * *") : undefined;
		const stamp = cadence ? scheduledTaskProvenance(job.id, cadence) : provenance(tick);
		try {
			pi.sendMessage(
				{
					customType: TICK_MESSAGE_TYPE,
					content: `${stamp}\n${body}`,
					display: true,
					details: {
						kind: job.kind,
						tickCount: tick,
						jobId: job.id,
						cron: job.cron,
						prompt: body,
						reason: job.reason,
						// The supplement in before_agent_start must key off the message,
						// not a scheduler lookup: a one-shot's job is gone by then.
						loopFile: isLoopFileSentinel(job.prompt),
					},
				},
				// `triggerTurn` is what starts the run: without it the message is
				// only recorded and nothing ever happens.
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			// resolve() remembers a loop.md/maintenance body as delivered. If Pi
			// rejected the message, a one-shot/wakeup retry must send the full
			// body again rather than a reminder that refers to a missing message.
			loopFile.reset();
			throw error;
		}
		// Counted only once the message is in: a throw here means the tick never
		// happened, so it must not use up a number.
		tickCounters.set(job.prompt, tick);
		job.tickCount = tick;

		if (job.maxFires !== undefined && (job.fireCount ?? 0) >= job.maxFires) {
			const ctx = lastCtx;
			if (ctx) notify(ctx, `loop ${job.id} reached its cap of ${job.maxFires} fires`, "info");
		}
	}

	/** True when the pi-cc-monitor extension registered its Monitor tool. */
	function monitorToolAvailable(): boolean {
		try {
			return pi.getAllTools().some((tool) => tool.name === "Monitor");
		} catch {
			return false;
		}
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
		description: "Run a prompt repeatedly: /loop [interval] <prompt>, /loop <prompt>, /loop stop, /loop status.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const raw = args.trim();
			const [head] = raw.split(/\s+/);

			// Keep old settings words from starting a loop by mistake.
			switch ((head ?? "").toLowerCase()) {
				case "footer":
				case "statusline":
				case "settings":
				case "config":
					notify(ctx, "Settings live under /loop_settings: /loop_settings footer on|off, /loop_settings messages on|off", "info");
					return;
				case "help":
				case "--help":
				case "-h":
					showHelp(ctx);
					return;
				default:
					break;
			}

			// Everything else becomes a normal user message, the way Claude Code's
			// /loop skill does: the conversation keeps the request, and the model
			// drives cron_create / cron_list / cron_delete / schedule_wakeup itself.
			// The per-run rules travel with the run through before_agent_start.
			const text = raw ? `/loop ${raw}` : "/loop";
			const guidelines = [loopCommandGuidelines(raw, { monitorAvailable: monitorToolAvailable() })];
			const send = () => {
				// The user asking for this loop again is a new loop: the mark that
				// keeps a late schedule_wakeup from reviving a stopped chain must
				// not block it.
				const prompt = normalizePrompt(raw);
				stoppedPrompts.delete(prompt || LOOP_FILE_SENTINEL);
				// An interval-bearing /loop stores its chain under the sentinel
				// (`/loop 15m`) or the task without its interval (`/loop 15m task`);
				// clear that mark too, so the same /loop can restart. The unit must
				// end at whitespace: `5m.js audit` is a task, not an interval.
				const withoutInterval = prompt.replace(/^\d+[smhd](?=\s|$)\s*/i, "").trim();
				if (withoutInterval !== prompt) stoppedPrompts.delete(withoutInterval || LOOP_FILE_SENTINEL);
				queueRun({ content: text, guidelines });
				try {
					pi.sendUserMessage(text, { expandPromptTemplates: false, deliverAs: "followUp" });
				} catch {
					// The session was replaced while this request waited.
				}
			};

			// A run that is already streaming has passed before_agent_start, so
			// sending now would split the request in two: the text would be queued
			// into that run without its rules, and the model would work through it
			// twice. Wait for the run to end and start a clean one instead - the
			// same wait a follow-up lane would impose, without losing the rules.
			if (!ctx.isIdle() && typeof ctx.waitForIdle === "function") {
				notify(ctx, `${text} will start when the current turn ends`, "info");
				void ctx.waitForIdle().then(send, () => {});
				return;
			}
			// The followUp lane is the fallback for a Pi without waitForIdle: a
			// sendUserMessage from a streaming turn throws without one ("Agent is
			// already processing. Specify streamingBehavior"). When idle the option
			// is ignored and the turn starts.
			send();
		},
	});

	function showHelp(ctx: ExtensionContext): void {
		const help = [
			"/loop [interval] <prompt>   run <prompt> every <interval> (e.g. 30s, 5m, 2h, 1d)",
			"/loop <prompt>              self-paced: the agent picks the next delay",
			"/loop [interval]            the .pi/loop.md tasks, or the built-in maintenance prompt",
			"/loop_settings              Loop settings: message style and footer summary",
			"",
			"Esc on a self-paced loop's own turn cancels that loop; fixed-interval loops keep running.",
			"Flags: --durable  write the job to .pi/scheduled_tasks.json so it survives a restart.",
			"       --max N   stop the loop after N fires.",
		].join("\n");
		notify(ctx, help, "info");
	}

	// ------------------------------------------------------------- task panel

	/** One job by id, including a durable job another session runs. */
	function jobFor(id: string): (LoopJob & { foreignReason?: "other-session" | "other-folder" }) | undefined {
		return scheduler.get(id) ?? durable?.foreignJobs().find((job) => job.id === id);
	}

	/** The live state a pending/wakeup job is in right now. */
	function jobState(job: LoopJob & { foreignReason?: string }, now: number): string {
		if (job.foreignReason) return job.foreignReason === "other-folder" ? "foreign (other folder)" : "foreign (other session)";
		if (job.pending) return "pending (waiting for idle)";
		if (job.kind === "wakeup") {
			if (job.keepaliveTurn) return "keepalive turn";
			if (job.awaitingReschedule) {
				try {
					return lastCtx?.isIdle() === false ? "active (turn running)" : "active / awaiting reschedule";
				} catch {
					return "active / awaiting reschedule";
				}
			}
		}
		const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
		if (at !== undefined && at <= now) return "due";
		return at !== undefined ? "scheduled" : "armed";
	}

	function jobItem(job: LoopJob & { foreignReason?: string }, now: number): TaskItem {
		const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
		const meta: string[] = [];
		if (job.pending) meta.push("waiting for idle");
		else if (job.foreignReason) meta.push(job.foreignReason === "other-folder" ? "other folder" : "other session");
		else if (at !== undefined) meta.push(`${at <= now ? "due" : "next"} ${at <= now ? "now" : formatEta(at - now)}`);
		meta.push(`${job.fireCount ?? 0} fire${job.fireCount === 1 ? "" : "s"}`);
		if (job.durable) meta.push("durable");
		return {
			id: job.id,
			title: displayPrompt(job.prompt),
			createdAt: job.createdAt,
			state: jobState(job, now).replace(/ \(.*$/, ""),
			active: true,
			meta: meta.join(" · "),

		};
	}

	function jobDetail(job: LoopJob & { foreignReason?: string }, now: number): TaskDetail {
		const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
		const state = jobState(job, now);
		const ownership = job.foreignReason
			? job.foreignReason === "other-folder"
				? "durable · copied from another folder (listed, not run here)"
				: "durable · run by another Pi session in this project"
			: job.durable
				? durable?.owner
					? "durable · run by this session"
					: "durable · loaded, but another session holds the scheduler lock"
				: "session only";
		const fires = `${job.fireCount ?? 0}${job.maxFires !== undefined ? `/${job.maxFires}` : ""}` +
			(job.lastFiredAt !== undefined ? ` · last ${dateTime(job.lastFiredAt)}` : "");
		const rows = [
			{ label: "Kind", value: job.kind === "cron" ? "fixed interval (cron)" : "self-paced wakeup" },
			{ label: "State", value: state },
			{
				label: "Schedule",
				value: job.kind === "cron" ? `${job.cron ?? "?"} (${humanSchedule(job.cron ?? "")})` : "self-paced: the model picks the next delay",
			},
			{
				label: "Next run",
				value:
					at === undefined
						? "unscheduled"
						: `${dateTime(at)} · ${at <= now ? "due now" : `in ${formatEta(at - now)}`} · ${at} ms`,
			},
			{ label: "Reason", value: job.reason ?? "—" },
			{ label: "Fires", value: fires },
			{
				label: "Pending",
				value: job.pending
					? `yes · since ${dateTime(job.dueAt)} · waiting for the agent to go idle`
					: "no",
			},
			{
				label: "Chain",
				value:
					job.kind === "wakeup"
						? job.awaitingReschedule
							? "active · the turn is running or waiting to reschedule"
							: job.keepaliveUsed
								? "keepalive used"
								: "armed"
						: "fixed interval · fires its own next tick",
			},
			{ label: "Ownership", value: ownership },
			{ label: "Prompt", value: displayPrompt(job.prompt) },
			{ label: "Source", value: job.source },
			{ label: "Created", value: dateTime(job.createdAt) },
			{ label: "Project", value: job.createdInProject ?? "—" },
			{ label: "Keepalive", value: job.keepaliveUsed ? (job.keepaliveTurn ? "this turn is the keepalive" : "used once") : "not used" },
		] satisfies TaskDetail["rows"];
		return {
			rows,
			note: job.foreignReason
				? "Not running here. x removes it from .pi/scheduled_tasks.json; it does not abort another session's turn."
				: "x removes the schedule (and any Monitor bound to a stopped self-paced loop). It does not abort the main agent.",
		};
	}

	function stopTask(id: string): TaskStopResult {
		const job = scheduler.get(id);
		if (job) {
			if (job.kind === "wakeup") retireChain(job, "stopped from task panel");
			else removeJob(job);
			tasks.changed();
			return { stopped: true, message: `Cancelled ${job.kind === "wakeup" ? "self-paced loop" : "scheduled job"} ${id}.` };
		}
		// A durable job this session does not run: cancel its store entry, as
		// cron_delete does, without touching any session's current turn.
		const foreign = durable?.foreignJobs().find((candidate) => candidate.id === id);
		if (foreign && durable?.remove(id)) {
			tasks.changed();
			return {
				stopped: true,
				message: `Cancelled durable job ${id} (${foreign.foreignReason === "other-folder" ? "copied from another folder" : "run by another session"}).`,
			};
		}
		return { stopped: false, message: `No scheduled job with id ${id}.` };
	}

	// The shared task overlay. The provider reads the live LoopJob objects
	// (never cron_list's text, which drops pending/awaitingReschedule), so the
	// next run is the already-jittered time the scheduler will actually use.
	const tasks = registerTaskProvider(pi, {
		id: "loop",
		label: "Loop",
		list(): TaskItem[] {
			const now = Date.now();
			return listJobs().map((job) => jobItem(job, now));
		},
		detail(item: TaskItem): TaskDetail {
			const job = jobFor(item.id);
			if (!job) throw new Error("this job is no longer listed");
			return jobDetail(job, Date.now());
		},
		stop: stopTask,
	});

	registerSettingsCommand(pi);

	// A Loop setting changed: the footer follows.
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		refreshStatus();
	});

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
						"true (default) = fire on every cron match until deleted or past the configured age limit (7 days by default). false = fire once at the next match, then auto-delete.",
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
		// What a codemode script gets: values, not the text (Pi sends the shape, not this).
		outputSchema: Type.Object({
			id: Type.String(),
			cron: Type.String(),
			recurring: Type.Boolean(),
			durable: Type.Boolean(),
			nextFireAt: Type.Optional(Type.Number()),
			prompt: Type.String(),
			runsHere: Type.Boolean(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!parseCron(params.cron)) {
				throw new Error(`Invalid cron expression '${params.cron}'. Expected 5 fields: M H DoM Mon DoW.`);
			}
			if (isUnreachable(params.cron)) {
				throw new Error(`Cron expression '${params.cron}' does not match any date within the next 4 years.`);
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
				const days = maxAgeDays();
				lines.push(days > 0
					? `Recurring jobs auto-expire after ${days} days: the job runs one final time, then it is deleted.`
					: "Recurring jobs do not expire (PI_LOOP_MAX_AGE_DAYS=0).");
			}
			lines.push(`Cancel it with cron_delete { "id": "${job.id}" }.`);
			// Asked for in plain words, not through /loop: do it once now, as /loop would.
			if (recurring && !currentRun.loopRequest && !currentRun.cronId && !currentRun.chainId) lines.push(RUN_NOW_HINT);

			const value = {
				id: job.id,
				cron: job.cron ?? params.cron.trim(),
				recurring: job.recurring,
				durable: job.durable,
				...(nextAt !== undefined ? { nextFireAt: nextAt } : {}),
				prompt: job.prompt,
				runsHere: placement.runsHere,
			};

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				// Shared with codemode scripts; no key holds undefined, so it is JSON.
				details: value,
				structuredContent: value,
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
		outputSchema: Type.Object({ cancelled: Type.Boolean(), id: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const job = scheduler.get(params.id);
			if (job) {
				// A self-paced chain ends the same way /loop stop ends it.
				if (job.kind === "wakeup") retireChain(job, "cancelled with cron_delete");
				else removeJob(job);
			} else if (!durable?.remove(params.id)) {
				const value = { cancelled: false, id: params.id };
				return {
					content: [{ type: "text" as const, text: `No scheduled job with id ${params.id}.` }],
					details: value,
					structuredContent: value,
				};
			}
			const value = { cancelled: true, id: params.id };
			return {
				content: [{ type: "text" as const, text: `Cancelled job ${params.id}.` }],
				details: value,
				structuredContent: value,
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
		outputSchema: Type.Object({
			jobs: Type.Array(
				Type.Object({
					id: Type.String(),
					kind: Type.Union([Type.Literal("cron"), Type.Literal("wakeup")]),
					cron: Type.Optional(Type.String()),
					prompt: Type.String(),
					recurring: Type.Boolean(),
					createdAt: Type.Number(),
					nextFireAt: Type.Optional(Type.Number()),
					scheduledFor: Type.Optional(Type.Number()),
					chainStartedAt: Type.Optional(Type.Number()),
					keepaliveUsed: Type.Optional(Type.Boolean()),
					fireCount: Type.Optional(Type.Number()),
					tickCount: Type.Optional(Type.Number()),
					lastFiredAt: Type.Optional(Type.Number()),
					maxFires: Type.Optional(Type.Number()),
					durable: Type.Boolean(),
					createdInProject: Type.Optional(Type.String()),
					label: Type.Optional(Type.String()),
					reason: Type.Optional(Type.String()),
					source: Type.String(),
				}),
			),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const jobs = listJobs();
			const values = jobs.map(jobValue);
			if (!jobs.length) {
				return {
					content: [{ type: "text" as const, text: "No scheduled jobs." }],
					details: { jobs: values },
					structuredContent: { jobs: values },
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
				details: { jobs: values },
				structuredContent: { jobs: values },
			};
		},
	});

	pi.registerTool({
		name: "schedule_wakeup",
		label: "ScheduleWakeup",
		// A turn-control tool: codemode cannot propagate its terminate flag.
		exposure: "model-only",
		description: SCHEDULE_WAKEUP_DESCRIPTION,
		promptSnippet: SCHEDULE_WAKEUP_SNIPPET,
		parameters: Type.Object({
			delaySeconds: Type.Optional(
				Type.Number({
					description: "Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless stop is true.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						"One short sentence explaining the chosen delay. Shown to the user, so be specific. Required unless stop is true.",
				}),
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
		// Every return is one of these shapes: a stop, a suppression, an age-out, or a schedule.
		outputSchema: Type.Object({
			stopped: Type.Boolean(),
			cancelledWakeups: Type.Optional(Type.Number()),
			agedOut: Type.Optional(Type.Boolean()),
			suppressed: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			scheduledFor: Type.Optional(Type.Number()),
			clampedDelaySeconds: Type.Optional(Type.Number()),
			wasClamped: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;

			if (currentRun.cronId) {
				// Not an error: the request is already satisfied by the schedule.
				// Returning it as a result (instead of throwing) keeps the transcript
				// calm and tells the model nothing is missing.
				const cronJob = scheduler.get(currentRun.cronId);
				const value = { suppressed: "fixed-interval", id: currentRun.cronId, stopped: false };
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
					details: value,
					structuredContent: value,
				};
			}

			if (params.stop === true) {
				// Stop the loop this turn belongs to; otherwise the named one, or all.
				const current = currentRun.chainId ? scheduler.get(currentRun.chainId) : undefined;
				const named = params.prompt ? scheduler.findChain(normalizePrompt(params.prompt)) : undefined;
				const chains = current ? [current] : named ? [named] : scheduler.byKind("wakeup");
				for (const chain of chains) retireChain(chain, "stopped by the agent");
				const value = { stopped: true, cancelledWakeups: chains.length };
				return {
					content: [
						{
							type: "text" as const,
							text: chains.length
								? `Loop stopped \u2014 cancelled ${chains.length} pending wakeup(s); no further dynamic-loop wakeups scheduled. ` +
									"Any Monitor armed for this loop was stopped with it. Write the loop's outcome for the user, then end the turn."
								: "Loop stopped \u2014 any dynamic loop in this session is ended; there was no pending wakeup to cancel. " +
									"If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call \u2014 cancel it with cron_delete.",
						},
					],
					details: value,
					structuredContent: value,
				};
			}

			if (typeof params.delaySeconds !== "number" || Number.isNaN(params.delaySeconds)) {
				throw new Error("`delaySeconds` and `reason` are required when `stop` is not true.");
			}
			if (!params.reason || !params.reason.trim()) {
				throw new Error("`delaySeconds` and `reason` are required when `stop` is not true.");
			}
			const prompt = params.prompt ? normalizePrompt(params.prompt) : "";
			if (!prompt) {
				throw new Error("`prompt` is required when `stop` is not true.");
			}

			// Check the finalized assistant batch before changing any chain or timer.
			requireStandaloneWakeup(_toolCallId, ctx);

			// This run's own chain was stopped mid-run: a late arm must not start a
			// replacement chain, even under a reworded prompt.
			if (currentRun.cancelled) {
				throw new Error(
					"The /loop this turn belongs to was stopped and must not be rescheduled. " +
						"Do not call schedule_wakeup for it again. If the work should continue, ask the user to start a new /loop.",
				);
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
					const value = { stopped: true, agedOut: true, id: chain.id, cancelledWakeups: 1 };
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Wakeup not scheduled. The loop reached its maximum duration (${maxAgeDays()} days) \u2014 the loop has ended; ` +
									"do not re-issue. Tell the user they can start a new /loop.",
							},
						],
						details: value,
						structuredContent: value,
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

			const note = wasClamped ? ` (clamped to ${delay}s from your requested value)` : "";
			const clock = new Date(scheduledFor).toTimeString().slice(0, 8);
			const value = {
				id: chain.id,
				scheduledFor,
				clampedDelaySeconds: delay,
				wasClamped,
				stopped: false,
			};
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Next wakeup scheduled for ${clock} (in ${delay}s)${note}. ` +
							"This turn ends when this call returns \u2014 you are re-invoked when the wakeup fires or a monitor event arrives.",
					},
				],
				details: value,
				structuredContent: value,
				// Claude Code ends the turn when ScheduleWakeup returns (on models
				// that support it); the guidelines ask for the update first. Pi only
				// ends the turn when every tool in the batch agrees.
				terminate: true,
			};
		},
	});


	// ----------------------------------------------------------------- events

	/**
	 * Give a run the instructions of the loop message that started it, and
	 * remember which chain (if any) the run belongs to.
	 *
	 * A monitor event does not touch the chain: like Claude Code, the pending
	 * wakeup stays armed as the fallback heartbeat, and the model re-arms it if
	 * it wants a different time.
	 */
	pi.registerMessageRenderer(TICK_MESSAGE_TYPE, renderScheduledMessage);

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		currentRun = {};

		// Our own messages are ordinary user messages now, so the instructions
		// for the run travel with the queued entry.
		if (event.messageType === "user") {
			const queued = takeQueuedRun(event.prompt);
			if (!queued) return;
			currentRun = { loopRequest: true };
			return rulesFor(queued.guidelines);
		}
		if (event.messageType !== "custom") return;

		if (event.message.customType === TICK_MESSAGE_TYPE) {
			const details = (event.message.details ?? {}) as {
				kind?: "cron" | "wakeup";
				jobId?: string;
				cron?: string;
				tickCount?: number;
				loopFile?: boolean;
			};
			currentRun = {
				chainId: details.kind === "wakeup" ? details.jobId : undefined,
				cronId: details.kind === "cron" ? details.jobId : undefined,
				tick: details.tickCount,
			};
			// Pi compacts before before_agent_start, so a compaction reset only
			// repairs the next tick: this run's reminder may point at a body the
			// compaction just dropped. Supplement it here on a receipt: delivery
			// is committed at message_end, so a failed run start still resends on
			// the next tick, but a stored supplement is not sent again and again.
			const supplement = (): { text: string; token: number } | null => {
				if (!details.loopFile) return null;
				const pending = loopFile.peek(ctx.cwd);
				// A first fire already carries the full body in the tick itself.
				return pending && !String(event.message.content).includes(pending.text) ? pending : null;
			};
			// A cron fire needs nothing beyond its envelope ("it fires the next tick
			// on its own, so do not call schedule_wakeup; to cancel it, call
			// cron_delete"): an extra message every minute would only grow the
			// context. A self-paced tick carries the rules that keep the loop alive.
			if (details.kind !== "wakeup") {
				const full = supplement();
				return full ? rulesFor([full.text], full.token) : undefined;
			}
			const chain = details.jobId ? scheduler.get(details.jobId) : undefined;
			if (!chain) {
				// The chain was retired after this tick was queued (cron_delete can
				// land during pre-run compaction, before this handler): this run
				// must not arm a replacement, even under a reworded prompt.
				if (details.jobId) currentRun.cancelled = true;
				return;
			}
			const guidelines = [loopGuidelines(chain.prompt)];
			if (monitorToolAvailable()) guidelines.push(monitorGuidelines(chain.prompt));
			const full = supplement();
			if (full) guidelines.push(full.text);
			return rulesFor(guidelines, full?.token);
		}

		if (event.message.customType === MONITOR_EVENT_TYPE) {
			// A monitor bound to a loop woke the agent: the run belongs to that loop.
			// The monitor stores the prompt the model gave it; the chain is keyed
			// without a leading `/loop`, so both spellings find it.
			const loopPrompt = (event.message.details as { loopPrompt?: unknown } | undefined)?.loopPrompt;
			const prompt = typeof loopPrompt === "string" ? normalizePrompt(loopPrompt) : undefined;
			const chain = prompt !== undefined ? scheduler.findChain(prompt) : undefined;
			if (chain) {
				currentRun.chainId = chain.id;
				// A monitor can wake the agent after a compaction or tree navigation
				// dropped the sentinel chain's tasks: restore them for the active
				// chain on a receipt, without re-arming any rules.
				if (isLoopFileSentinel(chain.prompt)) {
					const pending = loopFile.peek(ctx.cwd);
					if (pending) return rulesFor([pending.text], pending.token);
				}
			}
			// A queued monitor event can outlive its stopped loop: the stopped memo
			// still bars a re-arm. No memo means a genuinely new loop; allow it.
			else if (prompt !== undefined && stoppedPrompts.has(prompt)) currentRun.cancelled = true;
			return;
		}
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

	/**
	 * The supplement's receipt: Pi finalized the rules message into the run, so
	 * the captured snapshot counts as delivered. Until then nothing is committed
	 * (a failed start resends); a reset in between voids the receipt.
	 */
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== RULES_MESSAGE_TYPE) return;
		const token = (message.details as { loopFileReceipt?: unknown } | undefined)?.loopFileReceipt;
		if (typeof token === "number") loopFile.acknowledge(token);
	});

	/**
	 * Tree navigation can leave the branch without the full loop.md body. Reset
	 * before navigating too: an extension loaded earlier may start a model from
	 * its session_tree handler before ours runs. A cancelled navigation costs at
	 * most one conservative full resend.
	 */
	pi.on("session_before_tree", async () => {
		loopFile.reset();
	});
	pi.on("session_tree", async () => {
		loopFile.reset();
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		// The card says "click to show more" only where Pi actually delivers mouse
		// events: fullscreen. An empty widget is the native way to reach the TUI.
		if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("pi-cc-loop:screen", (tui) => {
				setNotificationTui(tui);
				return { render: () => [], invalidate() {} };
			});
		}
		// Another process may have edited the Loop settings file.
		invalidateConfig();
		if (tempCleanupTimer) clearInterval(tempCleanupTimer);
		const cleanupTemps = () => cleanRuntimeTemps([configPath(), path.join(ctx.cwd, DURABLE_FILE), path.join(ctx.cwd, LOCK_FILE)]);
		cleanupTemps();
		tempCleanupTimer = setInterval(cleanupTemps, 30 * 60 * 1000);
		tempCleanupTimer.unref?.();
		durable?.stop();
		restoreState(ctx, (event as { reason?: string } | undefined)?.reason);
		durable = createDurable(ctx.cwd);
		try {
			durable.start();
		} catch (error) {
			// Refusing a symlinked or unreadable durable store must not disable
			// this session's ordinary (non-durable) scheduled jobs.
			notify(ctx, `Durable jobs unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		scheduler.start();
	});

	pi.on("session_shutdown", async () => {
		if (tempCleanupTimer) clearInterval(tempCleanupTimer);
		tempCleanupTimer = undefined;
		releaseNotificationHover();
		// Close an open task overlay while the context is still valid.
		tasks.close();
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
		schedulers.delete(pi);
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
			return;
		}

		for (const prompt of data.stopped ?? []) rememberStopped(prompt);

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
