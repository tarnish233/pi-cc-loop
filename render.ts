/**
 * Rendering helpers for the pi-cc custom messages (loop ticks, monitor events).
 *
 * Pi renders a custom message with its raw `customType` as the title, which
 * reads like a machine name. A custom renderer replaces that with either a
 * quiet block (the default) or the legacy padded card, depending on
 * `compactMessages`.
 *
 * The quiet block is modelled on Claude Code's `scheduled_task_fire` marker:
 * a timestamped header plus the text, with no icon and no background. Long
 * text is capped to a few lines while collapsed; expanding shows all of it and
 * the metadata.
 *
 * The renderer only affects the display. The message content the model sees is
 * unchanged.
 *
 * This file is identical in pi-cc-loop and pi-cc-monitor; tests/shared.test.mjs
 * fails when the two copies drift apart.
 */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";

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

/** Cap a string for a display line, with an ellipsis. */
export function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}\u2026`;
}

/** "900ms", "5s", "1m 30s": a duration for a status line. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
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
	// Claude Code's clock style: "6:16pm", lowercase, no space.
	const hour = date.getHours();
	const time = `${hour % 12 === 0 ? 12 : hour % 12}:${String(date.getMinutes()).padStart(2, "0")}${
		hour < 12 ? "am" : "pm"
	}`;
	if (date.toDateString() === now.toDateString()) return time;
	const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${day} ${time}`;
}

/**
 * Draw the legacy padded card used when `compactMessages` is off.
 *
 * `header` is the one-line summary, `body` the full text shown when the
 * message is expanded.
 */
export function renderCard(options: {
	header: string;
	body?: string;
	expanded: boolean;
	outputPad: number;
	theme: Theme;
}): Box {
	const { header, body, expanded, outputPad, theme } = options;
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", header), 0, 0));
	if (expanded && body) {
		box.addChild(new Text(theme.fg("customMessageText", `\n${body}`), 0, 0));
	} else if (!expanded) {
		box.addChild(new Text(theme.fg("dim", `  ${expandHint()}`), 0, 0));
	}
	return box;
}

/**
 * The hint for the expand shortcut. The keybinding is configurable and the
 * theme has to be initialised, so fall back to the default when the hint
 * would come out empty.
 */
function expandHint(): string {
	try {
		const hint = keyHint("app.tools.expand", "to expand");
		const plain = hint.replace(/\x1b\[[0-9;]*m/g, "");
		if (!plain.trim() || plain.trim().startsWith("to expand")) {
			return "(Ctrl+O to expand)";
		}
		return hint;
	} catch {
		return "(Ctrl+O to expand)";
	}
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
