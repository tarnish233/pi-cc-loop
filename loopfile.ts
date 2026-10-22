/**
 * loop.md support, resolved at fire time like Claude Code's `<<loop.md>>`
 * sentinel.
 *
 * Claude Code docs: "Edits to loop.md take effect on the next iteration, so
 * you can refine the instructions while a loop is running. When no loop.md
 * exists in either location, the loop falls back to the built-in maintenance
 * prompt. Keep the file concise: content beyond 25,000 bytes is truncated."
 *
 * A bare `/loop` stores the sentinel as its prompt instead of the file's text,
 * so the model does not have to echo a long prompt back to `schedule_wakeup`,
 * and each tick reads the file again. The full text goes out on the first
 * delivery and whenever the file changed; otherwise a short reminder points
 * back to it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOOP_FILE_SENTINEL, MAINTENANCE_PROMPT } from "./prompts.ts";

/** Claude Code truncates loop.md beyond this length. */
export const LOOP_FILE_MAX_CHARS = 25_000;

const MAINTENANCE_MARKER = "\u0000maintenance";

export function isLoopFileSentinel(prompt: string | undefined): boolean {
	return prompt?.trim() === LOOP_FILE_SENTINEL;
}

/** How a job's prompt is shown to the user. */
export function displayPrompt(prompt: string): string {
	return isLoopFileSentinel(prompt) ? "/loop (loop.md)" : prompt;
}

/** Project first, then user level, like Claude Code's .claude/loop.md and ~/.claude/loop.md. */
export function loopFileCandidates(cwd: string): string[] {
	return [path.join(cwd, ".pi", "loop.md"), path.join(os.homedir(), ".pi", "loop.md")];
}

/** The first non-empty loop file, truncated like Claude Code's. */
export function readLoopFile(cwd: string): { path: string; content: string } | null {
	for (const candidate of loopFileCandidates(cwd)) {
		let raw: string;
		try {
			raw = fs.readFileSync(candidate, "utf8");
		} catch {
			continue;
		}
		const content = raw.trim();
		if (content) return { path: candidate, content: truncate(content) };
	}
	return null;
}

function truncate(content: string): string {
	if (content.length <= LOOP_FILE_MAX_CHARS) return content;
	const cut = content.lastIndexOf("\n", LOOP_FILE_MAX_CHARS);
	return `${content.slice(0, cut > 0 ? cut : LOOP_FILE_MAX_CHARS)}\n> WARNING: loop.md was truncated to ${LOOP_FILE_MAX_CHARS} bytes. Keep the task list concise.`;
}

export type TickMode = "cron" | "wakeup";

/** Remembers what a session was last given, so unchanged tasks are not resent. */
export class LoopFileDelivery {
	private lastDelivered: string | null = null;

	/** Send the full text on the next tick (a new /loop, or after compaction). */
	reset(): void {
		this.lastDelivered = null;
	}

	/** The text of one tick for the loop.md sentinel. */
	resolve(cwd: string, mode: TickMode): string {
		const file = readLoopFile(cwd);
		if (file) {
			if (this.lastDelivered === file.content) {
				return (
					"# /loop tick \u2014 loop.md tasks\n" +
					"Work the tasks from the loop.md contents established earlier in this conversation. " +
					"If you cannot find them, treat this as a no-op tick."
				);
			}
			this.lastDelivered = file.content;
			return [
				`# /loop tick \u2014 tasks from ${file.path}`,
				"The user configured a loop-tasks file. Work through the tasks defined below; these are the " +
					"instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).",
				"",
				file.content,
			].join("\n");
		}
		if (this.lastDelivered === MAINTENANCE_MARKER) {
			return (
				"# /loop tick \u2014 maintenance pass\n" +
				"Run the maintenance pass using the instructions established earlier in this conversation. " +
				"If you cannot find them, treat this as a no-op tick."
			);
		}
		this.lastDelivered = MAINTENANCE_MARKER;
		return MAINTENANCE_PROMPT;
	}
}
