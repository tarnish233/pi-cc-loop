/**
 * Independent settings for pi-cc-loop (`pi-cc-loop.json`, inheriting valid
 * keys from legacy `pi-cc.json` on first save unless `PI_CC_CONFIG_FILE` is set).
 */

import { createConfigStore, envBool, withFileLock } from "./plugin-settings.ts";
import { writeAtomic } from "./temp-files.ts";
export { withFileLock };

export interface PiCcConfig {
	/** One-line notifications with expandable details instead of the legacy padded card. */
	compactMessages: boolean;
	/** Show this extension's summary in Pi's footer. */
	footer: boolean;
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compactMessages: true,
	footer: true,
};

export const store = createConfigStore<PiCcConfig>({
	fileName: "pi-cc-loop.json",
	defaults: DEFAULT_CONFIG,
	envOverrides: {
		compactMessages: "PI_CC_COMPACT_MESSAGES",
		footer: "PI_CC_FOOTER",
	},
	legacyKeys: ["compactMessages", "footer"],
	writeAtomic,
	parseValue(key, raw, fromEnv) {
		if (fromEnv) return envBool(key === "compactMessages" ? "PI_CC_COMPACT_MESSAGES" : "PI_CC_FOOTER");
		return typeof raw === "boolean" ? raw : undefined;
	},
});

export const { configPath, envOverride, loadConfig, invalidateConfig, saveConfig } = store;
