/**
 * Model-facing text for pi-cc-loop: the per-run guidelines, the built-in
 * maintenance prompt and the tool descriptions.
 *
 * The tool descriptions follow Claude Code's (v2.1.302) closely. The
 * differences are Pi's: lowercase tool names, `.pi/` instead of `.claude/`,
 * and a provider-neutral note about prompt caching.
 */

import { EVENT_FALLBACK_RANGE } from "./cc-loop-policy.ts";
import { LOOP_FILE_SENTINEL } from "./loopfile.ts";

export const PROVENANCE = "[loop tick #{n} \u00b7 scheduled by /loop, not typed by the user]";
/**
 * A fixed-interval fire is framed as what it is - a scheduled task, not a
 * loop iteration. Claude Code does the same: "This turn was started
 * automatically by a schedule, not typed live by the user. The content below is
 * the stored prompt of a scheduled task ... Treat it as this session's assigned
 * task and carry it out." It never calls a cron fire a "loop tick"; that word
 * belongs to dynamic pacing, where the model has to keep the loop alive. Naming
 * it "loop" here is what made the model try to reschedule.
 */
export const SCHEDULED_TASK_PROVENANCE =
	"[scheduled task {id} \u00b7 {schedule} \u00b7 started by the schedule, not typed by the user; it fires the next tick on its own, so do not call schedule_wakeup; to cancel it, call cron_delete with id {id}]";

/** The first line of the hidden rules message a /loop request or a self-paced tick carries. */
export const RULES_PROVENANCE = "[/loop instructions for this run \u00b7 added by pi-cc-loop, not typed by the user]";

const DELAY_ADVICE = [
	`- Do not poll work Pi/Monitor will report: keep a ${EVENT_FALLBACK_RANGE}s fallback; use the same range for idle ticks.`,
	"  For external state nothing reports, match its rate of change and commit instead of stacking short waits.",
].join("\n");

/**
 * The instructions for one `/loop` request. Claude Code's `/loop` is a skill:
 * the command turns into a user message carrying these rules, and the model
 * drives CronCreate / CronList / CronDelete / ScheduleWakeup itself. Nothing is
 * created by code, so the conversation shows what was asked and what was done.
 */
const STATUS_COMMAND_GUIDELINES = [
	"This is a `/loop status` request from the user: {raw}",
	"Call `cron_list` once. Report each job's id, fixed-cron or self-paced kind, cadence, actual next run, prompt, and session-only/durable ownership. Do not create, cancel, or execute any job.",
].join("\n");

const STOP_COMMAND_GUIDELINES = [
	"This is a `/loop stop` request from the user: {raw}",
	"Use `cron_list` if needed to resolve the target. Cancel with `cron_delete` by id; this works for both fixed and self-paced loops. With no id, list and cancel all jobs.",
	"Do not use `schedule_wakeup` for a `/loop stop` request, and do not execute the loop tasks. Its `stop: true` is only for ending the current self-paced loop from inside its own run.",
	"Stop schedules/observations only, not independent business jobs; cancel a runner job only when the user explicitly asks.",
].join("\n");

const LOOP_COMMAND_GUIDELINES = [
	"This is a `/loop` request from the user: {raw}",
	"",
	"## Choose the mode",
	"- `[interval] <task>` means fixed interval; `<task>` alone means self-paced. Intervals may be natural language (\"5m\", \"every 20m\", \"每2分钟\").",
	"- An interval alone or a bare `/loop` uses the loop.md tasks below.",
	"",
	"## Fixed interval",
	"1. Call `cron_create` once with `recurring: true`, a 5-field local-time cron, and the task without its interval wording.",
	"   Under a minute rounds to `* * * * *`; 5 minutes is `*/5 * * * *`; hourly is `7 * * * *`; daily is `3 0 * * *`. Round non-clean intervals and say so.",
	"2. Do the task now; do not wait for the first fire.",
	"3. Confirm the cron, cadence, actual next run and expiry policy from the result, job id, and `/loop stop <id>` cancellation.",
	"4. Never call `schedule_wakeup` for this loop: cron fires itself, and a wakeup would run the task twice.",
	"",
	"## Self-paced",
	"- Do the task now.",
	"{monitorStep}",
	"- To continue, write your update, then call `schedule_wakeup` directly with `delaySeconds` (60-3600), a one-sentence `reason`, and the same input verbatim as `prompt` ({quoted}). It must be the last and only tool call in that assistant response, never codemode or a batch; the turn ends when it returns.",
	"{delayAdvice}",
	"- If complete or blocked on the user, call `schedule_wakeup` with `stop: true` and say why.",
	"",
	"## Flags and loop.md",
	"- For fixed cron jobs, `--durable` maps to `durable: true` and `--max N` to `maxFires: N`.",
	"- With no task of your own, pass literal {sentinel} as the prompt. It expands at each fire to `.pi/loop.md`, or the built-in maintenance pass when absent.",
	"- For the immediate run, read `.pi/loop.md` (or `~/.pi/loop.md`) yourself; only later fires expand the sentinel.",
].join("\n");

