/**
 * /tasks (or /cc-tasks on conflict): one native Monitor/Loop task overlay.
 *
 * Both packages carry this file verbatim (tests/shared.test.mjs fails when the
 * copies drift apart). They are separate npm packages but may run in the same
 * Pi session. Pi gives every extension its own `pi.events` facade over one
 * common event bus, so a WeakMap keyed by `pi.events` cannot join them. The
 * registry is therefore discovered synchronously over that bus:
 *
 *   - the first package selects one entry after startup: /tasks if no loaded
 *     command or prompt owns that name, otherwise /cc-tasks;
 *   - a later package emits a probe, the existing registry answers with itself
 *     and the new provider joins it (only one panel command exists);
 *   - the bus belongs to one Pi runtime (one session), so two SDK sessions or
 *     subagents in one process do not see each other's providers.
 *
 * The overlay is read-only except for an explicit, locally confirmed stop. It
 * never sends a message, starts a turn, changes the tool set, or calls the
 * model. Esc closes the detail, then the overlay; closing never cancels a task
 * and never reaches the application's interrupt handling.
 *
 * Provider numbers (times, counts) are computed in the owning package from its
 * live records: Monitor's records and LoopScheduler's LoopJob objects. The
 * overlay only renders what a provider returns. Log reads are bounded tails,
 * sanitized for display, and never part of an event stream.
 */

import fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	colorToRgb,
	foregroundAnsi,
	mixColors,
	rgbColor,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Color,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

/** Preferred entry when no loaded command or prompt already owns the name. */
export const TASKS_COMMAND = "tasks";
/** Used instead of /tasks on conflicts or when command ownership cannot be queried. */
export const TASKS_FALLBACK_COMMAND = "cc-tasks";

const PROBE_CHANNEL = "pi-cc:tasks:probe";
const CHANGED_CHANNEL = "pi-cc:tasks:changed";

/** A refresh coalesces bursts of provider changes. One second keeps elapsed times honest. */
const REFRESH_MS = 250;
const TICK_MS = 1000;
/** A log tail is small enough to read synchronously and wide enough to be useful. */
const LOG_MAX_BYTES = 8192;
const LOG_MAX_LINES = 60;
const LOG_LINE_MAX = 500;
const PANEL_MAX_WIDTH = 96;
const PANEL_MAX_BODY_ROWS = 12;

/** Keep wide terminals from turning an empty task list into a full-screen sheet. */
function panelWidth(columns: number): number {
	const available = Number.isFinite(columns) ? Math.floor(columns) - 2 : 78;
	return Math.max(1, Math.min(PANEL_MAX_WIDTH, available));
}

interface PanelPalette {
	surface: Color;
	chrome: Color;
	selected: Color;
	tab: Color;
	border: Color;
	text: Color;
	muted: Color;
}

/** Concrete colors also work when the system theme has transparent/default panels. */
function panelPalette(theme: Theme): PanelPalette {
	const dark = theme.appearance !== "light";
	const colors = theme.colors;
	const text = colors?.text ?? rgbColor(dark ? 232 : 32, dark ? 236 : 36, dark ? 242 : 42);
	const accent = colors?.accent ?? rgbColor(74, 153, 230);
	const original = colors?.userMessageBg ?? rgbColor(dark ? 46 : 248, dark ? 50 : 248, dark ? 58 : 250);
	const channels = colorToRgb(original);
	const base = dark
		? rgbColor(Math.max(46, channels.r), Math.max(50, channels.g), Math.max(58, channels.b))
		: original;
	const neutral = dark ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
	const tinted = mixColors(base, accent, 0.035, "srgb");
	const surface = mixColors(tinted, neutral, dark ? 0.06 : 0.03, "srgb");
	const chrome = mixColors(surface, accent, dark ? 0.09 : 0.055, "srgb");
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	// Nearby RGB shades can collapse into the same 256-color cell. Keep
	// selection/pills visibly distinct after terminal color conversion too.
	const distinct = (candidate: Color, against: Color): Color => {
		const reference = backgroundAnsi(against, mode);
		for (const amount of [0, 0.12, 0.24]) {
			const adjusted = amount ? mixColors(candidate, neutral, amount, "srgb") : candidate;
			if (backgroundAnsi(adjusted, mode) !== reference) return adjusted;
		}
		return mixColors(against, neutral, 0.4, "srgb");
	};
	return {
		surface,
		chrome,
		selected: distinct(mixColors(surface, accent, dark ? 0.17 : 0.11, "srgb"), surface),
		tab: distinct(mixColors(surface, accent, dark ? 0.27 : 0.20, "srgb"), chrome),
		border: mixColors(accent, text, 0.22, "srgb"),
		text,
		muted: mixColors(text, surface, 0.30, "srgb"),
	};
}

const TABS = [
	{ id: "all", label: "All" },
	{ id: "monitor", label: "Monitor" },
	{ id: "loop", label: "Loop" },
] as const;
type TaskTab = (typeof TABS)[number]["id"];

/** Provider order in the All tab and in the textual summary. */
const PROVIDER_ORDER = ["monitor", "loop"] as const;

