/**
 * Job store and dispatch scheduler for the pi-cc-loop extension.
 *
 * Modelled on Claude Code's scheduler (v2.1.306):
 *
 *   - "The scheduler checks every second for due tasks and enqueues them at low
 *     priority."  -> one scan per second, not one timer per job.
 *   - "A scheduled prompt fires between your turns, not while Claude is
 *     mid-response."  -> a due job waits until the agent is idle.
 *   - "If a task's scheduled time passes while Claude is busy on a long-running
 *     request, it fires once when Claude becomes idle, not once per missed
 *     interval."  -> at most one pending tick per job, no backlog.
 */

import { nextFireAfter, parseCron, type CronFields } from "./cron.ts";

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
	/** Epoch ms of the next cron slot. */
	nextFireAt?: number;
	/** Epoch ms of the next dynamic wakeup. */
	scheduledFor?: number;
	/** Epoch ms when the dynamic chain started; used for the age-out check. */
	chainStartedAt?: number;
	/** True once the keepalive fallback has been used for this chain. */
	keepaliveUsed?: boolean;
	/** True while the current turn is the keepalive turn (the model's last chance). */
	keepaliveTurn?: boolean;
	/** True after a tick was dispatched, until the model reschedules. */
	awaitingReschedule?: boolean;
	/** True when the job is due and waiting for the agent to go idle. */
	pending?: boolean;
	/** Epoch ms when the job became pending. */
	dueAt?: number;
	/** Epoch ms when the job was last dispatched. */
	dispatchedAt?: number;
	/** Turn sequence number at dispatch; set once a turn confirms delivery. */
	dispatchedTurnSeq?: number;
	/** How many times the job has fired. */
	fireCount?: number;
	/** How many ticks the model has seen. */
	tickCount?: number;
	/** Epoch ms of the last fire. */
	lastTickAt?: number;
	/** Optional cap on the number of fires. */
	maxFires?: number;
	/** True when the job is written to disk and survives a restart. */
	durable: boolean;
	/** Free-form label shown in `/loop status`. */
	label?: string;
	/** Why the delay was chosen (dynamic jobs). */
	reason?: string;
	/** Where the job came from: `loop_command`, `cron_create`, `schedule_wakeup`. */
	source: string;
}

export interface SchedulerHooks {
	/** Deliver the job's prompt to the agent. */
	dispatch: (job: LoopJob) => void;
	/** Called whenever the job set changes, so state can be persisted. */
	onChange?: (jobs: LoopJob[]) => void;
	/** Max age of a recurring job in ms; 0 disables the check. */
	maxAgeMs?: () => number;
	/** Fraction of its period a recurring job may be delayed by; 0 disables jitter. */
	jitterFraction?: () => number;
	/** Upper bound for the jitter delay in ms. */
	jitterCapMs?: () => number;
	/** True when the agent is idle and has nothing queued: a tick may go out. */
	canDispatch?: () => boolean;
	/** Called when a job passes its maximum age and is dropped. */
	onExpire?: (job: LoopJob) => void;
}

/** Claude Code checks for due tasks once a second. */
export const SCAN_INTERVAL_MS = 1000;

/**
 * The scan interval can be raised for tests, where the scan is driven by hand.
 */
export function scanIntervalMs(): number {
	const raw = process.env.PI_LOOP_SCAN_MS;
	if (raw === undefined) return SCAN_INTERVAL_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : SCAN_INTERVAL_MS;
}

/**
 * How long a dispatched tick may sit without a turn starting before it is
 * treated as undelivered and requeued.
 */
