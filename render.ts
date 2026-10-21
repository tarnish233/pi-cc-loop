/**
 * Rendering helpers for the pi-cc-loop custom messages.
 *
 * Pi renders a custom message with the raw `customType` as its title
 * (`[pi-cc-loop-tick]`), which reads like a machine name. A custom renderer
 * replaces that with a readable, collapsible card, the way Pi's own skill
 * invocations are drawn.
 *
 * The renderer only affects the display. The message content the model sees is
 * unchanged.
 */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

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

/** The first non-empty line of a text block. */
export function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
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
 * Draw a card with a coloured header on Pi's custom-message background.
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
	width?: number;
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
