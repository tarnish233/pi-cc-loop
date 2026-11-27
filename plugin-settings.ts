/**
 * Shared atomic file I/O, cross-process file locking, independent config stores,
 * and native single-page `/<plugin>_settings` panels for pi-cc packages.
 *
 * This file is identical in pi-cc-loop and pi-cc-monitor; tests/shared.test.mjs
 * fails when the copies drift apart.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, visibleWidth, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateId(length = 8): string {
	let out = "";
	while (out.length < length) {
		for (const byte of randomBytes(length * 2)) {
			// 252 is the largest multiple of 36 <= 255 (no modulo bias).
			if (byte >= 252) continue;
			out += ID_ALPHABET[byte % ID_ALPHABET.length];
			if (out.length === length) break;
		}
	}
	return out;
}

/** Only ESRCH proves a process (or POSIX process group) gone; EPERM/unknown stay alive. */
export function isPidAlive(pid: number, group = false): boolean {
	try {
		process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Atomic same-directory temp write + rename; cleans up the temp file on failure. */
export function writeAtomic(file: string, text: string): void {
	const dir = path.dirname(path.resolve(file));
	const temp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
	try {
		fs.writeFileSync(temp, text, { mode: 0o600 });
		fs.renameSync(temp, file);
	} finally {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			// Never mask an already-completed rename or the original write error.
		}
	}
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 60_000;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function removeStaleLock(lock: string): void {
	try {
		const stat = fs.statSync(lock);
		const age = Date.now() - stat.mtimeMs;
		if (age < 100) return;
		let stale = age > LOCK_STALE_MS;
		if (!stale) {
			const holder = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; hostname?: string };
			if (holder.hostname === os.hostname() && typeof holder.pid === "number") {
				stale = !isPidAlive(holder.pid);
			}
		}
		const current = fs.statSync(lock);
		if (stale && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) fs.rmSync(lock);
	} catch {
		// Another writer may still be filling or removing the lock.
	}
}

/** Serialize a short read-modify-write across Pi processes. */
export function withFileLock<T>(file: string, change: () => T): T {
	const lock = `${file}.write.lock`;
	const token = randomUUID();
	const started = Date.now();
	for (;;) {
		let fd: number;
		try {
			fd = fs.openSync(lock, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			removeStaleLock(lock);
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Timed out waiting for ${lock}`);
			Atomics.wait(lockSleep, 0, 0, 20);
			continue;
		}
		try {
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }));
		} catch (error) {
			fs.rmSync(lock, { force: true });
			throw error;
		} finally {
			fs.closeSync(fd);
		}
		break;
	}
	try {
		return change();
	} finally {
		try {
			const holder = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string };
			if (holder.token === token) fs.rmSync(lock);
		} catch {
			// A stale lock may have been replaced; never remove a new owner's lock.
		}
	}
}

export function envBool(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	if (/^(0|false|off|no)$/i.test(raw)) return false;
	if (/^(1|true|on|yes)$/i.test(raw)) return true;
	return undefined;
}

function readSettingsFile(file: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export interface ConfigStoreSpec<T extends object> {
	fileName: string;
	defaults: T;
	envOverrides: Record<keyof T, string>;
	legacyKeys: ReadonlyArray<keyof T>;
	/** Override staging when the caller also owns recovery of interrupted writes. */
	writeAtomic?(file: string, text: string): void;
	parseValue<K extends keyof T>(key: K, raw: unknown, fromEnv: boolean): T[K] | undefined;
}

export interface ConfigStore<T extends object> {
	configPath(): string;
	envOverride(key: keyof T): string | undefined;
	loadConfig(): T;
	invalidateConfig(): void;
	saveConfig(patch: Partial<T>): T;
}

export function createConfigStore<T extends object>(spec: ConfigStoreSpec<T>): ConfigStore<T> {
	let cached: T | undefined;

	const configPath = (): string => process.env.PI_CC_CONFIG_FILE || path.join(getAgentDir(), spec.fileName);

	const envValue = <K extends keyof T>(key: K): T[K] | undefined => {
		const raw = process.env[spec.envOverrides[key]];
		return raw === undefined ? undefined : spec.parseValue(key, raw, true);
	};

	const envOverride = (key: keyof T): string | undefined => {
		const name = spec.envOverrides[key];
		return envValue(key) === undefined ? undefined : `${name}=${process.env[name]}`;
	};

	const legacyConfig = (): Partial<T> => {
		if (process.env.PI_CC_CONFIG_FILE) return {};
		let raw: Record<string, unknown>;
		try {
			raw = readSettingsFile(path.join(getAgentDir(), "pi-cc.json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
			return {};
		}
		const inherited: Partial<T> = {};
		for (const key of spec.legacyKeys) {
			const parsed = spec.parseValue(key, raw[key as string], false);
			if (parsed !== undefined) inherited[key] = parsed;
		}
		return inherited;
	};

	const readConfig = (): T => {
		let file: Record<string, unknown> = {};
		try {
			file = readSettingsFile(configPath());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				try {
					file = legacyConfig() as Record<string, unknown>;
				} catch {
					// An unreadable legacy file uses defaults on read; saving still rejects it.
				}
			}
		}
		const config = { ...spec.defaults };
		for (const key of Object.keys(spec.defaults) as Array<keyof T>) {
			const saved = spec.parseValue(key, file[key as string], false);
			config[key] = envValue(key) ?? saved ?? spec.defaults[key];
		}
		return config;
	};

	const loadConfig = (): T => (cached ??= readConfig());
	const invalidateConfig = (): void => { cached = undefined; };

	const saveConfig = (patch: Partial<T>): T => {
		const file = configPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		withFileLock(file, () => {
			let raw: Record<string, unknown> = {};
			try {
				raw = readSettingsFile(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = legacyConfig() as Record<string, unknown>;
				else if (!(error instanceof SyntaxError)) throw error;
			}
			(spec.writeAtomic ?? writeAtomic)(file, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`);
		});
		cached = undefined;
		return loadConfig();
	};

	return { configPath, envOverride, loadConfig, invalidateConfig, saveConfig };
}

