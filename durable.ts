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
 *     can be taken over.
 *   - The runtime files are added to `.git/info/exclude`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextRunTime, storedJob, type LoopJob, type LoopScheduler, type TimingConfig } from "./schedule.ts";

export const DURABLE_FILE = path.join(".pi", "scheduled_tasks.json");
export const LOCK_FILE = path.join(".pi", "scheduled_tasks.lock");
/** A lock whose heartbeat is older than this is stale. */
export const LOCK_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

interface DurableFileData {
	version: 1;
	jobs: LoopJob[];
}

function writeAtomic(file: string, text: string): void {
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, text, "utf8");
	fs.renameSync(temp, file);
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

	/** Insert or replace one job, keeping every other job in the file. */
	upsert(job: LoopJob): void {
		this.assertWritable();
		const jobs = this.read().filter((other) => other.id !== job.id);
		jobs.push(storedJob(job));
		this.write(jobs);
	}

	remove(id: string): boolean {
		const jobs = this.read();
		const kept = jobs.filter((job) => job.id !== id);
		if (kept.length === jobs.length) return false;
		this.write(kept);
		return true;
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
	acquiredAt: number;
	heartbeatAt: number;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
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
	private readonly isAlive: (pid: number) => boolean;
	private readonly staleMs: number;

	constructor(cwd: string, identity: LockIdentity = {}) {
		this.file = path.join(cwd, LOCK_FILE);
		this.pid = identity.pid ?? process.pid;
		this.hostname = identity.hostname ?? os.hostname();
		this.isAlive = identity.isAlive ?? pidAlive;
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

	tryAcquire(now = Date.now()): boolean {
		if (this.owned) return true;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.mkdirSync(path.dirname(this.file), { recursive: true });
				const fd = fs.openSync(this.file, "wx");
				const info: LockInfo = { pid: this.pid, hostname: this.hostname, acquiredAt: now, heartbeatAt: now };
				fs.writeSync(fd, `${JSON.stringify(info)}\n`);
				fs.closeSync(fd);
				this.owned = true;
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
				const info = this.holder();
				// The same process after /reload, a dead process, or a missed heartbeat.
				const takeOver = !info || info.pid === this.pid || this.isStale(info, now);
				if (!takeOver) return false;
				try {
					fs.rmSync(this.file, { force: true });
				} catch {
					return false;
				}
			}
		}
		return false;
	}

	heartbeat(now = Date.now()): void {
		if (!this.owned) return;
		const info = this.holder();
		if (!info || info.pid !== this.pid) {
			// Someone took the lock over (we were considered stale).
			this.owned = false;
			return;
		}
		try {
			writeAtomic(this.file, `${JSON.stringify({ ...info, heartbeatAt: now })}\n`);
		} catch {
			// a missed heartbeat only matters after a minute
		}
	}

	release(): void {
		if (!this.owned) return;
		this.owned = false;
		if (this.holder()?.pid === this.pid) {
			try {
				fs.rmSync(this.file, { force: true });
			} catch {
				// a stale lock is taken over after a minute anyway
			}
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
		const wanted = ["**/.pi/scheduled_tasks.json", "**/.pi/scheduled_tasks.lock"];
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
		return this.lock.owned;
	}

	holderPid(): number | undefined {
		return this.lock.holder()?.pid;
	}

	/** Take the lock if the project has durable jobs, then load them. */
	start(now = Date.now()): void {
		if (this.store.exists()) this.acquireAndLoad(now);
	}

	stop(): void {
		this.lock.release();
	}

	/** Called on every scheduler scan; throttled. */
	maintain(now = Date.now()): void {
		if (now - this.lastMaintenance < this.options.syncMs()) return;
		this.lastMaintenance = now;
		if (!this.owner) {
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
		}
		return this.owner ? { runsHere: true } : { runsHere: false, holderPid: this.holderPid() };
	}

	/** Remove a durable job from the file. */
	remove(id: string): boolean {
		const removed = this.store.remove(id);
		this.lastMtime = this.store.mtime();
		return removed;
	}

	/** Record a fire: update the job in the file, or remove it after its last run. */
	afterFire(job: LoopJob, finished: boolean): void {
		try {
			if (finished) this.store.remove(job.id);
			else this.store.upsert(job);
			this.lastMtime = this.store.mtime();
		} catch {
			// best effort
		}
	}

	/** Durable jobs this session does not run (listed, not fired). */
	foreignJobs(): Array<LoopJob & { foreignReason: "other-session" | "other-folder" }> {
		return this.store
			.read()
			.filter((job) => !this.options.scheduler.get(job.id))
			.map((job) => ({
				...job,
				nextFireAt: nextRunTime(job, job.recurring ? Date.now() : job.createdAt, this.options.timing()) ?? undefined,
				foreignReason: this.ownsProject(job) ? ("other-session" as const) : ("other-folder" as const),
			}));
	}

	private ownsProject(job: LoopJob): boolean {
		return !job.createdInProject || path.resolve(job.createdInProject) === path.resolve(this.options.cwd);
	}

	private save(job: LoopJob): void {
		try {
			this.store.upsert(job);
			this.lastMtime = this.store.mtime();
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
			adopted = true;
		}
		if (adopted) scheduler.refresh();
		this.lastMtime = this.store.mtime();
		if (missed.length) this.options.onMissed(missed);
	}

	private dropLoadedJobs(): void {
		const { scheduler } = this.options;
		for (const job of scheduler.list()) if (job.durable) scheduler.remove(job.id);
	}
}
