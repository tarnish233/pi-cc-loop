import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const cron = await loadModule("cron.ts");

test("parseCron accepts the supported syntax", () => {
	assert.ok(cron.parseCron("*/5 * * * *"));
	assert.ok(cron.parseCron("0 9 * * 1-5"));
	assert.ok(cron.parseCron("0,30 9-17 * * *"));
	assert.ok(cron.parseCron("15 2 1,15 * *"));
});

test("parseCron rejects invalid expressions", () => {
	assert.equal(cron.parseCron("*/5 * * *"), null, "4 fields must fail");
	assert.equal(cron.parseCron("60 * * * *"), null, "minute 60 is out of range");
	assert.equal(cron.parseCron("* * * * 9"), null, "day of week 9 is out of range");
	assert.equal(cron.parseCron(""), null);
});

test("a step after a single value is invalid, as in Claude Code (not silently the value alone)", () => {
	// Claude Code 2.1.308 accepts *, */N, a-b, a-b/N and single values; "5/15" is none of them.
	assert.equal(cron.parseCron("5/15 * * * *"), null);
	assert.equal(cron.parseCron("0 9/2 * * *"), null);
	assert.ok(cron.parseCron("5-59/15 * * * *"), "the range form says it");
	assert.deepEqual([...cron.parseCron("5-59/15 * * * *").minute], [5, 20, 35, 50]);
});

test("a day field counts as restricted when it leaves days out, as in Claude Code", () => {
	// Claude Code compares the set with the full range: 1-31 and */1 are every day.
	for (const dom of ["*", "*/1", "1-31"]) {
		const fields = cron.parseCron(`0 9 ${dom} * 1`);
		assert.equal(fields.domRestricted, false, dom);
		const next = cron.nextFireAfter(fields, new Date("2026-10-21T10:00:00")); // a Wednesday
		assert.equal(next.getDay(), 1, `${dom}: Mondays only`);
	}
	for (const dow of ["*", "0-6", "0-7", "*/1"]) assert.equal(cron.parseCron(`0 9 15 * ${dow}`).dowRestricted, false, dow);
	const either = cron.parseCron("0 9 */2 * 1");
	assert.equal(either.domRestricted, true, "every other day leaves days out");
	assert.equal(either.dowRestricted, true);
});

test("day of week 7 aliases Sunday", () => {
	const fields = cron.parseCron("0 9 * * 7");
	assert.ok(fields.dow.has(0));
});

test("nextFireAfter finds the next slot", () => {
	const fields = cron.parseCron("*/5 * * * *");
	const next = cron.nextFireAfter(fields, new Date("2026-10-21T10:02:30"));
	assert.equal(next.getMinutes(), 5);
	assert.equal(next.getHours(), 10);
});

test("nextFireAfter rolls a daily job to the next day", () => {
	const fields = cron.parseCron("0 9 * * *");
	const next = cron.nextFireAfter(fields, new Date("2026-10-21T10:00:00"));
	assert.equal(next.getDate(), 22);
	assert.equal(next.getHours(), 9);
	assert.equal(next.getMinutes(), 0);
});

test("dom and dow are OR-ed when both are restricted", () => {
	const fields = cron.parseCron("0 0 15 * 1");
	const next = cron.nextFireAfter(fields, new Date("2026-10-21T00:00:00"));
	assert.ok(next.getDate() === 22 || next.getDay() === 1);
});

test("an impossible date never matches", () => {
	const fields = cron.parseCron("0 0 30 2 *");
	assert.equal(cron.nextFireAfter(fields, new Date("2026-01-01T00:00:00"), 366 * 4), null);
	assert.equal(cron.isUnreachable("0 0 30 2 *"), true);
	assert.equal(cron.isUnreachable("0 0 * * *"), false);
});

test("humanSchedule labels cron expressions like Claude Code", () => {
	const cases = {
		"* * * * *": "Every minute",
		"*/1 * * * *": "Every minute",
		"*/5 * * * *": "Every 5 minutes",
		"0 * * * *": "Every hour",
		"7 * * * *": "Every hour at :07",
		"0 */2 * * *": "Every 2 hours",
		"15 */3 * * *": "Every 3 hours at :15",
		"0 9 * * *": "Every day at 9:00 AM",
		"0 0 * * *": "Every day at 12:00 AM",
		"30 14 * * *": "Every day at 2:30 PM",
		"5 4 * * 0": "Every Sunday at 4:05 AM",
		"0 9 * * 7": "Every Sunday at 9:00 AM",
		"0 9 * * 1-5": "Weekdays at 9:00 AM",
		// Not in Claude Code (it shows the raw expression); /loop 3d produces it.
		"0 0 */3 * *": "Every 3 days at 12:00 AM",
		// Anything else is shown as written, never as a half-filled sentence.
		"*/15 9-17 * * 1-5": "*/15 9-17 * * 1-5",
		"0 9 1 * *": "0 9 1 * *",
		"0 9 * * 1,3": "0 9 * * 1,3",
		"not a cron": "not a cron",
	};
	for (const [expression, label] of Object.entries(cases)) {
		assert.equal(cron.humanSchedule(expression), label, expression);
	}
});



