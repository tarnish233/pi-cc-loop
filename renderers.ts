/**
 * Rendering for pi-cc-loop: the compact tool rows and the loop tick message.
 */

import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
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
import { compactRenderers, truncate } from "./tool-rows.ts";

export function formatClock(epochMs: number | undefined): string {
	if (!epochMs) return "unknown";
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

/** One-line rows for the four loop tools. */
export function loopToolRenderers(): Record<string, ToolRenderers> {
	return {
		cron_create: compactRenderers({
			call: (args) => ({
				label: "Schedule",
				detail: `${args.cron ?? ""} \u00b7 ${truncate(displayPrompt(args.prompt ?? ""), 40)}`,
			}),
			summary: (d) =>
				`Scheduled ${d.id ?? "?"} \u00b7 ${humanSchedule(d.cron ?? "")} \u00b7 next ${formatClock(d.nextFireAt)}` +
				(d.recurring === false ? " \u00b7 one-shot" : "") +
				(d.durable ? " \u00b7 durable" : "") +
				(d.runsHere === false ? " \u00b7 runs in another session" : ""),
			detail: (d) => (d.prompt ? displayPrompt(d.prompt) : undefined),
		}),
		cron_delete: compactRenderers({
			call: (args) => ({ label: "Cancel", detail: args.id ?? "" }),
			summary: (d) => (d.cancelled ? `Cancelled ${d.id ?? "?"}` : `No job ${d.id ?? "?"}`),
		}),
		cron_list: compactRenderers({
			call: () => ({ label: "List scheduled jobs" }),
			summary: (d) => {
				const jobs: LoopJob[] = d.jobs ?? [];
				if (!jobs.length) return "No scheduled jobs";
				if (jobs.length === 1) return `1 job \u00b7 ${jobSummary(jobs[0])}`;
				const shown = jobs.slice(0, 2).map(jobSummary).join(" \u00b7 ");
				return `${jobs.length} jobs \u00b7 ${shown}${jobs.length > 2 ? " \u2026" : ""}`;
			},
			detail: (d) =>
				((d.jobs ?? []) as LoopJob[])
					.map((job) => `${jobSummary(job)} \u00b7 ${truncate(displayPrompt(job.prompt), 60)}`)
					.join("\n") || undefined,
		}),
		schedule_wakeup: compactRenderers({
			call: (args) =>
				args.stop === true
					? { label: "Stop loop" }
					: {
							label: "Wakeup",
							detail: `${formatDelay(args.delaySeconds)}${args.reason ? ` \u00b7 ${truncate(args.reason, 40)}` : ""}`,
						},
			summary: (d) => {
				if (d.agedOut) return "Loop ended \u00b7 7-day limit reached";
				if (d.stopped) {
					return `Stopped \u00b7 ${d.cancelledWakeups ?? 0} wakeup${d.cancelledWakeups === 1 ? "" : "s"} cancelled`;
				}
				const adjusted = d.wasClamped ? " (clamped)" : d.cacheAdjusted ? " (cache window)" : "";
				return `Wakeup in ${formatDelay(d.clampedDelaySeconds)} \u00b7 loop ${d.id ?? "?"}${adjusted}`;
			},
			detail: (d, args) =>
				[args.reason, d.scheduledFor ? `at ${formatClock(d.scheduledFor)}` : undefined]
					.filter(Boolean)
					.join(" \u00b7 ") || undefined,
		}),
	};
}

/**
 * Draw a tick as a quiet block instead of Pi's default `[pi-cc-loop-tick]`
 * title. The provenance line is for the model, not the reader.
 */
export function renderTickMessage(message: any, options: any, theme: Theme): any {
	const details = (message.details ?? {}) as {
		tickCount?: number;
		jobId?: string;
		cron?: string;
		immediate?: boolean;
		missed?: boolean;
	};
	const text = contentText(message.content);
	const prompt = stripProvenance(text, /^\[[^\]]*\]\n?/);
	const label = details.missed
		? "loop \u00b7 missed jobs"
		: details.tickCount !== undefined
			? `loop #${details.tickCount}`
			: "loop";

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
