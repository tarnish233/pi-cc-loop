/**
 * The shared settings file (pi-cc.json) and the /loop settings commands.
 *
 * The file belongs to the user: a command writes only the key it changes. An
 * environment override (PI_CC_FOOTER, PI_CC_COMPACT_MESSAGES) wins while it is
 * set but is never copied into the file, and the commands say when one is in
 * force. The file lives in Pi's agent directory, so PI_CODING_AGENT_DIR moves
 * it along with Pi's own settings.
 *
 * In the TUI, a bare /loop settings opens a panel like Pi's own /settings (an
 * extension cannot add items to that one): the same SettingsList, where
 * Enter/Space changes the selected setting and saves it at once, and Esc
 * closes. Elsewhere it prints the summary.
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

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const ESC = "\x1b";

/** Run /loop settings with a TUI that hands out the panel the way ctx.ui.custom does. */
function openPanel(h) {
	let panel;
	let renders = 0;
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	h.ctx.ui.custom = (factory) =>
		new Promise((resolve) => {
			panel = factory({ requestRender: () => renders++ }, theme, {}, resolve);
		});
	const closed = loop(h).handler("settings", h.ctx);
	assert.ok(panel, "the panel opened");
	return { panel, closed, screen: () => panel.render(100).join("\n"), renders: () => renders };
}

test("a setting writes only its own key: other keys stay, an environment override never reaches the file", async () => {
	const file = tempConfig({ compactMessages: true, footer: true, mine: "kept" });
	await withEnv({ PI_CC_CONFIG_FILE: file, PI_CC_COMPACT_MESSAGES: "0" }, async () => {
		const h = await start(makeHarness());
		await loop(h).handler("settings footer off", h.ctx);
		assert.deepEqual(readJson(file), { compactMessages: true, footer: false, mine: "kept" });
	});
});

test("under PI_CC_FOOTER=0, footer on is saved for later but the variable still wins, and the commands say so", async () => {
	const file = tempConfig({ footer: false });
	await withEnv({ PI_CC_CONFIG_FILE: file, PI_CC_FOOTER: "0" }, async () => {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		await loop(h).handler("settings footer on", h.ctx);
		assert.equal(readJson(file).footer, true, "the file keeps the user's choice");
		assert.equal(config.loadConfig().footer, false, "the variable wins while it is set");
		assert.equal(h.status("loop"), undefined, "so the footer stays hidden, as it does in pi-cc-monitor");
		const notice = h.notifications.at(-1);
		assert.equal(notice.level, "warning");
		assert.match(notice.message, /PI_CC_FOOTER=0/);

		await loop(h).handler("settings", h.ctx);
		assert.match(h.notifications.at(-1).message, /footer: +hidden \(PI_CC_FOOTER=0\)/);
		await loop(h).handler("footer", h.ctx);
		assert.match(h.notifications.at(-1).message, /currently off \(PI_CC_FOOTER=0\)/);
	});
});

test("in the TUI, /loop settings opens a panel like Pi's /settings: Enter/Space changes and saves at once, Esc closes", async () => {
	const file = tempConfig({ compactMessages: true, footer: true });
	await withEnv({ PI_CC_CONFIG_FILE: file }, async () => {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		const ui = openPanel(h);
		assert.match(ui.screen(), /pi-cc settings/);
		assert.match(ui.screen(), /→ Message style +compact/);
		assert.match(ui.screen(), /\n {2}Footer summary +on/);
		assert.match(ui.screen(), /Enter\/Space to change · Esc to cancel/);

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

test("outside the TUI, /loop settings prints the summary as before", async () => {
	await withEnv({}, async () => {
		const h = await start(makeHarness());
		h.ctx.mode = "rpc";
		let opened = false;
		h.ctx.ui.custom = async () => {
			opened = true;
		};
		await loop(h).handler("settings", h.ctx);
		assert.equal(opened, false);
		assert.match(h.notifications.at(-1).message, /pi-cc settings/);
	});
});

test("the settings file lives in Pi's agent directory, so PI_CODING_AGENT_DIR moves it with Pi's own settings", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-agent-"));
	await withEnv({ PI_CC_CONFIG_FILE: undefined, PI_CODING_AGENT_DIR: agentDir }, async () => {
		// Checked before anything is written: a wrong path would be the user's real file.
		assert.equal(config.configPath(), path.join(agentDir, "pi-cc.json"));
		const h = await start(makeHarness());
		await loop(h).handler("settings footer off", h.ctx);
		assert.deepEqual(readJson(path.join(agentDir, "pi-cc.json")), { footer: false });
	});
});