const LOOP_GUIDELINES = [
	"A self-paced `/loop` is running. Its prompt is: {prompt}",
	"After this iteration:",
	"- To continue, write your update, then call `schedule_wakeup` with `delaySeconds` (60-3600), a one-sentence `reason`, and the same prompt verbatim: {quoted}",
	"- Call it directly as the last and only tool call in that assistant response, never codemode or a batch; finish other tools earlier. The turn ends when it returns.",
	DELAY_ADVICE,
	"- If complete or blocked on the user, call `schedule_wakeup` with `stop: true` and say why.",
].join("\n");

/**
 * How a self-paced loop uses the Monitor tool, after Claude Code's /loop
 * skill: arm a monitor only when the next iteration waits on an event, arm it
 * once, and keep the wakeup as a long fallback heartbeat. A monitor event
 * does not cancel that heartbeat.
 */
const MONITOR_GUIDELINES = [
	"If the next iteration is gated on an external event, call `monitor_list`; unless a monitor already covers it,",
	`arm one observation-only \`Monitor\` for the existing file/job/WebSocket source, with \`loopPrompt\` set to {quoted}. Keep \`delaySeconds\` at ${EVENT_FALLBACK_RANGE} as the fallback heartbeat:`,
	"Submit business background work through the execution host's native external runner first, never through Monitor. Reconnect to the original jobId/runId; an observation timeout/error or loop stop is not a job result and must not resubmit or cancel it.",
	"an event does not cancel it. Handle events and decide whether to continue; finish Monitor calls before the final standalone `schedule_wakeup` call.",
].join("\n");

/**
 * Fill `{name}` placeholders. A replacer function is used so that `$&` or
 * `$1` in a prompt are inserted literally.
 */
export function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** The prompt as a JSON string: unambiguous even with quotes or newlines. */
export function quote(prompt: string): string {
	return JSON.stringify(prompt);
}

/** How a prompt is described to the model; the loop.md sentinel gets an explanation. */
function describePrompt(prompt: string): string {
	if (prompt !== LOOP_FILE_SENTINEL) return prompt;
	return (
		"the loop tasks in the message above (pass the literal sentinel " +
		`${quote(LOOP_FILE_SENTINEL)} as \`prompt\`: it expands to the current loop.md tasks, or the built-in ` +
		"maintenance pass when there is no loop.md, every time it fires)"
	);
}

export function provenance(tick: number): string {
	return fill(PROVENANCE, { n: String(tick) });
}

/** The header of a fixed-interval fire: a scheduled task, not a loop tick. */
export function scheduledTaskProvenance(id: string, schedule: string): string {
	return fill(SCHEDULED_TASK_PROVENANCE, { id, schedule });
}

export function loopCommandGuidelines(raw: string, options: { monitorAvailable?: boolean } = {}): string {
	const trimmed = raw.trim();
	const quotedRaw = raw ? quote(raw) : "(empty: the loop.md tasks)";
	// Management needs only its own short protocol, not the fixed/self-paced
	// tutorial. Keep the match narrow so a task such as "status report" is not
	// accidentally reclassified as a management command.
	if (/^(?:status|list)$/i.test(trimmed)) return fill(STATUS_COMMAND_GUIDELINES, { raw: quotedRaw });
	if (/^stop(?:\s+\S+)?$/i.test(trimmed)) return fill(STOP_COMMAND_GUIDELINES, { raw: quotedRaw });

	const quoted = quote(raw || LOOP_FILE_SENTINEL);
	const monitorStep = options.monitorAvailable === true
		? `- If the next iteration waits on an external event and no monitor covers it, observe the existing file/job/WebSocket source with \`Monitor\` once and \`loopPrompt\` set to ${quoted}; keep the wakeup at ${EVENT_FALLBACK_RANGE}s as fallback. Business background work belongs to an external runner, not Monitor. Loop/observation stop must not cancel or resubmit that job.`
		: "";
	return fill(LOOP_COMMAND_GUIDELINES, {
		raw: quotedRaw,
		quoted,
		monitorStep,
		delayAdvice: DELAY_ADVICE,
		sentinel: quote(LOOP_FILE_SENTINEL),
	});
}

export function loopGuidelines(prompt: string): string {
	return fill(LOOP_GUIDELINES, { prompt: describePrompt(prompt), quoted: quote(prompt) });
}

export function monitorGuidelines(prompt: string): string {
	return fill(MONITOR_GUIDELINES, { quoted: quote(prompt) });
}

