/**
 * The shared settings file (pi-cc.json) and the /loop settings commands.
 *
 * The file belongs to the user: a command writes only the key it changes. An
 * environment override (PI_CC_FOOTER, PI_CC_COMPACT_MESSAGES) wins while it is
 * set but is never copied into the file, and the commands say when one is in
 * force. The file lives in Pi's agent directory, so PI_CODING_AGENT_DIR moves
 * it along with Pi's own settings.
 *
 * The command is /pi_cc, shared verbatim with pi-cc-monitor and pi-cc-plugins
 * (see settings.ts); only the first package to load registers it. In the TUI,
 * a bare /pi_cc opens a panel with one page per plugin, like pi-cc-extensions'
 * /ccstyle: a tab bar on top (Tab and Shift+Tab switch pages), Pi's
 * SettingsList below, where Enter/Space changes the selected setting and saves
 * it at once, and Esc closes. Elsewhere it prints the summary, page by page.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCron, makeHarness, start } from "./harness.mjs";
import { loadModule } from "./helpers.mjs";

const config = await loadModule("config.ts");

const ENV_KEYS = ["PI_CC_CONFIG_FILE", "PI_CC_FOOTER", "PI_CC_COMPACT_MESSAGES", "PI_CODING_AGENT_DIR"];

function setEnv(vars) {
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Run `body` with these variables (undefined unsets one), then put them back. */
async function withEnv(vars, body) {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		setEnv(vars);
		config.invalidateConfig();
		return await body();
	} finally {
		setEnv(saved);
		config.invalidateConfig();
	}
}

function tempConfig(content) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-settings-")), "pi-cc.json");
	if (content) fs.writeFileSync(file, JSON.stringify(content), "utf8");
	return file;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const loop = (h) => h.commands.get("loop");
const piCc = (h) => h.commands.get("pi_cc");

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const ESC = "\x1b";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

/** Run /pi_cc with a TUI that hands out the panel the way ctx.ui.custom does. */
function openPanel(h, theme = { fg: (_color, text) => text, bold: (text) => text }) {
	let panel;
	let renders = 0;
	h.ctx.ui.custom = (factory) =>
		new Promise((resolve) => {
			panel = factory({ requestRender: () => renders++ }, theme, {}, resolve);
		});
	const closed = piCc(h).handler("", h.ctx);
	assert.ok(panel, "the panel opened");
	return { panel, closed, screen: () => panel.render(100).join("\n"), renders: () => renders };
}

test("a setting writes only its own key: other keys stay, an environment override never reaches the file", async () => {
	const file = tempConfig({ compactMessages: true, footer: true, mine: "kept" });
	await withEnv({ PI_CC_CONFIG_FILE: file, PI_CC_COMPACT_MESSAGES: "0" }, async () => {
		const h = await start(makeHarness());
		await piCc(h).handler("footer off", h.ctx);
		assert.deepEqual(readJson(file), { compactMessages: true, footer: false, mine: "kept" });
	});
});

test("under PI_CC_FOOTER=0, footer on is saved for later but the variable still wins, and the commands say so", async () => {
	const file = tempConfig({ footer: false });
	await withEnv({ PI_CC_CONFIG_FILE: file, PI_CC_FOOTER: "0" }, async () => {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		await piCc(h).handler("footer on", h.ctx);
		assert.equal(readJson(file).footer, true, "the file keeps the user's choice");
		assert.equal(config.loadConfig().footer, false, "the variable wins while it is set");
		assert.equal(h.status("loop"), undefined, "so the footer stays hidden, as it does in pi-cc-monitor");
		const notice = h.notifications.at(-1);
		assert.equal(notice.level, "warning");
		assert.match(notice.message, /PI_CC_FOOTER=0/);

		await piCc(h).handler("", h.ctx);
		assert.match(h.notifications.at(-1).message, /footer: +hidden \(PI_CC_FOOTER=0\)/);
		await piCc(h).handler("footer", h.ctx);
		assert.match(h.notifications.at(-1).message, /footer: +hidden \(PI_CC_FOOTER=0\)/, "a bare /pi_cc footer prints the summary");
	});
});

