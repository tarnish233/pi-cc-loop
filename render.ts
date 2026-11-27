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

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiInputListener,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

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

/** A clock time the way Claude Code writes it: "6:16pm". */
export function formatClock(epochMs: number | undefined): string {
	if (epochMs === undefined) return "unknown";
	const date = new Date(epochMs);
	if (Number.isNaN(date.getTime())) return "unknown";
	const hour = date.getHours();
	return `${hour % 12 === 0 ? 12 : hour % 12}:${String(date.getMinutes()).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
}

/**
 * Format a timestamp the way Claude Code does: just the time for today,
 * "Oct 21 4:13pm" for an older message.
 */
export function formatStamp(epochMs: number | undefined): string {
	const date = new Date(epochMs ?? Date.now());
	if (Number.isNaN(date.getTime())) return "";
	const time = formatClock(date.getTime());
	if (date.toDateString() === new Date().toDateString()) return time;
	const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${day} ${time}`;
}

/** The task panel's nullable timestamp, shared by Loop, Monitor and the overlay. */
export function formatDateTime(epochMs: number | undefined): string {
	if (epochMs === undefined || !Number.isFinite(epochMs)) return "\u2014";
	return formatStamp(epochMs) || "?";
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
	keyHint?: KeyHintFn;
}): Box {
	const { header, body, expanded, outputPad, theme } = options;
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", header), 0, 0));
	if (expanded && body) {
		box.addChild(new Text(theme.fg("customMessageText", `\n${body}`), 0, 0));
	} else if (!expanded) {
		box.addChild(new Text(theme.fg("dim", `  ${expandHint(options.keyHint)}`), 0, 0));
	}
	return box;
}

/**
 * The hint for the expand shortcut. Falls back to the default when the host
 * provides no keybinding helper or when the hint comes out empty.
 */
function expandHint(keyHint?: KeyHintFn): string {
	try {
		const hint = keyHint?.("app.tools.expand", "to expand");
		const plain = hint?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
		if (plain.trim() && !plain.trim().startsWith("to expand")) return hint!;
	} catch {
		// Fall back to default expand shortcut.
	}
	return "(Ctrl+O to expand)";
}

// ------------------------------------------------------- notification card

/**
 * The card pi-cc draws for an asynchronous fact: one collapsed line, and an
 * expanded `├`/`│`/`└` tree inside the tool-card background Pi already has
 * theme slots for. Pi's own screen mode decides the affordance: fullscreen
 * delivers mouse events, the regular screen only has the expand keybinding.
 */

/** Native `move` only reaches the hit component, never the one the pointer left. */
let hoveredCard: NotificationCardView | undefined;

type HoverHost = { listeners: Set<TuiInputListener>; observer: TuiInputListener; unsubscribe: () => void };
let hoverHost: HoverHost | undefined;
let hoverEnabled = false;
/** The stable native TUI reference also supplies mode and viewport height for history cards. */
let screenTui: any;

function clearHintHover(): void {
	const previous = hoveredCard;
	hoveredCard = undefined;
	if (previous?.setHintHovered(false)) screenTui?.requestRender?.();
}

function removeHoverObserver(): void {
	hoverHost?.unsubscribe();
	hoverHost = undefined;
	clearHintHover();
}

/** Observe before native dispatch consumes input; never replace ccstyle's viewport method. */
function ensureHover(): void {
	if (!hoverEnabled) return;
	const tui = screenTui;
	const listeners = tui?.inputListeners;
	if (tui?.mode !== "fullscreen") {
		removeHoverObserver();
		return;
	}
	// The Set is stable through Pi's proxy; reading methods creates fresh functions.
	if (hoverHost && hoverHost.listeners === listeners && listeners.has(hoverHost.observer)) return;
	removeHoverObserver();
	if (!(listeners instanceof Set) || typeof tui.addInputListener !== "function" || typeof tui.removeInputListener !== "function") return;
	const previous = [...listeners];
	const observer: TuiInputListener = () => {
		// Keys, wheel and focus changes may move content; native moves restore the actual hit.
		clearHintHover();
		return undefined;
	};
	const unsubscribe = tui.addInputListener(observer);
	// shortcut: Pi's internal listener order supplies priority; replace when a pre-dispatch API exists.
	for (const listener of previous) {
		tui.removeInputListener(listener);
		tui.addInputListener(listener);
	}
	hoverHost = { listeners, observer, unsubscribe };
}

