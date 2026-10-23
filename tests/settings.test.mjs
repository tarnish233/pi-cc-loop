/**
 * The shared settings file (pi-cc.json) and the /loop settings commands.
 *
 * The file belongs to the user: a command writes only the key it changes. An
 * environment override (PI_CC_FOOTER, PI_CC_COMPACT_MESSAGES) wins while it is
 * set but is never copied into the file, and the commands say when one is in
 * force. The file lives in Pi's agent directory, so PI_CODING_AGENT_DIR moves
 * it along with Pi's own settings.
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
