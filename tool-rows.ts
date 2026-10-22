/**
 * Compact one-line tool rows and small formatting helpers shared by the pi-cc
 * extensions.
 *
 * This file is identical in pi-cc-loop and pi-cc-monitor; tests/shared.test.mjs
 * fails when the two copies drift apart.
 */

import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

/** Collapse whitespace and cut the text to `max` characters. */
export function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
}

/** "20s", "5m", "1m 30s", "1h", "1h 5m", "2d 3h". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "unknown";
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** The first text line of a tool result. */
export function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	for (const block of result.content ?? []) {
		if (block?.type === "text" && typeof block.text === "string") {
			return block.text.split("\n")[0] ?? "";
		}
	}
	return "";
}

export interface CompactRow {
	/** The call row, shown while the call runs. It disappears once the result arrives. */
	call: (args: any) => { label: string; detail?: string };
	/** The one-line summary of a successful result. */
	summary: (details: any, args: any) => string;
	/** Extra lines shown when the row is expanded. */
	detail?: (details: any, args: any) => string | undefined;
}

/**
 * Renderers that draw a tool call as a single result line, for example
 * `✓ Scheduled hu2389lz · Every minute · next 04:55 PM`. Errors show the first
 * line of the error text.
 */
/** The first sentence of an error message, so a failed row stays on one line. */
export function firstSentence(text: string, max = 160): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	const end = trimmed.indexOf(". ");
	if (end > 0 && end < max) return trimmed.slice(0, end + 1);
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}\u2026` : trimmed;
}

export function compactRenderers(row: CompactRow): ToolRenderers {
	return {
		renderCall(args: any, theme: Theme, context: any) {
			if (!context?.isPartial && context?.executionStarted) return new Container();
			const { label, detail } = row.call(args ?? {});
			const title = theme.fg("toolTitle", theme.bold(label));
			return new Text(detail ? `${title} ${theme.fg("muted", detail)}` : title, 0, 0);
		},
		renderResult(result: any, options: any, theme: Theme, context: any) {
			if (options?.isPartial) return new Text(theme.fg("warning", "Working\u2026"), 0, 0);
			if (context?.isError) {
				// A refusal explains itself in one sentence; keep the row to one line.
				return new Text(
					`${theme.fg("error", "\u2717 ")}${theme.fg("error", firstSentence(resultText(result))) || "Failed"}`,
					0,
					0,
				);
			}
			const details = result?.details ?? {};
			const args = context?.args ?? {};
			const summary = row.summary(details, args) || resultText(result);
			const line = `${theme.fg("success", "\u2713 ")}${theme.fg("toolOutput", summary)}`;
			const detail = options?.expanded ? row.detail?.(details, args) : undefined;
			return new Text(detail ? `${line}\n${theme.fg("dim", detail)}` : line, 0, 0);
		},
	};
}
