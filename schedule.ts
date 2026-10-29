/**
 * Job store and dispatch scheduler for the pi-cc-loop extension.
 *
 * Modelled on Claude Code's scheduler:
 *
 *   - "The scheduler checks every second for due tasks and enqueues them at low
 *     priority."  -> one scan per second, not one timer per job.
 *   - "A scheduled prompt fires between your turns, not while Claude is
 *     mid-response."  -> a due job waits until the agent is idle.
 *   - "If a task's scheduled time passes while Claude is busy on a long-running
 *     request, it fires once when Claude becomes idle, not once per missed
 *     interval."  -> at most one pending tick per job, no backlog.
 *   - "Recurring tasks automatically expire 7 days after creation. The task
 *     fires one final time, then deletes itself."  -> a recurring job past its
 *     maximum age is deleted right after its next fire. One-shot jobs do not
 *     expire.
 *   - Run times carry Claude Code's fixed per-job offset (see nextRunTime).
 *
 * There is no delivery confirmation or retry: Pi marks the session busy as
 * soon as a tick starts a turn, so the idle check alone keeps ticks one at a
 * time, and a tick that fails to start is dropped (Claude Code drops it too).
 */

import { nextFireAfter, parseCron } from "./cron.ts";

export type JobKind = "cron" | "wakeup";

export interface LoopJob {
	id: string;
	kind: JobKind;
	/** 5-field cron expression, for `cron` jobs. */
	cron?: string;
	/** The prompt that is sent to the model on every fire. */
	prompt: string;
	recurring: boolean;
	createdAt: number;
	/** Epoch ms of the next cron run, offset included. */
	nextFireAt?: number;
	/** Epoch ms of the next self-paced wakeup. */
	scheduledFor?: number;
	/** Epoch ms when the self-paced chain started; used for the 7-day limit. */
	chainStartedAt?: number;
	/** True once the keepalive fallback has been used for this chain. */
	keepaliveUsed?: boolean;
	/** True while the current turn is the keepalive turn (the model's last chance). */
	keepaliveTurn?: boolean;
	/** True after a wakeup fired, until the model reschedules. */
	awaitingReschedule?: boolean;
	/** True when the job is due and waiting for the agent to go idle. */
	pending?: boolean;
	/** Epoch ms when the job became pending. */
	dueAt?: number;
	/** How many times the job has fired. */
	fireCount?: number;
	/** How many ticks the model has seen. */
	tickCount?: number;
	/** Epoch ms of the last fire. */
	lastFiredAt?: number;
	/** Optional cap on the number of fires. */
	maxFires?: number;
	/** True when the job lives in .pi/scheduled_tasks.json and survives restarts. */
	durable: boolean;
	/** The project folder a durable job was created in; it only runs there. */
	createdInProject?: string;
	/** Free-form label shown in `/loop status`. */
	label?: string;
	/** Why the delay was chosen (self-paced chains). */
	reason?: string;
	/** Where the job came from: `loop_command`, `cron_create`, `schedule_wakeup`. */
	source: string;
}

/** Fields that only mean something while the job lives in this process. */
const TRANSIENT_FIELDS = ["pending", "dueAt", "awaitingReschedule", "keepaliveTurn"] as const;

/** A copy of the job without its in-process state, for persisting. */
export function storedJob(job: LoopJob): LoopJob {
	const copy = { ...job };
	for (const field of TRANSIENT_FIELDS) delete copy[field];
	return copy;
}

/**
 * Claude Code's offsets (v2.1.302 defaults, also in its docs): "a recurring
 * task starts each run late by up to half the gap to the next run, and by at
 * most 30 minutes"; "a one-shot task scheduled for :00 or :30 runs up to 90
 * seconds early".
 *
 * Claude Code also starts `*\/5` jobs 15 seconds early, so that consecutive runs
 * stay inside its 5 minute prompt cache. That is dropped here: it makes the
 * interval 4m45s instead of 5m, and caches now last far longer than 5 minutes.
 */
export interface TimingConfig {
	recurringFrac: number;
	recurringCapMs: number;
	oneShotMaxMs: number;
	oneShotMinuteMod: number;
}