/** Stop input observation and clear the painted state; historical cards keep their viewport cap. */
export function releaseNotificationHover(): void {
	hoverEnabled = false;
	removeHoverObserver();
}

/** Pi hands its TUI to an extension through the setWidget factory (ExtensionUIContext). */
export function setNotificationTui(tui: unknown): void {
	screenTui = tui;
	hoverEnabled = true;
	ensureHover();
}

export type NotificationTone = "success" | "error" | "warning" | "accent";

export interface NotificationSection {
	heading: string;
	/** Plain, unwrapped body lines; the card wraps them to the column it has. */
	lines: string[];
	color?: ThemeColor;
}

export interface NotificationCard {
	title: string;
	id?: string;
	stamp?: string;
	/** Short facts after the stamp, for example an exit code and a duration. */
	stats?: string[];
	/** What the card is about, written right after the id: a description or a reason. */
	subtitle?: string;
	tone: NotificationTone;
	/** A finished thing, not an in-progress batch: ■ instead of ✻ for a neutral tone. */
	terminal?: boolean;
	sections: NotificationSection[];
}

const CARD_ICON: Record<NotificationTone, string> = {
	success: "\u2713",
	error: "\u2717",
	warning: "\u26a0",
	accent: "\u273b",
};

/**
 * The neutral outcome marker. `pi-cc`'s dark theme maps every accent-ish UI slot
 * (`accent`, `borderAccent`, `mdLink`, `customMessageLabel`) to the same blue, so
 * the only distinct non-status hue left is this one. A theme that leaves it
 * undefined falls back to `accent`.
 */
const QUIET_OUTCOME_COLOR: ThemeColor = "syntaxFunction";

/**
 * `accent` is the in-progress or verdict-less card, so it must not sit on the
 * success background: a stopped monitor on a green card reads as a win.
 */
const CARD_BG: Record<NotificationTone, "toolSuccessBg" | "toolErrorBg" | "toolPendingBg"> = {
	success: "toolSuccessBg",
	error: "toolErrorBg",
	warning: "toolPendingBg",
	accent: "toolPendingBg",
};

/**
 * Click expansion is remembered per message: CustomMessageComponent.rebuild()
 * re-runs the renderer on every invalidate and theme change, so an instance
 * field would snap back. The host's own Ctrl+O changes `base`; a local value
 * recorded against the previous `base` is then stale and discarded.
 */
const cardExpansion = new WeakMap<object, { base: boolean; expanded: boolean }>();

/** The host's `options.keyHint`, minus its keybinding-id union. */
export type KeyHintFn = (keybinding: any, description: string) => string;

function collapsedHint(keyHint: KeyHintFn | undefined): string {
	if (screenTui?.mode === "fullscreen") return "click to show more";
	try {
		const hint = keyHint?.("app.tools.expand", "to show more");
		if (hint) return hint;
	} catch {
		// A host without bound keybindings still has the default expand key.
	}
	return "ctrl+o to show more";
}

const RAIL = "\u2502 ";
const LAST_INDENT = "  ";

/**
 * How many rows an expanded card may draw. A component far taller than the
 * viewport makes Pi's alternate screen fall back to a full redraw on every
 * frame, and the card's own background then bleeds across the whole screen
 * (pi-cc-extensions documents the same wall for its diff panels). Sixty percent
 * of the viewport keeps the card honest and leaves the rest readable, and an
 * absolute ceiling keeps a tall terminal from turning the card into a wall: the
 * full output is in the log path and in `/tasks`.
 */