test("in the TUI, /loop settings opens a panel like Pi's /settings: Enter/Space changes and saves at once, Esc closes", async () => {
	const file = tempConfig({ compactMessages: true, footer: true });
	await withEnv({ PI_CC_CONFIG_FILE: file }, async () => {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		const ui = openPanel(h);
		assert.match(ui.screen(), /→ Message style +compact/);
		assert.match(ui.screen(), /\n {2}Footer summary +on/);

		ui.panel.handleInput(DOWN);
		ui.panel.handleInput(SPACE);
		assert.match(ui.screen(), /→ Footer summary +off/);
		assert.equal(readJson(file).footer, false, "saved at once");
		assert.equal(h.status("loop"), undefined, "and the footer follows");
		assert.ok(h.busEvents.some((event) => event.channel === "pi-cc:config"), "pi-cc-monitor is told");
		assert.ok(ui.renders() > 0, "the panel asks for a repaint");

		ui.panel.handleInput(UP);
		ui.panel.handleInput(ENTER);
		assert.match(ui.screen(), /→ Message style +card/);
		assert.equal(readJson(file).compactMessages, false);
		assert.ok(
			!h.notifications.some((notice) => /Footer summary|Compact message style/.test(notice.message)),
			"the panel shows the change itself; no notices pile up in the chat",
		);

		ui.panel.handleInput(ESC);
		await ui.closed; // the command ends with the panel
	});
});

test("one page per plugin, like /ccstyle: Loop & Monitor / Plugins / Compact; Tab and Shift+Tab switch pages", async () => {
	const file = tempConfig({});
	await withEnv({ PI_CC_CONFIG_FILE: file }, async () => {
		const h = await start(makeHarness());
		const ui = openPanel(h, { fg: (_color, text) => text, bold: (text) => `*${text}*` });
		const page = () => ui.screen().split("\n");
		assert.match(page()[1], /^\*Loop & Monitor\* \/ Plugins \/ Compact/, "the tab bar, the open page in bold");
		assert.match(ui.screen(), /→ Message style +compact/);
		assert.match(ui.screen(), /\n {2}Footer summary +on/);
		assert.doesNotMatch(ui.screen(), /Draft recall|Turn summary|CC compaction|Idle compaction/, "other plugins' settings are on their pages");
		assert.match(ui.screen(), /Enter\/Space to change · Tab\/Shift\+Tab to switch pages · Esc to close/);
		assert.doesNotMatch(ui.screen(), /Esc to cancel/, "one hint line, the panel's");

		ui.panel.handleInput(DOWN);
		ui.panel.handleInput(TAB);
		assert.match(page()[1], /^Loop & Monitor \/ \*Plugins\* \/ Compact/);
		assert.match(ui.screen(), /→ Draft recall +on/);
		assert.match(ui.screen(), /\n {2}Turn summary +on/);
		assert.doesNotMatch(ui.screen(), /Message style|CC compaction/);

		ui.panel.handleInput(TAB);
		assert.match(page()[1], /^Loop & Monitor \/ Plugins \/ \*Compact\*/);
		assert.match(ui.screen(), /→ CC compaction +on/);
		ui.panel.handleInput(DOWN);
		ui.panel.handleInput(SPACE);
		assert.match(ui.screen(), /→ Idle compaction +off/);
		assert.deepEqual(readJson(file), { idleCompaction: false }, "saved at once, its own key only");

		ui.panel.handleInput(TAB);
		assert.match(page()[1], /^\*Loop & Monitor\*/, "Tab wraps around");
		assert.match(ui.screen(), /→ Footer summary +on/, "each page keeps its selection");
		ui.panel.handleInput(SHIFT_TAB);
		assert.match(ui.screen(), /→ Idle compaction +off/, "Shift+Tab goes back");

		ui.panel.handleInput(ESC);
		await ui.closed;
	});
});

test("the values line up across pages, and the file is named on the tab bar when there is room", async () => {
	const file = tempConfig({});
	await withEnv({ PI_CC_CONFIG_FILE: file }, async () => {
		const h = await start(makeHarness());
		const ui = openPanel(h);
		const column = () => ui.screen().split("\n").find((line) => line.startsWith("→")).search(/(compact|on|off)$/);
		const first = column();
		ui.panel.handleInput(TAB);
		assert.equal(column(), first);
		ui.panel.handleInput(TAB);
		assert.equal(column(), first);
		const wide = ui.panel.render(file.length + 60).join("\n").split("\n")[1];
		assert.ok(wide.endsWith(file.replace(os.homedir(), "~")), wide);
		const narrow = ui.panel.render(50).join("\n").split("\n")[1];
		assert.equal(narrow.trimEnd(), "Loop & Monitor / Plugins / Compact", "no room: the tabs alone");
		ui.panel.handleInput(ESC);
		await ui.closed;
	});
});

