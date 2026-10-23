/**
 * Model-facing text for pi-cc-loop: the per-run guidelines, the built-in
 * maintenance prompt and the tool descriptions.
 *
 * The tool descriptions follow Claude Code's (v2.1.302) closely. The
 * differences are Pi's: lowercase tool names, `.pi/` instead of `.claude/`,
 * and a provider-neutral note about prompt caching.
 */

/** A bare `/loop` stores this as its prompt; it expands to loop.md (or the maintenance pass) at fire time. */
export const LOOP_FILE_SENTINEL = "<<loop.md>>";

/** Claude Code's built-in maintenance prompt, used when there is no loop.md. */
export const MAINTENANCE_PROMPT = [
	"You are running a scheduled maintenance pass.",
	"Work through the following, in order:",
	"1. Continue any unfinished work from the conversation.",
	"2. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts.",
	"3. Run cleanup passes such as bug hunts or simplification when nothing else is pending.",
	"Do not start new initiatives outside that scope, and only perform irreversible actions",
	"(push, delete) that continue something the transcript already authorized.",
	"If nothing needs doing, say so in one line.",
].join("\n");

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
	"- Pick the delay from what you are waiting for. For idle ticks with nothing specific to watch, use 1200-1800s.",
	"  When actively polling external state nothing notifies you about (a CI run, a deploy), match how fast it changes.",
	"- Do not poll for work Pi will report anyway (a monitor event, a command you are running): use a long",
	"  fallback (1200s+) instead.",
].join("\n");

/**
 * The rules for a `/loop <prompt>` whose interval the command layer could not
 * parse. Claude Code's /loop is a skill: the model reads the input and works
 * the schedule out itself, so an interval written in any language works.
 */
/**
 * The instructions for one `/loop` request. Claude Code's `/loop` is a skill:
 * the command turns into a user message carrying these rules, and the model
 * drives CronCreate / CronList / CronDelete / ScheduleWakeup itself. Nothing is
 * created by code, so the conversation shows what was asked and what was done.
 */
const LOOP_FILE_SENTINEL_PLACEHOLDER = "__loop_md_sentinel__";

const LOOP_COMMAND_GUIDELINES = [
	"This is a `/loop` request from the user: {raw}",
	"",
	"## Read the input",
	"- `[interval] <task>`: an interval was given (\"5m\", \"2h\", \"every 20m\", \"每2分钟\", \"每隔2小时\"). Use the fixed-interval mode below.",
	"- `<task>` alone: no interval. Use the self-paced mode below and choose each delay yourself.",
	"- An interval alone, or a bare `/loop`: the tasks come from loop.md (see the last section).",
	"- `stop [id]` or `status`: see those sections.",
	"",
	"## Fixed interval (an interval was given)",
	"1. Call `cron_create` **once**, `recurring: true`, with a 5-field cron expression in local time and the task **without** the interval wording, so every run does the task instead of scheduling it again.",
	"   - under a minute rounds up to `* * * * *`; 5 minutes is `*/5 * * * *`; every hour is `0 * * * *`; every day is `0 0 * * *`.",
	"   - if the interval does not divide its unit cleanly, round to the nearest clean interval and say so.",
	"2. **Then do the task now** \u2014 do not wait for the first fire.",
	"3. Confirm briefly: what is scheduled, the cron expression, the cadence, the next run from the tool result, that a recurring job expires after 7 days (it fires once more, then is deleted), the job id, and that `/loop stop <id>` cancels it.",
	"4. Never call `schedule_wakeup` for this loop: the cron fires its own ticks. Scheduling one would run the task twice.",
	"",
	"## Self-paced (no interval)",
	"1. Do the task now, then write your update for the user.",
	"2. Then call `schedule_wakeup` with `delaySeconds` (60-3600), a one-sentence `reason`, and `prompt` set to the same `/loop` input verbatim ({quoted}). The turn ends as soon as it returns, so call it last.",
	"{delayAdvice}",
	"3. If the next iteration waits on an external event and no monitor is running for it, arm `Monitor` once with `loopPrompt` set to {quoted}; keep `delaySeconds` at 1200-1800 as the fallback heartbeat.",
	"4. If the task is complete or cannot progress without the user, call `schedule_wakeup` with `stop: true` and say why.",
	"",
	"## status and stop",
	"- `status`: call `cron_list` and report each job's id, cadence, next run and prompt, plus whether it is session-only or durable.",
	"- `stop`: if the id is unknown, call `cron_list` first; then `cron_delete` for a scheduled job. A self-paced loop is ended with `schedule_wakeup` and `stop: true`.",
	"",
	"## Flags",
	"- `--durable`: pass `durable: true` to `cron_create` so the job survives restarts.",
	"- `--max N`: pass `maxFires: N`.",
	"",
	"## loop.md",
	"When the request has no task of its own (bare `/loop`, or an interval alone), pass the literal sentinel " + LOOP_FILE_SENTINEL_PLACEHOLDER + " as the prompt: it expands at fire time to `.pi/loop.md`, or to the built-in maintenance pass when there is no loop.md.",
	"For the run you do right now, read `.pi/loop.md` (or `~/.pi/loop.md`) yourself and do those tasks; the sentinel only expands on later fires.",
].join("\n");