/** One row in a provider's list. `id` is unique within that provider, not across providers. */
export interface TaskItem {
	id: string;
	/** The one-line name a reader sees (a description, a prompt preview). */
	title: string;
	/** A short state word: running, pending, scheduled, foreign, ... */
	state: string;
	/** False when the task has ended or cannot be stopped from here. */
	active: boolean;
	/** Optional short right-hand detail, e.g. "3 events · 1m" or "next 2m". */
	meta?: string;
	/** Stable within a provider; lower comes first. */
	order?: number;
}

/** The overlay's list entry: the provider identity is part of the key. */
export interface TaskEntry extends TaskItem {
	provider: string;
	providerLabel: string;
}

export interface TaskDetailRow {
	label: string;
	value: string;
}

/** A log file the shared reader may tail. The provider names it, the overlay reads it. */
export interface TaskLogRef {
	label: string;
	path: string;
}

export interface TaskDetail {
	rows: TaskDetailRow[];
	logs?: TaskLogRef[];
	/** A short note under the rows (ownership, disabled actions, ...). */
	note?: string;
	/** Optional extra title line; the provider label and task id are always shown. */
	heading?: string;
}

export interface TaskStopResult {
	stopped: boolean;
	message?: string;
}

/**
 * What a package contributes. All methods are called on the interactive path;
 * they must be quick and must not throw (the overlay catches anyway).
 */
export interface TaskProvider {
	/** "monitor" or "loop": the namespace half of a task's identity. */
	id: string;
	label: string;
	list(): TaskItem[];
	detail?(item: TaskItem): TaskDetail;
	/** Stop one task. The owning package reuses its own lifecycle logic. */
	stop?(id: string): TaskStopResult | Promise<TaskStopResult>;
}

export interface TaskProviderRegistration {
	/** Ask an open overlay to refresh; coalesced and ignored when no overlay is open. */
	changed(): void;
	/** Remove this provider and, for the registry owner, close the overlay. */
	close(): void;
}

interface TaskRegistry {
	providers: Map<string, TaskProvider>;
	/** Close callbacks for overlays created by this registry. */
	overlays: Set<() => void>;
	disposed: boolean;
	probeListener?: () => void;
}

interface ProbeRequest {
	reply(registry: TaskRegistry): void;
}

/**
 * Find the registry that already exists in this Pi runtime, if any. The bus is
 * synchronous, so the answer arrives before `emit` returns; every extension
 * has its own facade, but they all share the one underlying bus.
 */
function findRegistry(pi: ExtensionAPI): TaskRegistry | undefined {
	let found: TaskRegistry | undefined;
	try {
		pi.events.emit(PROBE_CHANNEL, {
			reply: (registry: TaskRegistry) => {
				if (!found && registry && !registry.disposed) found = registry;
			},
		} satisfies ProbeRequest);
	} catch {
		// A missing bus only means this package stands alone.
	}
	return found;
}

function disposeRegistry(registry: TaskRegistry): void {
	if (registry.disposed) return;
	registry.disposed = true;
	const closes = [...registry.overlays];
	registry.overlays.clear();
	for (const close of closes) {
		try {
			close();
		} catch {
			// an overlay that is already gone must not break shutdown
		}
	}
	registry.providers.clear();
	try {
		registry.probeListener?.();
	} catch {
		// the runtime may already have unsubscribed it
	}
	registry.probeListener = undefined;
}

/**
 * Join (or create) this runtime's task registry. Only the first package owns
 * command registration. After startup command loading, it selects /tasks when
 * that name is free, otherwise /cc-tasks. Never register both or an extra alias.
 */
export function registerTaskProvider(pi: ExtensionAPI, provider: TaskProvider): TaskProviderRegistration {
	let registry = findRegistry(pi);
	let owner = false;

	if (!registry) {
		owner = true;
		const created: TaskRegistry = {
			providers: new Map(),
			overlays: new Set(),
			disposed: false,
			probeListener: undefined,
		};
		registry = created;
		created.probeListener = pi.events.on(PROBE_CHANNEL, (data) => {
			if (created.disposed) return;
			try {
				(data as ProbeRequest | undefined)?.reply?.(created);
			} catch {
				// a broken prober must not affect the registry
			}
		});
		const command = {
			description: "Open the shared Monitor and Loop task overlay (read-only; x stops a selected task)",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				await openTasks(pi, created, ctx);
			},
		};
		let commandRegistered = false;
		const registerPanelCommand = () => {
			if (created.disposed || commandRegistered) return;
			let name = TASKS_FALLBACK_COMMAND;
			try {
				if (typeof pi.getCommands === "function" &&
					!pi.getCommands().some(({ name }) => name === TASKS_COMMAND || /^tasks:\d+$/.test(name))) {
					name = TASKS_COMMAND;
				}
			} catch {
				// An unbound host cannot safely claim /tasks; use the fallback alone.
			}
			pi.registerCommand(name, command);
			commandRegistered = true;
		};
		if (typeof pi.getCommands !== "function") {
			// Legacy hosts may also lack resources_discover, so keep one safe entry.
			registerPanelCommand();
		} else {
			// getCommands() is not bound while factories load. This boundary runs
			// after all session_start handlers and before TUI autocomplete is built.
			pi.on("resources_discover", registerPanelCommand);
		}
	}

	registry.providers.set(provider.id, provider);
	let closed = false;
	return {
		changed() {
			if (closed || registry.disposed || registry.overlays.size === 0) return;
			try {
				pi.events.emit(CHANGED_CHANNEL, { provider: provider.id });
			} catch {
				// the session is going away; there is nobody left to repaint
			}
		},
		close() {
			if (closed) return;
			closed = true;
			if (registry.disposed) return;
			registry.providers.delete(provider.id);
			if (owner) disposeRegistry(registry);
		},
	};
}

