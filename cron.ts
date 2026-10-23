/**
 * Minimal 5-field cron support for the pi-cc-loop extension.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Per-field syntax: `*`, `*\/N`, `a`, `a-b`, `a-b/N`, `a,b,c`
 *
 * Deliberately unsupported (same subset Claude Code accepts): `L`, `W`, `?`
 * and name aliases such as `MON`.
 */

export interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	/** True when the day-of-month field was not `*`. */
	domRestricted: boolean;
	/** True when the day-of-week field was not `*`. */
	dowRestricted: boolean;
}

interface FieldSpec {
	name: string;
	min: number;
	max: number;
}

const FIELDS: FieldSpec[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of week", min: 0, max: 7 },
];

export const CRON_FIELD_COUNT = FIELDS.length;

function parseField(spec: FieldSpec, raw: string): Set<number> | null {
	const out = new Set<number>();
	const parts = raw.split(",");
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) return null;

		const [rangePart, stepPart] = trimmed.split("/");
		let step = 1;
		if (stepPart !== undefined) {
			if (!/^\d+$/.test(stepPart)) return null;
			step = Number(stepPart);
			if (step < 1) return null;
		}

		let start: number;
		let end: number;
		if (rangePart === "*") {
			start = spec.min;
			end = spec.max;
		} else {
			const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
			if (!m) return null;
			start = Number(m[1]);
			end = m[2] !== undefined ? Number(m[2]) : start;
			if (end < start) return null;
		}

		if (start < spec.min || end > spec.max) return null;
		for (let v = start; v <= end; v += step) {
			// cron treats 7 and 0 as Sunday
			out.add(spec.name === "day of week" && v === 7 ? 0 : v);
		}
	}
	return out;
}

/** Parse a 5-field cron expression. Returns null when the expression is invalid. */
export function parseCron(expression: string): CronFields | null {
	const trimmed = expression.trim();
	if (!trimmed) return null;
	const tokens = trimmed.split(/\s+/);
	if (tokens.length !== CRON_FIELD_COUNT) return null;

	const parsed: Set<number>[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const set = parseField(FIELDS[i], tokens[i]);
		if (!set || set.size === 0) return null;
		parsed.push(set);
	}

	return {
		minute: parsed[0],
		hour: parsed[1],
		dom: parsed[2],
		month: parsed[3],
		dow: parsed[4],
		domRestricted: tokens[2] !== "*",
		dowRestricted: tokens[4] !== "*",
	};
}

function dayMatches(fields: CronFields, date: Date): boolean {
	const domOk = fields.dom.has(date.getDate());
	const dowOk = fields.dow.has(date.getDay());
	// vixie-cron semantics: when both day fields are restricted, either may match.
	if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
	if (fields.domRestricted) return domOk;
	if (fields.dowRestricted) return dowOk;
	return true;
}

/**
 * Next time the expression matches strictly after `from`, or null when nothing
 * matches within the search window.
 */
export function nextFireAfter(
	fields: CronFields,
	from: Date,
	limitDays = 366 * 4,
): Date | null {
	const cursor = new Date(from.getTime());
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const limit = from.getTime() + limitDays * 24 * 60 * 60 * 1000;

	while (cursor.getTime() <= limit) {
		if (!fields.month.has(cursor.getMonth() + 1)) {
			cursor.setMonth(cursor.getMonth() + 1, 1);
			cursor.setHours(0, 0, 0, 0);
			continue;
		}
		if (!dayMatches(fields, cursor)) {
			cursor.setDate(cursor.getDate() + 1);
			cursor.setHours(0, 0, 0, 0);
			continue;
		}
		if (!fields.hour.has(cursor.getHours())) {
			cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!fields.minute.has(cursor.getMinutes())) {
			cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
			continue;
		}
		return cursor;
	}
	return null;
}

