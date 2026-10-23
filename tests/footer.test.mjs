/**
 * The footer summary: one line shared with every other extension's status,
 * so it has to be short, plain text, and only repainted when it changes.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCron, makeHarness, start, startSelfPaced } from "./harness.mjs";

const statusFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// The helper's throwaway settings file. Tests that point elsewhere put this
// back: without it the settings file is the user's real one.
const isolatedConfig = process.env.PI_CC_CONFIG_FILE;
assert.ok(isolatedConfig, "the test helper points PI_CC_CONFIG_FILE at a temp file");

/** Park a job's next run a fixed time from now. */
function schedule(h, id, inMs) {
	h.scheduler().update(id, { nextFireAt: Date.now() + inMs });
	h.scheduler().tick();
}

test("the footer shows how many loops are armed and when the next one runs", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	schedule(h, h.scheduler().list()[0].id, 3 * 60_000 + 30_000);
	assert.equal(h.status("loop"), "loop 1 · next 4m");
});

test("the next run under a minute reads as <1m", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	schedule(h, h.scheduler().list()[0].id, 40_000);
	assert.equal(h.status("loop"), "loop 1 · next <1m");
});

test("several loops collapse into one count with the earliest run", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	await startSelfPaced(h, "watch ci", 1200); // a self-paced chain, armed by the model
	const fixed = h.scheduler().byKind("cron")[0];
	h.scheduler().update(fixed.id, { nextFireAt: Date.now() + 3 * 60_000 });
	h.scheduler().tick();
	assert.equal(h.scheduler().size, 2);
	assert.equal(h.status("loop"), "loop 2 · next 3m", "the earliest run wins");
});

test("the footer is repainted only when its text changes", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	const id = h.scheduler().list()[0].id;
	schedule(h, id, 3 * 60_000);
	const calls = h.statusCalls.length;
	assert.ok(calls > 0);
	h.scheduler().tick();
	h.scheduler().tick();
	assert.equal(h.statusCalls.length, calls, "an unchanged minute is not repainted");
	schedule(h, id, 7 * 60_000);
	assert.equal(h.statusCalls.length, calls + 1, "a new minute is");
	assert.equal(h.status("loop"), "loop 1 · next 7m");
});

test("no loops means no status line at all", async () => {
	const h = await start(makeHarness());
	h.scheduler().tick();
	assert.equal(h.statusCalls.length, 0, "an empty footer line would push the editor up");
});

test("stopping a loop clears the footer", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	schedule(h, h.scheduler().list()[0].id, 3 * 60_000);
	assert.ok(h.status("loop"));
	const id = h.scheduler().list()[0].id;
	await h.tools.get("cron_delete").execute("d", { id }, undefined, undefined, h.ctx);
	assert.equal(h.status("loop"), undefined);
	assert.deepEqual(h.statusCalls.at(-1), { key: "loop", text: undefined });
});

test("/pi_cc footer on|off turns the footer summary off for every pi-cc package", async () => {
	const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-footer-")), "pi-cc.json");
	process.env.PI_CC_CONFIG_FILE = configFile;
	try {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		schedule(h, h.scheduler().list()[0].id, 3 * 60_000);

		await h.commands.get("pi_cc").handler("footer off", h.ctx);
		assert.equal(h.status("loop"), undefined);
		assert.equal(statusFile(configFile).footer, false);
		assert.ok(h.busEvents.some((event) => event.channel === "pi-cc:config"), "the other packages are told");
		const calls = h.statusCalls.length;
		h.scheduler().tick();
		assert.equal(h.statusCalls.length, calls, "and nothing is repainted while it is off");

		await h.commands.get("pi_cc").handler("footer on", h.ctx);
		assert.equal(h.status("loop"), "loop 1 · next 3m");
		assert.equal(statusFile(configFile).footer, true);
	} finally {
		process.env.PI_CC_CONFIG_FILE = isolatedConfig;
	}
});

test("PI_CC_FOOTER=0 starts with the footer off", async () => {
	process.env.PI_CC_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-footer-")), "pi-cc.json");
	process.env.PI_CC_FOOTER = "0";
	try {
		const h = await start(makeHarness());
		await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
		schedule(h, h.scheduler().list()[0].id, 3 * 60_000);
		assert.equal(h.statusCalls.length, 0);
	} finally {
		delete process.env.PI_CC_FOOTER;
		process.env.PI_CC_CONFIG_FILE = isolatedConfig;
	}
});

test("a Pi without ctx.ui.setStatus is left alone", async () => {
	const h = makeHarness();
	delete h.ctx.ui.setStatus;
	await start(h);
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	h.scheduler().tick();
	assert.equal(h.notifications.filter((n) => n.level === "error").length, 0, "no error is raised");
});
