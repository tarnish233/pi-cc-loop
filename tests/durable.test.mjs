/**
 * Durable jobs: one .pi/scheduled_tasks.json per project, run by the one Pi
 * session that holds .pi/scheduled_tasks.lock.
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeHarness, start, stateEntries } from "./harness.mjs";
import { loadModule } from "./helpers.mjs";

const { DurableRuntime, DurableStore, SchedulerLock, LOCK_FILE, LOCK_STALE_MS } = await loadModule("durable.ts");
const { DEFAULT_TIMING, LoopScheduler } = await loadModule("schedule.ts");

const tempProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-durable-"));
const readFile = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "scheduled_tasks.json"), "utf8")).jobs;

/** One Pi session: several sessions may share a pid, as subagents do. */
function session(cwd, pid, isAlive = () => true) {
	const fired = [];
	const missed = [];
	let runtime;
	const scheduler = new LoopScheduler({
		dispatch: (job) => fired.push(job.id),
		afterDispatch: (job, finished) => job.durable && runtime.afterFire(job, finished),
		canDispatch: (job) => !job.durable || runtime.canDispatch(),
	});
	runtime = new DurableRuntime({
		cwd,
		scheduler,
		timing: () => DEFAULT_TIMING,
		maxAgeMs: () => 7 * 86_400_000,
		syncMs: () => 0,
		onMissed: (jobs) => missed.push(...jobs),
		lock: { pid, isAlive },
	});
	return { scheduler, runtime, fired, missed };
}

function cronJob(id, extra = {}) {
	return { id, kind: "cron", cron: "*/10 * * * *", prompt: `task ${id}`, recurring: true, createdAt: Date.now(), durable: true, source: "test", ...extra };
}

test("only the session holding the lock runs durable jobs", () => {
	const cwd = tempProject();
	const a = session(cwd, 1001);
	const b = session(cwd, 1002);

	assert.deepEqual(a.runtime.add(cronJob("a1")), { runsHere: true }, "the first session takes the lock");
	b.runtime.start();
	assert.equal(b.runtime.owner, false);
	assert.equal(b.scheduler.size, 0, "the second session does not run the job too");

	const placement = b.runtime.add(cronJob("b1"));
	assert.deepEqual(placement, { runsHere: false, holderPid: 1001 });
	a.runtime.maintain();
	assert.deepEqual(a.scheduler.list().map((job) => job.id).sort(), ["a1", "b1"], "the holder picks up the new job");
	assert.deepEqual(b.runtime.foreignJobs().map((job) => [job.id, job.foreignReason]).sort(), [
		["a1", "other-session"],
		["b1", "other-session"],
	]);
});

