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

export interface IntervalSpec {
	/** Number of seconds the schedule actually uses. */
	seconds: number;
	/** Cron expression that implements the interval. */
	cron: string;
	/** Human readable cadence, e.g. "every 5 minutes". */
	human: string;
	/** True when the requested interval had to be adjusted. */
	adjusted: boolean;
	/** What the user asked for, in seconds. */
	requestedSeconds: number;
	/** Human readable explanation of the adjustment, for the user. */
	note?: string;
}

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
};

/** The unit words Claude Code's /loop accepts in a trailing "every N <unit>" clause. */
const UNIT_WORDS: Record<string, string[]> = {
	s: ["s", "sec", "secs", "second", "seconds"],
	m: ["m", "min", "mins", "minute", "minutes"],
	h: ["h", "hr", "hrs", "hour", "hours"],
	d: ["d", "day", "days"],
};

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

/**
 * Convert a duration into a cron expression, following Claude Code's rule:
 *
 *   "Supported suffixes: `s` -> ceil to nearest minute, `m` (minutes),
 *    `h` (hours), `d` (days). Examples: `5m` -> a 5 minute step, `1h` -> `0 * * * *`,
 *    `1d` -> `0 0 * * *`. If the interval doesn't cleanly divide its unit, round to the
 *    nearest clean interval and tell the user what you rounded to."
 */
export function intervalToCron(seconds: number): IntervalSpec | null {
	if (!Number.isFinite(seconds) || seconds <= 0) return null;

	// Sub-minute: the scheduler's granularity is one minute, so round up.
	if (seconds < 60) {
		return {
			seconds: 60,
			cron: "* * * * *",
			human: "every minute",
			adjusted: true,
			requestedSeconds: seconds,
			note: `${seconds}s rounded up to 1 minute (the scheduler's minimum granularity is 1 minute)`,
		};
	}

	// "Seconds are rounded up to the nearest minute since cron has one-minute
	// granularity."
	if (seconds < 3600 && Math.ceil(seconds / 60) < 60) {
		const requested = Math.ceil(seconds / 60);
		const minutes = nearestDivisor(requested, 60);
		return {
			seconds: minutes * 60,
			cron: `*/${minutes} * * * *`,
			human: `every ${minutes} minute${minutes === 1 ? "" : "s"}`,
			adjusted: minutes !== requested,
			requestedSeconds: seconds,
			...(minutes !== requested
				? { note: `${requested}m rounded to ${minutes}m, the nearest clean interval` }
				: {}),
		};
	}

	if (seconds < 86400) {
		const requested = Math.max(1, Math.round(seconds / 3600));
		const hours = nearestDivisor(requested, 24);
		return {
			seconds: hours * 3600,
			cron: hours === 1 ? "0 * * * *" : `0 */${hours} * * *`,
			human: `every ${hours} hour${hours === 1 ? "" : "s"}`,
			adjusted: hours !== requested,
			requestedSeconds: seconds,
			...(hours !== requested
				? { note: `${requested}h rounded to ${hours}h, the nearest clean interval` }
				: {}),
		};
	}

	const days = Math.max(1, Math.round(seconds / 86400));
	return {
		seconds: days * 86400,
		cron: days === 1 ? "0 0 * * *" : `0 0 */${days} * *`,
		human: days === 1 ? "every day" : `every ${days} days`,
		adjusted: days * 86400 !== seconds,
		requestedSeconds: seconds,
	};
}

/** Chinese interval words, with a digit required so `每个文件` or `每天都有一个…` stay prose. */
const CHINESE_UNITS: Record<string, number> = {
	秒: 1,
	秒钟: 1,
	分: 60,
	分钟: 60,
	小时: 3600,
	钟头: 3600,
	天: 86400,
	日: 86400,
};

/**
 * Parse `每2分钟输出一次` / `输出一次 每隔 2 小时`: an explicit interval written
 * in Chinese. The digit is required on purpose: `每天都有一个测试失败` is a
 * prompt, not a schedule, and Claude Code's own splitting is just as literal.
 */
/** Parse a duration token such as `5m`, `30s`, `2h`, `1d`, or `2分钟`. */
export function parseIntervalToken(token: string): number | null {
	const trimmed = token.trim();
	const m = /^(\d+)\s*([smhd])$/i.exec(trimmed);
	if (m) {
		const amount = Number(m[1]);
		if (!Number.isFinite(amount) || amount <= 0) return null;
		return amount * UNIT_SECONDS[m[2].toLowerCase()];
	}
	// A standalone Chinese duration token: `/loop 2分钟 输出一次`.
	const chinese = /^(\d+)\s*个?\s*(秒钟|分钟|钟头|小时|秒|分|天|日)$/u.exec(trimmed);
	if (!chinese) return null;
	const amount = Number(chinese[1]);
	const seconds = CHINESE_UNITS[chinese[2]];
	if (!Number.isFinite(amount) || amount <= 0 || !seconds) return null;
	return amount * seconds;
}

/**
 * Parse a trailing `every 20m` / `every 5 min` / `every 2 hours` clause, with
 * the unit words Claude Code accepts.
 */
export function parseEveryClause(input: string): { interval: number; prompt: string } | null {
	const m = /\bevery\s+(\d+)\s*([a-z]+)\s*$/i.exec(input.trim());
	if (!m) return null;
	const amount = Number(m[1]);
	if (!(amount > 0)) return null;
	const word = m[2].toLowerCase();
	const unit = Object.keys(UNIT_WORDS).find((key) => UNIT_WORDS[key].includes(word));
	if (!unit) return null;
	const unitSeconds = UNIT_SECONDS[unit];
	const prompt = input.trim().slice(0, m.index).trim();
	return { interval: amount * unitSeconds, prompt };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseChineseInterval(input: string): { interval: number; prompt: string } | null {
	const unit = "(秒钟|分钟|钟头|小时|秒|分|天|日)";
	const prefix = new RegExp(`^每\\s*隔?\\s*(\\d+)\\s*个?\\s*${unit}\\s*`, "u").exec(input.trim());
	if (prefix) {
		const amount = Number(prefix[1]);
		const seconds = CHINESE_UNITS[prefix[2]];
		if (!(amount > 0) || !seconds) return null;
		return { interval: amount * seconds, prompt: input.trim().slice(prefix[0].length).trim() };
	}
	const suffix = new RegExp(`\\s*每\\s*隔?\\s*(\\d+)\\s*个?\\s*${unit}\\s*$`, "u").exec(input.trim());
	if (suffix) {
		const amount = Number(suffix[1]);
		const seconds = CHINESE_UNITS[suffix[2]];
		if (!(amount > 0) || !seconds) return null;
		return { interval: amount * seconds, prompt: input.trim().slice(0, suffix.index).trim() };
	}
	return null;
}


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
