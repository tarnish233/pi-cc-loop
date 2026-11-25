import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { writeAtomic, cleanRuntimeTemps, TEMP_RETENTION_MS } = await loadModule("temp-files.ts");
const DAY = 86400000;
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-temp-policy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, file: path.join(dir, "scheduled_tasks.json") };
}
function deadPid() {
	const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 10000 });
	assert.ok(child.pid);
	assert.throws(() => process.kill(child.pid, 0), (e) => e.code === "ESRCH");
	return child.pid;
}
function owned(file, now, fields = {}) {
	const dir = fs.mkdtempSync(file + ".pi-cc-loop-tmp-");
	fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({
		schema: "pi-cc-loop.atomic", version: 1, kind: "atomic-write",
		target: path.resolve(file), pid: process.pid, hostname: os.hostname(),
		createdAt: now - 3 * DAY, closedAt: null, ...fields,
	}));
	fs.writeFileSync(path.join(dir, "value.tmp"), "temporary bytes");
	const old = new Date(now - 3 * DAY);
	for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), old, old);
	fs.utimesSync(dir, old, old);
	return dir;
}

test("atomic writes keep the target and leave no scratch directory", (t) => {
	const { dir, file } = fixture(t);
	fs.writeFileSync(file, "before");
	writeAtomic(file, "after\n");
	assert.equal(fs.readFileSync(file, "utf8"), "after\n");
	assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
	assert.equal(TEMP_RETENTION_MS, DAY);
});

test("rename failure preserves data and cleans its temporary directory", (t) => {
	const { dir, file } = fixture(t);
	fs.writeFileSync(file, "must survive");
	const original = fs.renameSync;
	try {
		fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error("rename denied"), { code: "EIO" }); return original(from, to); };
		assert.throws(() => writeAtomic(file, "new"), /rename denied/);
	} finally { fs.renameSync = original; }
	assert.equal(fs.readFileSync(file, "utf8"), "must survive");
	assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test("cleanup failure does not fail a successful save and marks the scratch directory closed", (t) => {
	const { dir, file } = fixture(t), original = fs.rmSync;
	try {
		fs.rmSync = (p, opts) => { if (String(p).includes(".pi-cc-loop-tmp-")) throw new Error("cleanup denied"); return original(p, opts); };
		assert.doesNotThrow(() => writeAtomic(file, "saved"));
	} finally { fs.rmSync = original; }
	assert.equal(fs.readFileSync(file, "utf8"), "saved");
	const leftover = fs.readdirSync(dir).find((p) => p.includes(".pi-cc-loop-tmp-"));
	assert.ok(leftover);
	assert.equal(typeof JSON.parse(fs.readFileSync(path.join(dir, leftover, "owner.json"), "utf8")).closedAt, "number");
	cleanRuntimeTemps([file], Date.now() + 2 * DAY);
	assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test("old verified-dead or closed scratch directories are removed, never the target", (t) => {
	const { file } = fixture(t), now = Date.now();
	fs.writeFileSync(file, "user tasks");
	const abandoned = owned(file, now, { pid: deadPid() });
	const closed = owned(file, now, { closedAt: now - 2 * DAY });
	cleanRuntimeTemps([file], now);
	assert.equal(fs.existsSync(abandoned), false);
	assert.equal(fs.existsSync(closed), false);
	assert.equal(fs.readFileSync(file, "utf8"), "user tasks");
});

test("live owners, uncertain probes, foreign hosts and recent writes stay protected", (t) => {
	const { file } = fixture(t), now = Date.now();
	const live = owned(file, now), foreign = owned(file, now, { hostname: "other-host", closedAt: now - 2 * DAY });
	const recent = owned(file, now, { pid: deadPid() });
	fs.writeFileSync(path.join(recent, "value.tmp"), "recent");
	cleanRuntimeTemps([file], now);
	for (const dir of [live, foreign, recent]) assert.ok(fs.existsSync(dir));
	const original = process.kill;
	try {
		for (const code of ["EPERM", "EINVAL"]) {
			process.kill = (pid, signal) => { if (pid === process.pid && signal === 0) throw Object.assign(new Error("uncertain"), { code }); return original(pid, signal); };
			cleanRuntimeTemps([file], now + 5 * DAY);
			assert.ok(fs.existsSync(live));
		}
	} finally { process.kill = original; }
});

test("unmarked legacy files, invalid markers and symlinks are not guessed to be garbage", (t) => {
	const { dir, file } = fixture(t), now = Date.now();
	const legacy = file + ".123.12345678-1234-1234-1234-123456789abc.tmp";
	fs.writeFileSync(legacy, "unknown old file");
	const wrong = owned(file, now, { target: path.join(dir, "another.json"), closedAt: now - 2 * DAY });
	const invalid = owned(file, now); fs.writeFileSync(path.join(invalid, "owner.json"), "{broken");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "loop-temp-victim-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, "keep"), "important");
	const link = file + ".pi-cc-loop-tmp-symlink"; fs.symlinkSync(outside, link);
	cleanRuntimeTemps([file], now + 5 * DAY);
	for (const p of [legacy, wrong, invalid, link]) assert.ok(fs.existsSync(p));
	assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "important");
});

test("scratch owned by a different OS user is retained even with a valid old marker", (t) => {
	if (typeof process.getuid !== "function") return t.skip("POSIX uid not available");
	const { file } = fixture(t), now = Date.now(), dir = owned(file, now, { closedAt: now - 2 * DAY });
	const original = fs.lstatSync;
	try {
		fs.lstatSync = (p, ...args) => { const stat = original(p, ...args); return p === dir ? new Proxy(stat, { get: (target, key) => key === "uid" ? target.uid + 1 : Reflect.get(target, key) }) : stat; };
		cleanRuntimeTemps([file], now);
	} finally { fs.lstatSync = original; }
	assert.ok(fs.existsSync(dir));
});

test("cleanup is read-only for missing locations and never traverses a symlinked parent", (t) => {
	const { dir, file } = fixture(t), now = Date.now();
	const missing = path.join(dir, "not-created", "config.json");
	cleanRuntimeTemps([missing], now);
	assert.equal(fs.existsSync(path.dirname(missing)), false);
	const target = path.join(dir, "actual"); fs.mkdirSync(target);
	const realFile = path.join(target, "scheduled_tasks.json");
	const scratch = owned(realFile, now, { closedAt: now - 2 * DAY });
	const link = path.join(dir, "linked"); fs.symlinkSync(target, link);
	cleanRuntimeTemps([path.join(link, "scheduled_tasks.json")], now);
	assert.ok(fs.existsSync(scratch));
});
