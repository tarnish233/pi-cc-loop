import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const config = await loadModule("config.ts");

test("an incomplete lock left by a crashed writer is recovered", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-config-lock-"));
	const file = path.join(dir, "pi-cc.json");
	const lock = `${file}.write.lock`;
	const previous = process.env.PI_CC_CONFIG_FILE;
	fs.writeFileSync(lock, "{crashed");
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lock, old, old);
	try {
		process.env.PI_CC_CONFIG_FILE = file;
		config.saveConfig({ footer: false });
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).footer, false);
		assert.equal(fs.existsSync(lock), false);
	} finally {
		if (previous === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = previous;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("two Pi processes changing different settings retain both changes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-config-lock-"));
	const file = path.join(dir, "pi-cc.json");
	const ready = path.join(dir, "writer-ready");
	const previous = process.env.PI_CC_CONFIG_FILE;
	fs.writeFileSync(file, JSON.stringify({ draft: true, footer: true }));
	const script = `const fs=require('node:fs'),os=require('node:os');
		const [file,ready]=process.argv.slice(1),lock=file+'.write.lock';
		fs.writeFileSync(lock,JSON.stringify({pid:process.pid,hostname:os.hostname()}));
		fs.writeFileSync(ready,'ready');
		setTimeout(()=>{fs.writeFileSync(file,JSON.stringify({draft:true,footer:false}));fs.unlinkSync(lock)},250);`;
	const child = spawn(process.execPath, ["-e", script, file, ready], { stdio: "ignore" });
	try {
		const until = Date.now() + 3000;
		while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		assert.ok(fs.existsSync(ready), "the other process holds the writer lock");
		process.env.PI_CC_CONFIG_FILE = file;
		config.invalidateConfig();
		config.saveConfig({ draft: false });
		await new Promise((resolve) => child.once("exit", resolve));
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { draft: false, footer: false });
	} finally {
		if (child.exitCode === null) child.kill();
		if (previous === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = previous;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