// --------------------------------------------------------------- text mode

function safeItems(provider: TaskProvider): TaskItem[] {
	try {
		const items = provider.list();
		return Array.isArray(items) ? items.filter((item) => item && typeof item.id === "string") : [];
	} catch {
		return [];
	}
}

function providerFor(registry: TaskRegistry, id: string): TaskProvider | undefined {
	const provider = registry.providers.get(id);
	return provider && !registry.disposed ? provider : undefined;
}

/** A plain-text listing for print, JSON, and RPC modes: no TUI methods are called. */
export function taskSummary(registry: TaskRegistry): string {
	const lines = ["Tasks · Monitor & Loop"];
	let total = 0;
	for (const id of PROVIDER_ORDER) {
		const provider = providerFor(registry, id);
		if (!provider) {
			lines.push(`${id === "monitor" ? "Monitor" : "Loop"}: not loaded`);
			continue;
		}
		const items = safeItems(provider);
		total += items.length;
		lines.push(`${provider.label} (${items.length})`);
		for (const item of items) {
			lines.push(`  ${oneLine(item.state)}  ${oneLine(item.id)}  ${oneLine(item.title)}${item.meta ? `  ${oneLine(item.meta)}` : ""}`);
		}
	}
	if (total === 0) lines.push("No tasks.");
	return lines.join("\n");
}

async function openTasks(pi: ExtensionAPI, registry: TaskRegistry, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(taskSummary(registry), "info");
			} catch {
				// a stale context must never break the command
			}
		}
		return;
	}

	// Both command names share one overlay; a second invocation replaces it.
	for (const close of [...registry.overlays]) {
		try {
			close();
		} catch {
			// already closed
		}
	}

	let doneRef: ((result: void) => void) | undefined;
	let overlayTerminal: TUI["terminal"] | undefined;
	const close = () => {
		const done = doneRef;
		doneRef = undefined;
		try {
			done?.(undefined);
		} catch {
			// the interaction already ended
		}
	};
	registry.overlays.add(close);
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				doneRef = done;
				overlayTerminal = tui.terminal;
				return new TasksOverlay({
					tui,
					theme,
					keybindings,
					registry,
					pi,
					onClose: close,
				});
			},
			{
				overlay: true,
				overlayOptions: () => ({
					// custom() resolves the factory once; the retained getter keeps
					// the native renderer responsive even when a narrow window grows.
					get width() { return panelWidth(overlayTerminal?.columns ?? 80); },
					maxHeight: "90%",
					margin: 1,
				}),
			},
		);
	} finally {
		registry.overlays.delete(close);
		doneRef = undefined;
		overlayTerminal = undefined;
	}
}