/** Claude Code's notice for durable one-shot jobs that came due while nobody was running them. */
export function missedJobsMessage(lines: string[]): string {
	const one = lines.length === 1;
	return [
		"[missed scheduled jobs \u00b7 reported by /loop, not typed by the user]",
		`The following one-shot scheduled task${one ? " was" : "s were"} missed while Pi was not running. ` +
			`${one ? "It has" : "They have"} already been removed from .pi/scheduled_tasks.json.`,
		`Do NOT execute ${one ? "this prompt" : "these prompts"} yet. First ask the user whether to run ` +
			`${one ? "it" : "each one"} now. Only execute if the user confirms.`,
		...lines,
	].join("\n");
}

// ---------------------------------------------------------------- tools

export const CRON_CREATE_DESCRIPTION = `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.
Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local \u2014 no timezone conversion needed.

## One-shot tasks (recurring: false)
For "remind me at X" or "at <time>, do Y" requests \u2014 fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" \u2192 cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" \u2192 cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)
For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "7 * * * *" (hourly, offset from :00), "0 9 * * 1-5" (weekdays at 9am sharp local)

## Avoid the :00 and :30 minute marks when the task allows it
When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" \u2192 "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" \u2192 "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." \u2192 pick whatever minute you land on, don't round
Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past").

## Durability
By default (durable: false) the job belongs to this Pi session: it is restored if the session is resumed and gone otherwise. Pass durable: true to write it to .pi/scheduled_tasks.json so it survives restarts; one Pi session per project runs the durable jobs. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently").

## Not for live watching
cron_create re-runs a prompt at fixed wall-clock intervals. To watch an existing file, external job status or WebSocket and be told when something changes, use the observation-only Monitor tool when available \u2014 it streams events; cron polls on a schedule. Submit business background work through a native external runner, not Monitor. Stopping a loop or its observation does not cancel the external job.

## Runtime behavior
Jobs only fire while the agent is idle (not mid-turn). The scheduler shifts each job by a fixed per-job offset on top of whatever you pick: a recurring job runs up to half its period late (max 30 min), a "*/5 * * * *" job keeps its 5 minute cadence, late by that offset rather than early, and a one-shot job landing on :00 or :30 runs up to 90 s early. The result of this tool and of cron_list gives each job's actual next run time: when you tell the user when a job will run, give that time, not the minute in the cron expression.
Recurring jobs auto-expire after 7 days by default \u2014 they fire one final time, then are deleted. The extension can change or disable this limit. Tell the user the actual expiry policy reported by this tool when scheduling recurring jobs.
Returns a job ID you can pass to cron_delete.
Ending, failing or stopping a job always wakes the model. There is no parameter to disable that.`;

export const CRON_DELETE_DESCRIPTION =
	"Cancel a scheduled prompt or end a self-paced /loop by id. Remove it from .pi/scheduled_tasks.json or this session. Ending a self-paced loop also stops its bound observations. It does not cancel independent external-runner business jobs.";

export const CRON_LIST_DESCRIPTION =
	"List the scheduled jobs, both durable (.pi/scheduled_tasks.json) and session-only, with their ids, schedules, actual next run times and prompts.";

export const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule the next iteration of a self-paced /loop. To continue, pass \`delaySeconds\` (60-3600), a one-sentence \`reason\`, and the same /loop prompt verbatim via \`prompt\`. For a bare /loop, pass the literal sentinel "${LOOP_FILE_SENTINEL}": it expands at fire time to the current loop.md tasks, or the built-in maintenance pass when absent.

Call directly as the last and only tool call in that assistant response, never through codemode or in a batch. Finish Monitor and other tools in earlier responses and write your update first: the turn ends as soon as it returns. To end the current self-paced loop, call it with \`stop: true\` alone and explain the outcome; stopping does not force the turn to end. For a \`/loop stop <id>\` request, use \`cron_delete\` instead: it cancels either kind by id.

## Picking delaySeconds
Do not poll work Pi/Monitor will report: schedule a ${EVENT_FALLBACK_RANGE}s fallback so the loop survives if no event arrives. Use the same default for idle ticks. For external state nothing reports, match its rate of change and commit instead of stacking short waits. The runtime clamps to [60, 3600].

## Only for self-paced loops
A /loop with an interval is a cron job: it fires itself, and calling this from its tick would run the prompt twice. Cancel that kind with \`cron_delete\`.

## The reason field
One short sentence on what you chose and why, shown to the user: "watching CI run" beats "waiting".
Ending, failing or stopping this loop always wakes the model. There is no parameter to disable that.`;

export const CRON_CREATE_SNIPPET = "Schedule a prompt on a 5-field cron expression, recurring or one-shot";
export const CRON_DELETE_SNIPPET = "Cancel a scheduled job or a self-paced /loop by id";
export const CRON_LIST_SNIPPET = "List scheduled jobs with their actual next run times";
export const SCHEDULE_WAKEUP_SNIPPET = "Pick when a self-paced /loop runs next, or stop it";