test("in the panel, a setting a variable overrides shows its value in effect, names the variable, and stays put", async () => {
	const file = tempConfig({});
	await withEnv({ PI_CC_CONFIG_FILE: file, PI_CC_FOOTER: "0" }, async () => {
		const h = await start(makeHarness());
		const ui = openPanel(h);
		ui.panel.handleInput(DOWN);
		assert.match(ui.screen(), /→ Footer summary +off/);
		assert.match(ui.screen(), /PI_CC_FOOTER=0 overrides this while set/);
		ui.panel.handleInput(SPACE);
		assert.match(ui.screen(), /→ Footer summary +off/);
		assert.deepEqual(readJson(file), {}, "nothing is written");
		ui.panel.handleInput(ESC);
		await ui.closed;
	});
});

test("outside the TUI, /pi_cc prints the summary, page by page", async () => {
	await withEnv({ PI_CC_CONFIG_FILE: tempConfig({}) }, async () => {
		const h = await start(makeHarness());
		h.ctx.mode = "rpc";
		let opened = false;
		h.ctx.ui.custom = async () => {
			opened = true;
		};
		await piCc(h).handler("", h.ctx);
		assert.equal(opened, false);
		assert.match(h.notifications.at(-1).message, /pi-cc settings/);
		assert.match(
			h.notifications.at(-1).message,
			/\nLoop & Monitor\n {2}messages: +compact\n {2}footer: +summary\nPlugins\n {2}draft: +on\n {2}summary: +on\nCompact\n {2}compact: +on\n {2}idle: +on\n/,
		);
	});
});

test("the settings file lives in Pi's agent directory, so PI_CODING_AGENT_DIR moves it with Pi's own settings", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-agent-"));
	await withEnv({ PI_CC_CONFIG_FILE: undefined, PI_CODING_AGENT_DIR: agentDir }, async () => {
		// Checked before anything is written: a wrong path would be the user's real file.
		assert.equal(config.configPath(), path.join(agentDir, "pi-cc.json"));
		const h = await start(makeHarness());
		await piCc(h).handler("footer off", h.ctx);
		assert.deepEqual(readJson(path.join(agentDir, "pi-cc.json")), { footer: false });
	});
});

test("only one /pi_cc however many pi-cc packages load: the claim is first come, released at shutdown", async () => {
	const { registerPiCcCommand } = await loadModule("settings.ts");
	const claim = Symbol.for("pi-cc:slash-command");
	globalThis[claim] = undefined;
	try {
		const first = makeHarness();
		registerPiCcCommand(first.pi, "pi-cc-loop");
		const second = makeHarness();
		registerPiCcCommand(second.pi, "pi-cc-monitor");
		assert.ok(first.commands.has("pi_cc"));
		assert.ok(!second.commands.has("pi_cc"), "the later package leaves /pi_cc to the first");

		// A package re-loading over its own claim re-claims it (/reload re-runs the module).
		const again = makeHarness();
		registerPiCcCommand(again.pi, "pi-cc-loop");
		assert.ok(again.commands.has("pi_cc"));

		// Shutdown releases the name: the next package can take it.
		await first.handlers.get("session_shutdown")({ type: "session_shutdown" }, first.ctx);
		const third = makeHarness();
		registerPiCcCommand(third.pi, "pi-cc-monitor");
		assert.ok(third.commands.has("pi_cc"), "the claim is released at shutdown");
	} finally {
		globalThis[claim] = undefined;
	}
});

test("the old /loop settings words redirect instead of starting a loop", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("settings", h.ctx);
	assert.equal(h.sent.length, 0, "no message to the model");
	assert.match(h.notifications.at(-1).message, /under \/pi_cc/);
	await loop(h).handler("footer on", h.ctx);
	assert.equal(h.sent.length, 0, "still no loop started");
	assert.match(h.notifications.at(-1).message, /under \/pi_cc/);
});
