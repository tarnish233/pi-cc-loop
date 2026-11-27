/**
 * Durable jobs: `.pi/scheduled_tasks.json`, shared by every Pi session in a
 * project, and the lock that decides which session runs them.
 *
 * Claude Code keeps durable tasks in `.claude/scheduled_tasks.json` and uses
 * `.claude/scheduled_tasks.lock` so that only one session fires them. Its docs
 * add: "When the `.claude` directory or that file is a symlink, Claude Code
 * returns an error instead of scheduling the task. A saved task runs only in
 * the project folder where you created it. If you copy the file into another
 * folder, such as a new worktree, sessions there list the copied tasks but
 * don't run them."
 *
 * Rules here:
 *   - Every write is a read-modify-write of one job, so sessions never
 *     overwrite each other's jobs, and the file is never deleted wholesale.
 *   - The session holding the lock runs the durable jobs and picks up jobs
 *     other sessions add or remove. The lock carries a heartbeat; a lock whose
 *     heartbeat is older than a minute (or whose process is gone) is stale and
 *     can be taken over. A PID identifies a process, not a session: main and
 *     subagent sessions in that process each get their own ownership token.
 *   - The runtime files are added to `.git/info/exclude`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPidAlive, withFileLock } from "./plugin-settings.ts";
import { nextRunTime, storedJob, type LoopJob, type LoopScheduler, type TimingConfig } from "./schedule.ts";
import { writeAtomic } from "./temp-files.ts";

export const DURABLE_FILE = path.join(".pi", "scheduled_tasks.json");
export const LOCK_FILE = path.join(".pi", "scheduled_tasks.lock");
/** A lock whose heartbeat is older than this is stale. */
export const LOCK_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

interface DurableFileData {
	version: 1;
	jobs: LoopJob[];
}

