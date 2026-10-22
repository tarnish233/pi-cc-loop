/**
 * Shared settings for the pi-cc extensions.
 *
 * Both pi-cc-loop and pi-cc-monitor read the same small JSON file so a single
 * toggle changes the look of both packages. The file is optional; when it is
 * missing or malformed the defaults apply.
 *
 *   ~/.pi/agent/pi-cc.json
 *   {
 *     "compactMessages": true,
 *     "compactToolRows": true,
 *     "footer": true
 *   }
 *
 * Environment overrides (useful for tests and quick experiments):
 *   PI_CC_CONFIG_FILE=/path/to/pi-cc.json
 *   PI_CC_COMPACT_MESSAGES=0|1
 *   PI_CC_COMPACT_TOOL_ROWS=0|1
 *   PI_CC_FOOTER=0|1
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiCcConfig {
	/** Two-line marker blocks instead of the padded card. */
	compactMessages: boolean;
	/** One-line tool results instead of Pi's "N lines returned" preview. */
	compactToolRows: boolean;
	/**
	 * Keep pi-cc tools out of pi-cc-extensions' global tool styling so the
	 * compact rows above are visible. Only names this extension added are
	 * removed again when the setting is turned off.
	 */
	managePiCcExtensions: boolean;
	/**
	 * Show a one-line summary in Pi's footer (loops armed, monitors running).
	 * Shared so one switch silences both packages.
	 */
	footer: boolean;
	/** Internal: names this extension added to pi-cc-extensions.json. */
	managedExcludes?: string[];
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compactMessages: true,
	compactToolRows: true,
	footer: true,
	managePiCcExtensions: true,
};

function envBool(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	if (/^(0|false|off|no)$/i.test(raw)) return false;
	if (/^(1|true|on|yes)$/i.test(raw)) return true;
	return undefined;
}

/** The settings file shared by pi-cc-loop and pi-cc-monitor. */
export function configPath(): string {
	if (process.env.PI_CC_CONFIG_FILE) return process.env.PI_CC_CONFIG_FILE;
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "pi-cc.json");
}

function readConfig(): PiCcConfig {
	let file: Partial<PiCcConfig> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
		if (parsed && typeof parsed === "object") file = parsed as Partial<PiCcConfig>;
	} catch {
		// Missing or malformed files fall back to defaults.
	}
	return {
		compactMessages:
			envBool("PI_CC_COMPACT_MESSAGES") ??
			(typeof file.compactMessages === "boolean" ? file.compactMessages : DEFAULT_CONFIG.compactMessages),
		compactToolRows:
			envBool("PI_CC_COMPACT_TOOL_ROWS") ??
			(typeof file.compactToolRows === "boolean" ? file.compactToolRows : DEFAULT_CONFIG.compactToolRows),
		footer:
			envBool("PI_CC_FOOTER") ?? (typeof file.footer === "boolean" ? file.footer : DEFAULT_CONFIG.footer),
		managePiCcExtensions:
			envBool("PI_CC_MANAGE_CCSTYLE") ??
			(typeof file.managePiCcExtensions === "boolean"
				? file.managePiCcExtensions
				: DEFAULT_CONFIG.managePiCcExtensions),
		managedExcludes: Array.isArray(file.managedExcludes)
			? file.managedExcludes.filter((name): name is string => typeof name === "string")
			: [],
	};
}

let cached: PiCcConfig | undefined;

/** Load the settings. Cached until `invalidateConfig` or `saveConfig`. */
export function loadConfig(): PiCcConfig {
	if (!cached) cached = readConfig();
	return cached;
}

/** Forget the cached settings, e.g. after another extension changed the file. */
export function invalidateConfig(): void {
	cached = undefined;
}

/** Merge a patch into the settings file and update the cache. */
export function saveConfig(patch: Partial<PiCcConfig>): PiCcConfig {
	const next = { ...loadConfig(), ...patch };
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	fs.renameSync(temp, file);
	cached = next;
	return next;
}

/**
 * pi-cc-extensions' config file. That extension loads its config once at load
 * time, so changes made here apply after `/reload`.
 */
export function piCcExtensionsConfigPath(): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return process.env.PI_CC_EXTENSIONS_CONFIG_FILE ?? path.join(agentDir, "pi-cc-extensions.json");
}

/**
 * Add or remove our tool names in pi-cc-extensions' `excludeRenderers`.
 *
 * Returns true when the file changed (the caller can tell the user to reload).
 * Only names this extension added are removed again; a name the user put there
 * themselves is left alone.
 */
export function syncPiCcExtensionsExcludes(toolNames: readonly string[], enabled: boolean): boolean {
	// Another package may have written managedExcludes since our last read.
	invalidateConfig();
	const config = loadConfig();
	if (!config.managePiCcExtensions) return false;
	const file = piCcExtensionsConfigPath();
	if (!fs.existsSync(file)) return false;

	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		raw = parsed as Record<string, unknown>;
	} catch {
		return false;
	}

	const current = Array.isArray(raw.excludeRenderers)
		? raw.excludeRenderers.filter((name): name is string => typeof name === "string")
		: [];
	const managed = new Set(config.managedExcludes ?? []);
	const next = new Set(current);
	let changed = false;

	// A tool this package stopped compact-rendering goes back to the normal
	// rendering other extensions give it; only names we added are removed.
	for (const name of managed) {
		if (toolNames.includes(name)) continue;
		if (next.delete(name)) changed = true;
		managed.delete(name);
	}

	for (const name of toolNames) {
		if (enabled) {
			if (!next.has(name)) {
				next.add(name);
				managed.add(name);
				changed = true;
			}
		} else if (managed.has(name)) {
			if (next.delete(name)) changed = true;
			managed.delete(name);
		}
	}

	if (!changed && managed.size === (config.managedExcludes ?? []).length) return false;

	raw.excludeRenderers = [...next].sort((a, b) => a.localeCompare(b));
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	fs.renameSync(temp, file);
	saveConfig({ managedExcludes: [...managed].sort((a, b) => a.localeCompare(b)) });
	return changed;
}
