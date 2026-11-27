/**
 * Bounded, sanitized log-tail reading for the shared /tasks overlay and
 * Monitor completion summaries.
 *
 * Node builtins only: this file is copied verbatim between pi-cc-monitor and
 * pi-cc-loop and must never import Pi or the TUI.
 */

import fs from "node:fs";

/** What a bounded log read returns. */
export interface LogTail {
	text: string;
	truncated: boolean;
	/** Why there is nothing to show, when the file is missing or unreadable. */
	note?: string;
}

const LOG_MAX_BYTES = 8192;
const LOG_MAX_LINES = 60;
const LOG_LINE_MAX = 500;

/** Terminal escape sequences: OSC/DCS/SOS/PM/APC (BEL or ST terminated), CSI, and Fe escapes. */
const TERMINAL_ESCAPES =
	/\x1b(?:[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
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

function readTailBytes(filePath: string, start: number, want: number): { data: Buffer; atLineStart: boolean } {
	if (want <= 0) return { data: EMPTY_BUFFER, atLineStart: start === 0 };
	const fd = fs.openSync(filePath, "r");
	try {
		let data = Buffer.alloc(want);
		let read = 0;
		while (read < want) {
			const chunk = fs.readSync(fd, data, read, want - read, start + read);
			if (chunk <= 0) break;
			read += chunk;
		}
		if (read < want) data = data.subarray(0, read);
		let atLineStart = start === 0;
		if (start > 0) {
			const prior = Buffer.alloc(1);
			atLineStart = fs.readSync(fd, prior, 0, 1, start - 1) === 1 && prior[0] === 0x0a;
		}
		return { data, atLineStart };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read a bounded tail of a log (optionally bridging from a rotated `.1` archive
 * when the current segment holds fewer than `maxBytes` bytes).
 */
export function readLogTail(
	filePath: string,
	maxBytes = LOG_MAX_BYTES,
	maxLines = LOG_MAX_LINES,
	maxLineChars = LOG_LINE_MAX,
	archivePath?: string,
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
	let buffer: Buffer = EMPTY_BUFFER;
	let atLineStart = start === 0;
	let totalSize = size;
	let byteClipped = start > 0;

	try {
		const current = readTailBytes(filePath, start, want);
		buffer = current.data;
		atLineStart = current.atLineStart;

		if (archivePath) {
			try {
				const archiveStat = fs.statSync(archivePath);
				if (archiveStat.isFile() && archiveStat.size > 0) {
					totalSize += archiveStat.size;
					const remaining = byteLimit - buffer.length;
					if (remaining > 0) {
						const archiveStart = Math.max(0, archiveStat.size - remaining);
						const archive = readTailBytes(archivePath, archiveStart, archiveStat.size - archiveStart);
						buffer = archive.data.length ? Buffer.concat([archive.data, buffer]) : buffer;
						atLineStart = archive.atLineStart;
						byteClipped = archiveStart > 0;
					} else {
						byteClipped = true;
						if (start === 0) {
							const last = readTailBytes(archivePath, archiveStat.size - 1, 1);
							atLineStart = last.data.length === 1 && last.data[0] === 0x0a;
						}
					}
				}
			} catch {
				// Missing or unreadable rotated archive is ignored; current segment stands.
			}
		}
	} catch {
		return { text: "", truncated: false, note: "log unreadable" };
	}

	let offset = 0;
	if (byteClipped) {
		while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset++;
	}
	let text = buffer.subarray(offset).toString("utf8");

	if (byteClipped && !atLineStart) {
		const newline = text.indexOf("\n");
		const rest = newline < 0 ? "" : text.slice(newline + 1);
		if (sanitizeDisplay(rest).trim()) text = rest;
	}

	let lines = text.split(/\r\n|\r|\n/);
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
	if (byteClipped) reasons.push(`${formatBytes(buffer.length)} tail of ${formatBytes(totalSize)}`);
	if (shortenedLines > 0) {
		reasons.push(`${shortenedLines} long line${shortenedLines === 1 ? "" : "s"} shortened (ends kept)`);
	}
	return { text: text_, truncated: true, note: reasons.join(" \u00b7 ") };
}

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
