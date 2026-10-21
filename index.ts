/**
 * pi-cc-loop — a Claude Code compatible `/loop` for the Pi coding agent.
 *
 * Mirrors Claude Code v2.1.306:
 *
 *   /loop 5m check the deploy    fixed interval, driven by a 5-field cron
 *   /loop check the deploy       self-paced: the model picks the next delay
 *   /loop                        uses .pi/loop.md, or the built-in maintenance prompt
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
 *                   chain ends.
 *
 * The tools are named after their Claude Code counterparts:
 *   CronCreate  -> cron_create
 *   CronDelete  -> cron_delete
 *   CronList    -> cron_list
 *   ScheduleWakeup -> schedule_wakeup
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	describeCron,
	humanSchedule,
	intervalToCron,
	isUnreachable,
	parseCron,
	parseEveryClause,
	parseIntervalToken,
} from "./cron.ts";
import {
	configPath,
	loadConfig,
	saveConfig,
	syncPiCcExtensionsExcludes,
	type PiCcConfig,
} from "./config.ts";
import { generateId, LoopScheduler, type LoopJob } from "./schedule.ts";
import {
	bodyLines,
	contentText,
	firstLine,
	formatStamp,
	renderBlock,
	renderCard,
	stripProvenance,
} from "./render.ts";

const STATE_ENTRY = "pi-cc-loop-state";
const TICK_MESSAGE_TYPE = "pi-cc-loop-tick";
const WIDGET_KEY = "pi-cc-loop";
const CONFIG_CHANNEL = "pi-cc:config";
const LOOP_TOOL_NAMES = ["cron_create", "cron_delete", "cron_list", "schedule_wakeup"];
const ALL_PI_CC_TOOLS = [...LOOP_TOOL_NAMES, "Monitor", "monitor_stop", "monitor_list"];

/**
 * The event channel pi-cc-monitor publishes on. When a monitor names a loop
 * chain, its events supersede that chain's fallback heartbeat.
 */
const MONITOR_WAKE_CHANNEL = "monitor:wake";

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
const DEFAULT_KEEPALIVE_SECONDS = 1200;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAINTENANCE_PROMPT = [
	"You are running a scheduled maintenance pass.",
	"Work through the following, in order:",
	"1. Continue any unfinished work from the conversation.",
	"2. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts.",
	"3. Run cleanup passes such as bug hunts or simplification when nothing else is pending.",
	"Do not start new initiatives outside that scope, and only perform irreversible actions",
	"(push, delete) that the transcript already authorized.",
].join("\n");

/**
 * The rules for a loop whose interval the command layer could not parse.
 *
 * Claude Code's /loop is a skill: the model reads the user's input and
 * applies the skill's rules itself, so an interval written in any language is
 * understood. The command layer here only recognises the English token forms
 * (`5m`, `every 20m`); when it finds none, these rules take over so the model
 * can work the schedule out itself.
 */
const LOOP_SCHEDULE_RULES = [
	"This is a `/loop` request. Its prompt is: {prompt}",
	"",
	"Decide how it should repeat, then set it up.",
	"",
	"**If the prompt asks for a fixed interval** (\"every 30 seconds\", \"each 5 minutes\",",
	"\"every hour\", \"5m\", \"every 5m\"): create a recurring job with the `cron_create` tool.",
	"- Convert the interval to a 5-field cron expression in local time (\"M H DoM Mon DoW\").",
	"  `s` rounds up to the nearest minute (the scheduler's minimum granularity is 1 minute),",
	"  `m` are minutes, `h` are hours, `d` are days. Examples: `5m` -> `*/5 * * * *`,",
	"  `1h` -> `0 * * * *`, `1d` -> `0 0 * * *`. If the interval does not cleanly divide its",
	"  unit, round to the nearest clean interval and tell the user what you rounded to.",
	"- Then confirm to the user: what is scheduled, the cron expression, the human-readable",
	"  cadence, that recurring jobs auto-expire after 7 days, and the job id they can cancel",
	"  with `cron_delete`.",
	"",
	"**Otherwise the interval is open-ended.** After each iteration, call the `schedule_wakeup`",
	"tool with:",
	"- `delaySeconds`: seconds until the next iteration (60-3600). Default to 1200-1800; pick",
	"  something shorter only when you observed fast-changing external state.",
	"- `reason`: one short sentence on why you picked that delay.",
	"- `prompt`: the same /loop prompt verbatim: {quoted}",
	"If the task is complete or can no longer make progress, call `schedule_wakeup` with",
	"`stop: true` instead of scheduling another iteration.",
].join("\n");

const LOOP_GUIDELINES = [
	"A `/loop` chain is active. Its prompt is: {prompt}",
	"After this iteration finishes, call the `schedule_wakeup` tool with:",
	"- `delaySeconds`: seconds until the next iteration (60-3600). Default to 1200-1800;",
	"  pick something shorter only when you observed fast-changing external state.",
	"- `reason`: one short sentence on why you picked that delay.",
	"- `prompt`: the same /loop prompt verbatim: {quoted}",
	"If the task is complete or can no longer make progress, call `schedule_wakeup` with",
	"`stop: true` instead of scheduling another iteration.",
].join("\n");

