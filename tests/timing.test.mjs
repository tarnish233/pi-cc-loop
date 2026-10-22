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

test("intervals follow Claude Code: seconds round up to whole minutes", () => {
	assert.equal(cron.intervalToCron(61).cron, "*/2 * * * *");
	assert.equal(cron.intervalToCron(90).cron, "*/2 * * * *");
	assert.equal(cron.intervalToCron(30).cron, "* * * * *");
	assert.equal(cron.intervalToCron(3599).cron, "0 * * * *", "just under an hour is hourly, not */60");
});

test("the trailing every clause takes Claude Code's unit words", () => {
	for (const [text, seconds] of [
		["check the deploy every 5 min", 300],
		["check the deploy every 2 hrs", 7200],
		["check the deploy every 30 secs", 30],
		["check the deploy every 1 day", 86400],
		["check the deploy every 10 mins", 600],
	]) {
		const parsed = cron.parseEveryClause(text);
		assert.ok(parsed, text);
		assert.equal(parsed.interval, seconds, text);
		assert.equal(parsed.prompt, "check the deploy");
	}
	assert.equal(cron.parseEveryClause("check every 0 min"), null);
});
