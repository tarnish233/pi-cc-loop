import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeHarness, start, createCron } from "./harness.mjs";
import { loadModule } from "./helpers.mjs";
const config = await loadModule("config.ts");
const DAY = 86400000;
function closedScratch(file, now) {
	const dir = fs.mkdtempSync(file + ".pi-cc-loop-tmp-");
	fs.writeFileSync(path.join(dir,"owner.json"), JSON.stringify({schema:"pi-cc-loop.atomic",version:1,kind:"atomic-write",target:path.resolve(file),pid:process.pid,hostname:os.hostname(),createdAt:now-3*DAY,closedAt:now-2*DAY}));
	fs.writeFileSync(path.join(dir,"value.tmp"),"obsolete scratch");
	const date = new Date(now-2*DAY);
	for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir,name),date,date);
	fs.utimesSync(dir,date,date); return dir;
}

test("session startup reclaims only owned scratch, not settings, durable data or ordinary jobs", async () => {
	const beforeCwd = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(),"loop-cleanup-lifecycle-"));
	const old = process.env.PI_CC_CONFIG_FILE; let h;
	try {
		const file = path.join(dir,"loop-settings.json");
		process.env.PI_CC_CONFIG_FILE = file; fs.writeFileSync(file,'{"footer":false}'); config.invalidateConfig();
		fs.mkdirSync(path.join(dir,"project"));
		h = makeHarness(path.join(dir,"project"));
		const piDir = path.join(h.ctx.cwd,".pi"); fs.mkdirSync(piDir);
		const tasks = path.join(piDir,"scheduled_tasks.json"), loopFile = path.join(piDir,"loop.md");
		const data = JSON.stringify({version:1,jobs:[]}); fs.writeFileSync(tasks,data); fs.writeFileSync(loopFile,"user task list");
		const a = closedScratch(process.env.PI_CC_CONFIG_FILE,Date.now()), b = closedScratch(tasks,Date.now());
		await start(h);
		assert.equal(fs.existsSync(a),false); assert.equal(fs.existsSync(b),false);
		assert.equal(fs.readFileSync(tasks,"utf8"),data); assert.equal(fs.readFileSync(loopFile,"utf8"),"user task list");
		assert.equal(fs.readFileSync(process.env.PI_CC_CONFIG_FILE,"utf8"),'{"footer":false}');
		const job = await createCron(h,{cron:"* * * * *",prompt:"keep this schedule",recurring:true});
		assert.ok(h.scheduler().get(job.id));
	} finally {
		if (h) await h.handlers.get("session_shutdown")({},h.ctx);
		process.chdir(beforeCwd);
		if (old === undefined) delete process.env.PI_CC_CONFIG_FILE; else process.env.PI_CC_CONFIG_FILE=old;
		config.invalidateConfig(); fs.rmSync(dir,{recursive:true,force:true});
	}
});

test("cleanup timers are unref'd, replaced on another session_start and cancelled on shutdown", async () => {
	const set = globalThis.setInterval, clear = globalThis.clearInterval;
	const timers=[], cleared=new Set(); let h;
	try {
		globalThis.setInterval=(fn,ms,...args)=>{const timer=set(fn,ms,...args);if(ms===30*60*1000)timers.push(timer);return timer;};
		globalThis.clearInterval=(timer)=>{cleared.add(timer);return clear(timer);};
		h=await start(makeHarness());
		assert.equal(timers.length,1); assert.equal(timers[0].hasRef(),false);
		await h.handlers.get("session_start")({reason:"reload"},h.ctx);
		assert.equal(timers.length,2); assert.ok(cleared.has(timers[0]));
		await h.handlers.get("session_shutdown")({},h.ctx); h=undefined;
		assert.ok(cleared.has(timers[1]));
	} finally {
		if(h)await h.handlers.get("session_shutdown")({},h.ctx);
		globalThis.setInterval=set; globalThis.clearInterval=clear;
	}
});