/** True when the expression can never match (e.g. February 30th). */
export function isUnreachable(expression: string): boolean {
	const fields = parseCron(expression);
	if (!fields) return true;
	// Look a year ahead; if nothing matches, the expression is dead.
	return nextFireAfter(fields, new Date(), 366) === null;
}

/**
 * The divisor of `total` closest to `n`.
 *
 * Claude Code rounds a non-dividing interval to the nearest clean one: "If the
 * interval doesn't cleanly divide its unit, round to the nearest clean interval
 * and tell the user what you rounded to."
 */
function nearestDivisor(n: number, total: number): number {
	let best = 1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let d = 1; d <= total; d++) {
		if (total % d !== 0) continue;
		const distance = Math.abs(d - n);
		if (distance < bestDistance) {
			best = d;
			bestDistance = distance;
		}
	}
	return best;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];


/**
 * A human readable cadence for a cron expression, with Claude Code's labels:
 * "Every minute", "Every 5 minutes", "Every hour at :07", "Every 2 hours",
 * "Every day at 9:00 AM", "Every Sunday at 9:00 AM", "Weekdays at 9:00 AM".
 *
 * Like Claude Code, anything else is shown as written rather than as a
 * half-filled sentence. The one addition is "Every N days at ...", which
 * `/loop Nd` produces.
 */
export function humanSchedule(expression: string): string {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== CRON_FIELD_COUNT || !parseCron(expression)) return expression;
	const [minute, hour, dom, month, dow] = fields;
	const isNumber = (value: string) => /^\d+$/.test(value);
	const step = (value: string) => {
		const match = /^\*\/(\d+)$/.exec(value);
		return match ? Number(match[1]) : undefined;
	};
	const atMinute = (value: number) => `:${String(value).padStart(2, "0")}`;
	const everyDay = dom === "*" && month === "*" && dow === "*";

	if (hour === "*" && everyDay) {
		if (minute === "*") return "Every minute";
		const n = step(minute);
		if (n !== undefined) return n === 1 ? "Every minute" : `Every ${n} minutes`;
		if (isNumber(minute)) return Number(minute) === 0 ? "Every hour" : `Every hour at ${atMinute(Number(minute))}`;
		return expression;
	}

	const hours = step(hour);
	if (isNumber(minute) && hours !== undefined && everyDay) {
		const at = Number(minute) === 0 ? "" : ` at ${atMinute(Number(minute))}`;
		return hours === 1 ? `Every hour${at}` : `Every ${hours} hours${at}`;
	}

	if (!isNumber(minute) || !isNumber(hour)) return expression;
	const clock = clockText(Number(minute), Number(hour));
	if (everyDay) return `Every day at ${clock}`;
	if (dom === "*" && month === "*") {
		if (/^\d$/.test(dow)) return `Every ${DAY_NAMES[Number(dow) % 7]} at ${clock}`;
		if (dow === "1-5") return `Weekdays at ${clock}`;
	}
	const days = step(dom);
	if (days !== undefined && month === "*" && dow === "*") {
		return days === 1 ? `Every day at ${clock}` : `Every ${days} days at ${clock}`;
	}
	return expression;
}

/** "9:05 AM" style time. */
function clockText(minute: number, hour: number): string {
	const suffix = hour < 12 ? "AM" : "PM";
	const display = hour % 12 === 0 ? 12 : hour % 12;
	return `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** Human readable summary of a cron expression. */
export function describeCron(expression: string): string {
	const fields = parseCron(expression);
	if (!fields) return expression;
	const [minute, hour, dom, month, dow] = expression.trim().split(/\s+/);
	const parts: string[] = [];
	if (minute !== "*") parts.push(`minute ${minute}`);
	if (hour !== "*") parts.push(`hour ${hour}`);
	if (dom !== "*") parts.push(`day-of-month ${dom}`);
	if (month !== "*") parts.push(`month ${month}`);
	if (dow !== "*") parts.push(`day-of-week ${dow}`);
	return parts.length ? parts.join(", ") : "every minute";
}
