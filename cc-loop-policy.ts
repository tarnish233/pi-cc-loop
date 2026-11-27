/** Current CC-compatible preset. The scheduler does not import these defaults. */
import type { TimingConfig } from "./schedule.ts";

export const CC_TIMING: Readonly<TimingConfig> = {
	recurringFrac: 0.5,
	recurringCapMs: 30 * 60_000,
	oneShotMaxMs: 90_000,
	oneShotMinuteMod: 30,
};

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_KEEPALIVE_SECONDS = 1200;
const DEFAULT_SCAN_INTERVAL_MS = 1000;
const DEFAULT_DURABLE_SYNC_MS = 5000;
export const EVENT_FALLBACK_RANGE = "1200-1800";

export const CC_EMPTY_LOOP_TASK = {
	body: [
		"You are running a scheduled maintenance pass.",
		"Work through the following, in order:",
		"1. Continue any unfinished work from the conversation.",
		"2. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts.",
		"3. Run cleanup passes such as bug hunts or simplification when nothing else is pending.",
		"Do not start new initiatives outside that scope, and only perform irreversible actions",
		"(push, delete) that continue something the transcript already authorized.",
		"If nothing needs doing, say so in one line.",
	].join("\n"),
	reminder:
		"# /loop tick — maintenance pass\n" +
		"Run the maintenance pass using the instructions established earlier in this conversation. " +
		"If you cannot find them, treat this as a no-op tick.",
};

export const RUN_NOW_HINT =
	'If the user asked for this to repeat on an interval ("every 5 minutes"), do the task once now as well — ' +
	'don\'t wait for the first fire, as /loop does. A job at set times ("every day at 9am") only runs at those times.';

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

export function maxAgeDays(): number {
	return Math.max(0, envNumber("PI_LOOP_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS));
}

export function maxAgeMs(): number { return maxAgeDays() * 86_400_000; }

export function keepaliveSeconds(): number {
	return Math.max(0, envNumber("PI_LOOP_KEEPALIVE_SECONDS", DEFAULT_KEEPALIVE_SECONDS));
}

export function timingConfig(): TimingConfig {
	const fraction = Math.min(1, Math.max(0, envNumber("PI_LOOP_JITTER", CC_TIMING.recurringFrac)));
	return { ...CC_TIMING, recurringFrac: fraction, oneShotMaxMs: fraction > 0 ? CC_TIMING.oneShotMaxMs : 0 };
}

export function scanIntervalMs(): number {
	const value = envNumber("PI_LOOP_SCAN_MS", DEFAULT_SCAN_INTERVAL_MS);
	return value > 0 ? value : DEFAULT_SCAN_INTERVAL_MS;
}

export function durableSyncMs(): number {
	return Math.max(0, envNumber("PI_LOOP_DURABLE_SYNC_MS", DEFAULT_DURABLE_SYNC_MS));
}
