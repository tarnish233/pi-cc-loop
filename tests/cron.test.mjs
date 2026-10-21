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

test("intervalToCron uses step syntax when it divides evenly", () => {
	assert.equal(cron.intervalToCron(300).cron, "*/5 * * * *");
	assert.equal(cron.intervalToCron(300).human, "every 5 minutes");
	assert.equal(cron.intervalToCron(3600).cron, "0 * * * *");
	assert.equal(cron.intervalToCron(7200).cron, "0 */2 * * *");
	assert.equal(cron.intervalToCron(86400).cron, "0 0 * * *");
	assert.equal(cron.intervalToCron(86400 * 3).cron, "0 0 */3 * *");
});

test("intervalToCron rounds a sub-minute interval up to one minute", () => {
	// Claude Code: "s -> ceil to nearest minute". The old code produced
	// "0 * * * *", which is hourly, not every minute.
	const thirty = cron.intervalToCron(30);
	assert.equal(thirty.cron, "* * * * *");
	assert.equal(thirty.seconds, 60);
	assert.equal(thirty.adjusted, true);
	assert.match(thirty.note, /rounded up to 1 minute/);

	// The generated expression really does fire every minute.
	const fields = cron.parseCron(thirty.cron);
	const a = cron.nextFireAfter(fields, new Date("2026-10-21T10:02:30"));
	const b = cron.nextFireAfter(fields, a);
	assert.equal((b - a) / 60000, 1, "one minute apart");
});

test("intervalToCron rounds a non-dividing interval to the nearest clean one", () => {
	// Claude Code: "If the interval doesn't cleanly divide its unit, round to
	// the nearest clean interval and tell the user what you rounded to."
	const seven = cron.intervalToCron(420);
	assert.equal(seven.cron, "*/6 * * * *");
	assert.equal(seven.adjusted, true);
	assert.match(seven.note, /rounded to 6m/);
});

test("parseIntervalToken reads the duration units", () => {
	assert.equal(cron.parseIntervalToken("5m"), 300);
	assert.equal(cron.parseIntervalToken("30s"), 30);
	assert.equal(cron.parseIntervalToken("2h"), 7200);
	assert.equal(cron.parseIntervalToken("1d"), 86400);
	assert.equal(cron.parseIntervalToken("5min"), null);
	assert.equal(cron.parseIntervalToken("abc"), null);
});

test("parseEveryClause handles the trailing clause", () => {
	const every = cron.parseEveryClause("check the deploy every 20m");
	assert.equal(every.interval, 1200);
	assert.equal(every.prompt, "check the deploy");

	const words = cron.parseEveryClause("run tests every 5 minutes");
	assert.equal(words.interval, 300);
	assert.equal(words.prompt, "run tests");
});

test("'every PR' is not an interval", () => {
	assert.equal(cron.parseEveryClause("check every PR"), null);
	assert.equal(cron.parseEveryClause("review every 3 PRs"), null);
});

test("describeCron summarises the expression", () => {
	assert.equal(cron.describeCron("*/5 * * * *"), "minute */5");
	assert.equal(cron.describeCron("0 9 * * *"), "minute 0, hour 9");
});
