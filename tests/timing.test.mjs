/**
 * Run times and expiry, against Claude Code's documented behaviour:
 * "a recurring task starts each run late by up to half the gap to the next
 * run, and by at most 30 minutes"; "`*\/5 * * * *` ... each run starts 15
 * seconds sooner"; "a one-shot task scheduled for :00 or :30 runs up to 90
 * seconds early"; "Recurring tasks automatically expire 7 days after creation.
 * The task fires one final time, then deletes itself."
 */
import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const schedule = await loadModule("schedule.ts");
const cron = await loadModule("cron.ts");
const { DEFAULT_TIMING, LoopScheduler, nextRunTime } = schedule;

const at = (iso) => new Date(iso).getTime();
const job = (id, cronExpr, recurring = true) => ({ id, cron: cronExpr, recurring });

test("a recurring delivery that throws is dropped without consuming a fire or escaping the scan", () => {
	const errors = [];
	const after = [];
	const scheduler = new LoopScheduler({
		dispatch: () => {
			throw new Error("This extension ctx is stale");
		},
		canDispatch: () => true,
		onDispatchError: (job, error) => errors.push(`${job.id}: ${error.message}`),
		afterDispatch: (job, finished) => after.push([job.id, finished]),
	});
	const added = scheduler.add({
		id: "j1",
		kind: "cron",
		cron: "* * * * *",
		prompt: "print hi",
		recurring: true,
		createdAt: Date.now(),
		durable: false,
		source: "cron_create",
	});
	added.nextFireAt = Date.now() - 1000;

	assert.doesNotThrow(() => scheduler.tick(), "an exception in a timer callback would crash Pi");
	assert.deepEqual(errors, ["j1: This extension ctx is stale"]);
	assert.ok(!added.pending, "dropped, like any recurring tick that fails to start");
	assert.ok(added.nextFireAt > Date.now(), "the job keeps its next run");
	assert.equal(added.fireCount, undefined, "a failed delivery is not a fire");
	assert.equal(added.lastFiredAt, undefined);
	assert.deepEqual(after, [], "a failed delivery is not persisted as a fire");
});

test("a one-shot whose first delivery throws stays due and is deleted only after a successful retry", () => {
	const attempts = [];
	const after = [];
	const errors = [];
	const scheduler = new LoopScheduler({
		dispatch: (job) => {
			attempts.push(job.fireCount);
			if (attempts.length === 1) throw new Error("transient delivery failure");
		},
		canDispatch: () => true,
		onDispatchError: (job) => errors.push(job.id),
		afterDispatch: (job, finished) => after.push([job.id, finished]),
	});
	const added = scheduler.add({
		id: "once-retry", kind: "cron", cron: "0 9 22 10 *", prompt: "once", recurring: false,
		createdAt: Date.now() - 1000, nextFireAt: Date.now() - 1, durable: false, source: "t", maxFires: 1,
	});
	added.nextFireAt = Date.now() - 1;
	assert.doesNotThrow(() => scheduler.tick());
	assert.equal(scheduler.get(added.id), added, "the failed one-shot was not deleted");
	assert.equal(added.fireCount, undefined);
	assert.ok(added.nextFireAt <= Date.now(), "it remains due");
	assert.deepEqual(after, [], "durable removal is not requested for a failed delivery");

	scheduler.tick();
	assert.deepEqual(attempts, [1, 1], "the retry sees its first real fire, not fire number two");
	assert.equal(scheduler.get(added.id), undefined, "the accepted one-shot is removed");
	assert.deepEqual(after, [["once-retry", true]]);
	assert.deepEqual(errors, ["once-retry"]);
});

test("a capped recurring job retries after a failed final-fire delivery", () => {
	let attempts = 0;
	const scheduler = new LoopScheduler({
		dispatch: () => {
			attempts++;
			if (attempts === 1) throw new Error("try again");
		},
		canDispatch: () => true,
	});
	const added = scheduler.add({
		id: "capped-retry", kind: "cron", cron: "* * * * *", prompt: "p", recurring: true,
		createdAt: Date.now(), nextFireAt: Date.now() - 1, durable: false, source: "t", maxFires: 1,
	});
	added.nextFireAt = Date.now() - 1;
	scheduler.tick();
	assert.equal(scheduler.get(added.id), added, "a tentative cap cannot delete the job");
	assert.equal(added.fireCount, undefined);
	assert.ok(added.nextFireAt > Date.now(), "the failed recurring tick advances without consuming its cap");
	added.nextFireAt = Date.now() - 1;
	scheduler.tick();
	assert.equal(attempts, 2);
	assert.equal(added.fireCount, 1);
	assert.equal(scheduler.get(added.id), undefined, "the successful first fire reaches the cap");
});

