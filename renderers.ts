/**
 * The display helpers pi-cc-loop still needs: clock times, the coarse countdown
 * for the footer, and the card a scheduled fire draws in the transcript. The
 * /loop request itself is an ordinary user message, rendered by Pi.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
	const label = details.missed
		? "loop \u00b7 missed jobs"
		: details.kind === "cron"
			? "Running scheduled task"
			: details.tickCount !== undefined
				? `loop #${details.tickCount}`
				: "loop";

	if (!loadConfig().compactMessages) {
		// Same naming as the block: a cron fire is a scheduled task, only a
		// self-paced tick is a loop. The header is one line: a loop.md body
		// must not render whole while the card is collapsed. Width-aware, so
		// emoji/CJK/ANSI are never cut mid-grapheme or mid-escape.
		const header = details.missed ? label : `${label} \u00b7 ${truncateToWidth(displayPrompt(prompt).replace(/\s+/g, " ").trim(), 80, "\u2026")}`;
		return renderCard({ header, body: prompt, expanded: options.expanded, outputPad: options.outputPad, theme });
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