// ------------------------------------------------------------- log display

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Strip ANSI, C0/C1 controls, and bidi overrides from anything shown. */
export function sanitizeDisplay(value: unknown): string {
	let text = String(value ?? "");
	try {
		text = stripTerminalSequences(text);
	} catch {
		// fall through to the control-character pass
	}
	return text
		.replace(/\x1b/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function oneLine(value: unknown): string {
	return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

export interface LogTail {
	text: string;
	truncated: boolean;
	/** Why there is nothing to show, when the file is missing or unreadable. */
	note?: string;
}

/**
 * Read a bounded tail of a log. Missing files and permission errors are notes,
 * not failures: the task viewer must work even after a log is cleaned up.
 */
export function readLogTail(filePath: string, maxBytes = LOG_MAX_BYTES, maxLines = LOG_MAX_LINES): LogTail {
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
	const size = stat.size;
	const start = Math.max(0, size - Math.max(0, maxBytes));
	let buffer: Buffer;
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			buffer = Buffer.alloc(size - start);
			if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, start);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { text: "", truncated: false, note: "log unreadable" };
	}

	let text = buffer.toString("utf8");
	if (start > 0) {
		// Drop the partial first line of a byte-bounded tail.
		const newline = text.indexOf("\n");
		if (newline >= 0) text = text.slice(newline + 1);
	}
	let lines = text.split(/\r\n|\r|\n/);
	const overLines = lines.length > maxLines;
	if (overLines) lines = lines.slice(-maxLines);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const sanitized = lines.map((line) =>
		truncateToWidth(sanitizeDisplay(line).replace(/\t/g, "    "), LOG_LINE_MAX, "\u2026"),
	);
	return {
		text: sanitized.join("\n"),
		truncated: start > 0 || overLines,
		note:
			start > 0 || overLines
				? `last ${Math.min(maxLines, lines.length)} lines \u00b7 ${formatBytes(Math.max(0, size - start))} tail`
				: undefined,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

// ---------------------------------------------------------------- overlay

interface OverlayOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	registry: TaskRegistry;
	pi: ExtensionAPI;
	onClose: () => void;
}

interface DetailLogView {
	label: string;
	path: string;
	note?: string;
	lines: string[];
}

function taskKey(entry: Pick<TaskEntry, "provider" | "id">): string {
	return `${entry.provider}:${entry.id}`;
}

function shortDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function clock(ms: number): string {
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "?";
	const hour = date.getHours();
	const twelve = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelve}:${String(date.getMinutes()).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
}

function dateTime(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "\u2014";
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "?";
	const today = new Date();
	if (date.toDateString() === today.toDateString()) return clock(ms);
	return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock(ms)}`;
}

function eta(ms: number): string {
	if (!Number.isFinite(ms)) return "?";
	if (ms <= 0) return "now";
	return shortDuration(ms);
}

function stateColor(state: string): ThemeColor {
	if (/fail|error/i.test(state)) return "error";
	if (/pending|waiting|keepalive|awaiting|foreign/i.test(state)) return "warning";
	if (/running|scheduled|active|armed|due/i.test(state)) return "success";
	return "dim";
}

class TasksOverlay {
	private tab: TaskTab = "all";
	private entries: TaskEntry[] = [];
	private selectedKey: string | undefined;
	private selectedIndexHint = 0;
	private listScroll = 0;
	private detailKey: string | undefined;
	private detailScroll = 0;
	private detailLineCount = 0;
	private detailViewport = 0;
	private lastRenderWidth = 0;
	private lastBodyWidth = 0;
	private lastColumns = 0;
	private logs: DetailLogView[] = [];
	private knownKeys: Set<string> | undefined;
	private recentTask: string | undefined;
	private confirming: TaskEntry | undefined;
	private stoppingKey: string | undefined;
	private status = "";
	private disposed = false;
	private renderQueued = false;
	private renderPalette: PanelPalette | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(private readonly options: OverlayOptions) {
		this.refreshNow(false);
		try {
			this.unsubscribe = options.pi.events.on(CHANGED_CHANNEL, () => this.markDirty());
		} catch {
			this.unsubscribe = undefined;
		}
		this.tickTimer = setInterval(() => this.markDirty(), TICK_MS);
		this.tickTimer.unref?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = undefined;
		}
		try {
			this.unsubscribe?.();
		} catch {
			// the runtime may already have unsubscribed it
		}
		this.unsubscribe = undefined;
	}

	invalidate(): void {
		this.renderQueued = false;
		this.renderPalette = undefined;
	}

	private palette(): PanelPalette {
		return this.renderPalette ??= panelPalette(this.options.theme);
	}

	private styled(text: string, style: { fg?: Color; bg?: Color; bold?: boolean }): string {
		const theme = this.options.theme;
		// Older/minimal hosts without rich theme styling retain a readable plain view.
		return typeof theme.style === "function" ? theme.style(text, style) : text;
	}

	private panelTheme(): Pick<Theme, "fg" | "bold"> {
		const theme = this.options.theme;
		return {
			fg: (role, text) => {
				if (role === "dim" || role === "muted") return this.styled(text, { fg: this.palette().muted });
				if (role === "border") return this.styled(text, { fg: this.palette().border });
				return theme.fg(role, text);
			},
			bold: (text) => theme.bold(text),
		};
	}

	/** Paint padding too, and restore the card after nested tab/selection resets. */
	private paint(text: string, width: number, background: Color = this.palette().surface): string {
		const fitted = fitWidth(text, width);
		const theme = this.options.theme;
		if (typeof theme.style !== "function") return fitted;
		const mode = theme.getColorMode();
		const bg = backgroundAnsi(background, mode);
		const fg = foregroundAnsi(this.palette().text, mode);
		const restored = fitted
			.replace(/\x1b\[(?:0)?m/g, (reset) => reset + fg + bg)
			.replace(/\x1b\[49m/g, () => bg)
			.replace(/\x1b\[39m/g, () => fg);
		return theme.style(restored, { fg: this.palette().text, bg: background });
	}

	// ------------------------------------------------------------- data

	private markDirty(): void {
		if (this.disposed) return;
		if (this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			if (this.disposed) return;
			this.refreshNow(true);
		}, REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private collect(): TaskEntry[] {
		const registry = this.options.registry;
		const entries: TaskEntry[] = [];
		const seen = new Set<string>();
		const add = (id: string, provider: TaskProvider) => {
			if (seen.has(id)) return;
			seen.add(id);
			for (const item of safeItems(provider)) {
				entries.push({ ...item, provider: id, providerLabel: provider.label || id });
			}
		};
		for (const id of PROVIDER_ORDER) {
			const provider = providerFor(registry, id);
			if (provider) add(id, provider);
		}
		for (const [id, provider] of registry.providers) {
			if (!registry.disposed) add(id, provider);
		}
		return entries;
	}

	private visible(): TaskEntry[] {
		return this.tab === "all" ? this.entries : this.entries.filter((entry) => entry.provider === this.tab);
	}

	private entryFor(key: string): TaskEntry | undefined {
		return this.entries.find((entry) => taskKey(entry) === key);
	}

	private selected(): TaskEntry | undefined {
		const list = this.visible();
		if (!list.length) return undefined;
		const found = list.find((entry) => taskKey(entry) === this.selectedKey);
		return found ?? list[Math.min(this.selectedIndexHint, list.length - 1)];
	}

	private refreshNow(render: boolean): void {
		if (this.disposed) return;
		this.entries = this.collect();
		const keys = new Set(this.entries.map(taskKey));
		if (this.knownKeys) {
			const added = this.entries.filter((entry) => !this.knownKeys!.has(taskKey(entry)));
			if (added.length) this.recentTask = added[added.length - 1]!.title;
		}
		this.knownKeys = keys;
		this.ensureSelection();
		if (this.detailKey && !this.entryFor(this.detailKey)) this.detailKey = undefined;
		if (this.detailKey) this.reloadLogs();
		else {
			this.logs = [];
		}
		if (render) this.requestRender();
	}

	private ensureSelection(): void {
		const list = this.visible();
		if (!list.length) {
			this.selectedKey = undefined;
			this.selectedIndexHint = 0;
			return;
		}
		const index = list.findIndex((entry) => taskKey(entry) === this.selectedKey);
		if (index >= 0) {
			this.selectedIndexHint = index;
			return;
		}
		const next = Math.min(Math.max(0, this.selectedIndexHint), list.length - 1);
		this.selectedKey = taskKey(list[next]!);
		this.selectedIndexHint = next;
	}

	private move(delta: number, page = false): void {
		const list = this.visible();
		if (!list.length) return;
		const current = Math.max(
			0,
			list.findIndex((entry) => taskKey(entry) === this.selectedKey),
		);
		const step = page ? (delta < 0 ? -this.pageSize() : this.pageSize()) : delta;
		const next = Math.max(0, Math.min(list.length - 1, current + step));
		this.selectedKey = taskKey(list[next]!);
		this.selectedIndexHint = next;
		this.requestRender();
	}

	private switchTab(delta: number): void {
		const index = TABS.findIndex((tab) => tab.id === this.tab);
		this.tab = TABS[(index + delta + TABS.length) % TABS.length]!.id;
		this.ensureSelection();
		this.listScroll = 0;
		this.requestRender();
	}

	private reloadLogs(): void {
		if (!this.detailKey) return;
		const entry = this.entryFor(this.detailKey);
		if (!entry) return;
		const provider = providerFor(this.options.registry, entry.provider);
		if (!provider?.detail) {
			this.logs = [];
			return;
		}
		let detail: TaskDetail;
		try {
			detail = provider.detail(entry);
		} catch {
			return;
		}
		const refs = detail.logs ?? [];
		// Re-read the bounded tails on every refresh: a live monitor's log grows
		// while the detail is open. The refresh is already throttled and each read
		// is capped by bytes and lines.
		this.logs = refs.map((log) => {
			const tail = readLogTail(log.path);
			return {
				label: log.label,
				path: log.path,
				note: tail.note,
				lines: tail.text ? tail.text.split("\n") : [],
			};
		});
	}

	private requestRender(): void {
		if (this.disposed) return;
		this.renderQueued = true;
		try {
			this.options.tui.requestRender();
		} catch {
			// the TUI may be shutting down
		}
	}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (this.disposed) return;
		this.recentTask = undefined;

		if (this.confirming) {
			if (data === "y" || data === "Y") {
				const target = this.confirming;
				this.confirming = undefined;
				void this.stop(target);
				return;
			}
			if (data === "n" || data === "N" || this.isCancel(data)) {
				this.confirming = undefined;
				this.status = "";
				this.requestRender();
				return;
			}
			return;
		}

		if (this.detailKey) {
			if (this.isCancel(data)) {
				this.detailKey = undefined;
				this.detailScroll = 0;
				this.status = "";
				this.requestRender();
				return;
			}
			if (data === "x" || data === "X") {
				this.askStop();
				return;
			}
			const page = this.pageSize();
			if (this.isUp(data)) this.scrollDetail(-1);
			else if (this.isDown(data)) this.scrollDetail(1);
			else if (this.isPageUp(data)) this.scrollDetail(-page);
			else if (this.isPageDown(data)) this.scrollDetail(page);
			return;
		}

		if (this.isNextTab(data)) {
			this.switchTab(1);
			return;
		}
		if (this.isPreviousTab(data)) {
			this.switchTab(-1);
			return;
		}
		if (this.isCancel(data)) {
			this.options.onClose();
			return;
		}
		if (this.isUp(data)) {
			this.move(-1);
			return;
		}
		if (this.isDown(data)) {
			this.move(1);
			return;
		}
		if (this.isPageUp(data)) {
			this.move(-1, true);
			return;
		}
		if (this.isPageDown(data)) {
			this.move(1, true);
			return;
		}
		if (this.isConfirm(data)) {
			const entry = this.selected();
			if (entry) {
				this.detailKey = taskKey(entry);
				this.detailScroll = 0;
				this.reloadLogs();
				this.requestRender();
			}
			return;
		}
		if (data === "x" || data === "X") {
			this.askStop();
		}
	}

	private askStop(): void {
		if (this.stoppingKey) return;
		const entry = this.detailKey ? this.entryFor(this.detailKey) : this.selected();
		if (!entry) return;
		if (!entry.active) {
			this.status = "This task has ended; there is nothing to stop.";
			this.requestRender();
			return;
		}
		const provider = providerFor(this.options.registry, entry.provider);
		if (!provider?.stop) {
			this.status = "This task cannot be stopped from here.";
			this.requestRender();
			return;
		}
		this.confirming = entry;
		this.status = `Stop ${entry.providerLabel} ${entry.id}? (y/N)`;
		this.requestRender();
	}

	private async stop(entry: TaskEntry): Promise<void> {
		if (this.disposed || this.stoppingKey) return;
		const provider = providerFor(this.options.registry, entry.provider);
		if (!provider?.stop) return;
		const key = taskKey(entry);
		this.stoppingKey = key;
		this.status = `Stopping ${entry.providerLabel} ${entry.id}\u2026`;
		this.requestRender();
		try {
			const result = await provider.stop(entry.id);
			if (this.disposed) return;
			this.stoppingKey = undefined;
			this.status = oneLine(
				result?.message ??
					(result?.stopped ? `Stopped ${entry.providerLabel} ${entry.id}.` : `${entry.providerLabel} ${entry.id} was already gone.`),
			);
		} catch (error) {
			if (this.disposed) return;
			this.stoppingKey = undefined;
			this.status = `Stop failed: ${oneLine(error instanceof Error ? error.message : String(error))}`;
		}
		this.refreshNow(true);
	}

	private scrollDetail(delta: number): void {
		// Recompute the line count from the live width and height: a resize
		// between renders must not leave PageUp/PageDown on stale bounds.
		this.syncDetailMetrics();
		const viewport = Math.max(1, this.pageSize());
		this.detailViewport = viewport;
		const max = Math.max(0, this.detailLineCount - viewport);
		this.detailScroll = Math.max(0, Math.min(max, this.detailScroll + delta));
		this.requestRender();
	}

	private syncDetailMetrics(): void {
		if (!this.detailKey) return;
		const lines = this.detailLines(this.metricsWidth());
		this.detailLineCount = lines.length;
		this.detailViewport = Math.max(1, this.pageSize());
		this.detailScroll = Math.max(0, Math.min(Math.max(0, lines.length - this.detailViewport), this.detailScroll));
	}

	private isCancel(data: string): boolean {
		return matchesKey(data, "escape") || this.options.keybindings.matches(data, "tui.select.cancel");
	}
	private isConfirm(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.confirm");
	}
	private isUp(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.up");
	}
	private isDown(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.down");
	}
	private isPageUp(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.pageUp");
	}
	private isPageDown(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.pageDown");
	}
	private isNextTab(data: string): boolean {
		return data === "\t" || matchesKey(data, "tab");
	}
	private isPreviousTab(data: string): boolean {
		return data === "\x1b[Z" || matchesKey(data, "shift+tab");
	}

	// ---------------------------------------------------------- rendering

	private rows(): number {
		const rows = this.options.tui.terminal?.rows;
		return Number.isFinite(rows) && (rows ?? 0) > 0 ? rows! : 24;
	}

	private columns(): number {
		const columns = this.options.tui.terminal?.columns;
		return Number.isFinite(columns) && (columns ?? 0) > 0 ? columns! : 80;
	}

	/** The native overlay's height budget: 90% of rows, also inside margin 1 top and bottom. */
	private overlayRows(): number {
		const rows = this.rows();
		const cap = Math.max(1, Math.floor(rows * 0.9));
		const insideMargins = Math.max(1, rows - 2);
		return Math.max(1, Math.min(cap, insideMargins));
	}

	private estimatedOverlayWidth(): number {
		return panelWidth(this.columns());
	}

	/**
	 * The body height the current terminal can show. Framed modes keep the
	 * title/tabs/rules/hint; very short terminals switch to a borderless layout
	 * with just tabs, body and hint, and finally to a single line.
	 */
	private layoutFor(width: number = this.lastRenderWidth || this.estimatedOverlayWidth()): {
		mode: "framed" | "compact" | "borderless" | "twoLine" | "single";
		body: number;
		max: number;
	} {
		const max = this.overlayRows();
		const mode = width >= 6 && max >= 9 ? "framed"
			: width >= 6 && max >= 7 ? "compact"
				: max >= 3 ? "borderless" : max === 2 ? "twoLine" : "single";
		const chrome = mode === "framed" ? 7 : mode === "compact" ? 6 : mode === "borderless" ? 2 : 1;
		const bodyWidth = mode === "framed" || mode === "compact" ? Math.max(1, width - 4) : width;
		const wanted = this.detailKey ? this.detailLines(bodyWidth).length : Math.max(2, this.visible().length);
		const body = Math.max(1, Math.min(PANEL_MAX_BODY_ROWS, wanted, max - chrome));
		return { mode, body, max };
	}

	private pageSize(): number {
		return Math.max(1, this.layoutFor().body);
	}

	private metricsWidth(): number {
		if (this.lastColumns === this.columns() && this.lastBodyWidth > 0) return this.lastBodyWidth;
		const overlay = this.estimatedOverlayWidth();
		const layout = this.layoutFor(overlay);
		return layout.mode === "framed" || layout.mode === "compact"
			? Math.max(1, overlay - 4)
			: Math.max(1, overlay);
	}

	/** Slice the detail or list body to the current height and record scroll metrics. */
	private bodyLines(width: number, height: number): string[] {
		if (this.detailKey) {
			const full = this.detailLines(width);
			this.detailLineCount = full.length;
			this.detailViewport = height;
			const maxScroll = Math.max(0, full.length - height);
			this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll));
			return full.slice(this.detailScroll, this.detailScroll + height);
		}
		this.detailLineCount = 0;
		this.detailViewport = 0;
		return this.listLines(width, height);
	}

	private listLines(width: number, height: number): string[] {
		const list = this.visible();
		if (!list.length) {
			const message =
				this.tab === "all"
					? "No tasks. Arm a Monitor or start a /loop."
					: this.tab === "monitor"
						? providerFor(this.options.registry, "monitor")
							? "No monitors in this session."
							: "pi-cc-monitor is not loaded."
						: providerFor(this.options.registry, "loop")
							? "No loops in this session."
							: "pi-cc-loop is not loaded.";
			return this.tab === "all"
				? [this.options.theme.fg("text", "No tasks."), this.panelTheme().fg("muted", "Start a Monitor or /loop to add one.")]
				: [this.options.theme.fg("text", message)];
		}
		const index = Math.max(
			0,
			list.findIndex((entry) => taskKey(entry) === this.selectedKey),
		);
		if (index < this.listScroll) this.listScroll = index;
		if (index >= this.listScroll + height) this.listScroll = index - height + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, list.length - height)));
		const lines: string[] = [];
		const theme = this.panelTheme();
		for (let i = this.listScroll; i < Math.min(list.length, this.listScroll + height); i++) {
			const entry = list[i]!;
			const selected = entry === this.selected();
			const marker = selected ? theme.fg("accent", "\u25b8 ") : "  ";
			const tag = this.tab === "all" ? `${theme.fg("dim", entry.provider === "monitor" ? "M" : "L")} ` : "";
			const state = theme.fg(stateColor(entry.state), oneLine(entry.state));
			const title = selected ? theme.fg("text", theme.bold(oneLine(entry.title))) : oneLine(entry.title);
			const meta = entry.meta ? theme.fg("dim", ` \u00b7 ${oneLine(entry.meta)}`) : "";
			const line = fitWidth(`${marker}${tag}${state} ${title}${meta}`, width);
			lines.push(selected ? this.styled(line, { bg: this.palette().selected }) : line);
		}
		return lines;
	}

	private detailLines(width: number): string[] {
		const entry = this.detailKey ? this.entryFor(this.detailKey) : undefined;
		if (!entry) return [];
		const theme = this.panelTheme();
		const lines: string[] = [];
		lines.push(fitWidth(theme.fg("accent", theme.bold(`${entry.providerLabel} \u00b7 ${oneLine(entry.id)}`)), width));
		lines.push(fitWidth(theme.fg("text", oneLine(entry.title)), width));

		let detail: TaskDetail | undefined;
		const provider = providerFor(this.options.registry, entry.provider);
		if (provider?.detail) {
			try {
				detail = provider.detail(entry);
			} catch (error) {
				lines.push(fitWidth(theme.fg("error", `Detail unavailable: ${oneLine(error instanceof Error ? error.message : String(error))}`), width));
			}
		}
		if (detail?.heading) lines.push(fitWidth(theme.fg("muted", oneLine(detail.heading)), width));
		if (detail) {
			const labels = detail.rows.map((row) => oneLine(row.label));
			const labelWidth = Math.min(12, Math.max(1, ...labels.map((label) => visibleWidth(label))));
			const inline = width >= labelWidth + 16;
			for (let i = 0; i < detail.rows.length; i++) {
				const label = labels[i] ?? "";
				const value = oneLine(detail.rows[i]!.value);
				if (!inline) {
					lines.push(fitWidth(theme.fg("dim", label), width));
					for (const part of wrapTextWithAnsi(value, Math.max(8, width - 2))) {
						lines.push(fitWidth(`  ${part}`, width));
					}
					continue;
				}
				const prefix = theme.fg("dim", `${label.padEnd(labelWidth)} `);
				const available = Math.max(8, width - labelWidth - 1);
				const wrapped = wrapTextWithAnsi(value, available);
				lines.push(fitWidth(`${prefix}${wrapped[0] ?? ""}`, width));
				for (const part of wrapped.slice(1)) {
					lines.push(fitWidth(`${" ".repeat(labelWidth + 1)}${part}`, width));
				}
			}
			if (detail.note) lines.push(fitWidth(theme.fg("dim", oneLine(detail.note)), width));
		} else if (!provider) {
			lines.push(fitWidth(theme.fg("dim", "The owning package is no longer loaded."), width));
		}

		if (this.logs.length) {
			lines.push("");
			for (const log of this.logs) {
				lines.push(
					fitWidth(
						theme.fg("accent", theme.bold(`${oneLine(log.label)}`)) +
							theme.fg("dim", log.note ? ` \u00b7 ${oneLine(log.note)}` : " \u00b7 recent output"),
						width,
					),
				);
				if (!log.lines.length) {
					lines.push(fitWidth(theme.fg("dim", "  (empty)"), width));
				}
				for (const line of log.lines) {
					lines.push(fitWidth(theme.fg("text", `  ${line}`), width));
				}
			}
		}
		return lines;
	}

	private tabsLine(width: number): string {
		const theme = this.panelTheme();
		const counts: Record<TaskTab, number> = {
			all: this.entries.length,
			monitor: this.entries.filter((entry) => entry.provider === "monitor").length,
			loop: this.entries.filter((entry) => entry.provider === "loop").length,
		};
		const parts = TABS.map((tab) => {
			const label = ` ${tab.label} ${counts[tab.id]} `;
			return tab.id === this.tab
				? this.styled(label, { fg: this.palette().text, bg: this.palette().tab, bold: true })
				: theme.fg("muted", label);
		});
		return fitWidth(parts.join(" "), width);
	}

	private titleLine(width: number): string {
		const theme = this.panelTheme();
		const title = this.detailKey ? "Task detail" : "Tasks";
		const right = this.detailKey ? "Esc back" : "Esc close";
		const left = theme.fg("accent", theme.bold(title));
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap < 1) return fitWidth(left, width);
		return fitWidth(`${left}${" ".repeat(gap)}${theme.fg("dim", right)}`, width);
	}

	private hintLine(width: number): string {
		const theme = this.panelTheme();
		if (this.status) return fitWidth(theme.fg("warning", this.status), width);
		if (this.confirming) return fitWidth(theme.fg("warning", "y stop \u00b7 n/Esc cancel"), width);
		if (this.detailKey) {
			const total = this.detailLineCount;
			const visible = this.detailViewport;
			const scroll = total > visible ? ` ${this.detailScroll + 1}-${Math.min(total, this.detailScroll + visible)}/${total}` : "";
			return fitWidth(theme.fg("dim", `\u2191\u2193 scroll \u00b7 pgUp/pgDn page \u00b7 x stop \u00b7 Esc back${scroll}`), width);
		}
		const newTask = this.recentTask ? theme.fg("warning", `new ${oneLine(this.recentTask)} \u00b7 `) : "";
		return fitWidth(
			newTask + theme.fg("dim", "Tab switch \u00b7 \u2191\u2193 select \u00b7 Enter detail \u00b7 x stop \u00b7 Esc close"),
			width,
		);
	}

	private singleLine(width: number): string {
		const entry = this.detailKey ? this.entryFor(this.detailKey) : this.selected();
		const hint = this.hintLine(width);
		if (!entry || this.status) return hint;
		const controls = this.detailKey ? "Esc back" : "Esc close";
		return fitWidth(`${oneLine(entry.state)} ${oneLine(entry.title)} \u00b7 ${controls}`, width);
	}

	private renderBorderless(width: number, layout: ReturnType<TasksOverlay["layoutFor"]>): string[] {
		if (layout.mode === "twoLine") {
			const body = this.bodyLines(width, 1);
			return [fitWidth(body[0] ?? this.hintLine(width), width), this.hintLine(width)];
		}
		const lines: string[] = [this.tabsLine(width)];
		const body = this.bodyLines(width, layout.body);
		while (body.length < layout.body) body.push("");
		for (const line of body) lines.push(fitWidth(line, width));
		lines.push(this.hintLine(width));
		return lines;
	}

	render(width: number): string[] {
		// Rebuild colors on every render: the injected theme can change in place.
		this.renderPalette = panelPalette(this.options.theme);
		const safeWidth = Math.max(1, Math.floor(Number(width) || 0));
		this.lastRenderWidth = safeWidth;
		this.lastColumns = this.columns();
		const layout = this.layoutFor(safeWidth);
		if (layout.mode === "single") {
			this.lastBodyWidth = safeWidth;
			if (this.detailKey) {
				this.detailLineCount = this.detailLines(safeWidth).length;
				this.detailViewport = 1;
			} else {
				this.detailLineCount = 0;
				this.detailViewport = 0;
			}
			return [this.paint(this.singleLine(safeWidth), safeWidth)];
		}
		if (layout.mode === "borderless" || layout.mode === "twoLine") {
			this.lastBodyWidth = safeWidth;
			const lines = this.renderBorderless(safeWidth, layout);
			return lines.map((line, index) => this.paint(line, safeWidth,
				index === 0 || index === lines.length - 1 ? this.palette().chrome : this.palette().surface));
		}

		const inner = safeWidth - 2;
		const bodyWidth = Math.max(1, inner - 2);
		this.lastBodyWidth = bodyWidth;
		const theme = this.panelTheme();
		const border = (text: string) => theme.fg("border", text);
		const row = (text: string, background: Color = this.palette().surface) =>
			this.paint(border("│") + fitWidth(text, inner) + border("│"), safeWidth, background);
		const rule = (left: string, right: string) => this.paint(border(left + "─".repeat(inner) + right), safeWidth);
		const lines: string[] = [rule("╭", "╮")];
		if (layout.mode === "framed") lines.push(row(` ${this.titleLine(bodyWidth)} `, this.palette().chrome));
		lines.push(row(` ${this.tabsLine(bodyWidth)} `, this.palette().chrome));
		lines.push(rule("├", "┤"));

		const body = this.bodyLines(bodyWidth, layout.body);
		while (body.length < layout.body) body.push("");
		for (const line of body) lines.push(row(` ${line} `));
		lines.push(rule("├", "┤"));
		lines.push(row(` ${this.hintLine(bodyWidth)} `, this.palette().chrome));
		lines.push(rule("╰", "╯"));
		return lines;
	}

}

/** Truncate/pad a line to exactly `width` visible columns. */
function fitWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "\u2026", true);
}