test("a failed wakeup delivery remains due without entering awaiting-reschedule limbo", () => {
	let attempts = 0;
	const scheduler = new LoopScheduler({
		dispatch: () => {
			attempts++;
			if (attempts === 1) throw new Error("try again");
		},
		canDispatch: () => true,
	});
	const added = scheduler.add({
		id: "wake-retry", kind: "wakeup", prompt: "p", recurring: false,
		createdAt: Date.now(), scheduledFor: Date.now() - 1, durable: false, source: "t",
	});
	scheduler.tick();
	assert.equal(added.awaitingReschedule, undefined);
	assert.ok(added.scheduledFor <= Date.now(), "the wakeup is still due");
	assert.equal(added.fireCount, undefined);
	scheduler.tick();
	assert.equal(attempts, 2);
	assert.equal(added.fireCount, 1);
	assert.equal(added.awaitingReschedule, true, "the accepted wakeup now belongs to its active turn");
	assert.equal(added.scheduledFor, undefined);
});

test("a failing housekeeping step does not stop due jobs or escape the scan", () => {
	const delivered = [];
	const scheduler = new LoopScheduler({
		dispatch: (job) => delivered.push(job.id),
		canDispatch: () => true,
		// e.g. .pi/scheduled_tasks.json became unwritable
		onScan: () => {
			throw new Error("EACCES: permission denied");
		},
	});
	const added = scheduler.add({
		id: "j2",
		kind: "cron",
		cron: "* * * * *",
		prompt: "print hi",
		recurring: true,
		createdAt: Date.now(),
		durable: false,
		source: "cron_create",
	});
	added.nextFireAt = Date.now() - 1000;
	assert.doesNotThrow(() => scheduler.tick(), "an exception in a timer callback would crash Pi");
	assert.deepEqual(delivered, ["j2"]);
});

test("a recurring job runs late by a fixed per-job offset, at most half its period", () => {
	const from = at("2026-10-22T10:02:00");
	const slot = at("2026-10-22T10:10:00");
	const offsets = ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"].map(
		(id) => nextRunTime(job(id, "*/10 * * * *"), from) - slot,
	);
	for (const offset of offsets) {
		assert.ok(offset >= 0 && offset < 5 * 60_000, `0 to 5 minutes late for a 10 minute job, got ${offset}ms`);
	}
	assert.ok(new Set(offsets).size > 1, "different jobs get different offsets");
	assert.equal(
		nextRunTime(job("aaaa1111", "*/10 * * * *"), from),
		nextRunTime(job("aaaa1111", "*/10 * * * *"), from),
		"the same job always gets the same offset",
	);
});

test("the offset is capped at 30 minutes for hourly and daily jobs", () => {
	const from = at("2026-10-22T10:02:00");
	for (const [cronExpr, slot] of [
		["7 * * * *", at("2026-10-22T10:07:00")],
		["3 9 * * *", at("2026-10-23T09:03:00")],
	]) {
		for (const id of ["aaaa1111", "zzzz9999", "q1w2e3r4"]) {
			const offset = nextRunTime(job(id, cronExpr), from) - slot;
			assert.ok(offset >= 0 && offset <= 30 * 60_000, `${cronExpr}: ${offset}ms`);
		}
	}
});

test("a */5 job keeps a 5 minute cadence, late by its own offset", () => {
	const from = at("2026-10-22T10:02:30");
	for (const id of ["aaaa1111", "zzzz9999", "q1w2e3r4"]) {
		const first = nextRunTime(job(id, "*/5 * * * *"), from);
		const offset = first - at("2026-10-22T10:05:00");
		assert.ok(offset >= 0 && offset < 150_000, `${id}: ${offset}ms late`);
		assert.equal(
			nextRunTime(job(id, "*/5 * * * *"), first),
			first + 300_000,
			"consecutive runs stay exactly 5 minutes apart",
		);
	}
});