const MONITOR_GUIDELINES = [
	"This iteration is waiting on an external event.",
	"Arm the `Monitor` tool with `loopPrompt` set to {quoted} so the event wakes this chain",
	"immediately instead of waiting for the next heartbeat. Keep the `schedule_wakeup` call too:",
	"its delay is then only the fallback heartbeat for the case where no event ever arrives.",
].join("\n");

const PROVENANCE = "[loop tick #{n} · scheduled by /loop, not typed by the user]";

interface PersistedState {
	version: 1;
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

function maxAgeMs(): number {
	const days = envNumber("PI_LOOP_MAX_AGE_DAYS", DEFAULT_MAX_AGE_MS / 86_400_000);
	return Math.max(0, days) * 86_400_000;
}

function jitterFraction(): number {
	return Math.min(1, Math.max(0, envNumber("PI_LOOP_JITTER", 0)));
}

/**
 * Fallback delay used when the model forgot to reschedule a self-paced loop.
 * Set to 0 to disable the fallback: the chain then ends as soon as a turn
 * finishes without a reschedule.
 */
function keepaliveSeconds(): number {
	return Math.max(0, envNumber("PI_LOOP_KEEPALIVE_SECONDS", DEFAULT_KEEPALIVE_SECONDS));
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24}h`;
}

function formatClock(epochMs: number | undefined): string {
	if (!epochMs) return "unknown";
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A compact one-line call row for a tool. */
function toolCall(label: string, detail: string, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold(label));
	return new Text(detail ? `${title} ${theme.fg("muted", detail)}` : title, 0, 0);
}

/** A compact one-line result row for a tool. */
function toolResult(
	summary: string,
	detail: string | undefined,
	options: { expanded: boolean; isPartial: boolean; isError: boolean },
	theme: Theme,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
	const prefix = options.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
	const body = options.isError ? theme.fg("error", summary) : theme.fg("toolOutput", summary);
	const text = prefix + body;
	if (options.expanded && detail) return new Text(`${text}\n${theme.fg("dim", detail)}`, 0, 0);
	return new Text(text, 0, 0);
}

/** Hide the call row once the result has arrived, leaving one result line. */
function completedCall(): Container {
	return new Container();
}

/** The first text line of a tool result, used as a fallback summary. */
function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	for (const block of result.content ?? []) {
		if (block?.type === "text" && typeof block.text === "string") {
			return block.text.split("\n")[0] ?? "";
		}
	}
	return "";
}

function formatDelay(seconds: number | undefined): string {
	if (seconds === undefined) return "unknown";
	if (seconds < 60) return `${seconds}s`;
	return `${Math.round(seconds / 60)}m`;
}

function jobSummary(job: LoopJob): string {
	if (job.kind === "cron" && job.cron) {
		return `${job.id} ${humanSchedule(job.cron)} · next ${formatClock(job.nextFireAt)}`;
	}
	return `${job.id} self-paced · ${job.scheduledFor ? `next ${formatClock(job.scheduledFor)}` : "unscheduled"}`;
}

function resolveLoopFile(cwd: string): { path: string; content: string } | null {
	const candidates = [path.join(cwd, ".pi", "loop.md"), path.join(os.homedir(), ".pi", "loop.md")];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				const content = fs.readFileSync(candidate, "utf8");
				if (content.trim()) return { path: candidate, content };
			}
		} catch {
			// ignore unreadable candidates
		}
	}
	return null;
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
	const scheduler = new LoopScheduler({
		dispatch: (job) => {
			deliverTick(job);
		},
		onChange: (jobs) => {
			persist(jobs);
			refreshWidget(jobs);
		},
		maxAgeMs,
		jitterFraction,
		jitterCapMs: () => 30 * 60 * 1000,
		canDispatch: () => {
			const ctx = lastCtx;
			if (!ctx) return false;
			try {
				return ctx.isIdle() && !ctx.hasPendingMessages();
			} catch {
				return false;
			}
		},
		onExpire: (job) => {
			if (job.kind === "wakeup") {
				// The job is already gone from the store; retire it so the chain
				// cannot come back and the monitor stops with it.
				stoppedPrompts.add(job.prompt);
				try {
					pi.events.emit(LOOP_STOPPED_CHANNEL, { prompt: job.prompt, reason: "expired" });
				} catch {
					// ignore
				}
			}
		},
	});
	activeScheduler = scheduler;

	/** Chain that the current run belongs to, injected as a system guideline. */
	let runChainId: string | undefined;
	/**
	 * Rules for a loop whose interval the command line did not contain. The
	 * model applies them itself, the way Claude Code's /loop skill does.
	 */
	let pendingScheduleRules: string | undefined;
	/** One-off note attached to the next run. */
	let pendingNote: string | undefined;
	/** Cached context for UI helpers. */
	let lastCtx: ExtensionContext | undefined;
	/**
	 * Prompts whose chain was stopped. A stopped chain must not be resurrected
	 * by a late `schedule_wakeup` call from a turn that a still-running monitor
	 * woke up.
	 */
	const stoppedPrompts = new Set<string>();
	/**
	 * Whether the status widget is shown.
	 *
	 * Claude Code's main session shows no loop status at all: the job id only
	 * appears once, in the CronCreate tool result, and the countdown only in
	 * agent view. The widget is therefore off by default here too; `/loop
	 * widget on` turns it on for people who want the at-a-glance status that
	 * agent view provides in Claude Code.
	 */
	let widgetEnabled = process.env.PI_LOOP_WIDGET === "1";
	/** Signature of the last persisted state, to avoid empty session entries. */
	let lastPersistedSignature = "";

	// ---------------------------------------------------------------- helpers

	function persist(jobs: LoopJob[]): void {
		const signature = JSON.stringify(
			jobs.map((job) => [
				job.id,
				job.kind,
				job.cron,
				job.prompt,
				job.recurring,
				job.nextFireAt,
				job.scheduledFor,
				job.keepaliveUsed,
				job.awaitingReschedule,
				job.durable,
				job.reason,
				job.maxFires,
				job.fireCount,
			]),
		);
		if (signature === lastPersistedSignature) return;
		lastPersistedSignature = signature;

		const durable = jobs.filter((job) => job.durable);
		try {
			pi.appendEntry(STATE_ENTRY, {
				version: 1,
				jobs,
				stopped: [...stoppedPrompts],
				widget: widgetEnabled,
			} satisfies PersistedState);
		} catch {
			// session persistence is best effort
		}
		try {
			// Use the session cwd, not process.cwd(): the user can move the session
			// with /cd without restarting the process.
			const dir = path.join(lastCtx?.cwd ?? process.cwd(), ".pi");
			const file = path.join(dir, "scheduled_tasks.json");
			if (durable.length === 0) {
				if (fs.existsSync(file)) fs.rmSync(file);
				return;
			}
			fs.mkdirSync(dir, { recursive: true });
			const payload: PersistedState = { version: 1, jobs: durable };
			fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		} catch {
			// durable persistence is best effort
		}
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function refreshWidget(jobs: LoopJob[]): void {
		const ctx = lastCtx;
		if (!ctx || !ctx.hasUI) return;
		if (!widgetEnabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines: string[] = [];
		for (const job of jobs) {
			if (job.kind === "cron") {
				const at = job.nextFireAt;
				const inText = at ? `in ${formatDuration(at - Date.now())}` : "pending";
				lines.push(
					ctx.ui.theme.fg(
						"accent",
						`loop ${job.id} · fixed ${job.cron} · next ${formatClock(at)} (${inText}) · ${truncate(job.prompt, 28)}`,
					),
				);
			} else {
				const at = job.scheduledFor;
				const inText = at && at > Date.now() ? `next in ${formatDuration(at - Date.now())}` : "awaiting reschedule";
				lines.push(
					ctx.ui.theme.fg("accent", `loop ${job.id} · self-paced · ${inText} · ${truncate(job.prompt, 28)}`),
				);
			}
		}
		ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined);
	}

	function findChain(prompt: string): LoopJob | undefined {
		return scheduler.findChain(prompt);
	}

	/**
	 * End a chain for good.
	 *
	 * Retiring means: the job is removed, the prompt is remembered so a late
	 * `schedule_wakeup` cannot resurrect the chain, and pi-cc-monitor is told to
	 * stop any monitor that belongs to it. Claude Code requires the last part:
	 * "call ScheduleWakeup with stop: true and TaskStop any Monitor you armed".
	 * Without it, a monitor that keeps firing wakes the agent, the agent
	 * reschedules, and the loop the user just stopped comes back.
	 */
	function retireChain(chain: LoopJob, reason: string): void {
		stoppedPrompts.add(chain.prompt);
		scheduler.remove(chain.id);
		try {
			pi.events.emit(LOOP_STOPPED_CHANNEL, { prompt: chain.prompt, reason });
		} catch {
			// a listener must never break the loop
		}
		const ctx = lastCtx;
		if (ctx) notify(ctx, `loop ${chain.id} ended: ${reason}`, "info");
	}

	function endChain(chain: LoopJob, reason: string): void {
		retireChain(chain, reason);
	}

	function expireOldJobs(ctx: ExtensionContext): void {
		const limit = maxAgeMs();
		if (limit <= 0) return;
		const now = Date.now();
		for (const job of scheduler.list()) {
			if (now - job.createdAt < limit) continue;
			if (job.kind === "wakeup") {
				retireChain(job, "expired");
			} else {
				scheduler.remove(job.id);
				notify(ctx, `loop ${job.id} expired after ${Math.round(limit / 86_400_000)} days`, "info");
			}
		}
	}

	/**
	 * Deliver a scheduled tick.
	 *
	 * `followUp` is the low-priority lane: when the agent is busy the message
	 * waits until the current turn ends instead of cutting into it. That is
	 * Claude Code's "A scheduled prompt fires between your turns, not while
	 * Claude is mid-response."
	 */
	function deliverTick(job: LoopJob): void {
		// Continue the shared per-prompt counter: the immediate run of /loop and
		// the first fire of the job the model created afterwards are one loop.
		const tick = Math.max(tickCounters.get(job.prompt) ?? 0, job.tickCount ?? 0) + 1;
		tickCounters.set(job.prompt, tick);
		scheduler.update(job.id, { tickCount: tick, lastTickAt: Date.now() });
		const content = `${PROVENANCE.replace("{n}", String(tick))}\n${job.prompt}`;
		// A self-paced tick needs the chain guidelines too, so the model knows
		// it has to schedule the next iteration.
		runChainId = job.kind === "wakeup" ? job.id : undefined;
		pi.sendMessage(
			{
				customType: TICK_MESSAGE_TYPE,
				content,
				display: true,
				details: { jobId: job.id, tickCount: tick, cron: job.cron, scheduledAt: Date.now() },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		const cap = job.maxFires;
		if (cap !== undefined && (job.fireCount ?? 0) >= cap) {
			const ctx = lastCtx;
			if (ctx) notify(ctx, `loop ${job.id} reached its cap of ${cap} fires`, "info");
		}
	}

	/**
	 * Run the prompt right away, the way Claude Code's skill does
	 * ("Then immediately execute the parsed prompt now").
	 *
	 * `steer` is the right lane here: it lands in the current turn when the
	 * agent is already working, which is what executing the prompt inside the
	 * skill turn means.
	 */
	/**
	 * How many times each prompt has been run as a loop tick.
	 *
	 * The immediate run of `/loop` and the first fire of the job the model
	 * creates afterwards belong to the same loop, so they share one counter.
	 */
	const tickCounters = new Map<string, number>();

	function runNow(ctx: ExtensionContext, prompt: string, job?: LoopJob): void {
		const tick = (tickCounters.get(prompt) ?? 0) + 1;
		tickCounters.set(prompt, tick);
		if (job) {
			scheduler.update(job.id, {
				tickCount: tick,
				fireCount: (job.fireCount ?? 0) + 1,
				lastTickAt: Date.now(),
			});
		}
		runChainId = job?.kind === "wakeup" ? job.id : undefined;
		pi.sendMessage(
			{
				customType: TICK_MESSAGE_TYPE,
				content: `${PROVENANCE.replace("{n}", String(tick))}\n${prompt}`,
				display: true,
				details: { jobId: job?.id, tickCount: tick, immediate: true, scheduledAt: Date.now() },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function scheduleNote(text: string): void {
		pendingNote = text;
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

	// ---------------------------------------------------------------- command

	pi.registerCommand("loop", {
		description:
			"Run a prompt repeatedly. Usage: /loop [interval] <prompt> | /loop <prompt> | /loop stop [id] | /loop status | /loop settings",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const raw = args.trim();

			if (!raw) {
				await startLoop(ctx, null, "", false, undefined);
				return;
			}

			const [head, ...rest] = raw.split(/\s+/);
			switch (head.toLowerCase()) {
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
					notify(ctx, "Usage: /loop settings [messages|tools] [on|off]", "info");
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

			// Rule 3: no interval -> self-paced
			await startLoop(ctx, intervalSeconds, prompt, flags.durable, flags.maxFires);
		},
	});

	async function startLoop(
		ctx: ExtensionCommandContext,
		intervalSeconds: number | null,
		prompt: string,
		durable: boolean,
		maxFires: number | undefined,
	): Promise<void> {
		expireOldJobs(ctx);

		// Starting a chain again clears the stop marker: the user asked for it.
		stoppedPrompts.delete(prompt);

		let finalPrompt = prompt;

		if (!finalPrompt) {
			const loopFile = resolveLoopFile(ctx.cwd);
			if (loopFile) {
				finalPrompt = `Work the tasks from the loop file at ${loopFile.path}:\n\n${loopFile.content}`;
			} else {
				finalPrompt = MAINTENANCE_PROMPT;
			}
		}

		if (intervalSeconds === null) {
			// The interval could not be parsed from the command line. Claude Code's
			// /loop is a skill, so the model reads the input and works the schedule
			// out itself; the rules below let it do the same here. No chain is
			// created up front: the model picks cron_create (fixed interval) or
			// schedule_wakeup (open ended), and schedule_wakeup creates the chain.
			let rules = LOOP_SCHEDULE_RULES.replace("{prompt}", finalPrompt).replace(
				"{quoted}",
				`"${finalPrompt}"`,
			);
			if (durable) {
				rules +=
					"\n- The user asked for the job to survive a restart: create it with `durable: true`.";
			}
			if (maxFires !== undefined) {
				rules +=
					`\n- The user asked for the job to stop after ${maxFires} fires: create it with \`maxFires: ${maxFires}\`.`;
			}
			pendingScheduleRules = rules;
			runNow(ctx, finalPrompt);
			return;
		}

		const spec = intervalToCron(intervalSeconds);
		if (!spec) {
			notify(ctx, `Invalid interval: ${intervalSeconds}s`, "error");
			return;
		}
		if (!parseCron(spec.cron)) {
			notify(ctx, `Could not build a cron expression for ${intervalSeconds}s`, "error");
			return;
		}
		if (scheduler.size >= MAX_JOBS) {
			notify(ctx, `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`, "error");
			return;
		}

		const job = scheduler.add({
			id: generateId(),
			kind: "cron",
			cron: spec.cron,
			prompt: finalPrompt,
			recurring: true,
			createdAt: Date.now(),
			durable,
			maxFires,
			label: humanSchedule(spec.cron),
			source: "loop_command",
		});

		const expiryDays = Math.round(maxAgeMs() / 86_400_000);
		notify(
			ctx,
			`Scheduled ${job.id} (${job.label}, next run ${formatClock(job.nextFireAt)}) · ${spec.cron} · expires in ${expiryDays}d · cancel with /loop stop ${job.id}` +
				(spec.note ? ` · ${spec.note}` : ""),
			"info",
		);
		scheduleNote(
			`A recurring /loop job was created: id ${job.id}, cron \`${spec.cron}\` (${spec.human}), ` +
				`next run ${formatClock(job.nextFireAt)}, auto-expires after ${expiryDays} days. ` +
				`The user cancels it with \`/loop stop ${job.id}\`.` +
				(spec.note ? ` The requested interval was adjusted: ${spec.note}.` : ""),
		);

		runNow(ctx, finalPrompt, job);
	}

	async function stopLoops(ctx: ExtensionContext, target: string): Promise<void> {
		if (target) {
			const job = scheduler.get(target);
			if (!job) {
				notify(ctx, `No loop with id ${target}`, "warning");
				return;
			}
			if (job.kind === "wakeup") {
				retireChain(job, "stopped by the user");
			} else {
				scheduler.remove(target);
				notify(ctx, `Cancelled loop ${target}`, "info");
			}
			return;
		}
		const jobs = scheduler.list();
		if (!jobs.length) {
			notify(ctx, "No active loops", "info");
			return;
		}
		for (const job of jobs) {
			if (job.kind === "wakeup") {
				// Retiring also tells pi-cc-monitor to stop the monitors that
				// belong to this chain.
				retireChain(job, "stopped by the user");
			} else {
				scheduler.remove(job.id);
			}
		}
		notify(ctx, `Cancelled ${jobs.length} loop${jobs.length === 1 ? "" : "s"}`, "info");
	}

	function showStatus(ctx: ExtensionContext): void {
		const jobs = scheduler.list();
		if (!jobs.length) {
			notify(ctx, "No active loops", "info");
			return;
		}
		const lines = jobs.map((job) => {
			if (job.kind === "cron") {
				const cap = job.maxFires !== undefined ? ` · ${job.fireCount ?? 0}/${job.maxFires} fires` : "";
				return `${job.id}  cron  ${job.cron}  (${job.label ?? describeCron(job.cron ?? "")})  next ${formatClock(job.nextFireAt)}${cap}  ${truncate(job.prompt, 60)}`;
			}
			const at = job.scheduledFor;
			const inText = at && at > Date.now() ? `next in ${formatDuration(at - Date.now())}` : "awaiting reschedule";
			return `${job.id}  self-paced  ${inText}  ${truncate(job.prompt, 60)}`;
		});
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	}

	function showHelp(ctx: ExtensionContext): void {
		const help = [
			"/loop [interval] <prompt>   run <prompt> every <interval> (e.g. 30s, 5m, 2h, 1d)",
			"/loop <prompt>              self-paced: the agent picks the next delay",
			"/loop                       use .pi/loop.md, or the built-in maintenance prompt",
			"/loop stop [id]             cancel one loop, or all of them",
			"/loop status                list the active loops",
			"/loop widget on|off         show or hide the status line above the editor",
			"/loop settings              show UI settings",
			"/loop settings messages on|off   compact two-line markers",
			"/loop settings tools on|off      one-line tool results",
			"",
			"Flags: --durable  write the job to .pi/scheduled_tasks.json so it survives a restart.",
			"       --max N   stop the loop after N fires.",
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(help, "info");
	}

	function showSettings(ctx: ExtensionContext): void {
		const config = loadConfig();
		const lines = [
			`pi-cc settings · ${configPath()}`,
			`  messages:  ${config.compactMessages ? "compact" : "card"}`,
			`  tool rows: ${config.compactToolRows ? "compact" : "default"}`,
			"",
			"Usage: /loop settings messages on|off",
			"       /loop settings tools on|off",
		];
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	}

	function setSetting(ctx: ExtensionContext, key: "messages" | "tools", raw: string | undefined): void {
		const value = (raw ?? "").toLowerCase();
		const on = value === "on" || value === "true" || value === "1";
		const off = value === "off" || value === "false" || value === "0";
		if (!on && !off) {
			showSettings(ctx);
			return;
		}
		const patch: Partial<PiCcConfig> =
			key === "messages" ? { compactMessages: on } : { compactToolRows: on };
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
		notify(ctx, `${key === "messages" ? "Compact message style" : "Compact tool rows"} ${on ? "enabled" : "disabled"}`, "info");
		if (compatChanged) {
			notify(ctx, "pi-cc-extensions excludeRenderers updated · /reload to apply", "info");
		}
	}

	// ------------------------------------------------------------------ tools

	function registerTools(): void {

		pi.registerTool({
			name: "cron_create",
			label: "Create Scheduled Job",
			description:
				"Schedule a prompt to run on a 5-field cron expression in local time. Use this for fixed-interval " +
				"work such as polling a deployment or re-running a check. One-shot reminders should set " +
				"recurring to false. The job id can be cancelled with cron_delete.",
			parameters: Type.Object({
				cron: Type.String({
					description:
						'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes).',
				}),
				prompt: Type.String({ description: "The prompt to enqueue at each fire time." }),
				recurring: Type.Optional(
					Type.Boolean({
						description:
							"true (default) = fire on every cron match until deleted or auto-expired. false = fire once at the next match, then auto-delete.",
					}),
				),
				durable: Type.Optional(
					Type.Boolean({ description: "Write the job to .pi/scheduled_tasks.json so it survives a restart." }),
				),
				maxFires: Type.Optional(
					Type.Number({
						minimum: 1,
						description: "Stop the job after this many fires. Claude Code has no such cap; it is an addition here.",
					}),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				lastCtx = ctx;
				const fields = parseCron(params.cron);
				if (!fields) {
					throw new Error(
						`Invalid cron expression '${params.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
					);
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

				const job = scheduler.add({
					id: generateId(),
					kind: "cron",
					cron: params.cron.trim(),
					prompt: params.prompt,
					recurring: params.recurring ?? true,
					createdAt: Date.now(),
					durable: params.durable ?? false,
					maxFires: params.maxFires,
					// Continue the tick numbering of the /loop run that led here.
					tickCount: tickCounters.get(params.prompt) ?? 0,
					label: humanSchedule(params.cron),
					source: "cron_create",
				});

				return {
					content: [
						{
							type: "text",
							text:
								`Scheduled ${job.id} (${job.label}, next run ${formatClock(job.nextFireAt)})\n` +
								`Cancel it with cron_delete { "id": "${job.id}" }.`,
						},
					],
					details: {
						id: job.id,
						cron: job.cron,
						recurring: job.recurring,
						durable: job.durable,
						nextFireAt: job.nextFireAt,
						prompt: job.prompt,
					},
				};
			},
		});

		pi.registerTool({
			name: "cron_delete",
			label: "Cancel Scheduled Job",
			description: "Cancel a scheduled job by its id. Use it to stop a recurring /loop.",
			parameters: Type.Object({
				id: Type.String({ description: "The job id returned by cron_create." }),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				lastCtx = ctx;
				const job = scheduler.get(params.id);
				if (!job) {
					return {
						content: [{ type: "text" as const, text: `No scheduled job with id ${params.id}.` }],
						details: { cancelled: false, id: params.id },
					};
				}
				scheduler.remove(params.id);
				return {
					content: [{ type: "text" as const, text: `Cancelled job ${params.id}.` }],
					details: { cancelled: true, id: params.id },
				};
			},
		});

		pi.registerTool({
			name: "cron_list",
			label: "List Scheduled Jobs",
			description: "List the scheduled jobs of this session with their ids, cron expressions and next run times.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				lastCtx = ctx;
				const jobs = scheduler.list();
				if (!jobs.length) {
					return {
						content: [{ type: "text" as const, text: "No scheduled jobs." }],
						details: { jobs: [] },
					};
				}
				const text = jobs
					.map((job) =>
						job.kind === "cron"
							? `${job.id}  cron ${job.cron}  recurring=${job.recurring}  next ${formatClock(job.nextFireAt)}  ${truncate(job.prompt, 80)}`
							: `${job.id}  self-paced  next ${job.scheduledFor ? formatClock(job.scheduledFor) : "unscheduled"}  ${truncate(job.prompt, 80)}`,
					)
					.join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { jobs },
				};
			},
		});

		pi.registerTool({
			name: "schedule_wakeup",
			label: "Schedule Next Loop Iteration",
			description:
				"Schedule the next iteration of a self-paced /loop, or end the loop. " +
				"Pass delaySeconds (60-3600), a one-sentence reason, and the same /loop prompt verbatim. " +
				"Pass stop: true when the task is complete or can no longer make progress.",
			parameters: Type.Object({
				delaySeconds: Type.Optional(
					Type.Number({
						description:
							"Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless stop is true.",
					}),
				),
				reason: Type.Optional(
					Type.String({ description: "One short sentence explaining the chosen delay. Shown to the user." }),
				),
				prompt: Type.Optional(
					Type.String({
						description:
							"The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing continues the loop.",
					}),
				),
				stop: Type.Optional(
					Type.Boolean({
						description: "Set to true to end the self-paced loop immediately. All other fields are ignored.",
					}),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				lastCtx = ctx;

				if (params.stop === true) {
					const chains = scheduler.byKind("wakeup");
					for (const chain of chains) {
						// Retiring also stops the monitors that belong to this chain.
						retireChain(chain, "stopped by the agent");
					}
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

				if (typeof params.delaySeconds !== "number" || !Number.isFinite(params.delaySeconds)) {
					throw new Error("delaySeconds is required unless stop is true.");
				}
				const prompt = params.prompt?.trim();
				if (!prompt) {
					throw new Error("prompt is required unless stop is true.");
				}

				const requested = params.delaySeconds;
				const clamped = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, requested));
				const wasClamped = clamped !== requested;

				let chain = findChain(prompt);
				if (!chain) {
					if (stoppedPrompts.has(prompt)) {
						throw new Error(
							`The /loop chain for "${prompt}" was stopped and must not be rescheduled. ` +
								"Do not call schedule_wakeup for it again. If the work should continue, ask the user to start a new /loop.",
						);
					}
					chain = scheduler.add({
						id: generateId(),
						kind: "wakeup",
						prompt,
						recurring: false,
						createdAt: Date.now(),
						chainStartedAt: Date.now(),
						durable: false,
						source: "schedule_wakeup",
					});
				}

				const scheduledFor = Date.now() + clamped * 1000;
				scheduler.update(chain.id, {
					scheduledFor,
					keepaliveUsed: false,
					keepaliveTurn: false,
					awaitingReschedule: false,
					reason: params.reason,
				});

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Next iteration scheduled in ${clamped}s` +
								(wasClamped ? ` (clamped from ${requested}s)` : "") +
								` for loop ${chain.id}.`,
						},
					],
					details: {
						id: chain.id,
						scheduledFor,
						clampedDelaySeconds: clamped,
						wasClamped,
						stopped: false,
					},
				};
			},
		});
	}

	registerTools();

	// ---------------------------------------------------------------- rendering

	/**
	 * Compact one-line tool rows.
	 *
	 * The resolver is consulted every time a tool row renders, so setting
	 * `compactToolRows` to false falls back to Pi's default rendering without
	 * re-registering the tool or reloading the extension.
	 */
	function registerToolRenderers(): void {
		if (typeof pi.registerToolRenderer !== "function") return;
		const renderers: Record<string, ToolRenderers> = {
			cron_create: {
				renderCall(args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					return toolCall("Schedule", `${args.cron ?? ""} · ${truncate(args.prompt ?? "", 40)}`, theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as {
						id?: string;
						cron?: string;
						nextFireAt?: number;
						recurring?: boolean;
						durable?: boolean;
						prompt?: string;
					};
					const summary =
						`Scheduled ${d.id ?? "?"} · ${humanSchedule(d.cron ?? "")} · next ${formatClock(d.nextFireAt)}` +
						(d.recurring === false ? " · one-shot" : "") +
						(d.durable ? " · durable" : "");
					return toolResult(
						summary,
						d.prompt,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
			cron_delete: {
				renderCall(args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					return toolCall("Cancel", args.id ?? "", theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as { cancelled?: boolean; id?: string };
					const summary = d.cancelled ? `Cancelled ${d.id ?? "?"}` : `No job ${d.id ?? "?"}`;
					return toolResult(
						summary,
						undefined,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
			cron_list: {
				renderCall(_args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					return toolCall("List scheduled jobs", "", theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as { jobs?: LoopJob[] };
					const jobs = d.jobs ?? [];
					let summary: string;
					if (!jobs.length) summary = "No scheduled jobs";
					else if (jobs.length === 1) summary = `1 job · ${jobSummary(jobs[0])}`;
					else {
						const shown = jobs.slice(0, 2).map(jobSummary).join(" · ");
						summary = `${jobs.length} jobs · ${shown}${jobs.length > 2 ? " …" : ""}`;
					}
					const detail = options.expanded
						? jobs.map((job) => `${jobSummary(job)} · ${truncate(job.prompt, 60)}`).join("\n")
						: undefined;
					return toolResult(
						summary || resultText(result),
						detail,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
			schedule_wakeup: {
				renderCall(args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					if (args.stop === true) return toolCall("Stop loop", "", theme);
					const reason = args.reason ? ` · ${truncate(args.reason, 40)}` : "";
					return toolCall("Wakeup", `${formatDelay(args.delaySeconds)}${reason}`, theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as {
						id?: string;
						scheduledFor?: number;
						clampedDelaySeconds?: number;
						wasClamped?: boolean;
						stopped?: boolean;
						cancelledWakeups?: number;
					};
					const summary = d.stopped
						? `Stopped · ${d.cancelledWakeups ?? 0} wakeup${d.cancelledWakeups === 1 ? "" : "s"} cancelled`
						: `Wakeup in ${formatDelay(d.clampedDelaySeconds)} · loop ${d.id ?? "?"}${d.wasClamped ? " (clamped)" : ""}`;
					const detail = options.expanded
						? [context.args.reason, d.scheduledFor ? `at ${formatClock(d.scheduledFor)}` : undefined]
								.filter(Boolean)
								.join(" · ")
						: undefined;
					return toolResult(
						summary,
						detail || undefined,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
		};

		pi.registerToolRenderer((toolName, next) => {
			if (!loadConfig().compactToolRows) return next();
			return renderers[toolName] ?? next();
		});
	}

	registerToolRenderers();

	// ----------------------------------------------------------------- events

	/**
	 * Draw the tick as a quiet two-line block instead of Pi's default
	 * `[pi-cc-loop-tick]` title.
	 */
	pi.registerMessageRenderer(TICK_MESSAGE_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as {
			tickCount?: number;
			jobId?: string;
			cron?: string;
			immediate?: boolean;
		};
		const text = contentText(message.content);
		const prompt = stripProvenance(text, /^\[loop tick[^\]]*\]\n?/);
		if (!loadConfig().compactMessages) {
			const summary = firstLine(prompt);
			const header = `loop tick #${details.tickCount ?? "?"}${summary ? ` · ${summary}` : ""}`;
			return renderCard({
				header,
				body: prompt,
				expanded: options.expanded,
				outputPad: options.outputPad,
				theme,
			});
		}
		const label = details.tickCount !== undefined ? `loop #${details.tickCount}` : "loop";
		const stamp = formatStamp(message.timestamp);
		const header = stamp
			? `${theme.fg("accent", theme.bold(label))}${theme.fg("dim", " · ")}${theme.fg("muted", stamp)}`
			: theme.fg("accent", theme.bold(label));

		const meta: string[] = [];
		if (details.jobId) meta.push(`job ${details.jobId}`);
		if (details.cron) meta.push(`cron ${details.cron}`);
		else if (details.immediate) meta.push("immediate run");
		else meta.push("self-paced");
		meta.push("scheduled by /loop");

		return renderBlock({
			header,
			body: bodyLines(prompt),
			meta,
			expanded: options.expanded,
			outputPad: options.outputPad,
			theme,
			maxBodyLines: 3,
		});
	});

	/**
	 * A monitor event supersedes the chain's pending fallback heartbeat.
	 *
	 * The handler is deliberately synchronous: pi-cc-monitor emits the bus
	 * event before it sends the notification, so this must land before the
	 * woken turn starts. Otherwise the turn would end, find no reschedule, and
	 * arm a keepalive on top of the event that just arrived.
	 */
	pi.events.on(MONITOR_WAKE_CHANNEL, (data) => {
		const wake = data as { loopPrompt?: string } | undefined;
		if (!wake?.loopPrompt) return;
		const chain = scheduler.findChain(wake.loopPrompt);
		if (!chain) return;
		scheduler.update(chain.id, { scheduledFor: undefined, awaitingReschedule: true });
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		const notes: string[] = [];

		if (pendingNote) {
			notes.push(pendingNote);
			pendingNote = undefined;
		}

		const chainId = runChainId;
		runChainId = undefined;
		if (chainId) {
			const chain = scheduler.get(chainId);
			if (chain) {
				notes.push(LOOP_GUIDELINES.replace("{prompt}", chain.prompt).replace("{quoted}", `"${chain.prompt}"`));
				// Self-paced chains can be woken by an event instead of the timer.
				// Only mention the Monitor tool when it is actually installed.
				if (chain.kind === "wakeup" && monitorToolAvailable()) {
					notes.push(MONITOR_GUIDELINES.replace("{quoted}", `"${chain.prompt}"`));
				}
			}
		}

		if (pendingScheduleRules) {
			notes.push(pendingScheduleRules);
			pendingScheduleRules = undefined;
			if (monitorToolAvailable()) {
				notes.push(MONITOR_GUIDELINES.replace("{quoted}", `"the /loop prompt"`));
			}
		}

		if (!notes.length) return;
		const options = event.systemPromptOptions;
		options.promptGuidelines = [...(options.promptGuidelines ?? []), ...notes];
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		scheduler.noteTurnStarted();
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		expireOldJobs(ctx);

		const now = Date.now();
		for (const chain of scheduler.byKind("wakeup")) {
			// The keepalive turn is the model's last chance to reschedule.
			if (chain.keepaliveTurn) {
				scheduler.update(chain.id, { keepaliveTurn: false, awaitingReschedule: false });
				endChain(chain, "keepalive budget exhausted (the model did not reschedule twice)");
				continue;
			}

			// The model rescheduled: it armed the next wakeup itself.
			if (!chain.awaitingReschedule) continue;

			const limit = maxAgeMs();
			if (limit > 0 && chain.chainStartedAt !== undefined && now - chain.chainStartedAt >= limit) {
				scheduler.update(chain.id, { awaitingReschedule: false });
				endChain(chain, "aged out");
				continue;
			}

			if (chain.keepaliveUsed) continue;

			const fallback = keepaliveSeconds();
			if (fallback <= 0) {
				scheduler.update(chain.id, { awaitingReschedule: false });
				endChain(chain, "the model did not reschedule (keepalive disabled)");
				continue;
			}

			scheduler.update(chain.id, {
				scheduledFor: now + fallback * 1000,
				keepaliveUsed: true,
				awaitingReschedule: false,
			});
			notify(
				ctx,
				`loop ${chain.id}: the model did not reschedule — keepalive armed (${Math.round(fallback / 60)} min)`,
				"warning",
			);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		// The agent is idle now: a pending tick may go out.
		scheduler.notifyIdle();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		restoreState(ctx);
		expireOldJobs(ctx);
		scheduler.start();
		if (syncPiCcExtensionsExcludes(piCcToolNames(), loadConfig().compactToolRows)) {
			notify(ctx, "pi-cc-extensions excludeRenderers updated · /reload to apply", "info");
		}
	});

	pi.on("session_before_switch", async () => {
		for (const chain of scheduler.byKind("wakeup")) {
			retireChain(chain, "the session was switched");
		}
		scheduler.clear(false);
	});

	pi.on("session_shutdown", async () => {
		scheduler.stop();
		scheduler.clear(false);
	});

	// -------------------------------------------------------------- restoring

	function restoreState(ctx: ExtensionContext): void {
		scheduler.clear(false);

		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: PersistedState };
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.jobs) {
				for (const prompt of entry.data.stopped ?? []) stoppedPrompts.add(prompt);
				if (typeof entry.data.widget === "boolean") widgetEnabled = entry.data.widget;
				for (const job of entry.data.jobs) {
					if (job.kind === "wakeup") {
						// A self-paced chain is not restored: the wakeup that was pending
						// died with the previous process.
						scheduler.restore({ ...job, scheduledFor: undefined, keepaliveUsed: true });
					} else {
						scheduler.restore(job);
						scheduler.arm(job);
					}
				}
				break;
			}
		}

		// Durable jobs live in .pi/scheduled_tasks.json and are restored even
		// across a restart.
		const file = path.join(ctx.cwd, ".pi", "scheduled_tasks.json");
		try {
			if (fs.existsSync(file)) {
				const payload = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedState;
				for (const job of payload.jobs ?? []) {
					if (scheduler.get(job.id)) continue;
					if (job.kind === "wakeup") {
						scheduler.restore({ ...job, scheduledFor: undefined, keepaliveUsed: true });
					} else {
						scheduler.restore(job);
						scheduler.arm(job);
					}
				}
			}
		} catch {
			// ignore a malformed file
		}

		const pending = scheduler.byKind("wakeup");
		if (pending.length) {
			notify(
				ctx,
				`${pending.length} self-paced loop(s) were not restored: their wakeup did not survive the restart. Re-run /loop to restart them.`,
				"warning",
			);
		}
		refreshWidget(scheduler.list());
	}
}
