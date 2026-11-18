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

/** Claude Code truncates loop.md beyond this many UTF-8 bytes. */
export const LOOP_FILE_MAX_BYTES = 25_000;

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
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= LOOP_FILE_MAX_BYTES) return content;
	// Start at the byte limit and back off only when it splits a UTF-8 code
	// point. fs.readFileSync has already normalized the input to valid Unicode.
	let end = LOOP_FILE_MAX_BYTES;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	const prefix = bytes.subarray(0, end).toString("utf8");
	const newline = prefix.lastIndexOf("\n");
	const kept = newline > 0 ? prefix.slice(0, newline) : prefix;
	return `${kept}\n> WARNING: loop.md was truncated to ${LOOP_FILE_MAX_BYTES} bytes. Keep the task list concise.`;
}

/** Remembers what a session was last given, so unchanged tasks are not resent. */
export class LoopFileDelivery {
	private lastDelivered: string | null = null;
	/**
	 * The one outstanding supplement receipt: its token travels in the rules
	 * message's details, its key is the snapshot captured at preparation time.
	 * Runs are serialized, so one slot suffices; a newer peek replaces it.
	 */
	private pending: { token: number; key: string } | null = null;
	private nextToken = 0;

	/** Send the full text on the next tick: after a compaction the earlier copy is gone. */
	reset(): void {
		this.lastDelivered = null;
		// An outstanding receipt must not restore a snapshot this reset invalidated.
		this.pending = null;
	}

	/**
	 * The text of one tick for the loop.md sentinel. `remember: false` resolves
	 * without recording delivery, for a supplement that must not mark the body
	 * as delivered before the run actually starts.
	 */
	resolve(cwd: string, remember = true): string {
		return this.textFor(readLoopFile(cwd), remember);
	}

	private textFor(file: { path: string; content: string } | null, remember: boolean): string {
		if (file) {
			if (this.lastDelivered === file.content) {
				return (
					"# /loop tick \u2014 loop.md tasks\n" +
					"Work the tasks from the loop.md contents established earlier in this conversation. " +
					"If you cannot find them, treat this as a no-op tick."
				);
			}
			if (remember) this.lastDelivered = file.content;
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
		if (remember) this.lastDelivered = MAINTENANCE_MARKER;
		return MAINTENANCE_PROMPT;
	}

	/**
	 * The full text to supplement a run whose context lost it (compaction ran
	 * after the tick was resolved, or tree navigation left the branch), or null
	 * when the earlier copy still stands. Noncommitting until `acknowledge`: if
	 * the run fails to start, the next normal tick still resends the full body.
	 * The receipt commits the snapshot captured here, never a later file read.
	 */
	peek(cwd: string): { text: string; token: number } | null {
		const file = readLoopFile(cwd);
		const key = file ? file.content : MAINTENANCE_MARKER;
		if (this.lastDelivered === key) return null;
		const token = ++this.nextToken;
		this.pending = { token, key };
		return { text: this.textFor(file, false), token };
	}

	/** Commit the captured snapshot once Pi has finalized the supplement message. */
	acknowledge(token: number): void {
		if (this.pending?.token !== token) return;
		this.lastDelivered = this.pending.key;
		this.pending = null;
	}
}
