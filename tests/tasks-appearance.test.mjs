import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { makeHarness } from "./harness.mjs";
import { findPiInstall, loadModule } from "./helpers.mjs";

const { registerTaskProvider } = await loadModule("tasks.ts");
const { rgbColor, styleText, stripTerminalSequences, visibleWidth } = await import(pathToFileURL(findPiInstall().piTui).href);

/** A theme using Pi's real ANSI styler, including nested background resets. */
function colorTheme(appearance = "dark", mode = "truecolor") {
	const dark = appearance === "dark";
	const colors = {
		text: rgbColor(dark ? 228 : 32, dark ? 234 : 36, dark ? 242 : 42),
		userMessageBg: rgbColor(dark ? 48 : 250, dark ? 52 : 250, dark ? 58 : 252),
		accent: rgbColor(65, 155, 235),
		success: rgbColor(75, 170, 110),
	};
	return {
		appearance,
		colors,
		getColorMode: () => mode,
		fg: (role, text) => styleText(text, { fg: colors[role] ?? colors.text }, mode),
		bold: (text) => styleText(text, { bold: true }, mode),
		style: (text, style) => styleText(text, style, mode),
	};
}

/** Track the background of every visible cell, not merely the presence of an ANSI prefix. */
function cells(line) {
	let background;
	const result = [];
	for (const segment of line.split(/(\x1b\[[\d;]*m)/)) {
		if (segment.startsWith("\x1b[")) {
			const codes = segment.slice(2, -1).split(";").map((part) => Number(part || 0));
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 0 || code === 49) background = undefined;
				else if (code === 48 && codes[i + 1] === 2) {
					background = `rgb:${codes.slice(i + 2, i + 5).join(",")}`;
					i += 4;
				} else if (code === 48 && codes[i + 1] === 5) {
					background = `index:${codes[i + 2]}`;
					i += 2;
				} else if (code === 38 && codes[i + 1] === 2) i += 4;
				else if (code === 38 && codes[i + 1] === 5) i += 2;
			}
			continue;
		}
		for (const character of segment) {
			for (let column = 0; column < visibleWidth(character); column++) result.push({ character, background });
		}
	}
	return result;
}

