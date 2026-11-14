/**
 * Bounded, sanitized log-tail reading for the shared /tasks overlay.
 *
 * Node builtins only: this file is copied verbatim between the task-owning
 * packages (pi-cc-monitor and pi-cc-loop) and must never import Pi or the
 * TUI. Every byte shown is bounded (total tail bytes, line count, characters
 * per line), sanitized (ANSI escapes, C0/C1 controls and bidi overrides are
 * stripped, so nothing can be re-injected into the terminal), and the raw
 * log file is never modified.
 *
 * Failure policy: a missing, unreadable or non-file path is a note, not an
 * error - the task viewer must keep working after a log is cleaned up. All
 * clipping is detected and reported truthfully: byte-bounded tails, dropped
 * older lines, and long lines shortened with their ending preserved (log
 * lines end with the marker that matters: an exit status or result).
 */

import fs from "node:fs";

/** What a bounded log read returns. */
export interface LogTail {
	text: string;
	truncated: boolean;
	/** Why there is nothing to show, when the file is missing or unreadable. */
	note?: string;
}

/** A log tail is small enough to read synchronously and wide enough to be useful. */
const LOG_MAX_BYTES = 8192;
const LOG_MAX_LINES = 60;
const LOG_LINE_MAX = 500;

/** Terminal escape sequences: OSC ( BEL / ST terminated), CSI, and other Fe escapes. */
const TERMINAL_ESCAPES =
	/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
/** Dangling surrogates: not valid UTF-8 once the text is written back out. */
const DANGLING_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Strip ANSI escapes, C0/C1 controls and bidi overrides from anything shown.
 * Tabs, newlines and carriage returns survive; anything else control-like is
 * removed so no escape sequence can survive into a rendered line.
 */
export function sanitizeDisplay(value: unknown): string {
	return String(value ?? "")
		.replace(TERMINAL_ESCAPES, "")
		.replace(DANGLING_SURROGATES, "")
		.replace(/\x1b/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Read a bounded tail of a log. Missing files and permission errors are
 * notes, not failures. Byte clipping drops the partial first line of the
 * tail - unless that would leave nothing (the whole tail is one huge line),
 * in which case a bounded fragment of its ending is kept so a final marker
 * survives. `truncated` and `note` report every kind of clipping truthfully.
 */
export function readLogTail(
	filePath: string,
	maxBytes = LOG_MAX_BYTES,
	maxLines = LOG_MAX_LINES,
	maxLineChars = LOG_LINE_MAX,
): LogTail {
	if (!filePath) return { text: "", truncated: false, note: "no log path" };
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		return {
			text: "",
			truncated: false,
			note: errorCode(error) === "ENOENT" ? "log not created yet" : "log unreadable",
		};
	}
	if (!stat.isFile()) return { text: "", truncated: false, note: "log is not a file" };

	const byteLimit = Math.max(0, Math.floor(maxBytes));
	const size = stat.size;
	const start = Math.max(0, size - byteLimit);
	const want = size - start;
	let buffer = EMPTY_BUFFER;
	if (want > 0) {
		try {
			const fd = fs.openSync(filePath, "r");
			try {
				buffer = Buffer.alloc(want);
				let read = 0;
				while (read < want) {
					const chunk = fs.readSync(fd, buffer, read, want - read, start + read);
					if (chunk <= 0) break;
					read += chunk;
				}
				// Trust only the bytes actually read: the file may have shrunk
				// between stat and read.
				if (read < want) buffer = buffer.subarray(0, read);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return { text: "", truncated: false, note: "log unreadable" };
		}
	}

	// A byte-bounded tail can start inside a UTF-8 character; skip the sliced
	// continuation bytes so the decoded head is valid UTF-8.
	let offset = 0;
	if (start > 0) {
		while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset++;
	}
	let text = buffer.subarray(offset).toString("utf8");

	// Drop a partial first line only when useful content survives the drop.
	// Blank lines (or terminal styles) after a huge line are not a replacement
	// for that line's final result.
	const byteClipped = start > 0;
	if (start > 0) {
		const newline = text.indexOf("\n");
		const rest = newline < 0 ? "" : text.slice(newline + 1);
		if (sanitizeDisplay(rest).trim()) text = rest;
	}

	let lines = text.split(/\r\n|\r|\n/);
	// Trim the terminal empty line before the line-count limit so a trailing
	// newline never consumes one of the last-lines slots.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const lineLimit = Math.max(1, Math.floor(maxLines));
	const lineClipped = lines.length > lineLimit;
	if (lineClipped) lines = lines.slice(-lineLimit);

	const charLimit = Math.max(4, Math.floor(maxLineChars));
	let shortenedLines = 0;
	const sanitized: string[] = [];
	for (const line of lines) {
		const clean = sanitizeDisplay(line).replace(/\t/g, "    ");
		if (clean.length > charLimit) {
			shortenedLines++;
			sanitized.push(shortenLine(clean, charLimit));
		} else {
			sanitized.push(clean);
		}
	}

	const text_ = sanitized.join("\n");
	if (!byteClipped && !lineClipped && shortenedLines === 0) {
		return { text: text_, truncated: false };
	}
	const reasons: string[] = [];
	if (byteClipped || lineClipped) reasons.push(`last ${sanitized.length} line${sanitized.length === 1 ? "" : "s"}`);
	if (byteClipped) reasons.push(`${formatBytes(buffer.length)} tail of ${formatBytes(size)}`);
	if (shortenedLines > 0) {
		reasons.push(`${shortenedLines} long line${shortenedLines === 1 ? "" : "s"} shortened (ends kept)`);
	}
	return { text: text_, truncated: true, note: reasons.join(" \u00b7 ") };
}

/**
 * Shorten one plain line to at most `maxChars` characters while keeping its
 * ending. Character counts, not terminal widths: no TUI dependency here.
 * The final ellipsis marks the cut; dangling surrogates at the cut points
 * are removed so the result stays valid UTF-8.
 */
function shortenLine(line: string, maxChars: number): string {
	const tail = Math.max(1, Math.floor(maxChars / 4));
	const head = Math.max(1, maxChars - tail - 1);
	return `${line.slice(0, head)}\u2026${line.slice(line.length - tail)}`.replace(DANGLING_SURROGATES, "");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

const EMPTY_BUFFER = Buffer.alloc(0);