const MAX_EXPANDED_ROWS = 24;

function expandedRowBudget(): number {
	if (screenTui?.mode !== "fullscreen") return Number.POSITIVE_INFINITY;
	const rows = Number(screenTui?.terminal?.rows);
	if (!Number.isFinite(rows) || rows <= 0) return 20;
	return Math.max(6, Math.min(Math.floor(rows * 0.6), MAX_EXPANDED_ROWS));
}

/** Section tree: `├`/`└` corners, accent-bold headings, body behind the rail. */
function detailRows(sections: NotificationSection[], width: number, theme: Theme): string[] {
	const room = Math.max(1, width - RAIL.length);
	const rows: string[] = [];
	sections.forEach((section, index) => {
		const last = index === sections.length - 1;
		const bodyPrefix = last ? LAST_INDENT : RAIL;
		if (index) rows.push(theme.fg("dim", "\u2502"));
		const heading = wrapTextWithAnsi(theme.fg("accent", theme.bold(section.heading)), room);
		heading.forEach((line, lineIndex) => {
			const corner = lineIndex ? bodyPrefix : `${last ? "\u2514" : "\u251c"} `;
			rows.push(`${theme.fg("dim", corner)}${line}`);
		});
		for (const source of section.lines) {
			for (const line of wrapTextWithAnsi(source, room)) {
				rows.push(
					line
						? `${theme.fg("dim", bodyPrefix)}${theme.fg(section.color ?? "toolOutput", line)}`
						: theme.fg("dim", last ? "" : "\u2502"),
				);
			}
		}
	});
	return rows;
}

class NotificationCardView implements Component {
	private expanded: boolean;
	private hintHovered = false;
	/** Columns of the collapsed hint, recorded by the last render. */
	private hintStart = 0;
	private hintEnd = 0;

	constructor(
		private readonly message: object,
		private readonly card: NotificationCard,
		private readonly theme: Theme,
		private readonly pad: number,
		private readonly base: boolean,
		private readonly keyHint: KeyHintFn | undefined,
	) {
		const local = cardExpansion.get(message);
		this.expanded = local?.base === base ? local.expanded : base;
		if (local && local.base !== base) cardExpansion.delete(message);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		// The hint is not drawn while expanded: leaving the flag set painted it
		// bright when the card collapsed again with the pointer somewhere else.
		this.setHintHovered(false);
		cardExpansion.set(this.message, { base: this.base, expanded });
	}

	/** Any left click toggles; a move over the hint is what lights it. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			this.setExpanded(!this.expanded);
			return { handled: true, render: true };
		}
		if (event.type !== "move" || !hoverHost) return undefined;
		return this.setHintHovered(
			!this.expanded && event.y === 0 && event.x >= this.hintStart && event.x < this.hintEnd,
		)
			? { handled: true, render: true }
			: undefined;
	}

	/** Only the card the pointer is on stays lit; the input observer clears the rest. */
	setHintHovered(hovered: boolean): boolean {
		if (this.hintHovered === hovered) return false;
		this.hintHovered = hovered;
		if (hovered) hoveredCard = this;
		else if (hoveredCard === this) hoveredCard = undefined;
		return true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		ensureHover();
		// Pi 1.5 declares a mutable array and 1.6 a readonly one; a fresh array satisfies both.
		return this.expanded ? this.expandedRows(width) : this.collapsedRows(width);
	}

	/** A card with no state of its own (a manual stop, a terminated command, a
	 * closed socket) gets a violet square: a hue of its own, not one of the four
	 * status colours and not the blue of a live batch. */
	private isQuietOutcome(): boolean {
		return this.card.terminal === true && this.card.tone === "accent";
	}

	/** The icon colour, and the title colour with it: a failed card reads red. */
	private toneColor(): ThemeColor {
		return this.isQuietOutcome() ? QUIET_OUTCOME_COLOR : this.card.tone;
	}

