/** Task panel projections. The runtime supplies ownership and scheduling facts. */
import { humanSchedule } from "./cron.ts";
import { displayPrompt } from "./loopfile.ts";
import { formatDateTime as dateTime } from "./render.ts";
import { formatEta } from "./renderers.ts";
import type { LoopJob } from "./schedule.ts";
import type { TaskDetail, TaskItem } from "./tasks.ts";

export type ListedSchedule = LoopJob & { foreignReason?: "other-session" | "other-folder" };

/** The live state a pending/wakeup job is in right now. */
function jobState(job: ListedSchedule, now: number, running: boolean): string {
	if (job.foreignReason) return job.foreignReason === "other-folder" ? "foreign (other folder)" : "foreign (other session)";
	if (job.pending) return "pending (waiting for idle)";
	if (job.kind === "wakeup") {
		if (job.keepaliveTurn) return "keepalive turn";
		if (job.awaitingReschedule) return running ? "active (turn running)" : "active / awaiting reschedule";
	}
	const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
	if (at !== undefined && at <= now) return "due";
	return at !== undefined ? "scheduled" : "armed";
}

export function loopTaskItem(job: ListedSchedule, now: number, running: boolean): TaskItem {
	const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
	const meta: string[] = [];
	if (job.pending) meta.push("waiting for idle");
	else if (job.foreignReason) meta.push(job.foreignReason === "other-folder" ? "other folder" : "other session");
	else if (at !== undefined) meta.push(`${at <= now ? "due" : "next"} ${at <= now ? "now" : formatEta(at - now)}`);
	meta.push(`${job.fireCount ?? 0} fire${job.fireCount === 1 ? "" : "s"}`);
	if (job.durable) meta.push("durable");
	return {
		id: job.id,
		title: displayPrompt(job.prompt),
		createdAt: job.createdAt,
		state: jobState(job, now, running).replace(/ \(.*$/, ""),
		active: true,
		meta: meta.join(" · "),
	};
}

export function loopTaskDetail(job: ListedSchedule, now: number, running: boolean, durableOwner: boolean): TaskDetail {
	const at = job.kind === "cron" ? job.nextFireAt : job.scheduledFor;
	const state = jobState(job, now, running);
	const ownership = job.foreignReason
		? job.foreignReason === "other-folder"
			? "durable · copied from another folder (listed, not run here)"
			: "durable · run by another Pi session in this project"
		: job.durable
			? durableOwner
				? "durable · run by this session"
				: "durable · loaded, but another session holds the scheduler lock"
			: "session only";
	const fires = `${job.fireCount ?? 0}${job.maxFires !== undefined ? `/${job.maxFires}` : ""}` +
		(job.lastFiredAt !== undefined ? ` · last ${dateTime(job.lastFiredAt)}` : "");
	const rows = [
		{ label: "Kind", value: job.kind === "cron" ? "fixed interval (cron)" : "self-paced wakeup" },
		{ label: "State", value: state },
		{
			label: "Schedule",
			value: job.kind === "cron" ? `${job.cron ?? "?"} (${humanSchedule(job.cron ?? "")})` : "self-paced: the model picks the next delay",
		},
		{
			label: "Next run",
			value: job.pending
				? "due · waiting for idle"
				: at === undefined
					? "unscheduled"
					: `${dateTime(at)} · ${at <= now ? "due now" : `in ${formatEta(at - now)}`} · ${at} ms`,
		},
		{ label: "Reason", value: job.reason ?? "—" },
		{ label: "Fires", value: fires },
		{
			label: "Pending",
			value: job.pending
				? `yes · since ${dateTime(job.dueAt)} · waiting for the agent to go idle`
				: "no",
		},
		{
			label: "Chain",
			value:
				job.kind === "wakeup"
					? job.awaitingReschedule
						? "active · the turn is running or waiting to reschedule"
						: job.keepaliveUsed
							? "keepalive used"
							: "armed"
					: "fixed interval · fires its own next tick",
		},
		{ label: "Ownership", value: ownership },
		{ label: "Prompt", value: displayPrompt(job.prompt) },
		{ label: "Source", value: job.source },
		{ label: "Created", value: dateTime(job.createdAt) },
		{ label: "Project", value: job.createdInProject ?? "—" },
		{ label: "Keepalive", value: job.keepaliveUsed ? (job.keepaliveTurn ? "this turn is the keepalive" : "used once") : "not used" },
	] satisfies TaskDetail["rows"];
	return {
		rows,
		note: job.foreignReason
			? "Not running here. x removes it from .pi/scheduled_tasks.json; it does not abort another session's turn."
			: "x removes the schedule (and any Monitor bound to a stopped self-paced loop). It does not abort the main agent.",
	};
}
