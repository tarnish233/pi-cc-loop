/**
 * The /loop settings panel: the same kind of screen as Pi's /settings.
 *
 * Pi's /settings cannot take items from an extension (its panel is a fixed
 * list, and the command is handled before extension commands), so the shared
 * pi-cc settings get their own panel, built from the same parts: SettingsList
 * between two borders, the selected setting's description below it, and
 * Enter/Space to change a value. A change is saved at once and Esc closes.
 *
 * A setting that an environment variable overrides shows the value in effect
 * and cannot be changed here; its description names the variable.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { envOverride, loadConfig, type PiCcConfig } from "./config.ts";

/** The part of Pi's theme the panel uses. */
export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface SettingSpec {
	field: keyof PiCcConfig;
	label: string;
	/** Display values for true and false. */
	on: string;
	off: string;
	description: string;
}

const SETTINGS: SettingSpec[] = [
	{
		field: "compactMessages",
		label: "Message style",
		on: "compact",
		off: "card",
		description:
			"How scheduled fires and Monitor events are drawn. compact: \u273b header and indented body; card: the old padded card.",
	},
	{
		field: "footer",
		label: "Footer summary",
		on: "on",
		off: "off",
		description: "One line in Pi's footer while loops or monitors run: loop 2 \u00b7 next 3m, monitor 2.",
	},
];

/**
 * Pi's getSettingsListTheme(), built from the theme the panel is given: the
 * global theme that function reads is not shared with extensions in every
 * Pi runtime (see the note on Pi's DynamicBorder).
 */
function listTheme(theme: PanelTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "\u2192 "),
		hint: (text) => theme.fg("dim", text),
	};
}

/** A path with the home directory shortened to ~. */
function displayPath(file: string): string {
	const home = os.homedir();
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function item(spec: SettingSpec): SettingItem {
	const value = loadConfig()[spec.field] ? spec.on : spec.off;
	const override = envOverride(spec.field);
	if (override) {
		// No values: Enter/Space leaves it alone, and the description says why.
		return {
			id: spec.field,
			label: spec.label,
			currentValue: value,
			description: `${spec.description}\n${override} overrides this while set; unset it to change it here.`,
		};
	}
	return { id: spec.field, label: spec.label, currentValue: value, values: [spec.on, spec.off], description: spec.description };
}

export interface SettingsPanelOptions {
	theme: PanelTheme;
	/** Where the settings are saved, shown in the title. */
	file: string;
	/** Save one setting (and tell the other packages). */
	onChange(field: keyof PiCcConfig, value: boolean): void;
	onClose(): void;
}

export interface SettingsPanel {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export function settingsPanel(options: SettingsPanelOptions): SettingsPanel {
	const { theme } = options;
	const list = new SettingsList(
		SETTINGS.map(item),
		SETTINGS.length,
		listTheme(theme),
		(id, value) => {
			const spec = SETTINGS.find((candidate) => candidate.field === id);
			if (!spec) return;
			options.onChange(spec.field, value === spec.on);
			// Show what is in effect now.
			list.updateValue(id, loadConfig()[spec.field] ? spec.on : spec.off);
		},
		() => options.onClose(),
	);

	const border = () => new DynamicBorder((text: string) => theme.fg("border", text));
	const container = new Container();
	container.addChild(border());
	container.addChild(
		new Text(`${theme.fg("accent", theme.bold("pi-cc settings"))}${theme.fg("dim", ` \u00b7 ${displayPath(options.file)}`)}`, 0, 0),
	);
	container.addChild(new Spacer(1));
	container.addChild(list);
	container.addChild(border());

	return {
		render: (width) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data) => list.handleInput(data),
	};
}
