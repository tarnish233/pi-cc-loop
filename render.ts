/**
 * Rendering helpers for the pi-cc-loop custom messages.
 *
 * Pi renders a custom message with the raw `customType` as its title
 * (`[pi-cc-loop-tick]`), which reads like a machine name. A custom renderer
 * replaces that with a quiet two-line block, modelled on Claude Code's
 * `scheduled_task_fire` system marker: a timestamped header plus the prompt.
 *
 * No icon and no background: the accent-coloured label carries the meaning,
 * and the timestamp makes a minute-by-minute loop easy to scan.
 *
 * The renderer only affects the display. The message content the model sees is
 * unchanged.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

/** Flatten a custom message body to plain text. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const text = (part as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			})
			.join("\n");
	}
	return "";
}

/** Remove the provenance line the model needs but the reader does not. */
export function stripProvenance(text: string, pattern: RegExp): string {
	return text.replace(pattern, "");
}

/** Split a text block into displayable lines, dropping blank ones. */
export function bodyLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line.trim().length > 0);
}

/**
 * Format a timestamp the way Claude Code does: just the time for today,
 * "Oct 21 4:13 PM" for an older message.
 */
export function formatStamp(epochMs: number | undefined): string {
	const date = new Date(epochMs ?? Date.now());
	if (Number.isNaN(date.getTime())) return "";
	const now = new Date();
	const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	if (date.toDateString() === now.toDateString()) return time;
	const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${day} ${time}`;
}

/**
 * Draw a quiet event block: one coloured header line, then an indented body.
 *
 * Collapsed shows at most `maxBodyLines` body lines (plus a "+N more" note);
 * expanded shows the whole body and the metadata line.
 */
export function renderBlock(options: {
	header: string;
	body: string[];
	meta?: string[];
	expanded: boolean;
	outputPad: number;
	theme: Theme;
	maxBodyLines?: number;
}): Container {
	const { header, body, meta, expanded, outputPad, theme } = options;
	const limit = options.maxBodyLines ?? 3;
	const container = new Container();
	container.addChild(new Text(header, outputPad, 0));

	const indent = outputPad + 2;
	const shown = expanded ? body : body.slice(0, limit);
	for (const line of shown) {
		container.addChild(new Text(theme.fg("customMessageText", line), indent, 0));
	}
	if (!expanded && body.length > shown.length) {
		container.addChild(new Text(theme.fg("dim", `+${body.length - shown.length} more lines`), indent, 0));
	}
	if (expanded && meta?.length) {
		container.addChild(new Text(theme.fg("dim", meta.join(" · ")), indent, 0));
	}
	return container;
}
