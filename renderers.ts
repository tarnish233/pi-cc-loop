/**
 * The display helpers pi-cc-loop still needs: clock times, the coarse countdown
 * for the footer, and the block a scheduled fire draws in the transcript. The
 * /loop request itself is an ordinary user message, rendered by Pi.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { bodyLines, contentText, formatStamp, renderBlock, renderCard } from "./render.ts";
import { loadConfig } from "./config.ts";
import { humanSchedule } from "./cron.ts";
import { displayPrompt } from "./loopfile.ts";


/**
 * A clock time the way Claude Code writes it: "6:16pm". Formatted here rather
 * than through the locale, so the transcript reads the same everywhere.
 */
export function formatClock(epochMs: number | undefined): string {
	if (!epochMs) return "unknown";
	const date = new Date(epochMs);
	const hour = date.getHours();
	const suffix = hour < 12 ? "am" : "pm";
	const twelve = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelve}:${String(date.getMinutes()).padStart(2, "0")}${suffix}`;
}

/**
 * A countdown for the footer: "3m", "<1m", "2h 15m". Rounded up and coarse on
 * purpose, so the shared footer line is repainted at most once a minute.
 */
export function formatEta(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return "<1m";
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** What a tick carries for the renderer; the model reads `content`. */
export interface ScheduledDetails {
	kind?: "cron" | "wakeup";
	tickCount?: number;
	jobId?: string;
	cron?: string;
	prompt?: string;
	reason?: string;
	missed?: boolean;
}

/**
 * Draw a scheduled fire the way Claude Code does: `✻ Running scheduled task ·
 * 6:16pm`, then the task. The provenance line in `content` is addressed to the
 * model ("started by the schedule...") and must not reach the reader.
 */
export function renderScheduledMessage(message: any, options: any, theme: Theme): any {
	const details = (message.details ?? {}) as ScheduledDetails;
	// The provenance line is addressed to the model, not the reader.
	const prompt = details.prompt ?? contentText(message.content).replace(/^\[[^\]]*\]\n?/, "");
	// A fixed interval fires a scheduled task; only a self-paced tick is a loop.
	const label = details.missed
		? "\u273b loop \u00b7 missed jobs"
		: details.kind === "cron"
			? "\u273b Running scheduled task"
			: details.tickCount !== undefined
				? `\u273b loop #${details.tickCount}`
				: "\u273b loop";

	if (!loadConfig().compactMessages) {
		// Same naming as the block: a cron fire is a scheduled task, only a
		// self-paced tick is a loop.
		const header = details.missed ? label : `${label.replace("\u273b ", "")} \u00b7 ${displayPrompt(prompt)}`;
		return renderCard({ header, body: prompt, expanded: options.expanded, outputPad: options.outputPad, theme });
	}

	const stamp = formatStamp(message.timestamp);
	// The reason the model gave for this delay, in the header so the reader
	// knows why the loop woke up without expanding anything.
	const why = details.kind === "wakeup" && details.reason ? ` \u00b7 ${details.reason}` : "";
	const header =
		(stamp
			? `${theme.fg("accent", theme.bold(label))}${theme.fg("dim", " \u00b7 ")}${theme.fg("muted", stamp)}`
			: theme.fg("accent", theme.bold(label))) + (why ? theme.fg("dim", why) : "");

	const meta: string[] = [];
	if (details.jobId) meta.push(`job ${details.jobId}`);
	if (details.kind === "cron" && details.cron) meta.push(humanSchedule(details.cron));
	else if (!details.missed) meta.push("self-paced");
	meta.push("scheduled by /loop");

	return renderBlock({
		header,
		body: bodyLines(prompt),
		meta,
		expanded: options.expanded,
		outputPad: options.outputPad,
		theme,
		maxBodyLines: 3,
	});
}
