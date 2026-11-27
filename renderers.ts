/**
 * The display helpers pi-cc-loop still needs: clock times, the coarse countdown
 * for the footer, and the card a scheduled fire draws in the transcript. The
 * /loop request itself is an ordinary user message, rendered by Pi.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	bodyLines,
	contentText,
	formatStamp,
	renderCard,
	renderNotificationCard,
	type KeyHintFn,
	type NotificationSection,
} from "./render.ts";
export { formatClock } from "./render.ts";
import { loadConfig } from "./config.ts";
import { humanSchedule } from "./cron.ts";
import { displayPrompt } from "./loopfile.ts";


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

/** Why a loop ended; the model reads `content`, the reader sees the title. */
export interface OutcomeDetails {
	ended?: boolean;
	cause?: "stopped" | "expired" | "dispatch-failed";
	jobId?: string;
	prompt?: string;
	reason?: string;
	/** A dispatch failure is not terminal: it stays due or only skips this tick. */
	retry?: "due" | "skipped";
}

const OUTCOME_TITLES = { stopped: "Loop Stopped", expired: "Loop Expired", "dispatch-failed": "Loop Tick Failed" } as const;

export function outcomeTitle(details: OutcomeDetails): string {
	return details.cause ? OUTCOME_TITLES[details.cause] : "Loop Ended";
}

/** The one fact a collapsed card carries besides its title. */
function outcomeStat(details: OutcomeDetails): string {
	if (details.cause === "expired") return "schedule expired";
	if (details.cause === "dispatch-failed") return details.retry === "due" ? "stays due" : "this tick skipped";
	return "not rescheduled";
}

/**
 * Draw the end of a loop: a title naming the outcome instead of the raw
 * `pi-cc-loop-outcome` custom type Pi prints for an unregistered message.
 */
export function renderOutcomeMessage(
	message: { content: unknown; details?: unknown; timestamp?: number },
	options: { expanded: boolean; outputPad: number; keyHint?: KeyHintFn },
	theme: Theme,
): Component {
	const details = (message.details ?? {}) as OutcomeDetails;
	const title = outcomeTitle(details);
	const text = contentText(message.content);

	if (!loadConfig().compactMessages) {
		return renderCard({ header: details.jobId ? `${title} \u00b7 ${details.jobId}` : title, body: text, expanded: options.expanded, outputPad: options.outputPad, theme, keyHint: options.keyHint });
	}

	const sections: NotificationSection[] = [];
	if (text.trim()) sections.push({ heading: "Status", lines: bodyLines(text), color: "toolOutput" });
	if (details.jobId) sections.push({ heading: "Job", lines: [details.jobId, "scheduled by /loop"], color: "dim" });
	if (details.prompt) sections.push({ heading: "Prompt", lines: bodyLines(displayPrompt(details.prompt)), color: "dim" });

	return renderNotificationCard(message, options, theme, {
		title,
		...(details.jobId ? { id: details.jobId } : {}),
		stamp: formatStamp(message.timestamp),
		stats: [outcomeStat(details)],
		tone: details.cause === "expired" || details.cause === "dispatch-failed" ? "warning" : "accent",
		terminal: details.cause !== "dispatch-failed",
		sections,
	});
}

/**
 * Draw a scheduled fire the way Claude Code does: `✻ Running scheduled task ·
 * 6:16pm`, then the task. The provenance line in `content` is addressed to the
 * model ("started by the schedule...") and must not reach the reader.
 */
export function renderScheduledMessage(
	message: { content: unknown; details?: unknown; timestamp?: number },
	options: { expanded: boolean; outputPad: number; keyHint?: KeyHintFn },
	theme: Theme,
): ReturnType<typeof renderCard> | ReturnType<typeof renderNotificationCard> {
	const details = (message.details ?? {}) as ScheduledDetails;
	// The provenance line is addressed to the model, not the reader.
	const prompt = details.prompt ?? contentText(message.content).replace(/^\[[^\]]*\]\n?/, "");
	// A fixed interval fires a scheduled task; only a self-paced tick is a loop.
	// Titles read like every other card: capitalised, with the fact after a dot.
	const label = details.missed
		? "Loop \u00b7 missed jobs"
		: details.kind === "cron"
			? "Running scheduled task"
			: details.tickCount !== undefined
				? `Loop #${details.tickCount}`
				: "Loop";

	if (!loadConfig().compactMessages) {
		// Same naming as the block: a cron fire is a scheduled task, only a
		// self-paced tick is a loop. The header is one line: a loop.md body
		// must not render whole while the card is collapsed. Width-aware, so
		// emoji/CJK/ANSI are never cut mid-grapheme or mid-escape.
		const header = details.missed ? label : `${label} \u00b7 ${truncateToWidth(displayPrompt(prompt).replace(/\s+/g, " ").trim(), 80, "\u2026")}`;
		return renderCard({ header, body: prompt, expanded: options.expanded, outputPad: options.outputPad, theme, keyHint: options.keyHint });
	}

	const lines = bodyLines(prompt);
	const sections: NotificationSection[] = [];
	if (details.kind === "cron" && details.cron) {
		sections.push({ heading: "Schedule", lines: [humanSchedule(details.cron)], color: "muted" });
	}
	if (details.missed) {
		sections.push({ heading: "Late", lines: ["These jobs were due before this tick and fire now."], color: "dim" });
	}
	// The reason the model gave for this delay, so the reader knows why it woke up.
	if (details.kind === "wakeup" && details.reason) {
		sections.push({ heading: "Reason", lines: [details.reason], color: "muted" });
	}
	if (details.jobId) {
		sections.push({ heading: "Job", lines: [details.jobId, "scheduled by /loop"], color: "dim" });
	}
	sections.push({ heading: "Prompt", lines, color: "toolOutput" });

	return renderNotificationCard(message, options, theme, {
		title: label,
		stamp: formatStamp(message.timestamp),
		stats: details.missed
			? [`${lines.length} ${lines.length === 1 ? "job" : "jobs"}`]
			: [details.kind === "cron" && details.cron ? humanSchedule(details.cron) : "self-paced"],
		subtitle: details.kind === "wakeup" && details.reason ? details.reason : undefined,
		tone: details.missed ? "warning" : "accent",
		sections,
	});
}