export const DEFAULT_TIMING: TimingConfig = {
	recurringFrac: 0.5,
	recurringCapMs: 30 * 60_000,
	oneShotMaxMs: 90_000,
	oneShotMinuteMod: 30,
};

/** A fraction in [0, 1) derived from the job id, so a job always gets the same offset. */
export function idFraction(id: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 4294967296;
}

/**
 * When a cron job runs next, measured from `from`, with Claude Code's
 * offsets. Recurring jobs measure from their last fire (or creation); a
 * one-shot measures from its creation, so its run time never moves.
 */
export function nextRunTime(
	job: Pick<LoopJob, "id" | "cron" | "recurring">,
	from: number,
	timing: TimingConfig = DEFAULT_TIMING,
): number | null {
	if (!job.cron) return null;
	const fields = parseCron(job.cron);
	if (!fields) return null;
	const first = nextFireAfter(fields, new Date(from));
	if (!first) return null;
	const slot = first.getTime();

	if (!job.recurring) {
		if (new Date(slot).getMinutes() % timing.oneShotMinuteMod !== 0) return slot;
		return Math.max(slot - idFraction(job.id) * timing.oneShotMaxMs, from);
	}

	const second = nextFireAfter(fields, first);
	if (!second) return slot;
	const period = second.getTime() - slot;
	return slot + Math.min(idFraction(job.id) * timing.recurringFrac * period, timing.recurringCapMs);
}

export interface SchedulerHooks {
	/** Deliver the job's prompt to the agent. */
	dispatch: (job: LoopJob) => void;
	/** Called after a fire; `finished` when the job was deleted (one-shot, cap, final run). */
	afterDispatch?: (job: LoopJob, finished: boolean) => void;
	/** Called whenever the job set changes, so state can be persisted. */
	onChange?: (jobs: LoopJob[]) => void;
	/** True when idle and this job may fire (durable jobs also need their live lock). */
	canDispatch?: (job: LoopJob) => boolean;
	/** The offsets to apply to run times. */
	timing?: () => TimingConfig;
	/** Max age of a recurring job in ms; 0 disables the limit. */
	maxAgeMs?: () => number;
	/** A recurring job ran its final time and was deleted. */
	onExpire?: (job: LoopJob) => void;
	/** Runs at the start of every scan (housekeeping such as durable jobs). */
	onScan?: (now: number) => void;
	/** A delivery threw (Pi's API is stale once the session is replaced); the tick is dropped. */
	onDispatchError?: (job: LoopJob, error: Error) => void;
}

/** Claude Code checks for due tasks once a second. */
export const SCAN_INTERVAL_MS = 1000;

/** The scan interval can be raised for tests, where the scan is driven by hand. */
export function scanIntervalMs(): number {
	const raw = process.env.PI_LOOP_SCAN_MS;
	if (raw === undefined) return SCAN_INTERVAL_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : SCAN_INTERVAL_MS;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateId(length = 8): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
	}
	return out;
}