function view(theme, items = [], { columns = 140, rows = 40 } = {}) {
	const previousCwd = process.cwd();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-card-appearance-"));
	const h = makeHarness(cwd);
	const state = { columns, rows, items };
	let panel, options, resolveOverlay;
	const tui = {
		terminal: { get columns() { return state.columns; }, get rows() { return state.rows; } },
		requestRender() {},
	};
	const keybindings = {
		matches(data, action) {
			return ({ "tui.select.cancel": "\x1b", "tui.select.confirm": "\r", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.pageUp": "\x1b[5~", "tui.select.pageDown": "\x1b[6~" })[action] === data;
		},
	};
	h.ctx.ui.custom = (factory, configured) => {
		options = configured;
		panel = factory(tui, theme, keybindings, () => { panel.dispose(); resolveOverlay?.(); });
		return new Promise((resolve) => { resolveOverlay = resolve; });
	};
	const registration = registerTaskProvider(h.pi, {
		id: "monitor", label: "Monitor", list: () => state.items,
		detail: (item) => ({ rows: Array.from({ length: 30 }, (_, i) => ({ label: `Field ${i}`, value: `${item.title} detail ${i}` })) }),
	});
	const shown = h.commands.get("cc-tasks").handler("", h.ctx);
	// The real custom() bridge retains one resolved options object, not the factory.
	const retainedOptions = options.overlayOptions();
	return {
		state, panel, h,
		width: () => retainedOptions.width,
		render() { return panel.render(retainedOptions.width); },
		async close() {
			registration.close(); panel.dispose(); await shown;
			process.chdir(previousCwd); fs.rmSync(cwd, { recursive: true, force: true });
		},
	};
}

const item = (id) => ({ id, title: `task ${id} 中文 🚀`, state: "running", active: true });

test("empty task card is compact and its width responds to resize without growing beyond 96 columns", async () => {
	const v = view(colorTheme());
	try {
		assert.equal(v.width(), 96);
		assert.equal(v.render().length, 9, "an empty list uses only two body rows, not a 16-row sheet");
		assert.match(stripTerminalSequences(v.render().join("\n")), /No tasks\.[\s\S]*Start a task/);
		v.state.columns = 62;
		assert.equal(v.width(), 60);
		assert.ok(v.render().every((line) => visibleWidth(line) === 60));
		v.state.columns = 180;
		assert.equal(v.width(), 96);
		assert.deepEqual(v.h.sent, [], "styling and resizing do not start a model turn");
	} finally { await v.close(); }
});

test("every dark/light card cell has a solid background, including padding after nested tab resets", async () => {
	for (const appearance of ["dark", "light"]) {
		for (const mode of ["truecolor", "256color"]) {
			const v = view(colorTheme(appearance, mode));
			try {
				const rendered = v.render();
				for (const line of rendered) {
					const row = cells(line);
					assert.equal(row.length, v.width());
					assert.ok(row.every((cell) => cell.background !== undefined), `${appearance}/${mode}: no default-background holes`);
				}
				const tabRow = cells(rendered[2]);
				assert.notEqual(tabRow[3].background, tabRow.at(-3).background, "active tab gets its own filled pill");
				assert.equal(tabRow.at(-3).background, tabRow.at(-1).background, "closing a tab background restores the header, not the terminal");
			} finally { await v.close(); }
		}
	}
});

test("selection remains visibly distinct after dark/light 256-color quantization", async () => {
	for (const appearance of ["dark", "light"]) {
		const v = view(colorTheme(appearance, "256color"), [item("0"), item("1")]);
		try {
			assert.notEqual(cells(v.render()[4])[3].background, cells(v.render()[5])[3].background);
		} finally { await v.close(); }
	}
});

test("task rows grow with content, scroll beyond 12 rows, and paint the full selected row", async () => {
	const v = view(colorTheme(), [item("0"), item("1"), item("2")]);
	try {
		assert.equal(v.render().length, 10);
		const selected = cells(v.render()[4]);
		const ordinary = cells(v.render()[5]);
		assert.notEqual(selected[3].background, ordinary[3].background);
		assert.equal(selected[3].background, selected.at(-3).background, "selection includes the trailing blank area");
		v.panel.handleInput("\x1b[B");
		assert.notEqual(cells(v.render()[4])[3].background, cells(v.render()[5])[3].background, "selection moves without repainting the old row as selected");
		v.state.items = Array.from({ length: 31 }, (_, i) => item(String(i)));
		v.panel.refreshNow(false);
		assert.equal(v.render().length, 19, "the card keeps at most 12 body rows");
		v.panel.handleInput("\x1b[6~");
		assert.match(stripTerminalSequences(v.render().find((line) => line.includes("▸"))), /task 13/);
		v.panel.handleInput("\x1b[5~");
		assert.match(stripTerminalSequences(v.render().find((line) => line.includes("▸"))), /task 1 /);
	} finally { await v.close(); }
});

test("theme changes replace the card palette without changing selection or content", async () => {
	let active = colorTheme("dark");
	const theme = {
		get appearance() { return active.appearance; }, get colors() { return active.colors; },
		getColorMode: () => active.getColorMode(), style: (...args) => active.style(...args),
		fg: (...args) => active.fg(...args), bold: (...args) => active.bold(...args),
	};
	const v = view(theme, [item("unchanged")]);
	try {
		const before = v.render();
		active = colorTheme("light");
		v.panel.invalidate();
		const after = v.render();
		assert.notEqual(cells(before[0])[0].background, cells(after[0])[0].background);
		assert.equal(stripTerminalSequences(after.join("\n")), stripTerminalSequences(before.join("\n")));
	} finally { await v.close(); }
});

test("colored cards keep detail scrolling and Esc correct in tiny/narrow layouts", async () => {
	const v = view(colorTheme(), [item("narrow")]);
	try {
		v.panel.handleInput("\r");
		for (const columns of [100, 42, 16, 5, 4, 1]) {
			for (const rows of [36, 18, 10, 9, 6, 3]) {
				v.state.columns = columns; v.state.rows = rows;
				v.panel.invalidate();
				const rendered = v.render();
				const allowed = Math.max(1, Math.min(Math.floor(rows * 0.9), rows - 2));
				assert.ok(rendered.length <= allowed);
				assert.ok(rendered.every((line) => visibleWidth(line) === v.width()));
				assert.ok(rendered.every((line) => cells(line).every((cell) => cell.background !== undefined)));
				v.panel.handleInput("\x1b[6~");
				assert.ok(v.panel.detailScroll > 0 || v.panel.detailLineCount <= 1, "paging remains usable after resize");
			}
		}
		v.panel.handleInput("\x1b");
		assert.equal(v.panel.detailKey, undefined, "first Esc closes only the detail");
		assert.deepEqual(v.h.sent, []);
	} finally { await v.close(); }
});