const LOOP_GUIDELINES = [
	"A self-paced `/loop` is running. Its prompt is: {prompt}",
	"After this iteration, decide whether the loop continues:",
	"- To continue, call the `schedule_wakeup` tool with `delaySeconds` (60-3600), a one-sentence `reason`,",
	"  and `prompt` set to the same /loop prompt verbatim: {quoted}",
	"- Write your update for the user before you call `schedule_wakeup`: the turn ends as soon as it returns.",
	DELAY_ADVICE,
	"- If the task is complete, or the loop cannot move further without the user, call `schedule_wakeup`",
	"  with `stop: true` instead and say why.",
].join("\n");

/**
 * How a self-paced loop uses the Monitor tool, after Claude Code's /loop
 * skill: arm a monitor only when the next iteration waits on an event, arm it
 * once, and keep the wakeup as a long fallback heartbeat. A monitor event
 * does not cancel that heartbeat.
 */
const MONITOR_GUIDELINES = [
	"If the next iteration is gated on an external event (a CI run finishing, a PR comment, a log line) and no",
	"monitor is already running for it, arm one with the `Monitor` tool and set `loopPrompt` to {quoted}, so the",
	"event wakes you as soon as it happens. Arm it once: on later iterations call `monitor_list` first and skip",
	"this step while a monitor for it is still running.",
	"While a monitor is armed, keep `delaySeconds` at 1200-1800: the monitor is the wake signal and the",
	"`schedule_wakeup` delay is only the fallback heartbeat. When a monitor event wakes you, handle the event,",
	"then decide whether the loop continues.",
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

export function loopCommandGuidelines(raw: string): string {
	const quoted = quote(raw || LOOP_FILE_SENTINEL);
	return fill(LOOP_COMMAND_GUIDELINES, {
		raw: raw ? `${quote(raw)}` : "(empty: the loop.md tasks)",
		quoted,
		delayAdvice: DELAY_ADVICE,
	}).replace(LOOP_FILE_SENTINEL_PLACEHOLDER, quote(LOOP_FILE_SENTINEL));
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
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it
When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" \u2192 "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" \u2192 "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." \u2192 pick whatever minute you land on, don't round
Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past").

## Durability
By default (durable: false) the job belongs to this Pi session: it is restored if the session is resumed and gone otherwise. Pass durable: true to write it to .pi/scheduled_tasks.json so it survives restarts; one Pi session per project runs the durable jobs. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently").

## Not for live watching
cron_create re-runs a prompt at fixed wall-clock intervals. To watch a log file, process, or command output and be told the moment something changes, use the Monitor tool instead when it is available \u2014 it streams events as they happen; cron polls on a schedule.

## Runtime behavior
Jobs only fire while the agent is idle (not mid-turn). The scheduler shifts each job by a fixed per-job offset on top of whatever you pick: a recurring job runs up to half its period late (max 30 min), a "*/5 * * * *" job keeps its 5 minute cadence, late by that offset rather than early, and a one-shot job landing on :00 or :30 runs up to 90 s early. The result of this tool and of cron_list gives each job's actual next run time: when you tell the user when a job will run, give that time, not the minute in the cron expression.
Recurring jobs auto-expire after 7 days \u2014 they fire one final time, then are deleted. Tell the user about the 7-day limit when scheduling recurring jobs.
Returns a job ID you can pass to cron_delete.`;

/**
 * Appended to the result of a recurring `cron_create` in a plain turn (not a
 * /loop request, not a scheduled tick). Claude Code's /loop skill says "Then
 * immediately run it now ... Don't wait for the first cron fire", and its model
 * reaches that skill for "every 5 minutes ..." typed without /loop: the skill is
 * listed every turn and CronCreate is a deferred tool. Pi has no deferred tools,
 * so the model calls cron_create directly and the result says it instead. A
 * tool result is appended at the end of the transcript; the cache is untouched.
 */
export const RUN_NOW_HINT =
	'If the user asked for this to repeat on an interval ("every 5 minutes"), do the task once now as well \u2014 ' +
	'don\'t wait for the first fire, as /loop does. A job at set times ("every day at 9am") only runs at those times.';

export const CRON_DELETE_DESCRIPTION =
	"Cancel a job scheduled with cron_create, or end a self-paced /loop, by its id. Removes it from .pi/scheduled_tasks.json (durable jobs) or from this session (session-only jobs).";

export const CRON_LIST_DESCRIPTION =
	"List the scheduled jobs, both durable (.pi/scheduled_tasks.json) and session-only, with their ids, schedules, actual next run times and prompts.";

export const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule when to resume work in a self-paced /loop \u2014 the user invoked /loop without an interval, asking you to self-pace iterations of a task. Call it as the last thing in the turn to keep the loop alive: the turn ends as soon as it returns, so write your update for the user first. To end the loop, call it with stop: true (omit every other field).

Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. For a bare /loop (no prompt), pass the literal sentinel "${LOOP_FILE_SENTINEL}": it expands at fire time to the current loop.md tasks, or to the built-in maintenance pass when there is no loop.md.

Do not schedule a short wakeup to poll for work Pi will tell you about anyway (a monitor event, a command you are running): schedule a long fallback (1200s+) so the loop survives if that never arrives. For external work nothing notifies you about (a CI run, a deploy, a remote queue), pick a delay matched to how fast that state actually changes.

## Picking delaySeconds
Pick the delay from what you are waiting for. When actively polling state nothing notifies you about, match how fast it changes and commit to it instead of stacking short waits. For idle ticks with no specific signal to watch, default to 1200-1800s (20-30 min). The runtime clamps to [60, 3600].

## Only for self-paced loops
A /loop started with an interval (for example /loop 5m ...) is a cron job: it fires its own ticks, and calling this from one of those ticks would run the prompt twice. Cancel that kind of loop with \`cron_delete\` instead.

## The reason field
One short sentence on what you chose and why. It is shown to the user: "watching CI run" beats "waiting".`;

export const CRON_CREATE_SNIPPET = "Schedule a prompt on a 5-field cron expression, recurring or one-shot";
export const CRON_DELETE_SNIPPET = "Cancel a scheduled job or a self-paced /loop by id";
export const CRON_LIST_SNIPPET = "List scheduled jobs with their actual next run times";
export const SCHEDULE_WAKEUP_SNIPPET = "Pick when a self-paced /loop runs next, or stop it";
