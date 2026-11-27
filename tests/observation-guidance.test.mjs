/** New runner/observation guidance and offline cache-probe contract, never an online model. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createObservationProbe, verifyProbeFiles } from "../scripts/observation-probe.mjs";
import { loadModule, loadModuleFrom, siblingExtensionDir } from "./helpers.mjs";
const prompts = await loadModule("prompts.ts");
// The sibling checkout exists in the monorepo, not in a standalone Loop package.
const protocol = fs.existsSync(path.join(siblingExtensionDir("pi-cc-monitor"), "job-protocol.ts"))
	? await loadModuleFrom(siblingExtensionDir("pi-cc-monitor"), "job-protocol.ts")
	: undefined;
const needsSibling = { skip: !protocol && "pi-cc-monitor checkout not found" };
const script = fileURLToPath(new URL("../scripts/cache-check.mjs", import.meta.url));

function workspace(t) { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observation-guidance-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); return cwd; }
test("Loop instructions distinguish schedules/observations from business jobs and never resubmit implicitly", () => {
	const hint = prompts.monitorGuidelines("observe the existing run");
	assert.match(hint, /existing file\/job\/WebSocket/); assert.match(hint, /native external runner/); assert.match(hint, /original jobId\/runId/); assert.match(hint, /not a job result/);
	const start = prompts.loopCommandGuidelines("watch training", { monitorAvailable: true }); assert.match(start, /external runner, not Monitor/); assert.match(start, /not cancel or resubmit/);
	const stop = prompts.loopCommandGuidelines("stop"); assert.match(stop, /not independent business jobs/); assert.match(stop, /only when the user explicitly asks/);
	assert.match(prompts.CRON_DELETE_DESCRIPTION, /does not cancel independent/);
	assert.match(prompts.CRON_DELETE_DESCRIPTION, /Ending a self-paced loop also stops its bound observations/);
});
test("the probe produces valid same-run status and two file events without execution fields", needsSibling, t => {
	const cwd = workspace(t), probe = createObservationProbe(cwd);
	const manifest = protocol.parseJobManifest(fs.readFileSync(probe.manifestPath, "utf8"), probe.manifestPath);
	assert.equal(protocol.parseJobStatus(fs.readFileSync(probe.statusPath, "utf8"), manifest).state, "running");
	assert.match(probe.prompt, /Use Monitor only to observe/); assert.match(probe.prompt, /notify.output "turn"/); assert.match(probe.prompt, /Do not start any command/);
	const a = probe.line(1), b = probe.line(2); probe.complete();
	assert.equal(protocol.parseJobStatus(fs.readFileSync(probe.statusPath, "utf8"), manifest).state, "succeeded"); assert.equal(fs.readFileSync(probe.stdout, "utf8"), `${a}\n${b}\n`);
	assert.equal(verifyProbeFiles(probe).runId, probe.runId); assert.equal("command" in manifest, false); assert.equal(fs.readdirSync(probe.root).some(name => name.includes(".tmp-")), false);
});
test("dry-run starts no Pi/provider and cleans its exact owned workspace", t => {
	const cwd = workspace(t), bin = path.join(cwd, "bin"), agent = path.join(cwd, "empty-agent"), marker = path.join(cwd, "PI-MUST-NOT-START"); fs.mkdirSync(bin); fs.mkdirSync(agent);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\ntouch '${marker}'\nexit 77\n`, { mode: 0o700 });
	const before = fs.readdirSync(cwd).sort(); const r = spawnSync(process.execPath, [script, "--dry-run", "--model", "fixture/not-a-provider"], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_MONITOR_ARTIFACT_DIR: cwd }, encoding: "utf8", timeout: 10000 });
	assert.equal(r.status, 0, r.stderr); const report = JSON.parse(r.stdout); assert.equal(report.noPiOrProviderStarted, true); assert.equal(report.cacheMeasured, false);
	// Without a Monitor checkout the probe is skipped, so no observation is reported.
	if (protocol) assert.equal(report.observation.state, "succeeded"); else assert.equal(report.monitor, false);
	assert.equal(fs.existsSync(marker), false); assert.deepEqual(fs.readdirSync(cwd).sort(), before);
});
test("invalid probe arguments fail before allocating work or starting Pi", t => {
	const cwd = workspace(t); for (const args of [["--model"], ["--timeout", "NaN"], ["--monitor", path.join(cwd, "missing.ts")]]) {
		const r = spawnSync(process.execPath, [script, ...args, "--dry-run"], { env: { ...process.env, PI_MONITOR_ARTIFACT_DIR: cwd }, encoding: "utf8", timeout: 10000 }); assert.equal(r.status, 2); assert.deepEqual(fs.readdirSync(cwd), []);
	}
});