test("a one-shot on :00 or :30 runs up to 90s early, never before it was created", () => {
	const created = at("2026-10-22T08:00:00");
	const slot = at("2026-10-22T09:00:00");
	for (const id of ["aaaa1111", "zzzz9999"]) {
		const run = nextRunTime(job(id, "0 9 22 10 *", false), created);
		assert.ok(run <= slot && run >= slot - 90_000, `${slot - run}ms early`);
	}
	assert.equal(
		nextRunTime(job("aaaa1111", "7 9 22 10 *", false), created),
		at("2026-10-22T09:07:00"),
		"any other minute runs exactly on time",
	);
	const justBefore = at("2026-10-22T08:59:50");
	assert.ok(nextRunTime(job("zzzz9999", "0 9 22 10 *", false), justBefore) >= justBefore);
});

test("PI_LOOP_JITTER=0 style timing runs exactly on the cron minute", () => {
	const exact = { ...DEFAULT_TIMING, recurringFrac: 0, oneShotMaxMs: 0 };
	const from = at("2026-10-22T10:02:30");
	assert.equal(nextRunTime(job("aaaa1111", "*/10 * * * *"), from, exact), at("2026-10-22T10:10:00"));
	assert.equal(nextRunTime(job("aaaa1111", "*/5 * * * *"), from, exact), at("2026-10-22T10:05:00"));
});

function harness(maxAgeMs = 7 * 86_400_000) {
	const fired = [];
	const expired = [];
	const scheduler = new LoopScheduler({
		dispatch: (j) => fired.push(j.id),
		canDispatch: () => true,
		maxAgeMs: () => maxAgeMs,
		onExpire: (j) => expired.push(j.id),
	});
	return { scheduler, fired, expired };
}

test("a recurring job past 7 days fires one final time, then deletes itself", () => {
	const { scheduler, fired, expired } = harness();
	const created = Date.now() - 7 * 86_400_000 - 1000;
	scheduler.add({ id: "old1", kind: "cron", cron: "*/10 * * * *", prompt: "p", recurring: true, createdAt: created, durable: false, source: "t" });
	assert.ok(scheduler.get("old1"), "not deleted before its final run");
	scheduler.get("old1").nextFireAt = Date.now() - 1;
	scheduler.tick();
	assert.deepEqual(fired, ["old1"], "the final run happened");
	assert.equal(scheduler.get("old1"), undefined, "then the job was deleted");
	assert.deepEqual(expired, ["old1"]);
});

test("a one-shot job does not expire, however far out it is", () => {
	const { scheduler, fired } = harness();
	scheduler.add({ id: "once", kind: "cron", cron: "*/10 * * * *", prompt: "p", recurring: false, createdAt: Date.now() - 8 * 86_400_000, durable: false, source: "t" });
	scheduler.get("once").nextFireAt = Date.now() - 1;
	scheduler.tick();
	assert.deepEqual(fired, ["once"], "it fires at its time");
	assert.equal(scheduler.get("once"), undefined, "and deletes itself afterwards");
});


test("re-arming a pending wakeup supersedes the due fire instead of firing at once", () => {
	const delivered = [];
	let idle = false;
	const scheduler = new LoopScheduler({ dispatch: (job) => delivered.push(job.id), canDispatch: () => idle });
	const added = scheduler.add({
		id: "rearm", kind: "wakeup", prompt: "p", recurring: false,
		createdAt: Date.now(), scheduledFor: Date.now() - 1, durable: false, source: "t",
	});
	scheduler.tick();
	assert.equal(added.pending, true, "due while the agent is busy");
	assert.equal(added.scheduledFor, undefined, "markDue consumed the old time");

	scheduler.update(added.id, { scheduledFor: Date.now() + 1200_000, awaitingReschedule: false });
	assert.equal(added.pending, false, "the new arm time replaces the due fire");
	assert.equal(added.dueAt, undefined);
	idle = true;
	scheduler.tick();
	assert.deepEqual(delivered, [], "the wakeup fires in 1200s, not at the next settle");
});