export class LoopScheduler {
	private jobs = new Map<string, LoopJob>();
	private scanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly hooks: SchedulerHooks) {}

	get size(): number {
		return this.jobs.size;
	}

	list(): LoopJob[] {
		return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): LoopJob | undefined {
		return this.jobs.get(id);
	}

	byKind(kind: JobKind): LoopJob[] {
		return this.list().filter((job) => job.kind === kind);
	}

	/** The self-paced chain that owns the given prompt, if any. */
	findChain(prompt: string): LoopJob | undefined {
		return this.list().find((job) => job.kind === "wakeup" && job.prompt === prompt);
	}

	add(job: LoopJob): LoopJob {
		this.jobs.set(job.id, job);
		this.arm(job);
		this.changed();
		return job;
	}

	/** Update a job in place, so references held elsewhere stay current. */
	update(id: string, patch: Partial<LoopJob>): LoopJob | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		Object.assign(job, patch);
		this.changed();
		return job;
	}

	remove(id: string): boolean {
		const existed = this.jobs.delete(id);
		if (existed) this.changed();
		return existed;
	}

	clear(notify = true): void {
		this.jobs.clear();
		if (notify) this.changed();
	}

	/** Put a job back without arming it or announcing a change. */
	restore(job: LoopJob): void {
		this.jobs.set(job.id, job);
	}

	/** Announce the current job set (after a series of restores). */
	refresh(): void {
		this.changed();
	}

	/**
	 * Compute a cron job's next run. Recurring jobs measure from `from`
	 * (default now); a one-shot always measures from its creation.
	 */
	arm(job: LoopJob, from = Date.now()): void {
		if (job.kind !== "cron") return;
		const next = nextRunTime(job, job.recurring ? from : job.createdAt, this.timing());
		job.nextFireAt = next ?? undefined;
	}

	// ------------------------------------------------------------- lifecycle

	/** Start the once-per-second scan. */
	start(): void {
		if (this.scanTimer) return;
		this.scanTimer = setInterval(() => this.tick(), scanIntervalMs());
		// Never keep the process alive just for a pending tick.
		if (typeof this.scanTimer.unref === "function") this.scanTimer.unref();
	}

	stop(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
	}

	// ------------------------------------------------------------- dispatch

	/** Run one scan: housekeeping, mark due jobs pending, dispatch the oldest when idle. */
	tick(now = Date.now()): void {
		try {
			this.hooks.onScan?.(now);
		} catch {
			// Housekeeping (the durable file, the footer) is best effort. This runs
			// from a timer, where an exception would take Pi down with it.
		}
		this.markDue(now);
		this.tryDispatch(now);
	}

	/** The agent settled: a pending tick may go out now. */
	notifyIdle(): void {
		this.tick();
	}

	/**
	 * Mark jobs whose time has come as pending. A job is pending at most once:
	 * missed intervals coalesce into a single tick, like Claude Code.
	 */
	private markDue(now: number): void {
		let changed = false;
		for (const job of this.jobs.values()) {
			if (job.pending) continue;
			const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
			if (at === undefined || at > now) continue;
			job.pending = true;
			job.dueAt = now;
			if (job.kind === "wakeup") {
				// The wakeup has been consumed; the model has to arm the next one.
				job.scheduledFor = undefined;
			}
			changed = true;
		}
		if (changed) this.changed();
	}

	/** Dispatch the oldest pending job when the agent is idle. */
	private tryDispatch(now: number): void {
		const job = this.list()
			.filter((candidate) => candidate.pending)
			.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
		if (!job) return;
		if (this.hooks.canDispatch && !this.hooks.canDispatch(job)) return;

		job.pending = false;
		job.dueAt = undefined;
		job.fireCount = (job.fireCount ?? 0) + 1;
		job.lastFiredAt = now;

		let finished = false;
		let expired = false;
		if (job.kind === "wakeup") {
			// A wakeup that fired from the keepalive is the model's last chance.
			if (job.keepaliveUsed) job.keepaliveTurn = true;
			job.awaitingReschedule = true;
		} else {
			const capped = job.maxFires !== undefined && job.fireCount >= job.maxFires;
			const maxAge = this.hooks.maxAgeMs?.() ?? 0;
			expired = job.recurring && maxAge > 0 && now - job.createdAt >= maxAge;
			const next = job.recurring && !capped && !expired ? nextRunTime(job, now, this.timing()) : null;
			job.nextFireAt = next ?? undefined;
			finished = next === null;
		}

		try {
			this.hooks.dispatch(job);
		} catch (error) {
			// Dropped, like any tick that fails to start; the job keeps its next
			// run. Not rethrown: this runs from a timer, where an exception would
			// take Pi down with it.
			this.hooks.onDispatchError?.(job, error instanceof Error ? error : new Error(String(error)));
		}
		if (finished) this.jobs.delete(job.id);
		this.hooks.afterDispatch?.(job, finished);
		if (expired) this.hooks.onExpire?.(job);
		this.changed();
	}

	private timing(): TimingConfig {
		return this.hooks.timing?.() ?? DEFAULT_TIMING;
	}

	private changed(): void {
		this.hooks.onChange?.(this.list());
	}
}
