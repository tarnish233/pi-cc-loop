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
 *     "footer": true
 *   }
 *
 * Environment overrides (useful for tests and quick experiments):
 *   PI_CC_CONFIG_FILE=/path/to/pi-cc.json
 *   PI_CC_COMPACT_MESSAGES=0|1
 *   PI_CC_FOOTER=0|1
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiCcConfig {
	/** Two-line marker blocks instead of the padded card. */
	compactMessages: boolean;
	/**
	 * Show a one-line summary in Pi's footer (loops armed, monitors running).
	 * Shared so one switch silences both packages.
	 */
	footer: boolean;
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compactMessages: true,
	footer: true,
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
		footer:
			envBool("PI_CC_FOOTER") ?? (typeof file.footer === "boolean" ? file.footer : DEFAULT_CONFIG.footer),
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
	// Keep keys this version does not know about: the file is the user's.
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
	} catch {
		// A missing or malformed file is rewritten from scratch.
	}
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`, "utf8");
	fs.renameSync(temp, file);
	cached = next;
	return next;
}