test("main and subagent sessions sharing a PID never both run the same durable job", () => {
	const cwd = tempProject();
	const main = session(cwd, process.pid);
	const child = session(cwd, process.pid);
	try {
		main.runtime.add(cronJob("shared"));
		child.runtime.start();
		assert.equal(main.runtime.owner, true);
		assert.equal(child.runtime.owner, false, "the same PID is not permission to steal a live session's lock");
		assert.equal(child.scheduler.size, 0);
		main.scheduler.get("shared").nextFireAt = Date.now() - 1;
		main.scheduler.tick();
		child.scheduler.tick();
		assert.deepEqual(main.fired, ["shared"]);
		assert.deepEqual(child.fired, []);
		assert.equal(readFile(cwd)[0].fireCount, 1);

		main.runtime.stop();
		child.runtime.maintain();
		assert.equal(child.runtime.owner, true, "the child can take over after the main instance releases");
		assert.ok(child.scheduler.get("shared"));
	} finally {
		main.runtime.stop();
		child.runtime.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a replacement lock in the same process is neither renewed nor removed by the old instance", () => {
	for (const operation of ["heartbeat", "release"]) {
		const cwd = tempProject();
		const old = new SchedulerLock(cwd);
		try {
			assert.equal(old.tryAcquire(), true);
			const before = JSON.parse(fs.readFileSync(old.file, "utf8"));
			assert.equal(typeof before.ownerToken, "string");
			assert.ok(before.ownerToken.length > 0);
			const replacement = { ...before, ownerToken: randomUUID() };
			fs.writeFileSync(old.file, JSON.stringify(replacement));
			old[operation]();
			assert.deepEqual(JSON.parse(fs.readFileSync(old.file, "utf8")), replacement, `${operation} must check the instance token`);
			assert.equal(old.owned, false);
		} finally {
			old.release();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("lock ownership requires matching PID, hostname and instance token", () => {
	for (const change of [{ pid: -1 }, { hostname: "another-host" }, { ownerToken: randomUUID() }]) {
		const cwd = tempProject();
		const old = new SchedulerLock(cwd);
		try {
			assert.equal(old.tryAcquire(), true);
			const replacement = { ...JSON.parse(fs.readFileSync(old.file, "utf8")), ...change };
			fs.writeFileSync(old.file, JSON.stringify(replacement));
			old.heartbeat();
			old.release();
			assert.deepEqual(JSON.parse(fs.readFileSync(old.file, "utf8")), replacement);
			assert.equal(old.owned, false);
		} finally {
			old.release();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("a heartbeat waits for a concurrent lock update, then rechecks the ownership token", async () => {
	const cwd = tempProject();
	const lock = new SchedulerLock(cwd);
	let child;
	try {
		assert.equal(lock.tryAcquire(), true);
		const replacement = { ...JSON.parse(fs.readFileSync(lock.file, "utf8")), ownerToken: randomUUID() };
		const ready = path.join(cwd, "ready");
		const script = `const fs=require('node:fs'),os=require('node:os');
			const [file,ready,replacement]=process.argv.slice(1),mutex=file+'.write.lock';
			fs.writeFileSync(mutex,JSON.stringify({pid:process.pid,hostname:os.hostname()}));
			fs.writeFileSync(ready,'ready');
			setTimeout(()=>{fs.writeFileSync(file,replacement);fs.unlinkSync(mutex)},250);`;
		child = spawn(process.execPath, ["-e", script, lock.file, ready, JSON.stringify(replacement)], { stdio: "ignore" });
		const exited = new Promise((resolve) => child.once("exit", resolve));
		const until = Date.now() + 3000;
		while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		assert.ok(fs.existsSync(ready), "the other process holds the scheduler-lock mutation mutex");
		assert.equal(lock.heartbeat(), false, "ownership is checked after waiting, not before");
		assert.equal(lock.owned, false);
		assert.equal(await exited, 0);
		assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, "utf8")), replacement);
	} finally {
		if (child?.exitCode === null) child.kill();
		lock.release();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a stale same-PID lock can be taken over, but the old instance cannot release the new lock", () => {
	const cwd = tempProject();
	const now = Date.now();
	const old = new SchedulerLock(cwd);
	const next = new SchedulerLock(cwd);
	try {
		assert.equal(old.tryAcquire(now), true);
		assert.equal(next.tryAcquire(now + 1), false);
		assert.equal(next.tryAcquire(now + LOCK_STALE_MS + 1), true);
		const replacement = JSON.parse(fs.readFileSync(next.file, "utf8"));
		old.release();
		assert.deepEqual(JSON.parse(fs.readFileSync(next.file, "utf8")), replacement);
		next.heartbeat(now + LOCK_STALE_MS + 2);
		assert.equal(JSON.parse(fs.readFileSync(next.file, "utf8")).heartbeatAt, now + LOCK_STALE_MS + 2);
	} finally {
		old.release();
		next.release();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("fresh legacy PID-only locks are not stolen; stale ones migrate to an instance token", () => {
	const cwd = tempProject();
	const now = Date.now();
	const lock = new SchedulerLock(cwd);
	try {
		fs.mkdirSync(path.dirname(lock.file), { recursive: true });
		const legacy = { pid: process.pid, hostname: os.hostname(), acquiredAt: now, heartbeatAt: now };
		fs.writeFileSync(lock.file, JSON.stringify(legacy));
		assert.equal(lock.tryAcquire(now), false, "a fresh old-version lock is still held by a live process");
		assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, "utf8")), legacy);
		assert.equal(lock.tryAcquire(now + LOCK_STALE_MS + 1), true);
		assert.equal(typeof JSON.parse(fs.readFileSync(lock.file, "utf8")).ownerToken, "string");
	} finally {
		lock.release();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a session never overwrites or deletes the other sessions' jobs", () => {
	const cwd = tempProject();
	const a = session(cwd, 1001);
	const b = session(cwd, 1002);
	a.runtime.add(cronJob("a1"));
	a.runtime.add(cronJob("a2"));
	b.runtime.start();

	b.runtime.remove("a1");
	assert.deepEqual(readFile(cwd).map((job) => job.id), ["a2"], "only the cancelled job is removed");
	a.runtime.maintain();
	assert.deepEqual(a.scheduler.list().map((job) => job.id), ["a2"], "the holder drops the cancelled job");
});

test("when the holder stops, another session takes over the jobs", () => {
	const cwd = tempProject();
	const a = session(cwd, 1001);
	const b = session(cwd, 1002);
	a.runtime.add(cronJob("a1"));
	b.runtime.start();
	assert.equal(b.runtime.owner, false);

	a.runtime.stop();
	b.runtime.maintain();
	assert.equal(b.runtime.owner, true);
	assert.deepEqual(b.scheduler.list().map((job) => job.id), ["a1"]);
});

test("a lock left by a dead process or without a heartbeat is taken over", () => {
	const dead = tempProject();
	session(dead, 1001).runtime.add(cronJob("a1")); // never released
	const b = session(dead, 1002, (pid) => pid !== 1001);
	b.runtime.start();
	assert.equal(b.runtime.owner, true, "the holder's process is gone");

	const silent = tempProject();
	session(silent, 1001).runtime.add(cronJob("a1"));
	const lockFile = path.join(silent, ".pi", "scheduled_tasks.lock");
	const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
	fs.writeFileSync(lockFile, JSON.stringify({ ...lock, heartbeatAt: Date.now() - 61_000 }));
	const c = session(silent, 1003);
	c.runtime.start();
	assert.equal(c.runtime.owner, true, "no heartbeat for over a minute");
});

test("durable fires update the file; a one-shot leaves it after its run", () => {
	const cwd = tempProject();
	const a = session(cwd, 1001);
	a.runtime.add(cronJob("poll"));
	const soon = new Date(Date.now() + 3 * 60_000);
	a.runtime.add(cronJob("once", { recurring: false, cron: `${soon.getMinutes()} ${soon.getHours()} ${soon.getDate()} ${soon.getMonth() + 1} *` }));

	for (const id of ["poll", "once"]) a.scheduler.get(id).nextFireAt = Date.now() - 1;
	a.scheduler.tick();
	a.scheduler.tick();
	assert.deepEqual(a.fired.sort(), ["once", "poll"]);
	const jobs = readFile(cwd);
	assert.deepEqual(jobs.map((job) => job.id), ["poll"], "the one-shot is gone");
	assert.equal(jobs[0].fireCount, 1, "the recurring job's fire is recorded");
});

test("one-shots missed while nobody ran them are removed and reported", () => {
	const cwd = tempProject();
	const due = new Date(Date.now() - 3600_000);
	// Written two hours ago by a session that has exited since.
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "scheduled_tasks.json"),
		JSON.stringify({
			version: 1,
			jobs: [
				cronJob("late", {
					recurring: false,
					cron: `${due.getMinutes()} ${due.getHours()} ${due.getDate()} ${due.getMonth() + 1} *`,
					createdAt: Date.now() - 2 * 3600_000,
					createdInProject: cwd,
				}),
			],
		}),
	);

	const next = session(cwd, 1002);
	next.runtime.start();
	assert.deepEqual(next.missed.map((job) => job.id), ["late"]);
	assert.equal(next.scheduler.size, 0, "it does not run on its own");
	assert.deepEqual(readFile(cwd), [], "and it is removed from the file");
});

test("a job copied from another folder is listed but not run", () => {
	const cwd = tempProject();
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "scheduled_tasks.json"),
		JSON.stringify({ version: 1, jobs: [cronJob("copied", { createdInProject: "/some/other/checkout" })] }),
	);
	const a = session(cwd, 1001);
	a.runtime.start();
	assert.equal(a.scheduler.size, 0);
	assert.deepEqual(a.runtime.foreignJobs().map((job) => [job.id, job.foreignReason]), [["copied", "other-folder"]]);
});

test("a symlinked .pi refuses all durable mutations, including deleting a job", () => {
	const cwd = tempProject();
	const elsewhere = tempProject();
	fs.writeFileSync(path.join(elsewhere, "scheduled_tasks.json"), JSON.stringify({ version: 1, jobs: [cronJob("a1")] }));
	fs.symlinkSync(elsewhere, path.join(cwd, ".pi"));
	const a = session(cwd, 1001);
	assert.throws(() => a.runtime.add(cronJob("a2")), /symlink/);
	assert.throws(() => a.runtime.remove("a1"), /symlink/);
	assert.deepEqual(readFile(cwd).map((job) => job.id), ["a1"], "the symlink target was never edited");
	assert.throws(() => a.runtime.start(), /symlink/, "startup must not create a scheduler lock through the symlink");
	assert.equal(fs.existsSync(path.join(elsewhere, "scheduled_tasks.lock")), false);
});

test("concurrent durable writers do not overwrite jobs saved by another process", async () => {
	const cwd = tempProject();
	const dir = path.join(cwd, ".pi");
	const file = path.join(dir, "scheduled_tasks.json");
	fs.mkdirSync(dir);
	fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [] }));
	const ready = path.join(dir, "writer-ready");
	const otherJob = cronJob("other");
	const script = `const fs=require('node:fs'),os=require('node:os');
		const [file,ready,job]=process.argv.slice(1),lock=file+'.write.lock';
		fs.writeFileSync(lock,JSON.stringify({pid:process.pid,hostname:os.hostname()}));
		fs.writeFileSync(ready,'ready');
		setTimeout(()=>{fs.writeFileSync(file,JSON.stringify({version:1,jobs:[JSON.parse(job)]}));fs.unlinkSync(lock)},250);`;
	const child = spawn(process.execPath, ["-e", script, file, ready, JSON.stringify(otherJob)], { stdio: "ignore" });
	try {
		const until = Date.now() + 3000;
		while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		assert.ok(fs.existsSync(ready), "the other process holds the writer lock");
		new DurableStore(cwd).upsert(cronJob("mine"));
		await new Promise((resolve) => child.once("exit", resolve));
		assert.deepEqual(readFile(cwd).map((job) => job.id).sort(), ["mine", "other"]);
	} finally {
		if (child.exitCode === null) child.kill();
	}
});

test("a symlinked durable store does not stop session-only schedules", async () => {
	const cwd = tempProject();
	const elsewhere = tempProject();
	fs.writeFileSync(path.join(elsewhere, "scheduled_tasks.json"), JSON.stringify({ version: 1, jobs: [cronJob("a1")] }));
	fs.symlinkSync(elsewhere, path.join(cwd, ".pi"));
	const h = await start(makeHarness(cwd));
	try {
		await h.tools.get("cron_create").execute("c", { cron: "*/5 * * * *", prompt: "session-only" }, undefined, undefined, h.ctx);
		assert.equal(h.scheduler().list().some((job) => job.prompt === "session-only"), true);
	} finally {
		h.scheduler().stop();
	}
});

test("the runtime files are added to .git/info/exclude", () => {
	const cwd = tempProject();
	fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".git", "info", "exclude"), "# existing\n");
	session(cwd, 1001).runtime.add(cronJob("a1"));
	const exclude = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
	assert.match(exclude, /^# existing$/m, "existing entries are kept");
	assert.match(exclude, /^\*\*\/\.pi\/scheduled_tasks\.json$/m);
	assert.match(exclude, /^\*\*\/\.pi\/scheduled_tasks\.lock$/m);
	assert.match(exclude, /^\*\*\/\.pi\/scheduled_tasks\.lock\.write\.lock$/m);
});

