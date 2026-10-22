/**
 * Rendering for pi-cc-loop: the loop tick message, the /loop status lines and
 * the footer summary. Tool rows are left to Pi and to whatever renderer the
 * user has installed: Claude Code shows every tool call the same way, with its
 * arguments, and our one-line summaries hid them.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { humanSchedule } from "./cron.ts";
import { displayPrompt } from "./loopfile.ts";
import {
	bodyLines,
	contentText,
	firstLine,
	formatStamp,
	renderBlock,
	renderCard,
	stripProvenance,
} from "./render.ts";
import type { LoopJob } from "./schedule.ts";

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

export function formatDelay(seconds: number | undefined): string {
	if (seconds === undefined) return "unknown";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function jobSummary(job: LoopJob): string {
	if (job.kind === "cron" && job.cron) {
		return `${job.id} ${humanSchedule(job.cron)} \u00b7 next ${formatClock(job.nextFireAt)}`;
	}
	return `${job.id} self-paced \u00b7 ${job.scheduledFor ? `next ${formatClock(job.scheduledFor)}` : "unscheduled"}`;
}

/**
 * Draw a tick as a quiet block instead of Pi's default `[pi-cc-loop-tick]`
 * title. The provenance line is for the model, not the reader.
 */
export function renderTickMessage(message: any, options: any, theme: Theme): any {
	const details = (message.details ?? {}) as {
		tickCount?: number;
		jobId?: string;
		kind?: string;
		cron?: string;
		immediate?: boolean;
		missed?: boolean;
	};
	const text = contentText(message.content);
	const prompt = stripProvenance(text, /^\[[^\]]*\]\n?/);
	// A fixed-interval fire reads as a scheduled job, like Claude Code's
	// "started automatically by a schedule"; only a self-paced tick is a loop.
	// The immediate run of /loop 5m belongs to the /loop the user just typed.
	const scheduled = details.kind === "cron" && !details.immediate;
	const label = details.missed
		? "\u273b loop \u00b7 missed jobs"
		: scheduled
			? "\u273b Running scheduled task"
			: details.tickCount !== undefined
				? `\u273b loop #${details.tickCount}`
				: "\u273b loop";

	if (!loadConfig().compactMessages) {
		const summary = firstLine(prompt);
		const header = details.missed
			? label
			: `loop tick #${details.tickCount ?? "?"}${summary ? ` \u00b7 ${summary}` : ""}`;
		return renderCard({ header, body: prompt, expanded: options.expanded, outputPad: options.outputPad, theme });
	}

	const stamp = formatStamp(message.timestamp);
	const header = stamp
		? `${theme.fg("accent", theme.bold(label))}${theme.fg("dim", " \u00b7 ")}${theme.fg("muted", stamp)}`
		: theme.fg("accent", theme.bold(label));

	const meta: string[] = [];
	if (details.jobId) meta.push(`job ${details.jobId}`);
	if (details.cron) meta.push(`cron ${details.cron}`);
	else if (details.immediate) meta.push("immediate run");
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
