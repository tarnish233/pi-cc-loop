import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionDir, loadModuleFrom, siblingExtensionDir } from "./helpers.mjs";

const PACKAGES = [
	["pi-cc-loop", "loop_settings", "Loop"],
	["pi-cc-monitor", "monitor_settings", "Monitor"],
	["pi-cc-plugins", "plugins_settings", "Plugins"],
	["pi-cc-compaction", "compaction_settings", "Compaction"],
];
const available = PACKAGES.every(([repo]) => fs.existsSync(path.join(siblingExtensionDir(repo), "package.json")));
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_CC_CONFIG_FILE", "PI_CC_COMPACT_MESSAGES", "PI_CC_FOOTER", "PI_CC_DRAFT", "PI_CC_TURN_SUMMARY", "PI_CC_KEYS", "PI_CC_COMPACTION", "PI_CC_IDLE_COMPACTION", "PI_MONITOR_LOG_RETENTION_DAYS", "PI_MONITOR_LOG_MAX_MIB", "PI_MONITOR_LOG_BUDGET_MIB"];

for (const reverse of [false, true]) {
	test("four independent settings commands coexist in " + (reverse ? "reverse" : "forward") + " load order", { skip: !available && "sibling checkouts not found" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-isolation-"));
		const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		const modules = [];
		try {
			for (const key of ENV_KEYS) delete process.env[key];
			process.env.PI_CODING_AGENT_DIR = dir;
			const legacy = path.join(dir, "pi-cc.json");
			const old = JSON.stringify({ compactMessages: false, footer: false, draft: true, turnSummary: false, ccKeys: true, compaction: false, idleCompaction: true, futureSetting: "kept" });
			fs.writeFileSync(legacy, old);
			const commands = new Map(), changes = [];
			const pi = {
				registerCommand(name, command) {
					assert.ok(!commands.has(name), "a second package must not claim " + name);
					commands.set(name, command);
				},
				events: { emit(channel, data) { changes.push({ channel, data }); } },
			};
			const order = reverse ? [...PACKAGES].reverse() : PACKAGES;
			for (const [repo, command, title] of order) {
				const root = repo === "pi-cc-loop" ? extensionDir : siblingExtensionDir(repo);
				const config = await loadModuleFrom(root, "config.ts");
				config.invalidateConfig();
				const settings = await loadModuleFrom(root, "settings.ts");
				modules.push({ repo, command, title, config });
				settings.registerSettingsCommand(pi);
			}
			assert.deepEqual([...commands.keys()].sort(), PACKAGES.map(([, command]) => command).sort());
			assert.ok(!commands.has("pi_cc"));
			assert.deepEqual(changes, [], "registration needs no settings discovery bus");
			const ctx = { mode: "rpc", hasUI: true, ui: { notify() {} } };
			const get = (repo) => modules.find((module) => module.repo === repo).config;
			const loop = get("pi-cc-loop"), monitor = get("pi-cc-monitor");
			assert.equal(loop.loadConfig().footer, false);
			assert.equal(monitor.loadConfig().footer, false);
			await commands.get("loop_settings").handler("footer on", ctx);
			monitor.invalidateConfig();
			assert.equal(loop.loadConfig().footer, true);
			assert.equal(monitor.loadConfig().footer, false, "Loop's footer does not change Monitor's footer");
			await commands.get("monitor_settings").handler("messages on", ctx);
			loop.invalidateConfig();
			assert.equal(monitor.loadConfig().compactMessages, true);
			assert.equal(loop.loadConfig().compactMessages, false, "Monitor's style does not change Loop's style");
			const loopBefore = fs.readFileSync(loop.configPath(), "utf8");
			await commands.get("monitor_settings").handler("logs 5", ctx);
			assert.equal(monitor.loadConfig().logMaxMiB, 5);
			assert.equal(fs.readFileSync(loop.configPath(), "utf8"), loopBefore, "Monitor log policy never changes Loop settings");
			assert.ok(!("logMaxMiB" in loop.DEFAULT_CONFIG));
			await commands.get("plugins_settings").handler("summary on", ctx);
			await commands.get("compaction_settings").handler("idle off", ctx);
			assert.deepEqual(changes.map(({ channel }) => channel), ["pi-cc-loop:config", "pi-cc-monitor:config", "pi-cc-monitor:config", "pi-cc-plugins:config", "pi-cc-compaction:config"]);
			assert.equal(fs.readFileSync(legacy, "utf8"), old, "all four packages leave the shared legacy file untouched");
			for (const { repo, command, title, config } of modules) {
				const file = path.join(dir, repo + ".json");
				assert.equal(config.configPath(), file);
				const saved = JSON.parse(fs.readFileSync(file, "utf8"));
				assert.ok(Object.keys(saved).every((field) => field in config.DEFAULT_CONFIG), "migration copies no foreign fields into " + repo);
				assert.ok(!("futureSetting" in saved));
				const before = fs.readFileSync(file, "utf8");
				let panel;
				const tuiCtx = { mode: "tui", hasUI: true, ui: { notify() {}, custom(factory) {
					return new Promise((resolve) => { panel = factory({ requestRender() {} }, { fg: (_role, text) => text, bold: (text) => text }, {}, resolve); });
				} } };
				const closed = commands.get(command).handler("", tuiCtx);
				assert.ok(panel.render(120)[1].startsWith(title), "each command opens its own page");
				assert.ok(!panel.render(120).join("\n").includes("Tab/Shift+Tab"));
				panel.handleInput("\x1b");
				await closed;
				assert.equal(fs.readFileSync(file, "utf8"), before, "opening a panel does not rewrite settings");
			}
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			for (const { config } of modules) config.invalidateConfig();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}