// ------------------------------------------------------------ settings panel

export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type BooleanSettingSpec<K extends string> = {
	field: K;
	label: string;
	on: string;
	off: string;
	description: string;
};

export type NumberSettingSpec<K extends string> = {
	field: K;
	label: string;
	choices: number[];
	unit: string;
	parse(value: unknown): number | undefined;
	applyNote?: string;
	description: string;
};

export type PluginSettingSpec<K extends string> = BooleanSettingSpec<K> | NumberSettingSpec<K>;

export interface SettingsPanelOptions<K extends string> {
	theme: PanelTheme;
	file: string;
	onChange(field: K, value: string): void;
	onClose(): void;
}

export interface SettingsPanel {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface PluginSettingsOptions<T extends object> {
	command: string;
	title: string;
	channel: string;
	store: ConfigStore<T>;
	specs: ReadonlyArray<PluginSettingSpec<Extract<keyof T, string>>>;
	keys: Record<string, Extract<keyof T, string>>;
	usageHint?: string;
}

const PANEL_HINT = "  Enter/Space to change · Esc to close";

function listTheme(theme: PanelTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

function displayPath(file: string): string {
	const home = os.homedir();
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Stale UI context.
	}
}

export function createPluginSettings<T extends object>(plugin: PluginSettingsOptions<T>): {
	settingsPanel(options: SettingsPanelOptions<Extract<keyof T, string>>): SettingsPanel;
	registerSettingsCommand(pi: ExtensionAPI): void;
} {
	type K = Extract<keyof T, string>;
	const { command, title, channel, store, specs, keys } = plugin;
	const labelWidth = Math.max(...specs.map((spec) => spec.label.length));

	const settingValue = (spec: PluginSettingSpec<K>): string => {
		const value = store.loadConfig()[spec.field];
		return "on" in spec ? (value ? spec.on : spec.off) : `${value}${spec.unit}`;
	};

	const settingChoices = (spec: PluginSettingSpec<K>): string[] => {
		if ("on" in spec) return [spec.on, spec.off];
		const current = store.loadConfig()[spec.field] as number;
		return [...new Set([...spec.choices, current])].sort((a, b) => a - b).map((value) => `${value}${spec.unit}`);
	};

	const toItem = (spec: PluginSettingSpec<K>): SettingItem => {
		const currentValue = settingValue(spec);
		const override = store.envOverride(spec.field);
		const label = spec.label.padEnd(labelWidth);
		if (override) {
			return {
				id: spec.field,
				label,
				currentValue,
				description: `${spec.description}\n${override} overrides this while set; unset it to change it here.`,
			};
		}
		return { id: spec.field, label, currentValue, values: settingChoices(spec), description: spec.description };
	};

	const settingsPanel = (options: SettingsPanelOptions<K>): SettingsPanel => {
		const { theme } = options;
		const list = new SettingsList(
			specs.map(toItem),
			specs.length,
			listTheme(theme),
			(id, value) => {
				const spec = specs.find((candidate) => candidate.field === id);
				if (!spec) return;
				options.onChange(spec.field, value);
				list.updateValue(id, settingValue(spec));
			},
			() => options.onClose(),
		);
		const rule = (width: number) => theme.fg("dim", "─".repeat(width));
		const heading = (width: number) => {
			const head = theme.fg("text", theme.bold(title));
			const file = displayPath(options.file);
			const gap = width - visibleWidth(head) - visibleWidth(file);
			return gap >= 2 ? `${head}${" ".repeat(gap)}${theme.fg("dim", file)}` : truncateToWidth(head, width);
		};
		const body = (width: number) => {
			const lines = list.render(width);
			const hint = lines.findIndex((line) => line.includes("Esc to cancel"));
			const kept = hint === -1 ? [...lines] : lines.slice(0, hint);
			while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
			return kept;
		};
		return {
			render: (width) => {
				const safe = Math.max(0, Math.floor(width));
				return [rule(safe), heading(safe), rule(safe), ...body(safe), rule(safe), theme.fg("dim", PANEL_HINT), rule(safe)]
					.map((line) => truncateToWidth(line, safe));
			},
			invalidate: () => list.invalidate(),
			handleInput: (data) => list.handleInput(data),
		};
	};

	const commandWord = (field: K): string => Object.keys(keys).find((word) => keys[word] === field) ?? field;

	const showSettings = (ctx: ExtensionContext): void => {
		const lines = [`${title} settings · ${store.configPath()}`];
		for (const spec of specs) {
			const override = store.envOverride(spec.field);
			lines.push(`  ${commandWord(spec.field)}:`.padEnd(13) + settingValue(spec) + (override ? ` (${override})` : ""));
		}
		const usage = plugin.usageHint ?? `Usage: /${command} <item> on|off  (${specs.map((spec) => commandWord(spec.field)).join(", ")})`;
		lines.push("", usage);
		notify(ctx, lines.join("\n"));
	};

	const registerSettingsCommand = (pi: ExtensionAPI): void => {
		const applySetting = (field: K, value: string): void => {
			const spec = specs.find((candidate) => candidate.field === field);
			if (!spec) return;
			const saved = "on" in spec ? value === spec.on : spec.parse(Number.parseInt(value, 10));
			if (saved === undefined) return;
			const next = store.saveConfig({ [field]: saved } as unknown as Partial<T>);
			try {
				pi.events.emit(channel, next);
			} catch {
				// Another listener must not fail an already-saved setting.
			}
		};

		pi.registerCommand(command, {
			description: `${title} settings: ${specs.map((spec) => spec.label.toLowerCase()).join(", ")}`,
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const words = args.trim().split(/\s+/).filter(Boolean);
				if (words[0] === "settings" || words[0] === "config") words.shift();
				if (words.length === 0) {
					if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
						await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
							const panel = settingsPanel({
								theme,
								file: store.configPath(),
								onChange: (field, value) => {
									try {
										applySetting(field, value);
									} catch (error) {
										notify(ctx, `Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
									}
								},
								onClose: () => done(undefined),
							});
							return {
								render: (width: number) => panel.render(width),
								invalidate: () => panel.invalidate(),
								handleInput: (data: string) => {
									panel.handleInput(data);
									tui.requestRender();
								},
							};
						}, { blocked: { kind: "question", message: `Changing ${title} settings` } });
						return;
					}
					showSettings(ctx);
					return;
				}
				const word = words[0]!.toLowerCase();
				const field = Object.hasOwn(keys, word) ? keys[word] : undefined;
				const spec = field ? specs.find((candidate) => candidate.field === field) : undefined;
				const raw = words[1]?.trim().toLowerCase();
				if (!field || !spec || raw === undefined) {
					showSettings(ctx);
					return;
				}
				const numeric = "on" in spec ? undefined : /^\d+$/.test(raw) ? spec.parse(Number(raw)) : undefined;
				const value = "on" in spec
					? raw === "on" || raw === "true" || raw === "1" ? spec.on : raw === "off" || raw === "false" || raw === "0" ? spec.off : undefined
					: numeric === undefined ? undefined : `${numeric}${spec.unit}`;
				if (value === undefined) {
					showSettings(ctx);
					return;
				}
				applySetting(field, value);
				const override = store.envOverride(field);
				if (override && settingValue(spec) !== value) {
					notify(ctx, `${spec.label} saved as ${value}, but ${override} overrides it while set`, "warning");
				} else {
					notify(ctx, "on" in spec ? `${spec.label} ${value === spec.on ? "enabled" : "disabled"}` : `${spec.label} ${value}${spec.applyNote ?? ""}`);
				}
			},
		});
	};

	return { settingsPanel, registerSettingsCommand };
}