function isSymlink(file: string): boolean {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

/** `.pi/scheduled_tasks.json`, edited one job at a time. */
export class DurableStore {
	readonly file: string;
	readonly dir: string;

	constructor(readonly cwd: string) {
		this.dir = path.join(cwd, ".pi");
		this.file = path.join(cwd, DURABLE_FILE);
	}

	exists(): boolean {
		return fs.existsSync(this.file);
	}

	read(): LoopJob[] {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DurableFileData>;
			return Array.isArray(data.jobs) ? data.jobs.filter((job) => job && typeof job.id === "string") : [];
		} catch {
			return [];
		}
	}

	/**
	 * The write path's read: only a missing file means "no jobs". A file that
	 * cannot be read or parsed must throw, so a read-modify-write can never
	 * replace it (and every other session's jobs) with just the new job.
	 */
	private readForWrite(): LoopJob[] {
		let text: string;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const data = JSON.parse(text) as Partial<DurableFileData>;
		// Valid JSON of the wrong shape is still someone's data, not an empty
		// store: rewriting it would destroy intact records.
		if (data === null || typeof data !== "object" || Array.isArray(data) || (data.jobs !== undefined && !Array.isArray(data.jobs))) {
			throw new Error(`Refusing to rewrite ${this.file}: not a durable jobs document.`);
		}
		return Array.isArray(data.jobs) ? data.jobs.filter((job) => job && typeof job.id === "string") : [];
	}

	/** Modification time, to notice changes made by other sessions. */
	mtime(): number | undefined {
		try {
			return fs.statSync(this.file).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/** Like Claude Code, refuse to write through a symlinked `.pi` or task file. */
	assertWritable(): void {
		if (isSymlink(this.dir) || isSymlink(this.file)) {
			throw new Error(
				`Refusing to write durable jobs: ${isSymlink(this.dir) ? this.dir : this.file} is a symlink.`,
			);
		}
	}

	/**
	 * Insert or replace one job, keeping every other job in the file. With
	 * `onlyIfPresent`, a job another session removed is not reinserted; the
	 * existence check and the write share one lock. Returns whether it wrote.
	 */
	upsert(job: LoopJob, onlyIfPresent = false): boolean {
		this.assertWritable();
		fs.mkdirSync(this.dir, { recursive: true });
		return withFileLock(this.file, () => {
			this.assertWritable();
			const jobs = this.readForWrite();
			const kept = jobs.filter((other) => other.id !== job.id);
			if (onlyIfPresent && kept.length === jobs.length) return false;
			kept.push(storedJob(job));
			this.write(kept);
			return true;
		});
	}

	remove(id: string): boolean {
		this.assertWritable();
		if (!this.exists()) return false;
		return withFileLock(this.file, () => {
			this.assertWritable();
			const jobs = this.readForWrite();
			const kept = jobs.filter((job) => job.id !== id);
			if (kept.length === jobs.length) return false;
			this.write(kept);
			return true;
		});
	}

	private write(jobs: LoopJob[]): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const data: DurableFileData = { version: 1, jobs };
		writeAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
	}
}

interface LockInfo {
	pid: number;
	hostname: string;
	/** Absent on legacy locks, which remain valid until released or stale. */
	ownerToken?: string;
	acquiredAt: number;
	heartbeatAt: number;
}

/** Who a lock belongs to. Injectable so tests can play several processes. */
export interface LockIdentity {
	pid?: number;
	hostname?: string;
	isAlive?: (pid: number) => boolean;
	staleMs?: number;
}

/** `.pi/scheduled_tasks.lock`: which session runs the project's durable jobs. */
export class SchedulerLock {
	readonly file: string;
	owned = false;
	private readonly pid: number;
	private readonly hostname: string;
	private readonly ownerToken = randomUUID();
	private readonly isAlive: (pid: number) => boolean;
	private readonly staleMs: number;

	constructor(cwd: string, identity: LockIdentity = {}) {
		this.file = path.join(cwd, LOCK_FILE);
		this.pid = identity.pid ?? process.pid;
		this.hostname = identity.hostname ?? os.hostname();
		this.isAlive = identity.isAlive ?? ((pid) => isPidAlive(pid));
		this.staleMs = identity.staleMs ?? LOCK_STALE_MS;
	}

	holder(): LockInfo | null {
		try {
			const info = JSON.parse(fs.readFileSync(this.file, "utf8")) as LockInfo;
			return typeof info.pid === "number" ? info : null;
		} catch {
			return null;
		}
	}

	isStale(info: LockInfo, now: number): boolean {
		if (now - info.heartbeatAt > this.staleMs) return true;
		return info.hostname === this.hostname && !this.isAlive(info.pid);
	}

	private matches(info: LockInfo | null): boolean {
		return info?.pid === this.pid && info.hostname === this.hostname && info.ownerToken === this.ownerToken;
	}

	/** Check the file, not only the instance's last acquisition result. */
	owns(): boolean {
		if (this.owned && !this.matches(this.holder())) this.owned = false;
		return this.owned;
	}

	/** Serialize takeovers, heartbeats and releases across processes too. */
	private guarded<T>(action: () => T): T {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		return withFileLock(this.file, action);
	}

	tryAcquire(now = Date.now()): boolean {
		try {
			return this.guarded(() => {
				const held = this.holder();
				if (this.matches(held)) return (this.owned = true);
				this.owned = false;
				// /reload releases the old instance first. Sharing its PID does not
				// let a concurrent child session steal its still-live lock.
				if (held && !this.isStale(held, now)) return false;
				fs.rmSync(this.file, { force: true });
				const fd = fs.openSync(this.file, "wx");
				try {
					const info: LockInfo = { pid: this.pid, hostname: this.hostname, ownerToken: this.ownerToken, acquiredAt: now, heartbeatAt: now };
					fs.writeSync(fd, `${JSON.stringify(info)}\n`);
				} finally {
					fs.closeSync(fd);
				}
				return (this.owned = true);
			});
		} catch {
			this.owned = false;
			return false;
		}
	}

	/** Renew only our own lease; a failed renewal must not permit dispatch. */
	heartbeat(now = Date.now()): boolean {
		if (!this.owned) return false;
		try {
			return this.guarded(() => {
				const info = this.holder();
				if (!this.matches(info)) {
					this.owned = false;
					return false;
				}
				writeAtomic(this.file, `${JSON.stringify({ ...info, heartbeatAt: now })}\n`);
				return true;
			});
		} catch {
			this.owned = false;
			return false;
		}
	}

	release(): void {
		if (!this.owned) return;
		try {
			this.guarded(() => {
				if (this.matches(this.holder())) fs.rmSync(this.file, { force: true });
			});
		} catch {
			// a stale lock is taken over after a minute anyway
		} finally {
			this.owned = false;
		}
	}
}

/** The git directory that owns `cwd`, following worktree `.git` files. */
function gitCommonDir(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const dotGit = path.join(dir, ".git");
		try {
			const stat = fs.statSync(dotGit);
			if (stat.isDirectory()) return dotGit;
			const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
			if (!match) return undefined;
			const gitDir = path.resolve(dir, match[1].trim());
			try {
				return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
			} catch {
				return gitDir;
			}
		} catch {
			// no .git here; keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Add our runtime files to `.git/info/exclude`, like Claude Code does for its own. */
export function ensureGitExclude(cwd: string): void {
	try {
		const common = gitCommonDir(cwd);
		if (!common) return;
		const file = path.join(common, "info", "exclude");
		const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const lines = current.split("\n").map((line) => line.trim());
		const wanted = ["**/.pi/scheduled_tasks.json", "**/.pi/scheduled_tasks.lock", "**/.pi/scheduled_tasks.json.write.lock", "**/.pi/scheduled_tasks.lock.write.lock"];
		const missing = wanted.filter((entry) => !lines.includes(entry));
		if (!missing.length) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const prefix = current && !current.endsWith("\n") ? "\n" : "";
		fs.appendFileSync(file, `${prefix}# pi-cc-loop runtime files\n${missing.join("\n")}\n`);
	} catch {
		// best effort
	}
}

export interface DurableRuntimeOptions {
	cwd: string;
	scheduler: LoopScheduler;
	timing: () => TimingConfig;
	maxAgeMs: () => number;
	/** How often housekeeping runs (heartbeat, sync, lock attempts). */
	syncMs: () => number;
	/** One-shot jobs that came due while no session ran them. */
	onMissed: (jobs: LoopJob[]) => void;
	/** Lock identity; tests use it to play several Pi processes. */
	lock?: LockIdentity;
}

/** Where a durable job runs, for the tool result. */
export interface Placement {
	runsHere: boolean;
	holderPid?: number;
}

/** The durable-jobs side of one session. */
export class DurableRuntime {
	readonly store: DurableStore;
	private readonly lock: SchedulerLock;
	private lastMtime: number | undefined;
	private lastMaintenance = 0;
	private lastHeartbeat = 0;

	constructor(private readonly options: DurableRuntimeOptions) {
		this.store = new DurableStore(options.cwd);
		this.lock = new SchedulerLock(options.cwd, options.lock);
	}

	get owner(): boolean {
		return this.lock.owns();
	}

	/** Revalidate and renew immediately before a durable fire, even when sync is throttled. */
	canDispatch(): boolean {
		this.lastHeartbeat = Date.now();
		if (this.lock.heartbeat(this.lastHeartbeat)) return true;
		this.dropLoadedJobs();
		return false;
	}

	holderPid(): number | undefined {
		return this.lock.holder()?.pid;
	}

	/** Take the lock if the project has durable jobs, then load them. */
	start(now = Date.now()): void {
		if (this.store.exists()) {
			this.store.assertWritable();
			this.acquireAndLoad(now);
		}
	}

	stop(): void {
		this.lock.release();
	}

	/** Called on every scheduler scan; throttled. */
	maintain(now = Date.now()): void {
		if (now - this.lastMaintenance < this.options.syncMs()) return;
		this.lastMaintenance = now;
		this.store.assertWritable();
		if (!this.owner) {
			this.dropLoadedJobs();
			if (this.store.exists()) this.acquireAndLoad(now);
			return;
		}
		if (now - this.lastHeartbeat >= HEARTBEAT_MS) {
			this.lastHeartbeat = now;
			this.lock.heartbeat(now);
			if (!this.owner) {
				this.dropLoadedJobs();
				return;
			}
		}
		const mtime = this.store.mtime();
		if (mtime !== this.lastMtime) this.sync(now);
	}

	/**
	 * Save a new durable job. It runs here when this session holds (or can
	 * take) the lock; otherwise the session that holds it picks it up.
	 */
	add(job: LoopJob, now = Date.now()): Placement {
		this.store.assertWritable();
		job.createdInProject = path.resolve(this.options.cwd);
		this.store.upsert(job);
		ensureGitExclude(this.options.cwd);
		if (this.owner) {
			this.options.scheduler.add(job);
			this.save(job);
		} else {
			this.acquireAndLoad(now);
			// The new job was loaded from the file and armed in the scheduler.
			// Persist that already-jittered time so another session's read-only
			// view does not have to recompute it from a later clock. This is also
			// the one best-effort retry if sync's own save failed: sync skips
			// already-loaded jobs, and the mtime snapshot can equal the failed
			// write's mtime, so maintenance alone might never persist the time.
			const loaded = this.options.scheduler.get(job.id);
			if (loaded) this.save(loaded);
		}
		return this.owner ? { runsHere: true } : { runsHere: false, holderPid: this.holderPid() };
	}

	/** Remove a durable job from the file. */
	remove(id: string): boolean {
		const removed = this.store.remove(id);
		// A single-job write is not a full sync: the next maintenance must still
		// reload whatever other sessions changed in the file meanwhile.
		this.lastMtime = undefined;
		return removed;
	}

	/** Record a fire: update the job in the file, or remove it after its last run. */
	afterFire(job: LoopJob, finished: boolean): void {
		if (!this.owner) {
			this.dropLoadedJobs();
			return;
		}
		try {
			// Update only if the job still exists: another session may have
			// cancelled it since the last sync, and a late fire must not undo that.
			if (finished) this.store.remove(job.id);
			else if (!this.store.upsert(job, true)) this.options.scheduler.remove(job.id);
			this.lastMtime = undefined;
		} catch {
			// best effort
		}
	}

	/** Durable jobs this session does not run (listed, not fired). */
	foreignJobs(): Array<LoopJob & { foreignReason: "other-session" | "other-folder" }> {
		return this.store
			.read()
			.filter((job) => !this.options.scheduler.get(job.id))
			.map((job) => {
				// Prefer the owner's persisted, already-jittered run time. It may be
				// in the past when the owner is busy and the fire is waiting for
				// idle: keeping it is the honest read-only snapshot. Only old or
				// broken files need a computed fallback.
				const storedNext = typeof job.nextFireAt === "number" && Number.isFinite(job.nextFireAt) ? job.nextFireAt : undefined;
				const nextFireAt =
					storedNext ??
					nextRunTime(job, job.recurring ? Date.now() : job.createdAt, this.options.timing()) ??
					undefined;
				return {
					...job,
					nextFireAt,
					foreignReason: this.ownsProject(job) ? ("other-session" as const) : ("other-folder" as const),
				};
			});
	}

	private ownsProject(job: LoopJob): boolean {
		return !job.createdInProject || path.resolve(job.createdInProject) === path.resolve(this.options.cwd);
	}

	private save(job: LoopJob): void {
		try {
			// Post-arm persistence must not resurrect a job another session
			// cancelled between the arm and this write.
			if (!this.store.upsert(job, true)) this.options.scheduler.remove(job.id);
			this.lastMtime = undefined;
		} catch {
			// best effort
		}
	}

	private acquireAndLoad(now: number): void {
		if (!this.lock.tryAcquire(now)) return;
		this.lastHeartbeat = now;
		this.sync(now);
	}

	/** Bring the scheduler in line with the file: adopt new jobs, drop removed ones. */
	private sync(now: number): void {
		const { scheduler } = this.options;
		// Snapshot before reading: a write that lands after the read must trigger
		// the next sync, not be absorbed into the cache as already applied.
		const mtime = this.store.mtime();
		const jobs = this.store.read();
		const ids = new Set(jobs.map((job) => job.id));
		for (const job of scheduler.list()) {
			if (job.durable && !ids.has(job.id)) scheduler.remove(job.id);
		}

		const missed: LoopJob[] = [];
		const maxAge = this.options.maxAgeMs();
		let adopted = false;
		for (const stored of jobs) {
			if (scheduler.get(stored.id) || !this.ownsProject(stored)) continue;
			const job = { ...storedJob(stored), durable: true };
			if (!job.recurring) {
				const due = nextRunTime(job, job.createdAt, this.options.timing());
				if (due === null || due <= now) {
					missed.push(job);
					this.store.remove(job.id);
					continue;
				}
			} else if (maxAge > 0 && now - job.createdAt >= maxAge) {
				// Expired while nobody ran it: dropped, like a restored expired task.
				this.store.remove(job.id);
				continue;
			}
			scheduler.restore(job);
			scheduler.arm(job, now);
			// Persist the armed time so other sessions list the real next fire,
			// not the previous owner's stale one.
			this.save(job);
			adopted = true;
		}
		if (adopted) scheduler.refresh();
		this.lastMtime = mtime;
		if (missed.length) this.options.onMissed(missed);
	}

	private dropLoadedJobs(): void {
		const { scheduler } = this.options;
		for (const job of scheduler.list()) if (job.durable) scheduler.remove(job.id);
	}
}
