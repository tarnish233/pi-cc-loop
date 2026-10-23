#!/usr/bin/env node
/**
 * Prompt-cache check against a real provider, for use before a release.
 *
 * Drives Pi in RPC mode through every path where pi-cc-loop or pi-cc-monitor
 * adds something to a conversation, and reports how much of each request was
 * read from the provider's prompt cache:
 *
 *   /loop request (fixed interval) -> cron tick -> plain chat -> cron tick
 *   -> /loop stop -> Monitor events -> /loop request (self-paced) -> wakeup tick
 *
 * A request should read at least what the previous request sent; reading much
 * less means something before the end of the transcript changed (the system
 * prompt, the tools, an earlier message). The tick after the chat is the case
 * that broke before 5f833de.
 *
 * Defaults to a free model, so a run costs nothing:
 *
 *   node scripts/cache-check.mjs
 *   node scripts/cache-check.mjs --model opencode-go/beam-free --thinking low
 *   node scripts/cache-check.mjs --loop /path/to/index.ts --no-monitor
 *
 * Exit code: 0 all requests cached, 1 a cache miss, 2 inconclusive (the model
 * did not follow the script, an error, a timeout). Provider-side misses happen;
 * a miss that repeats at the same step on a re-run is ours.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const options = {
		model: "opencode-go/beam-free",
		thinking: "low",
		loop: path.resolve(here, "..", "index.ts"),
		monitor: path.resolve(here, "..", "..", "pi-cc-monitor", "index.ts"),
		timeoutSeconds: 900,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => argv[++i];
		if (arg === "--model") options.model = value();
		else if (arg === "--thinking") options.thinking = value();
		else if (arg === "--loop") options.loop = path.resolve(value());
		else if (arg === "--monitor") options.monitor = path.resolve(value());
		else if (arg === "--no-monitor") options.monitor = null;
		else if (arg === "--timeout") options.timeoutSeconds = Number(value());
		else if (arg === "--help" || arg === "-h") {
			console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
			process.exit(0);
		} else throw new Error(`Unknown option ${arg}`);
	}
	if (options.monitor && !fs.existsSync(options.monitor)) options.monitor = null;
	return options;
}

const options = parseArgs(process.argv.slice(2));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-cache-check-"));
const piArgs = [
	"--mode", "rpc", "--no-session", "--no-extensions",
	"-e", options.loop,
	...(options.monitor ? ["-e", options.monitor] : []),
	"--model", options.model, "--thinking", options.thinking,
	"--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
];
// Exact cron minutes, so a tick lands at the next minute instead of up to half a minute later.
const child = spawn("pi", piArgs, { cwd, env: { ...process.env, PI_LOOP_JITTER: "0" }, stdio: ["pipe", "pipe", "ignore"] });

const events = [];
const requests = [];
let label = "start";
let ticks = 0;

readline.createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	events.push(event);
	const message = event.message ?? {};
	// Label each request by what started its run.
	if (event.type === "message_start" && message.role === "custom") {
		if (message.customType === "pi-cc-loop-tick" && message.details?.kind) {
			label = message.details.kind === "cron" ? `cron tick ${++ticks}` : "self-paced tick";
		} else if (message.customType === "Monitor") {
			label = `monitor event (${message.details?.cause ?? "?"})`;
		}
	}
	if (event.type === "message_end" && message.role === "assistant") {
		const usage = message.usage ?? {};
		requests.push({
			label,
			input: usage.input ?? 0,
			cached: usage.cacheRead ?? 0,
			cost: usage.cost?.total ?? 0,
			error: message.stopReason === "error" ? String(message.errorMessage ?? "error") : undefined,
		});
	}
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + options.timeoutSeconds * 1000;

class Inconclusive extends Error {}

/** Wait for an event after `from` that matches; returns its index. */
async function waitFor(from, predicate, what, timeoutMs = 150_000) {
	const until = Math.min(deadline, Date.now() + timeoutMs);
	for (let i = from; ; ) {
		for (; i < events.length; i++) if (predicate(events[i])) return i;
		const failed = requests.find((request) => request.error);
		if (failed) throw new Inconclusive(`the model returned an error: ${failed.error}`);
		if (Date.now() > until) throw new Inconclusive(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const settledAfter = (from, what) => waitFor(from, (event) => event.type === "agent_settled", `${what} to finish`);

/** Send a prompt and wait for the run (and anything it queued) to settle. */
async function prompt(text, nextLabel) {
	const from = events.length;
	label = nextLabel;
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: text })}\n`);
	return settledAfter(from, nextLabel);
}

function toolResults(from, name) {
	return events
		.slice(from)
		.filter((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === name)
		.map((event) => ({ error: event.message.isError === true, text: JSON.stringify(event.message.content) }));
}

async function tick(kind, from) {
	const at = await waitFor(
		from,
		(event) => event.type === "message_start" && event.message?.customType === "pi-cc-loop-tick" && event.message.details?.kind === kind,
		`a ${kind} tick`,
	);
	return settledAfter(at, `the ${kind} tick`);
}

async function scenario() {
	let mark = events.length;
	await prompt("/loop 1m 只回复一个词 hi，不要调用任何工具", "/loop request (cron)");
	if (!toolResults(mark, "cron_create").some((result) => !result.error)) {
		throw new Inconclusive("the model did not create the cron job");
	}
	mark = await tick("cron", mark);
	mark = await prompt("用一句话回答：1+1 等于几？不要调用任何工具。", "plain chat");
	mark = await tick("cron", mark);
	mark = await prompt("/loop stop", "/loop stop");

	if (options.monitor) {
		const from = events.length;
		await prompt(
			"用 Monitor 工具运行命令 `for i in 1 2; do echo line$i; sleep 3; done`，description 写 demo。之后每收到一个事件只回复「收到」。",
			"Monitor request",
		);
		const exit = await waitFor(
			from,
			(event) => event.type === "message_start" && event.message?.customType === "Monitor" && event.message.details?.cause === "exit",
			"the monitor to end",
		);
		await settledAfter(exit, "the monitor exit event");
	}

	mark = events.length;
	await prompt(
		"/loop 只回复一个词 hi，然后调用 schedule_wakeup，delaySeconds 用 60（自定步调，不要用 cron）",
		"/loop request (self-paced)",
	);
	if (!toolResults(mark, "schedule_wakeup").some((result) => !result.error && result.text.includes("Next wakeup"))) {
		throw new Inconclusive("the model did not schedule a wakeup");
	}
	await tick("wakeup", mark);
}

function report() {
	const rows = [];
	let misses = 0;
	let previous;
	for (const request of requests) {
		const total = request.input + request.cached;
		let verdict = "warm-up";
		if (previous !== undefined) {
			// Everything the previous request sent should be cached now; allow the
			// provider's block rounding.
			const expected = previous - Math.max(256, Math.round(previous * 0.1));
			verdict = request.cached >= expected ? "ok" : `MISS (cached ${request.cached}, expected about ${previous})`;
			if (verdict !== "ok") misses++;
		}
		const hit = total ? `${Math.round((request.cached / total) * 100)}%` : "-";
		rows.push([request.label, String(request.input), String(request.cached), hit, verdict]);
		previous = total;
	}
	const header = ["step", "input", "cached", "hit", "verdict"];
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
	const line = (cells) => cells.map((cell, i) => (i === 0 || i === 4 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
	console.log(line(header));
	for (const row of rows) console.log(line(row));
	const cost = requests.reduce((sum, request) => sum + request.cost, 0);
	console.log(`\nmodel ${options.model} · ${requests.length} requests · cost $${cost.toFixed(4)}`);
	if (cost > 0) console.log("warning: this model is not free");
	return misses;
}

let code = 0;
try {
	await scenario();
	if (!requests.some((request) => request.cached > 0)) throw new Inconclusive("the model reports no cache reads at all");
	const misses = report();
	console.log(misses ? `\n${misses} cache miss(es). Re-run: a miss at the same step again is ours.` : "\nall requests cached");
	code = misses ? 1 : 0;
} catch (error) {
	if (requests.length) report();
	console.log(`\ninconclusive: ${error instanceof Inconclusive ? error.message : error}`);
	code = 2;
} finally {
	child.kill();
	fs.rmSync(cwd, { recursive: true, force: true });
}
process.exit(code);
