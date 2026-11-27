/**
 * /tasks (or /cc-tasks on conflict): one native background task overlay.
 *
 * The task-owning packages carry this file verbatim (tests/shared.test.mjs
 * fails when the copies drift apart). They are separate npm packages but may run in the same
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

import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	colorToRgb,
	foregroundAnsi,
	mixColors,
	rgbColor,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Color,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { readLogTail, sanitizeDisplay } from "./log-tail.ts";
export { readLogTail, sanitizeDisplay, type LogTail } from "./log-tail.ts";

/** Preferred entry when no loaded command or prompt already owns the name. */
export const TASKS_COMMAND = "tasks";
/** Used instead of /tasks on conflicts or when command ownership cannot be queried. */
export const TASKS_FALLBACK_COMMAND = "cc-tasks";

const PROBE_CHANNEL = "pi-cc:tasks:probe";
const CHANGED_CHANNEL = "pi-cc:tasks:changed";

/** A refresh coalesces bursts of provider changes. One second keeps elapsed times honest. */
const REFRESH_MS = 250;
const TICK_MS = 1000;
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

/** Preferred provider order; any additional provider follows registration order. */
const PROVIDER_ORDER = ["monitor", "loop"] as const;
interface TaskTab {
	id: string;
	label: string;
}

/** One row in a provider's list. `id` is unique within that provider, not across providers. */
export interface TaskItem {
	id: string;
	/** The one-line name a reader sees (a description, a prompt preview). */
	title: string;
	/** A short state word: running, pending, scheduled, foreign, ... */
	state: string;
	/** False when the task has ended or cannot be stopped from here. */
	active: boolean;
	/** Creation time in epoch milliseconds, used only for newest-first display. */
	createdAt?: number;
	/** Optional short right-hand detail, e.g. "3 events · 1m" or "next 2m". */
	meta?: string;
	/** User-facing role, separate from provider and lifecycle state. */
	role?: string;
	/** Scope of the locally confirmed stop, supplied by the resource owner. */
	stopConfirmation?: string;
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

export interface TaskDetailSection {
	title: string;
	rows: TaskDetailRow[];
}

export interface TaskDetail {
	/** Flat fallback for older panels, or the body when no sections are supplied. */
	rows: TaskDetailRow[];
	/** Preferred semantic body when present; never rendered alongside fallback rows. */
	sections?: TaskDetailSection[];
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
	/** "bash", "monitor", "loop", ...: the namespace half of a task's identity. */
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
			description: "Open the shared task overlay (read-only; x stops a selected task)",
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

function orderedProviders(registry: TaskRegistry): Array<[string, TaskProvider]> {
	if (registry.disposed) return [];
	const ordered: Array<[string, TaskProvider]> = [];
	const seen = new Set<string>();
	for (const id of PROVIDER_ORDER) {
		const provider = providerFor(registry, id);
		if (!provider) continue;
		seen.add(id);
		ordered.push([id, provider]);
	}
	for (const [id, provider] of registry.providers) {
		if (!seen.has(id)) ordered.push([id, provider]);
	}
	return ordered;
}

function taskTabs(registry: TaskRegistry): TaskTab[] {
	const providers = orderedProviders(registry);
	if (!providers.length) return [{ id: "all", label: "All" }];
	// All and a sole provider would show the same rows. Keep the provider's
	// name on one tab instead of presenting two identical views.
	if (providers.length === 1) return [{ id: "all", label: providers[0]![1].label || providers[0]![0] }];
	return [
		{ id: "all", label: "All" },
		...providers.map(([id, provider]) => ({ id, label: provider.label || id })),
	];
}

/** A plain-text listing for print, JSON, and RPC modes: no TUI methods are called. */
export function taskSummary(registry: TaskRegistry): string {
	const lines = ["Tasks"];
	let total = 0;
	for (const [, provider] of orderedProviders(registry)) {
		const items = safeItems(provider);
		total += items.length;
		lines.push(`${provider.label} (${items.length})`);
		for (const item of groupTaskEntries(items.map((item) => ({ ...item, provider: provider.id, providerLabel: provider.label })))) {
			const role = item.role ? `${oneLine(item.role)}  ` : "";
			lines.push(`  ${oneLine(item.state)}  ${role}${oneLine(item.id)}  ${oneLine(item.title)}${item.meta ? `  ${oneLine(item.meta)}` : ""}`);
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

function oneLine(value: unknown): string {
	return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

function logSignature(filePath: string): string {
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return "not-a-file";
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch {
		return "unreadable";
	}
}

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
	/** Cheap change key used to avoid reopening an unchanged log every second. */
	signature: string;
	note?: string;
	lines: string[];
}

type PanelAction =
	| { kind: "tab"; id: string }
	| { kind: "task"; key: string }
	| { kind: "detail" | "stop"; key: string }
	| { kind: "back" | "close" | "confirmStop" | "cancelStop" };

interface HitRegion {
	x: number;
	y: number;
	width: number;
	action: PanelAction;
}

interface BodyScrollbar {
	x: number;
	y: number;
	height: number;
	total: number;
	viewport: number;
	scroll: number;
	thumbOffset: number;
	thumbSize: number;
}

function taskKey(entry: Pick<TaskEntry, "provider" | "id">): string {
	return `${entry.provider}:${entry.id}`;
}

/** Equal/unknown times retain provider order; timestamped tasks precede undated ones. */
function compareTaskCreation(a: TaskItem, b: TaskItem): number {
	const aTime = Number.isFinite(a.createdAt) ? a.createdAt! : -Infinity;
	const bTime = Number.isFinite(b.createdAt) ? b.createdAt! : -Infinity;
	return aTime === bTime ? 0 : aTime > bTime ? -1 : 1;
}

/** Deduplicated newest-first ordering across providers. */
export function groupTaskEntries(entries: TaskEntry[]): TaskEntry[] {
	const byKey = new Map<string, TaskEntry>();
	for (const entry of entries) if (!byKey.has(taskKey(entry))) byKey.set(taskKey(entry), { ...entry });
	return [...byKey.values()].sort(compareTaskCreation);
}

function stateColor(state: string): ThemeColor {
	if (/stop_timeout|timed_out|flood/i.test(state)) return "warning";
	if (/fail|error/i.test(state)) return "error";
	if (/pending|waiting|keepalive|awaiting|foreign|stopping/i.test(state)) return "warning";
	if (/completed|succeeded/i.test(state)) return "success";
	if (/^(?:stopped|exited|closed|ended)\b/i.test(state)) return "accent";
	if (/running|scheduled|active|armed|due/i.test(state)) return "accent";
	return "dim";
}

class TasksOverlay {
	private tab = "all";
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
	/** Whether the last render actually painted a title control; otherwise the hint must offer Back/Close. */
	private framedTitle = false;
	private logs: DetailLogView[] = [];
	private knownKeys: Set<string> | undefined;
	private recentTask: string | undefined;
	private confirming: TaskEntry | undefined;
	private confirmationScroll = 0;
	private confirmationLineCount = 0;
	private confirmationViewport = 0;
	private hitRegions: HitRegion[] = [];
	private bodyScrollbar: BodyScrollbar | undefined;
	private scrollbarDragOffset: number | undefined;
	private suppressMouseGesture = false;
	private mouseWidth = 0;
	private mouseColumns = 0;
	private mouseRows = 0;
	private stoppingKey: string | undefined;
	private status = "";
	private disposed = false;
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
		this.renderPalette = undefined;
		this.mouseWidth = 0;
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
		const entries: TaskEntry[] = [];
		for (const [id, provider] of orderedProviders(this.options.registry)) {
			for (const item of safeItems(provider)) {
				entries.push({ ...item, provider: id, providerLabel: provider.label || id });
			}
		}
		return groupTaskEntries(entries);
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
		if (!taskTabs(this.options.registry).some((tab) => tab.id === this.tab)) {
			this.tab = "all";
			this.listScroll = 0;
		}
		this.entries = this.collect();
		const keys = new Set(this.entries.map(taskKey));
		if (this.knownKeys) {
			const added = this.entries.filter((entry) => !this.knownKeys!.has(taskKey(entry))).sort(compareTaskCreation);
			if (added.length) this.recentTask = added[0]!.title;
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

	/** Wheel input scrolls the viewport, keeping the selected task visible. */
	private scrollList(delta: number): void {
		const list = this.visible();
		if (!list.length) return;
		const height = this.pageSize();
		const index = this.syncListScroll(list, height);
		const next = Math.max(0, Math.min(Math.max(0, list.length - height), this.listScroll + delta));
		if (next === this.listScroll) return;
		this.listScroll = next;
		// Preserve selection unless the wheel moves it outside the visible page.
		const selected = Math.max(next, Math.min(next + height - 1, index));
		this.selectedKey = taskKey(list[selected]!);
		this.selectedIndexHint = selected;
		this.requestRender();
	}

	private syncListScroll(list: TaskEntry[], height: number): number {
		const index = Math.max(0, list.findIndex((entry) => taskKey(entry) === this.selectedKey));
		if (index < this.listScroll) this.listScroll = index;
		if (index >= this.listScroll + height) this.listScroll = index - height + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, list.length - height)));
		return index;
	}

	private selectTab(id: string): void {
		if (!taskTabs(this.options.registry).some((tab) => tab.id === id)) return;
		this.tab = id;
		this.detailKey = undefined;
		this.detailScroll = 0;
		this.confirming = undefined;
		this.confirmationScroll = 0;
		this.status = "";
		this.ensureSelection();
		this.listScroll = 0;
		this.requestRender();
	}

	private switchTab(delta: number): void {
		const tabs = taskTabs(this.options.registry);
		const index = tabs.findIndex((tab) => tab.id === this.tab);
		const current = index < 0 ? 0 : index;
		this.selectTab(tabs[(current + delta + tabs.length) % tabs.length]!.id);
	}

	private openDetail(entry = this.selected()): void {
		if (!entry) return;
		const key = taskKey(entry);
		if (this.detailKey === key) return;
		this.detailKey = key;
		this.detailScroll = 0;
		this.status = "";
		this.reloadLogs();
		this.requestRender();
	}

	private closeDetail(): void {
		if (!this.detailKey) return;
		this.detailKey = undefined;
		this.detailScroll = 0;
		this.status = "";
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
		const previous = new Map(this.logs.map((log) => [log.path, log]));
		// The one-second clock only stats live logs. Reopen and parse a bounded
		// tail when its identity, size or timestamps actually changed.
		this.logs = refs.map((log) => {
			const signature = logSignature(log.path);
			const cached = previous.get(log.path);
			if (cached?.signature === signature && cached.label === log.label) return cached;
			const tail = readLogTail(log.path);
			return {
				label: log.label,
				path: log.path,
				signature,
				note: tail.note,
				lines: tail.text ? tail.text.split("\n") : [],
			};
		});
	}

	private requestRender(): void {
		if (this.disposed) return;
		try {
			this.options.tui.requestRender();
		} catch {
			// the TUI may be shutting down
		}
	}

	// ------------------------------------------------------------ input

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return undefined;
		if (event.type === "wheel") {
			// Contain every wheel event, including bounds, so the transcript
			// behind the overlay never moves with the panel.
			const delta = Number.isFinite(event.wheelDelta) ? Math.trunc(event.wheelDelta!) : 0;
			if (delta) {
				this.recentTask = undefined;
				this.scrollBody(delta);
			}
			return { handled: true, render: false };
		}
		if (event.button !== "left" && event.type !== "release") return undefined;
		if (this.suppressMouseGesture) return { handled: true, focus: true, render: false };
		this.ensureMouseLayout(event);

		if (event.type === "press" && this.bodyScrollbar &&
			event.x === this.bodyScrollbar.x && event.y >= this.bodyScrollbar.y &&
			event.y < this.bodyScrollbar.y + this.bodyScrollbar.height) {
			// Re-render once at the gesture boundary to fold in any pending
			// refresh before mapping a track coordinate to a scroll position.
			const previous = this.bodyScrollbar;
			this.render(event.width, true);
			const bar = this.bodyScrollbar;
			if (!bar || bar.x !== previous.x || bar.y !== previous.y || bar.height !== previous.height ||
				event.x !== bar.x || event.y < bar.y || event.y >= bar.y + bar.height) {
				// The old bar may now overlap a new task row. Suppress the whole
				// gesture (including a double-click) until the host repaints it.
				this.suppressMouseGesture = true;
				this.scrollbarDragOffset = undefined;
				this.requestRender();
				return { handled: true, focus: true, render: false };
			}
			const localY = event.y - bar.y;
			this.scrollbarDragOffset = localY >= bar.thumbOffset && localY < bar.thumbOffset + bar.thumbSize
				? localY - bar.thumbOffset : Math.floor(bar.thumbSize / 2);
			this.scrollBodyFromPointer(event.y);
			// Repaint even when the scroll is unchanged: the render above already
			// rebuilt hitRegions for the folded-in frame, so the painted frame must catch up.
			return { capture: true, focus: true, render: true };
		}
		if (event.type === "drag" && this.scrollbarDragOffset !== undefined && this.bodyScrollbar) {
			this.scrollBodyFromPointer(event.y);
			return { capture: true, render: false };
		}
		if (event.type === "release" && event.button === "left" && this.scrollbarDragOffset !== undefined) {
			this.scrollbarDragOffset = undefined;
			return { handled: true, render: false };
		}
		if (event.type === "press" && this.mouseRegion(event.x, event.y)) {
			// Pi emits click only for a press target it owns. The action itself
			// still runs on click, after a stationary press/release sequence.
			return { handled: true, focus: true, render: false };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const region = this.mouseRegion(event.x, event.y);
		if (!region) return undefined;
		this.recentTask = undefined;
		this.performMouseAction(region.action, event.clickCount ?? 1);
		return { handled: true, focus: true, render: false };
	}

	private mouseRegion(x: number, y: number): HitRegion | undefined {
		for (let i = this.hitRegions.length - 1; i >= 0; i--) {
			const region = this.hitRegions[i]!;
			if (y === region.y && x >= region.x && x < region.x + region.width) return region;
		}
		return undefined;
	}

	private ensureMouseLayout(event: TuiMouseEvent): void {
		const width = Math.max(1, Math.floor(event.width));
		if (this.mouseWidth === width && this.mouseColumns === this.columns() && this.mouseRows === this.rows()) return;
		this.render(width, true);
	}

	private performMouseAction(action: PanelAction, clickCount: number): void {
		if (this.confirming && action.kind !== "confirmStop" && action.kind !== "cancelStop") return;
		switch (action.kind) {
			case "tab": this.selectTab(action.id); break;
			case "task": {
				if (this.detailKey) return;
				const list = this.visible();
				const index = list.findIndex((entry) => taskKey(entry) === action.key);
				if (index < 0) return;
				this.selectedKey = action.key;
				this.selectedIndexHint = index;
				if (clickCount >= 2) this.openDetail(list[index]);
				else this.requestRender();
				break;
			}
			case "back": this.closeDetail(); break;
			case "close": if (!this.detailKey) this.options.onClose(); break;
			case "detail": {
				if (this.detailKey) break;
				const index = this.visible().findIndex((entry) => taskKey(entry) === action.key);
				const entry = index >= 0 ? this.visible()[index] : undefined;
				if (!entry) break;
				this.selectedKey = action.key;
				this.selectedIndexHint = index;
				this.openDetail(entry);
				break;
			}
			case "stop": {
				const entry = this.entryFor(action.key);
				const inView = entry && (this.detailKey ? this.detailKey === action.key
					: this.visible().some((candidate) => taskKey(candidate) === action.key));
				if (inView) this.askStop(entry);
				break;
			}
			case "cancelStop": this.cancelStop(); break;
			case "confirmStop": {
				const target = this.confirming;
				if (!target) return;
				this.confirming = undefined;
				this.confirmationScroll = 0;
				void this.stop(target);
				break;
			}
		}
	}

	private scrollBody(delta: number): void {
		if (this.confirming) this.scrollConfirmation(delta);
		else if (this.detailKey) this.scrollDetail(delta);
		else this.scrollList(delta);
	}

	private scrollBodyTo(scroll: number): void {
		if (this.confirming) this.scrollConfirmation(scroll - this.confirmationScroll);
		else if (this.detailKey) this.scrollDetail(scroll - this.detailScroll);
		else this.scrollList(scroll - this.listScroll);
		if (this.bodyScrollbar) {
			this.bodyScrollbar.scroll = this.confirming ? this.confirmationScroll : this.detailKey ? this.detailScroll : this.listScroll;
		}
	}

	private scrollBodyFromPointer(pointerY: number): void {
		const bar = this.bodyScrollbar;
		if (!bar || this.scrollbarDragOffset === undefined) return;
		const range = Math.max(0, bar.height - bar.thumbSize);
		// A thumb with no travel maps every pointer row to the top; ignore it instead.
		if (range === 0) return;
		const thumb = Math.max(0, Math.min(range, pointerY - bar.y - this.scrollbarDragOffset));
		const maxScroll = Math.max(0, bar.total - bar.viewport);
		this.scrollBodyTo(Math.round(thumb / range * maxScroll));
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		this.recentTask = undefined;

		if (this.confirming) {
			if (data === "y" || data === "Y") {
				const target = this.confirming;
				this.confirming = undefined;
				this.confirmationScroll = 0;
				void this.stop(target);
				return;
			}
			if (data === "n" || data === "N" || this.isCancel(data)) {
				this.cancelStop();
				return;
			}
			const page = this.pageSize();
			if (this.isUp(data)) this.scrollConfirmation(-1);
			else if (this.isDown(data)) this.scrollConfirmation(1);
			else if (this.isPageUp(data)) this.scrollConfirmation(-page);
			else if (this.isPageDown(data)) this.scrollConfirmation(page);
			return;
		}

		if (this.detailKey) {
			if (this.isCancel(data)) {
				this.closeDetail();
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
			this.openDetail();
			return;
		}
		if (data === "x" || data === "X") {
			this.askStop();
		}
	}

	private askStop(target?: TaskEntry): void {
		if (this.stoppingKey || this.confirming) return;
		const entry = target ?? (this.detailKey ? this.entryFor(this.detailKey) : this.selected());
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
		this.confirmationScroll = 0;
		this.status = "";
		this.requestRender();
	}

	private cancelStop(): void {
		if (!this.confirming) return;
		this.confirming = undefined;
		this.confirmationScroll = 0;
		this.status = "";
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

	private scrollConfirmation(delta: number): void {
		if (!this.confirming) return;
		this.syncConfirmationMetrics();
		const max = Math.max(0, this.confirmationLineCount - this.confirmationViewport);
		this.confirmationScroll = Math.max(0, Math.min(max, this.confirmationScroll + delta));
		this.requestRender();
	}

	private syncConfirmationMetrics(): void {
		if (!this.confirming) return;
		const lines = this.confirmationLines(this.metricsWidth());
		this.confirmationLineCount = lines.length;
		this.confirmationViewport = Math.max(1, this.pageSize());
		this.confirmationScroll = Math.max(0, Math.min(Math.max(0, lines.length - this.confirmationViewport), this.confirmationScroll));
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
	private layoutFor(width: number = this.lastColumns === this.columns() && this.lastRenderWidth > 0
		? this.lastRenderWidth : this.estimatedOverlayWidth()): {
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
		const wanted = this.confirming ? this.confirmationLines(bodyWidth).length
			: this.detailKey ? this.detailLines(bodyWidth).length : Math.max(2, this.visible().length);
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

	/** Slice the active body and retain geometry for native mouse dispatch. */
	private bodyLines(width: number, height: number, row: number, x: number): string[] {
		if (this.confirming) {
			const full = this.confirmationLines(width);
			this.confirmationLineCount = full.length;
			this.confirmationViewport = height;
			const maxScroll = Math.max(0, full.length - height);
			this.confirmationScroll = Math.max(0, Math.min(maxScroll, this.confirmationScroll));
			return full.slice(this.confirmationScroll, this.confirmationScroll + height);
		}
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
		this.confirmationLineCount = 0;
		this.confirmationViewport = 0;
		return this.listLines(width, height, row, x);
	}

	private listLines(width: number, height: number, row: number, x: number): string[] {
		const list = this.visible();
		if (!list.length) {
			if (this.tab === "all") {
				return [
					this.options.theme.fg("text", "No tasks."),
					this.panelTheme().fg("muted", "Start a task with any loaded provider."),
				];
			}
			const provider = providerFor(this.options.registry, this.tab);
			const message = provider
				? `No ${provider.label} tasks in this session.`
				: "This task provider is no longer loaded.";
			return [this.options.theme.fg("text", message)];
		}
		this.syncListScroll(list, height);
		const lines: string[] = [];
		const theme = this.panelTheme();
		for (let i = this.listScroll; i < Math.min(list.length, this.listScroll + height); i++) {
			const entry = list[i]!;
			const key = taskKey(entry);
			const selected = entry === this.selected();
			const marker = selected ? theme.fg("accent", "\u25b8 ") : "  ";
			const glyph = entry.provider === "monitor" ? "M"
				: entry.provider === "loop" ? "L"
					: (entry.providerLabel.charAt(0).toUpperCase() || "?");
			const tag = this.tab === "all" ? `${theme.fg("dim", glyph)} ` : "";
			const state = theme.fg(stateColor(entry.state), entry.role ? oneLine(entry.state).padEnd(12) : oneLine(entry.state));
			const title = selected ? theme.fg("text", theme.bold(oneLine(entry.title))) : entry.role && !entry.active ? theme.fg("dim", oneLine(entry.title)) : oneLine(entry.title);
			const information = [entry.role, entry.meta].filter(Boolean).map(oneLine).join(" · ");
			const meta = information ? theme.fg("dim", ` · ${information}`) : "";
			const line = fitWidth(`${marker}${tag}${state} ${title}${meta}`, width);
			const y = row + lines.length;
			this.hitRegions.push({ x, y, width, action: { kind: "task", key } });
			lines.push(selected ? this.styled(line, { bg: this.palette().selected }) : line);
		}
		return lines;
	}

	private bodyTotal(width: number): number {
		if (this.confirming) return this.confirmationLines(width).length;
		if (this.detailKey) return this.detailLines(width).length;
		return this.visible().length;
	}

	/** Render the viewport first, then append a native hit-testable scrollbar. */
	private renderBody(width: number, height: number, row: number, x: number): string[] {
		const reservedWidth = Math.max(1, width - 1);
		const scrolling = width >= 2 && this.bodyTotal(reservedWidth) > height;
		const contentWidth = scrolling ? reservedWidth : width;
		this.lastBodyWidth = contentWidth;
		const body = this.bodyLines(contentWidth, height, row, x);
		while (body.length < height) body.push("");
		const total = this.confirming ? this.confirmationLineCount : this.detailKey ? this.detailLineCount : this.visible().length;
		const scroll = this.confirming ? this.confirmationScroll : this.detailKey ? this.detailScroll : this.listScroll;
		if (!scrolling || total <= height) {
			this.bodyScrollbar = undefined;
			return body.map((line) => fitWidth(line, width));
		}
		const thumbSize = Math.max(1, Math.min(height, Math.round(height * height / total)));
		const thumbRange = Math.max(0, height - thumbSize);
		const maxScroll = Math.max(1, total - height);
		const thumbOffset = Math.max(0, Math.min(thumbRange, Math.round(scroll / maxScroll * thumbRange)));
		this.bodyScrollbar = { x: x + contentWidth, y: row, height, total, viewport: height, scroll, thumbOffset, thumbSize };
		const theme = this.panelTheme();
		return body.map((line, index) => {
			const thumb = index >= thumbOffset && index < thumbOffset + thumbSize;
			const glyph = thumb ? theme.fg("accent", "█") : theme.fg("muted", "░");
			return `${fitWidth(line, contentWidth)}${glyph}`;
		});
	}

	private confirmationLines(width: number): string[] {
		const entry = this.confirming;
		if (!entry) return [];
		const theme = this.panelTheme();
		const title = `Stop ${oneLine(entry.role ?? entry.providerLabel)} #${oneLine(entry.id)}?`;
		const scope = entry.stopConfirmation ?? "Stops the selected task using its owning provider.";
		return [
			fitWidth(theme.fg("warning", theme.bold(title)), width),
			...wrapTextWithAnsi(oneLine(scope), Math.max(1, width)).map((part) => fitWidth(theme.fg("text", part), width)),
			fitWidth(theme.fg("dim", oneLine(entry.title)), width),
		];
	}

	private detailLines(width: number): string[] {
		const entry = this.detailKey ? this.entryFor(this.detailKey) : undefined;
		if (!entry) return [];
		const theme = this.panelTheme();
		const lines: string[] = [];
		lines.push(fitWidth(theme.fg("accent", theme.bold(`${entry.providerLabel} · ${entry.role ? `${oneLine(entry.role)} #` : ""}${oneLine(entry.id)}`)), width));
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
			const appendRows = (rows: TaskDetailRow[]) => {
				const labels = rows.map((row) => oneLine(row.label));
				const labelWidth = Math.min(12, Math.max(1, ...labels.map((label) => visibleWidth(label))));
				const inline = width >= labelWidth + 16;
				for (let i = 0; i < rows.length; i++) {
					const label = labels[i] ?? "";
					const value = oneLine(rows[i]!.value);
					if (!inline) {
						lines.push(fitWidth(theme.fg("dim", label), width));
						for (const part of wrapTextWithAnsi(value, Math.max(8, width - 2))) lines.push(fitWidth(`  ${part}`, width));
						continue;
					}
					// fitWidth, not padEnd: the prefix must occupy exactly labelWidth
					// columns (cap long labels, pad wide ones) or wrapping loses value text.
					const prefix = theme.fg("dim", `${fitWidth(label, labelWidth)} `);
					const available = Math.max(8, width - labelWidth - 1);
					const wrapped = wrapTextWithAnsi(value, available);
					lines.push(fitWidth(`${prefix}${wrapped[0] ?? ""}`, width));
					for (const part of wrapped.slice(1)) lines.push(fitWidth(`${" ".repeat(labelWidth + 1)}${part}`, width));
				}
			};
			if (!detail.sections?.length) appendRows(detail.rows);
			for (const section of detail.sections ?? []) {
				lines.push("", fitWidth(theme.fg("accent", theme.bold(oneLine(section.title))), width));
				appendRows(section.rows);
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
					// Long log lines must remain readable through detail scrolling;
					// truncating here would hide the ending readLogTail kept deliberately.
					for (const part of wrapTextWithAnsi(line, Math.max(1, width - 2))) {
						lines.push(fitWidth(theme.fg("text", `  ${part}`), width));
					}
				}
			}
		}
		return lines;
	}

	private tabsLine(width: number, row: number, x: number): string {
		const theme = this.panelTheme();
		const tabs = taskTabs(this.options.registry);
		const counts = new Map<string, number>([["all", this.entries.length]]);
		for (const entry of this.entries) counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
		let cursor = 0;
		const parts = tabs.map((tab) => {
			const label = ` ${tab.label} ${counts.get(tab.id) ?? 0} `;
			const labelWidth = visibleWidth(label);
			if (cursor + labelWidth <= width) {
				this.hitRegions.push({ x: x + cursor, y: row, width: labelWidth, action: { kind: "tab", id: tab.id } });
			}
			cursor += labelWidth + 1;
			return tab.id === this.tab
				? this.styled(label, { fg: this.palette().text, bg: this.palette().tab, bold: true })
				: theme.fg("muted", label);
		});
		return fitWidth(parts.join(" "), width);
	}

	private titleLine(width: number, row: number, x: number): string {
		const theme = this.panelTheme();
		const title = this.confirming ? "Confirm stop" : this.detailKey ? "Task detail" : "Tasks";
		const action: PanelAction = { kind: this.confirming ? "cancelStop" : this.detailKey ? "back" : "close" };
		const label = this.confirming ? "Esc cancel" : this.detailKey ? "Esc back" : "Esc close";
		const right = this.styled(` ${label} `, { fg: this.palette().text, bg: this.palette().tab, bold: true });
		const rightWidth = visibleWidth(right);
		const left = theme.fg("accent", theme.bold(title));
		const gap = width - visibleWidth(left) - rightWidth;
		if (gap < 1) return fitWidth(left, width);
		this.hitRegions.push({ x: x + width - rightWidth, y: row, width: rightWidth, action });
		this.framedTitle = true;
		return fitWidth(`${left}${" ".repeat(gap)}${right}`, width);
	}

	private actionLine(width: number, row: number, x: number, segments: Array<{ text: string; action?: PanelAction }>): string {
		let cursor = 0;
		for (const segment of segments) {
			const segmentWidth = visibleWidth(segment.text);
			if (segment.action && cursor + segmentWidth <= width) {
				this.hitRegions.push({ x: x + cursor, y: row, width: segmentWidth, action: segment.action });
			}
			cursor += segmentWidth + 1;
		}
		return fitWidth(segments.map((segment) => segment.text).join(" "), width);
	}

	private actionButton(label: string, action?: PanelAction): { text: string; action?: PanelAction } {
		return {
			text: action
				? this.styled(` ${label} `, { fg: this.palette().text, bg: this.palette().tab, bold: true })
				: this.panelTheme().fg("muted", ` ${label} `),
			...(action ? { action } : {}),
		};
	}

	private hintLine(width: number, row: number, x: number): string {
		const theme = this.panelTheme();
		if (this.status) {
			// A mouse-only user still needs an exit while the status replaces the hint.
			return this.actionLine(width, row, x, [
				...(this.framedTitle ? [] : [this.actionButton(this.detailKey ? "Back" : "Close", { kind: this.detailKey ? "back" : "close" })]),
				{ text: theme.fg("warning", this.status) },
			]);
		}
		const fullscreen = this.options.tui.mode === "fullscreen";
		const range = (total: number, viewport: number, scroll: number) => total > viewport
			? `${scroll + 1}-${Math.min(total, scroll + viewport)}/${total}` : "";
		if (this.confirming) {
			return this.actionLine(width, row, x, [
				this.actionButton("Cancel", { kind: "cancelStop" }),
				this.actionButton("Stop", { kind: "confirmStop" }),
				{ text: theme.fg("dim", "y stop · n/Esc cancel") },
				{ text: theme.fg("dim", range(this.confirmationLineCount, this.confirmationViewport, this.confirmationScroll)) },
			]);
		}
		const entry = this.detailKey ? this.entryFor(this.detailKey) : this.selected();
		const canStop = !!entry?.active && !this.stoppingKey && !!providerFor(this.options.registry, entry.provider)?.stop;
		if (this.detailKey) {
			return this.actionLine(width, row, x, [
				...(this.framedTitle ? [] : [this.actionButton("Back", { kind: "back" })]),
				this.actionButton("Stop", entry && canStop ? { kind: "stop", key: taskKey(entry) } : undefined),
				{ text: theme.fg("dim", fullscreen ? "↑↓/wheel scroll" : "↑↓ scroll · pgUp/pgDn page · x stop") },
				{ text: theme.fg("dim", range(this.detailLineCount, this.detailViewport, this.detailScroll)) },
			]);
		}
		return this.actionLine(width, row, x, [
			// The exit control comes first so a narrow frame clips optional task
			// actions, never the only way out for a mouse-only user.
			...(this.framedTitle ? [] : [this.actionButton("Close", { kind: "close" })]),
			this.actionButton("Detail", entry ? { kind: "detail", key: taskKey(entry) } : undefined),
			this.actionButton("Stop", entry && canStop ? { kind: "stop", key: taskKey(entry) } : undefined),
			// The announcement follows the buttons: a long title must never push
			// their hit regions past the frame edge, where actionLine drops them.
			...(this.recentTask ? [{ text: theme.fg("warning", `new ${oneLine(this.recentTask)}`) }] : []),
			{ text: theme.fg("dim", fullscreen ? "↑↓ select · wheel scroll" : "↑↓ select · Enter detail · x stop") },
			{ text: theme.fg("dim", range(this.visible().length, this.pageSize(), this.listScroll)) },
		]);
	}

	private singleLine(width: number): string {
		if (this.confirming) return fitWidth(this.panelTheme().fg("warning", `y stop ${oneLine(this.confirming.role ?? this.confirming.providerLabel)} · n/Esc cancel`), width);
		const entry = this.detailKey ? this.entryFor(this.detailKey) : this.selected();
		// Only the hint path may register hit regions; the plain text line paints none.
		if (!entry || this.status) return this.hintLine(width, 0, 0);
		const controls = this.detailKey ? "Esc back" : "Esc close";
		return fitWidth(`${oneLine(entry.state)} ${oneLine(entry.title)} \u00b7 ${controls}`, width);
	}

	private renderBorderless(width: number, layout: ReturnType<TasksOverlay["layoutFor"]>): string[] {
		if (layout.mode === "twoLine") {
			const body = this.renderBody(width, 1, 0, 0);
			return [fitWidth(body[0] ?? this.hintLine(width, 0, 0), width), this.hintLine(width, 1, 0)];
		}
		const lines: string[] = [this.tabsLine(width, 0, 0)];
		const body = this.renderBody(width, layout.body, 1, 0);
		for (const line of body) lines.push(fitWidth(line, width));
		lines.push(this.hintLine(width, lines.length, 0));
		return lines;
	}

	render(width: number, fromMouse = false): string[] {
		// Rebuild colors and mouse geometry on every render: providers, themes,
		// Unicode widths and terminal dimensions can all change between events.
		if (!fromMouse) this.suppressMouseGesture = false;
		this.renderPalette = panelPalette(this.options.theme);
		this.hitRegions = [];
		this.bodyScrollbar = undefined;
		this.framedTitle = false;
		const safeWidth = Math.max(1, Math.floor(Number(width) || 0));
		this.lastRenderWidth = safeWidth;
		this.lastColumns = this.columns();
		this.mouseWidth = safeWidth;
		this.mouseColumns = this.lastColumns;
		this.mouseRows = this.rows();
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
			const lines = this.renderBorderless(safeWidth, layout);
			return lines.map((line, index) => this.paint(line, safeWidth,
				index === 0 || index === lines.length - 1 ? this.palette().chrome : this.palette().surface));
		}

		const inner = safeWidth - 2;
		const bodyWidth = Math.max(1, inner - 2);
		const theme = this.panelTheme();
		const border = (text: string) => theme.fg("border", text);
		const row = (text: string, background: Color = this.palette().surface) =>
			this.paint(border("│") + fitWidth(text, inner) + border("│"), safeWidth, background);
		const rule = (left: string, right: string) => this.paint(border(left + "─".repeat(inner) + right), safeWidth);
		const lines: string[] = [rule("╭", "╮")];
		if (layout.mode === "framed") lines.push(row(` ${this.titleLine(bodyWidth, 1, 2)} `, this.palette().chrome));
		lines.push(row(` ${this.tabsLine(bodyWidth, lines.length, 2)} `, this.palette().chrome));
		lines.push(rule("├", "┤"));

		const body = this.renderBody(bodyWidth, layout.body, lines.length, 2);
		for (const line of body) lines.push(row(` ${line} `));
		lines.push(rule("├", "┤"));
		lines.push(row(` ${this.hintLine(bodyWidth, lines.length, 2)} `, this.palette().chrome));
		lines.push(rule("╰", "╯"));
		return lines;
	}

}

/** Truncate/pad a line to exactly `width` visible columns. */
function fitWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "\u2026", true);
}