/** Controlled external data producer for cache probes. No runner, process or model calls. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function atomicJson(file, value) {
	const stage = file + ".tmp-" + randomUUID();
	try {
		fs.writeFileSync(stage, JSON.stringify(value) + "\n", { mode: 0o600 });
		fs.renameSync(stage, file);
	} finally { try { fs.rmSync(stage, { force: true }); } catch { /* exact owned staging file only */ } }
}

export function createObservationProbe(cwd) {
	const root = path.join(cwd, "observation-probe");
	fs.mkdirSync(root, { mode: 0o700 });
	const jobId = "cache-probe-" + randomUUID(), runId = randomUUID(), createdAt = Date.now();
	const stdout = path.join(root, "stdout.log"), stderr = path.join(root, "stderr.log"), statusPath = path.join(root, "status.json"), manifestPath = path.join(root, "job.json");
	fs.writeFileSync(stdout, "", { mode: 0o600 }); fs.writeFileSync(stderr, "", { mode: 0o600 });
	const manifest = { schema: "pi-cc-job", version: 1, jobId, runId, createdAt, runner: { name: "probe-producer", id: jobId }, stdout: "stdout.log", stderr: "stderr.log", status: "status.json" };
	atomicJson(manifestPath, manifest);
	const status = (state, exitCode) => {
		const now = Math.max(createdAt, Date.now());
		const value = { schema: "pi-cc-job.status", version: 1, jobId, runId, state, startedAt: createdAt, updatedAt: now,
			...(exitCode !== undefined ? { endedAt: now, exitCode } : {}) };
		atomicJson(statusPath, value); return value;
	};
	status("running");
	const source = Object.freeze({ kind: "job", manifest: manifestPath });
	return { root, jobId, runId, manifestPath, statusPath, stdout, stderr, source,
		line(number) { const marker = `cache-probe-line-${number}`; fs.appendFileSync(stdout, marker + "\n"); return marker; },
		complete() { return status("succeeded", 0); },
		prompt: `Use Monitor only to observe the existing external data source ${JSON.stringify(source)}, with mode "events", description "cache probe", and notify.output "turn". The producer is already managed outside Pi. Do not start any command, runner, replacement job or task. After each output event reply only "received". After the terminal job report acknowledge the verified fixture result briefly.`,
	};
}

export function verifyProbeFiles(probe) {
	const manifest = JSON.parse(fs.readFileSync(probe.manifestPath, "utf8"));
	const status = JSON.parse(fs.readFileSync(probe.statusPath, "utf8"));
	if (manifest.schema !== "pi-cc-job" || manifest.version !== 1 || status.schema !== "pi-cc-job.status" || status.version !== 1 || manifest.jobId !== status.jobId || manifest.runId !== status.runId) throw new Error("invalid observation probe contract");
	if ("command" in manifest || "pid" in manifest) throw new Error("probe metadata must not contain execution/control fields");
	if (status.state === "succeeded" && (status.exitCode !== 0 || !Number.isSafeInteger(status.endedAt))) throw new Error("invalid probe terminal result");
	return { jobId: manifest.jobId, runId: manifest.runId, state: status.state };
}