export const DISPATCH_CONFIRM_MS = 30_000;

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
	private hooks: SchedulerHooks;
	private inFlightId: string | null = null;
	private turnSeq = 0;

	constructor(hooks: SchedulerHooks) {
		this.hooks = hooks;
	}

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

	/** The dynamic chain that owns the given wakeup prompt, if any. */
	findChain(prompt: string): LoopJob | undefined {
		return this.list().find((job) => job.kind === "wakeup" && job.prompt === prompt);
	}

	add(job: LoopJob): LoopJob {
		this.jobs.set(job.id, job);
		this.arm(job);
		this.changed();
		return job;
	}

	update(id: string, patch: Partial<LoopJob>): LoopJob | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		const updated = { ...job, ...patch };
		this.jobs.set(id, updated);
		this.changed();
		return updated;
	}

	remove(id: string): boolean {
		const existed = this.jobs.delete(id);
		if (existed && this.inFlightId === id) this.inFlightId = null;
		if (existed) this.changed();
		return existed;
	}

	/** Remove every job of a kind (used by `/loop stop`). */
	removeKind(kind: JobKind): number {
		const ids = this.byKind(kind).map((job) => job.id);
		for (const id of ids) this.jobs.delete(id);
		if (ids.length) this.changed();
		return ids.length;
	}

	clear(notify = true): void {
		this.jobs.clear();
		this.inFlightId = null;
		if (notify) this.changed();
	}

	/** Restore a job without arming it (used while loading persisted state). */
	restore(job: LoopJob): void {
		this.jobs.set(job.id, job);
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

	/** Compute the first fire time of a cron job. */
	arm(job: LoopJob, from = Date.now()): void {
		if (job.kind !== "cron" || !job.cron) return;
		const fields = parseCron(job.cron);
		if (!fields) return;
		const next = nextFireAfter(fields, new Date(from));
		if (!next) return;
		job.nextFireAt = next.getTime() + this.jitterFor(job, fields, next);
	}

	// ------------------------------------------------------------- dispatch

	/**
	 * Run one scan: expire old jobs, requeue unconfirmed ticks, mark due jobs
	 * pending, and dispatch the oldest pending job when the agent is idle.
	 */
	tick(now = Date.now()): void {
		this.expire(now);
		this.retryUnconfirmed(now);
		this.markDue(now);
		this.tryDispatch(now);
	}

	/**
	 * The agent settled: a dispatched tick has finished its turn, so the next
	 * pending job may go out.
	 */
	notifyIdle(): void {
		this.releaseInFlight();
		this.tick();
	}

	/** A turn started: any dispatched tick is confirmed delivered. */
	noteTurnStarted(): void {
		this.turnSeq += 1;
		if (!this.inFlightId) return;
		const job = this.jobs.get(this.inFlightId);
		if (job) job.dispatchedTurnSeq = this.turnSeq;
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

	/** Dispatch the oldest pending job when nothing is in flight and the agent is idle. */
	private tryDispatch(now: number): boolean {
		if (this.inFlightId) return false;
		const job = this.oldestPending();
		if (!job) return false;
		if (this.hooks.canDispatch && !this.hooks.canDispatch()) return false;

		job.pending = false;
		job.dueAt = undefined;
		job.dispatchedAt = now;
		job.dispatchedTurnSeq = undefined;
		job.fireCount = (job.fireCount ?? 0) + 1;
		job.lastTickAt = now;

		this.inFlightId = job.id;

		if (job.kind === "wakeup") {
			// A wakeup that fired from the keepalive is the model's last chance.
			if (job.keepaliveUsed) job.keepaliveTurn = true;
			job.awaitingReschedule = true;
		} else {
			this.advanceCron(job, now);
		}
		this.changed();

		this.hooks.dispatch(job);

		// A one-shot cron job and a capped cron job are done after their last
		// fire. A wakeup chain is never deleted here: the model re-arms it.
		if (job.kind === "cron" && (!job.recurring || (job.maxFires !== undefined && (job.fireCount ?? 0) >= job.maxFires))) {
			this.jobs.delete(job.id);
			this.inFlightId = null;
			this.changed();
		}
		return true;
	}

	/** Recompute the next cron slot after a fire. */
	private advanceCron(job: LoopJob, now: number): void {
		if (!job.cron) return;
		const fields = parseCron(job.cron);
		if (!fields) return;
		const next = nextFireAfter(fields, new Date(now));
		if (!next) return;
		job.nextFireAt = next.getTime() + this.jitterFor(job, fields, next);
	}

	/**
	 * A tick that was dispatched but never started a turn is treated as
	 * undelivered: the job goes back to pending so it fires again.
	 */
	private retryUnconfirmed(now: number): void {
		if (!this.inFlightId) return;
		const job = this.jobs.get(this.inFlightId);
		if (!job) {
			this.inFlightId = null;
			return;
		}
		if (job.dispatchedTurnSeq !== undefined) return;
		if (now - (job.dispatchedAt ?? 0) < DISPATCH_CONFIRM_MS) return;
		job.pending = true;
		job.dueAt = now;
		this.inFlightId = null;
		this.changed();
	}

	/** Called when the agent settles: the in-flight tick has finished its turn. */
	releaseInFlight(): void {
		this.inFlightId = null;
	}

	private oldestPending(): LoopJob | undefined {
		return this.list()
			.filter((job) => job.pending)
			.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
	}

	// --------------------------------------------------------------- expiry

	private expire(now: number): void {
		const limit = this.hooks.maxAgeMs?.() ?? 0;
		if (limit <= 0) return;
		let changed = false;
		for (const job of this.list()) {
			if (now - job.createdAt < limit) continue;
			this.jobs.delete(job.id);
			if (this.inFlightId === job.id) this.inFlightId = null;
			changed = true;
			this.hooks.onExpire?.(job);
		}
		if (changed) this.changed();
	}

	/**
	 * Randomised delay for recurring jobs, so many sessions polling the same
	 * target do not all fire on the same second.
	 */
	private jitterFor(job: LoopJob, fields: CronFields, next: Date): number {
		if (!job.recurring) return 0;
		const fraction = this.hooks.jitterFraction?.() ?? 0;
		if (!(fraction > 0)) return 0;
		const following = nextFireAfter(fields, next);
		if (!following) return 0;
		const period = following.getTime() - next.getTime();
		const cap = this.hooks.jitterCapMs?.() ?? 30 * 60 * 1000;
		return Math.round(Math.random() * Math.min(fraction * period, cap));
	}

	private changed(): void {
		this.hooks.onChange?.(this.list());
	}
}
