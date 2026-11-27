#!/usr/bin/env node
/**
 * Provider prompt-cache probe (online), or --dry-run contract validation (offline).
 * Online: fixed /loop -> cron tick -> chat -> cron tick -> stop -> observe
 * externally produced file/status events -> self-paced /loop -> wakeup tick.
 * Monitor never runs a business command. The driver writes its own probe data.
 *
 * node scripts/cache-check.mjs --dry-run       # no Pi, credentials or network
 * node scripts/cache-check.mjs                # real configured provider/quota
 * node scripts/cache-check.mjs --model provider/model --no-monitor
 * Online exit: 0 cached, 1 cache miss, 2 inconclusive. Offline 0 is NOT a cache hit.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createObservationProbe, verifyProbeFiles } from "./observation-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A scenario failure that says nothing about cache behaviour. */
class Inconclusive extends Error {}
function parseArgs(argv) {
	const options = { model: "opencode-go/beam-free", thinking: "low", loop: path.resolve(here, "..", "index.ts"), monitor: path.resolve(here, "..", "..", "pi-cc-monitor", "index.ts"), timeoutSeconds: 900, dryRun: false, help: false };
	let explicitMonitor = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => { const v = argv[++i]; if (!v || v.startsWith("--")) throw new Error(`Missing value for ${arg}`); return v; };
		if (arg === "--model") options.model = value();
		else if (arg === "--thinking") options.thinking = value();
		else if (arg === "--loop") options.loop = path.resolve(value());
		else if (arg === "--monitor") { options.monitor = path.resolve(value()); explicitMonitor = true; }
		else if (arg === "--no-monitor") options.monitor = null;
		else if (arg === "--timeout") options.timeoutSeconds = Number(value());
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown option ${arg}`);
	}
	if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("timeout must be a positive number of seconds");
	if (options.monitor && !fs.existsSync(options.monitor)) { if (explicitMonitor) throw new Error("explicit Monitor extension does not exist"); options.monitor = null; }
	return options;
}

function workspace() {
	const cwd = fs.mkdtempSync(path.join(process.env.PI_MONITOR_ARTIFACT_DIR || os.tmpdir(), "pi-cc-cache-check-"));
	const token = randomUUID();
	const owner = { schema: "pi-cc-loop.cache-probe", version: 1, pid: process.pid, hostname: os.hostname(), token, path: cwd };
	try { fs.writeFileSync(path.join(cwd, "owner.json"), JSON.stringify(owner), { mode: 0o600 }); } catch (error) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} throw error; }
	return { cwd, close() {
		const stat = fs.lstatSync(cwd), marker = JSON.parse(fs.readFileSync(path.join(cwd, "owner.json"), "utf8"));
		if (!stat.isDirectory() || stat.isSymbolicLink() || marker.schema !== owner.schema || marker.token !== token || marker.path !== cwd || marker.pid !== process.pid || marker.hostname !== os.hostname()) throw new Error("refusing to remove a workspace whose ownership changed");
		fs.rmSync(cwd, { recursive: true, force: true });
	} };
}
function groupAlive(child) {
	if (!child?.pid) return false;
	if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
	try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
async function stopChild(child) {
	if (!groupAlive(child)) return true;
	const send = signal => { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* confirmation below */ } };
	send("SIGTERM");
	let deadline = Date.now() + 5000;
	while (groupAlive(child) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
	if (!groupAlive(child)) return true;
	send("SIGKILL"); deadline = Date.now() + 1000;
	while (groupAlive(child) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
	return !groupAlive(child);
}

async function run(options, cwd) {
	const probe = options.monitor ? createObservationProbe(cwd) : undefined;
	if (options.dryRun) {
		if (probe) { const a = probe.line(1), b = probe.line(2); probe.complete(); const report = verifyProbeFiles(probe); if (fs.readFileSync(probe.stdout, "utf8") !== `${a}\n${b}\n`) throw new Error("invalid probe output"); console.log(JSON.stringify({ dryRun: true, cacheMeasured: false, noPiOrProviderStarted: true, observation: report })); }
		else console.log(JSON.stringify({ dryRun: true, cacheMeasured: false, noPiOrProviderStarted: true, monitor: false }));
		return 0;
	}
	const args = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", options.loop, ...(options.monitor ? ["-e", options.monitor] : []), "--model", options.model, "--thinking", options.thinking, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
	const child = spawn("pi", args, { cwd, env: { ...process.env, PI_LOOP_JITTER: "0" }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
	const events = [], requests = []; let label = "start", ticks = 0, launchError;
	child.on("error", error => { launchError = error; }); child.stdin.on("error", error => { launchError = error; });
	const lines = readline.createInterface({ input: child.stdout });
	lines.on("line", line => {
		let event; try { event = JSON.parse(line); } catch { return; } events.push(event);
		const message = event.message ?? {};
		if (event.type === "message_start" && message.role === "custom") {
			if (message.customType === "pi-cc-loop-tick" && message.details?.kind) label = message.details.kind === "cron" ? `cron tick ${++ticks}` : "self-paced tick";
			else if (message.customType === "Monitor") label = `monitor event (${message.details?.cause ?? "?"})`;
		}
		if (event.type === "message_end" && message.role === "assistant") { const u = message.usage ?? {}; requests.push({ label, input: u.input ?? 0, cached: u.cacheRead ?? 0, cost: u.cost?.total ?? 0, error: message.stopReason === "error" ? String(message.errorMessage ?? "error") : undefined }); }
	});
	const deadline = Date.now() + options.timeoutSeconds * 1000;
	async function waitFor(from, predicate, what, timeoutMs = 150000) {
		const until = Math.min(deadline, Date.now() + timeoutMs);
		for (let i = from; ; ) {
			for (; i < events.length; i++) if (predicate(events[i])) return i;
			if (launchError) throw new Inconclusive(`Pi subprocess failed: ${launchError.message}`);
			const failed = requests.find(request => request.error); if (failed) throw new Inconclusive(`model returned an error: ${failed.error}`);
			if (child.exitCode !== null || child.signalCode !== null) throw new Inconclusive("Pi subprocess ended before the scenario completed");
			if (Date.now() > until) throw new Inconclusive(`timed out waiting for ${what}`);
			await new Promise(r => setTimeout(r, 50));
		}
	}
	const settledAfter = (from, what) => waitFor(from, event => event.type === "agent_settled", `${what} to finish`);
	async function prompt(message, nextLabel) { const from = events.length; label = nextLabel; child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n"); return settledAfter(from, nextLabel); }
	const results = (from, name) => events.slice(from).filter(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolName === name);
	async function tick(kind, from) { const at = await waitFor(from, e => e.type === "message_start" && e.message?.customType === "pi-cc-loop-tick" && e.message.details?.kind === kind, `${kind} tick`); return settledAfter(at, `${kind} tick`); }
	async function observation() {
		const from = events.length; await prompt(probe.prompt, "Monitor observation request");
		const result = results(from, "Monitor").find(e => !e.message.isError && e.message.details?.kind === "job" && e.message.details?.job?.runId === probe.runId);
		if (!result) throw new Inconclusive("model did not attach to the existing job source");
		const id = result.message.details.taskId;
		for (const number of [1, 2]) {
			const mark = events.length, marker = probe.line(number);
			const at = await waitFor(mark, e => e.type === "message_start" && e.message?.customType === "Monitor" && e.message.details?.monitorId === id && e.message.details?.cause === "output" && e.message.details?.lines?.includes(marker), `observed line ${number}`);
			await settledAfter(at, `observed line ${number}`);
		}
		const mark = events.length; probe.complete();
		const at = await waitFor(mark, e => e.type === "message_start" && e.message?.customType === "Monitor" && e.message.details?.monitorId === id && e.message.details?.cause === "job" && e.message.details?.job?.runId === probe.runId && e.message.details?.job?.state === "succeeded", "external probe terminal report");
		await settledAfter(at, "external probe terminal report"); verifyProbeFiles(probe);
	}
	async function scenario() {
		let mark = events.length;
		await prompt("/loop 1m 只回复一个词 hi，不要调用任何工具", "/loop request (cron)");
		if (!results(mark, "cron_create").some(e => !e.message.isError)) throw new Inconclusive("model did not create the cron job");
		mark = await tick("cron", mark);
		mark = await prompt("用一句话回答：1+1 等于几？不要调用任何工具。", "plain chat");
		mark = await tick("cron", mark);
		await prompt("/loop stop", "/loop stop");
		if (probe) await observation();
		mark = events.length;
		await prompt("/loop 只回复一个词 hi，然后调用 schedule_wakeup，delaySeconds 用 60（自定步调，不要用 cron）", "/loop request (self-paced)");
		if (!results(mark, "schedule_wakeup").some(e => !e.message.isError)) throw new Inconclusive("model did not schedule a wakeup");
		await tick("wakeup", mark);
	}
	/**
	 * Report the cache read of each request against the previous request's total.
	 * A provider can drop its cache on its own, so repeatable misses are the signal.
	 */
	function report() {
		let misses = 0;
		let previous;
		for (const request of requests) {
			const total = request.input + request.cached;
			const expected = previous === undefined ? 0 : previous - Math.max(256, Math.round(previous * 0.1));
			const verdict = previous === undefined ? "warm-up" : request.cached >= expected ? "ok" : "MISS";
			if (verdict === "MISS") misses++;
			console.log(`${request.label}: input ${request.input}, cached ${request.cached}, ${verdict}`);
			previous = total;
		}
		const cost = requests.reduce((total, request) => total + request.cost, 0).toFixed(4);
		console.log(`model ${options.model} · ${requests.length} requests · reported cost $${cost}`);
		return misses;
	}
	let code = 0;
	let failure;
	try {
		await scenario();
		if (!requests.some(r => r.cached > 0)) throw new Inconclusive("model reports no cache reads");
		const misses = report();
		console.log(misses ? `${misses} cache miss(es); repeatable misses require investigation` : "all measured requests cached");
		code = misses ? 1 : 0;
	} catch (error) {
		if (requests.length) report();
		failure = error;
		console.log(`inconclusive: ${error.message ?? error}`);
		code = 2;
	} finally {
		lines.close();
		// A cleanup failure must not replace the scenario's own diagnosis.
		if (!await stopChild(child)) {
			const message = "probe Pi cleanup is unconfirmed; keep the owned workspace for inspection";
			throw new Error(message + (failure ? ` (after: ${failure.message ?? failure})` : ""));
		}
	}
	return code;
}

let owned;
let code = 2;
try {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); code = 0; }
	else { owned = workspace(); code = await run(options, owned.cwd); owned.close(); owned = undefined; }
} catch (error) { code = 2; console.error(error.message ?? error); }
process.exitCode = code;
