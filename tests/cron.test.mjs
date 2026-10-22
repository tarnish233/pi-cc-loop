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







test("describeCron summarises the expression", () => {
	assert.equal(cron.describeCron("*/5 * * * *"), "minute */5");
	assert.equal(cron.describeCron("0 9 * * *"), "minute 0, hour 9");
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



