/**
 * Durable jobs: one .pi/scheduled_tasks.json per project, run by the one Pi
 * session that holds .pi/scheduled_tasks.lock.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeHarness, start, stateEntries } from "./harness.mjs";
import { loadModule } from "./helpers.mjs";

const { DurableRuntime } = await loadModule("durable.ts");
const { DEFAULT_TIMING, LoopScheduler } = await loadModule("schedule.ts");

const tempProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-durable-"));
const readFile = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "scheduled_tasks.json"), "utf8")).jobs;

/** One Pi process: a scheduler plus its durable runtime, with its own pid. */
function session(cwd, pid, isAlive = () => true) {
	const fired = [];
	const missed = [];
	let runtime;
	const scheduler = new LoopScheduler({
		dispatch: (job) => fired.push(job.id),
		afterDispatch: (job, finished) => job.durable && runtime.afterFire(job, finished),
		canDispatch: () => true,
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

test("a symlinked .pi refuses durable jobs, like Claude Code", () => {
	const cwd = tempProject();
	const elsewhere = tempProject();
	fs.symlinkSync(elsewhere, path.join(cwd, ".pi"));
	const a = session(cwd, 1001);
	assert.throws(() => a.runtime.add(cronJob("a1")), /symlink/);
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

	const h2 = makeHarness(h.ctx.cwd);
	h2.ctx.sessionManager.getEntries = () => stateEntries(h);
	await start(h2, { type: "session_start", reason: "resume" });
	assert.equal(h2.scheduler().list().filter((job) => job.id === id).length, 1, "loaded once, from the file");
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
	const message = h.sent.find((entry) => entry.kind === "user" && /missed/.test(entry.content));
	assert.ok(message, "a user message about the missed job");
	assert.equal(message.options.deliverAs, "followUp", "attached to the next turn, not started at startup");
	assert.match(message.content, /Do NOT execute this prompt yet\. First ask the user/);
	assert.match(message.content, /push the release branch/);
});