	private icon(): string {
		return this.theme.fg(this.toneColor(), this.isQuietOutcome() ? "\u25a0" : CARD_ICON[this.card.tone]);
	}

	/** Title, id, then the facts a reader needs without expanding. */
	private collapsedHeader(): string {
		const theme = this.theme;
		const card = this.card;
		const sep = theme.fg("dim", " \u00b7 ");
		const lead = [theme.fg(this.toneColor(), card.title), ...(card.id ? [theme.fg("muted", card.id)] : [])].join(" ");
		const facts = [
			...(card.subtitle ? [theme.fg("dim", card.subtitle)] : []),
			...(card.stamp ? [theme.fg("muted", card.stamp)] : []),
			...(card.stats ?? []).map((stat) => theme.fg("dim", stat)),
		];
		return `${this.icon()} ${facts.length ? `${lead}${sep}${facts.join(sep)}` : lead}`;
	}

	/** The expanded title drops every fact: the sections below carry them. */
	private expandedHeader(): string {
		const theme = this.theme;
		const card = this.card;
		const lead = [theme.fg(this.toneColor(), card.title), ...(card.id ? [theme.fg("muted", card.id)] : [])].join(" ");
		return `${this.icon()} ${lead}`;
	}

	/** One line, always: the sections are one click or one Ctrl+O away. */
	private collapsedRows(width: number): string[] {
		const theme = this.theme;
		const rowWidth = Math.max(1, width);
		// The padding never eats the only column there is.
		const indent = " ".repeat(Math.min(this.pad, rowWidth - 1));
		const hint = ` ${theme.fg("dim", "\u00b7")} ${theme.fg(this.hintHovered ? "text" : "dim", collapsedHint(this.keyHint))}`;
		const head = `${indent}${this.collapsedHeader()}`;
		// The hint keeps its columns; the title gives way with an ellipsis. A hard cut
		// through "show more" reads like a bug, not like a narrow terminal.
		const hintWidth = visibleWidth(hint);
		const headRoom = Math.max(1, rowWidth - hintWidth);
		const line =
			hintWidth < rowWidth
				? `${truncateToWidth(head, headRoom, "\u2026")}${hint}`
				: truncateToWidth(`${head}${hint}`, rowWidth, "");
		// 0-based columns of the hint inside this row, for the move hit test.
		this.hintStart = Math.max(0, visibleWidth(line) - hintWidth);
		this.hintEnd = visibleWidth(line);
		return [line];
	}

	private expandedRows(width: number): string[] {
		const theme = this.theme;
		const columns = Math.max(1, width);
		// The frame never eats the only column there is.
		const pad = Math.min(this.pad, Math.max(0, Math.floor((columns - 1) / 2)));
		const box = new Box(pad, 1, (line) => theme.bg(CARD_BG[this.card.tone], line));
		box.addChild({
			invalidate() {},
			// Headings wrap themselves; the section tree already wrapped its body.
			render: (inner: number) => {
				const room = Math.max(1, inner);
				const rows = [
					...wrapTextWithAnsi(this.expandedHeader(), room),
					...detailRows(this.card.sections, room, theme),
				];
				const budget = expandedRowBudget();
				const fitted =
					rows.length <= budget
						? rows
						: [
								...rows.slice(0, budget - 1),
								`${theme.fg("dim", RAIL)}${theme.fg("dim", `\u2026 +${rows.length - budget + 1} more rows \u00b7 see /tasks`)}`,
							];
				return fitted.map((line) => truncateToWidth(line, room, ""));
			},
		});
		return [...box.render(columns)];
	}
}

/** Build the card component. `compactMessages` off keeps the padded legacy card. */
export function renderNotificationCard(
	message: object,
	options: { expanded: boolean; outputPad: number; keyHint?: KeyHintFn },
	theme: Theme,
	card: NotificationCard,
): Component {
	return new NotificationCardView(
		message,
		card,
		theme,
		Math.max(0, Math.floor(Number(options.outputPad) || 0)),
		options.expanded,
		options.keyHint,
	);
}
