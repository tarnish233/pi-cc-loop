/**
 * `/loop_settings` command and TUI panel for pi-cc-loop.
 */

import { store, type PiCcConfig } from "./config.ts";
import { createPluginSettings, type PanelTheme, type SettingsPanel, type SettingsPanelOptions as GenericPanelOptions } from "./plugin-settings.ts";
export type { PanelTheme, SettingsPanel };
export type SettingsPanelOptions = GenericPanelOptions<keyof PiCcConfig>;

export const CONFIG_CHANNEL = "pi-cc-loop:config";

export const { settingsPanel, registerSettingsCommand } = createPluginSettings<PiCcConfig>({
	command: "loop_settings",
	title: "Loop",
	channel: CONFIG_CHANNEL,
	store,
	specs: [
		{
			field: "compactMessages",
			label: "Message style",
			on: "compact",
			off: "card",
			description: "How scheduled fires are drawn. compact: one collapsed line, expandable details; card: the legacy padded card.",
		},
		{
			field: "footer",
			label: "Footer summary",
			on: "on",
			off: "off",
			description: "One line in Pi's footer while loops run: 1 loop · next 3m.",
		},
	],
	keys: {
		messages: "compactMessages",
		message: "compactMessages",
		footer: "footer",
		status: "footer",
		statusline: "footer",
	},
});