// ------------------------------------------------------------ in the extension

test("durable jobs live in the file, never in session entries", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("cron_create")
		.execute("c", { cron: "*/5 * * * *", prompt: "ping", durable: true }, undefined, undefined, h.ctx);
	const id = readFile(h.ctx.cwd)[0].id;
	assert.ok(h.scheduler().get(id), "this session runs it");
	assert.equal(h.lastState().jobs.length, 0, "a resumed session must not restore (and run) it a second time");

	await h.handlers.get("session_shutdown")({ reason: "reload" }, h.ctx);
	const h2 = makeHarness(h.ctx.cwd);
	h2.ctx.sessionManager.getEntries = () => stateEntries(h);
	await start(h2, { type: "session_start", reason: "reload" });
	try {
		assert.equal(h2.scheduler().list().filter((job) => job.id === id).length, 1, "loaded once, from the file after the old instance released");
	} finally {
		await h2.handlers.get("session_shutdown")({ reason: "quit" }, h2.ctx);
	}
});

test("a lost durable lock prevents dispatch even before the next housekeeping scan", async () => {
	const cwd = tempProject();
	const h = await start(makeHarness(cwd));
	try {
		await h.tools.get("cron_create").execute("d", { cron: "*/5 * * * *", prompt: "durable", durable: true }, undefined, undefined, h.ctx);
		await h.tools.get("cron_create").execute("s", { cron: "*/5 * * * *", prompt: "session-only" }, undefined, undefined, h.ctx);
		const durableJob = h.scheduler().list().find((job) => job.durable);
		const localJob = h.scheduler().list().find((job) => !job.durable);
		const lockFile = path.join(cwd, LOCK_FILE);
		process.env.PI_LOOP_DURABLE_SYNC_MS = "600000";
		h.scheduler().tick(); // establish the maintenance throttle with neither job due
		const before = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		const replacement = { ...before, ownerToken: randomUUID() };
		fs.writeFileSync(lockFile, JSON.stringify(replacement));
		durableJob.nextFireAt = localJob.nextFireAt = Date.now() - 1;
		h.scheduler().tick();
		assert.equal(h.sent.length, 0, "no prompt is delivered from a lock we no longer own");
		assert.equal(durableJob.fireCount, undefined, "the denied dispatch is not counted as a fire");
		assert.equal(h.scheduler().get(durableJob.id), undefined, "stale durable jobs leave this scheduler");
		assert.ok(h.scheduler().get(localJob.id), "session-only jobs are not removed");
		assert.equal(readFile(cwd)[0].fireCount, undefined, "the durable file is not updated by the old owner");
		assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")), replacement);
		h.scheduler().tick();
		assert.equal(h.sent.length, 1, "a session-only prompt can still run on the next scan");
		assert.match(h.sent[0].content ?? h.sent[0].message.content, /session-only/);
	} finally {
		delete process.env.PI_LOOP_DURABLE_SYNC_MS;
		await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("missed durable one-shots are surfaced to the model with an ask-first instruction", async () => {
	const cwd = tempProject();
	const due = new Date(Date.now() - 3600_000);
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "scheduled_tasks.json"),
		JSON.stringify({
			version: 1,
			jobs: [cronJob("late", { recurring: false, prompt: "push the release branch", cron: `${due.getMinutes()} ${due.getHours()} ${due.getDate()} ${due.getMonth() + 1} *`, createdAt: Date.now() - 2 * 3600_000, createdInProject: cwd })],
		}),
	);
	const h = await start(makeHarness(cwd));
	const message = h.sent.find((entry) => entry.message?.details?.missed);
	assert.ok(message, "a message about the missed job");
	assert.equal(message.options.deliverAs, "followUp", "attached to the next turn, not started at startup");
	assert.match(message.message.content, /Do NOT execute this prompt yet\. First ask the user/);
	assert.match(message.message.content, /push the release branch/);
});
