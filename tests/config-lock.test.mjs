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

test("an unreadable settings file is never rewritten: the save rejects and every byte survives", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-config-lock-"));
	const file = path.join(dir, "pi-cc.json");
	const previous = process.env.PI_CC_CONFIG_FILE;
	const bytes = `${JSON.stringify({ footer: true, draft: false, futureSetting: "must survive" }, null, 2)}\n`;
	fs.writeFileSync(file, bytes);
	fs.chmodSync(file, 0o200);
	try {
		let code;
		try { fs.readFileSync(file, "utf8"); } catch (error) { code = error.code; }
		if (code !== "EACCES") return t.skip("file permissions do not restrict this user");
		process.env.PI_CC_CONFIG_FILE = file;
		config.invalidateConfig();
		assert.throws(() => config.saveConfig({ footer: false }), (error) => error.code === "EACCES");
		fs.chmodSync(file, 0o600);
		assert.equal(fs.readFileSync(file, "utf8"), bytes, "unknown keys and the user's choices survive");
		assert.equal(fs.existsSync(`${file}.write.lock`), false, "the lock is cleaned on rejection");
	} finally {
		fs.chmodSync(file, 0o600);
		if (previous === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = previous;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("missing and malformed files still fall back to a fresh write", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-config-lock-"));
	const file = path.join(dir, "pi-cc.json");
	const previous = process.env.PI_CC_CONFIG_FILE;
	try {
		process.env.PI_CC_CONFIG_FILE = file;
		config.invalidateConfig();
		config.saveConfig({ footer: false });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { footer: false }, "a missing file is created");
		fs.writeFileSync(file, "{broken");
		config.invalidateConfig();
		config.saveConfig({ draft: false });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { draft: false }, "malformed JSON is rebuilt, as before");
		assert.equal(fs.existsSync(`${file}.write.lock`), false);
	} finally {
		if (previous === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = previous;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
