/**
 * Loop lifecycle: Esc, restore, loop.md, the wakeup tool's contract and what
 * gets persisted.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";
import {
	createCron,
	guidelinesOf,
	makeDue,
	makeHarness,
	runEvent,
	runTurn,
	start,
	startSelfPaced,
	stateEntries,
	textOf,
} from "./harness.mjs";

const LOOP_SENTINEL = "<<loop.md>>";
const { LOOP_FILE_MAX_BYTES, readLoopFile } = await loadModule("loopfile.ts");

const rawWakeup = (h, args) => h.tools.get("schedule_wakeup").execute("c", args, undefined, undefined, h.ctx);
/** Call the tool the way the model does, with the now-required reason. */
const wakeup = (h, args) => rawWakeup(h, { reason: "waiting for the task", ...args });

// -------------------------------------------------------------------- Esc

test("Esc during a loop tick cancels the self-paced loop", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick(); // the wakeup fires

	await runTurn(h, { aborted: true, start: h.sent.at(-1) }); // Esc during the tick's turn

	assert.equal(h.scheduler().get(chain.id), undefined, "the chain is gone, no keepalive was armed");
	assert.ok(
		h.busEvents.some((event) => event.channel === "loop:stopped" && event.data.prompt === "check the deploy"),
		"its monitors are told to stop",
	);
	assert.ok(h.notifications.some((n) => n.message.startsWith("Pending wakeup cancelled")), "Claude Code's notice");
	await assert.rejects(() => wakeup(h, { delaySeconds: 60, prompt: "check the deploy" }), /was stopped/);
});

test("Esc during the first /loop run cancels the loop it just armed", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent[0]), h.ctx); // the /loop run starts
	await wakeup(h, { delaySeconds: 600, prompt: "watch CI" }); // the model arms the chain
	await runTurn(h, { aborted: true }); // then the user presses Esc
	assert.equal(h.scheduler().byKind("wakeup").length, 0);
});

test("Esc during a turn woken by the loop's monitor cancels that loop", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await runTurn(h);
	const monitorEvent = {
		message: { customType: "Monitor", content: "monitor abc \u00b7 ci\nFAILED", details: { loopPrompt: "watch CI" } },
	};
	await runTurn(h, { aborted: true, start: monitorEvent });
	assert.equal(h.scheduler().get(chain.id), undefined);
});

test("a monitor's loopPrompt may quote the request with its /loop prefix and still name the chain", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await runTurn(h);
	// schedule_wakeup strips the prefix before it keys the chain; a model that
	// passes the request back verbatim includes it.
	const monitorEvent = {
		message: { customType: "Monitor", content: "monitor abc \u00b7 ci\nFAILED", details: { loopPrompt: "/loop watch CI" } },
	};
	await runTurn(h, { aborted: true, start: monitorEvent });
	assert.equal(h.scheduler().get(chain.id), undefined);
});

test("Esc on an unrelated turn keeps the loops; fixed-interval jobs are never stopped by Esc", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the build" });
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await runTurn(h);
	const scheduledFor = h.scheduler().get(chain.id).scheduledFor;

	// The user asks something else and interrupts it.
	const userTurn = { messageType: "user", prompt: "what does this error mean?", systemPromptOptions: { promptGuidelines: [] } };
	await h.handlers.get("before_agent_start")(userTurn, h.ctx);
	await runTurn(h, { aborted: true });
	assert.equal(h.scheduler().get(chain.id)?.scheduledFor, scheduledFor, "the loop keeps its pending wakeup");
	assert.ok(!h.notifications.some((n) => n.message.startsWith("Pending wakeup cancelled")));

	// A monitor event of another loop is not this loop's turn either.
	const otherMonitor = { message: { customType: "Monitor", content: "x", details: { loopPrompt: "watch deploy" } } };
	await runTurn(h, { aborted: true, start: otherMonitor });
	assert.ok(h.scheduler().get(chain.id));

	// A fixed-interval tick interrupted with Esc: Claude Code doesn't stop those either.
	const cron = h.scheduler().byKind("cron")[0];
	makeDue(h, cron.id);
	h.scheduler().tick();
	await runTurn(h, { aborted: true, start: h.sent.at(-1) });
	assert.ok(h.scheduler().get(cron.id), "the fixed-interval job keeps running");
	assert.ok(h.scheduler().get(chain.id), "and so does the self-paced loop");
});

test("a turn that ends normally does not cancel anything", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await runTurn(h);
	assert.ok(h.scheduler().get(chain.id));
	assert.ok(!h.notifications.some((n) => n.message.startsWith("Pending wakeup cancelled")));
});

// ---------------------------------------------------------------- restore

test("/reload keeps a pending self-paced wakeup", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 1200);
	const scheduledFor = h.scheduler().get(chain.id).scheduledFor;

	const h2 = makeHarness(h.ctx.cwd);
	h2.ctx.sessionManager.getEntries = () => stateEntries(h);
	await start(h2, { type: "session_start", reason: "reload" });

	const restored = h2.scheduler().get(chain.id);
	assert.ok(restored, "the chain survived the reload");
	assert.equal(restored.scheduledFor, scheduledFor, "with the same wakeup time");
	assert.ok(!h2.notifications.some((n) => n.message.includes("not restored")));
});

test("resuming a session does not restore a self-paced loop, and says so", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h, "watch CI", 1200);

	for (const reason of ["startup", "resume"]) {
		const h2 = makeHarness(h.ctx.cwd);
		h2.ctx.sessionManager.getEntries = () => stateEntries(h);
		await start(h2, { type: "session_start", reason });
		assert.equal(h2.scheduler().byKind("wakeup").length, 0, `${reason}: no leftover chain`);
		assert.ok(
			h2.notifications.some((n) => n.message.includes("run /loop again")),
			`${reason}: the user is told to restart it`,
		);
	}
});

test("after /loop stop, typing the same /loop again starts it again", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h, "watch CI", 600);
	await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "the chain is gone");

	// A late wakeup from a stale turn must still be refused...
	await assert.rejects(
		h.tools
			.get("schedule_wakeup")
			.execute("c", { delaySeconds: 600, reason: "late", prompt: "watch CI" }, undefined, undefined, h.ctx),
		/was stopped/,
	);

	// ...but the user asking for the loop again is a new loop.
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	const chain = await startSelfPaced(h, "watch CI", 600);
	assert.ok(chain, "the same prompt can be armed again");
});

test("restoring drops one-shots whose time passed and recurring jobs that expired", async () => {
	const h = await start(makeHarness());
	const create = (args) => h.tools.get("cron_create").execute("c", args, undefined, undefined, h.ctx);
	const past = new Date(Date.now() - 3600_000);
	const oneShot = await create({ cron: `${past.getMinutes()} ${past.getHours()} ${past.getDate()} ${past.getMonth() + 1} *`, prompt: "late reminder", recurring: false });
	const old = await create({ cron: "*/10 * * * *", prompt: "old poll" });
	const fresh = await create({ cron: "*/10 * * * *", prompt: "fresh poll" });

	const entries = stateEntries(h);
	const state = entries.at(-1).data;
	state.jobs.find((job) => job.id === oneShot.details.id).createdAt = Date.now() - 2 * 3600_000;
	state.jobs.find((job) => job.id === old.details.id).createdAt = Date.now() - 8 * 86_400_000;

	const h2 = makeHarness(h.ctx.cwd);
	h2.ctx.sessionManager.getEntries = () => entries;
	await start(h2, { type: "session_start", reason: "resume" });
	assert.deepEqual(
		h2.scheduler().list().map((job) => job.id),
		[fresh.details.id],
		"only the live recurring job comes back",
	);
	assert.ok(h2.notifications.some((n) => n.message.includes("one-shot job dropped")));
});

// ---------------------------------------------------------------- loop.md

test("/loop 5m runs the loop.md tasks on a fixed schedule", async () => {
	const h = await start(makeHarness());
	fs.mkdirSync(path.join(h.ctx.cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(h.ctx.cwd, ".pi", "loop.md"), "check the release branch\n");

	await createCron(h, { cron: "*/5 * * * *", prompt: LOOP_SENTINEL });
	const job = h.scheduler().list()[0];
	assert.equal(job.cron, "*/5 * * * *");
	assert.equal(job.prompt, "<<loop.md>>", "the prompt is the sentinel, not the file text");
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.ok(textOf(h.sent.at(-1)).includes("check the release branch"), "the first fire gets the tasks");
});

test("loop.md is read at fire time: edits apply, unchanged tasks are not resent", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "task A\n");
	await createCron(h, { cron: "*/10 * * * *", prompt: LOOP_SENTINEL });
	const job = h.scheduler().list()[0];
	const fire = () => {
		makeDue(h, job.id);
		h.scheduler().tick();
		return textOf(h.sent.at(-1));
	};

	const first = fire();
	assert.ok(first.includes("task A"), "the first fire carries the tasks");
	const unchanged = fire();
	assert.ok(!unchanged.includes("task A"), "unchanged tasks: a short reminder");
	assert.match(unchanged, /established earlier in this conversation/);

	fs.writeFileSync(file, "task B\n");
	assert.ok(fire().includes("task B"), "an edit is picked up on the next tick");

	fs.rmSync(file);
	assert.match(fire(), /maintenance pass/, "no loop.md: the built-in maintenance prompt");
});

test("a compaction makes the next tick resend the full loop.md tasks", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "task A\n");
	await createCron(h, { cron: "*/10 * * * *", prompt: LOOP_SENTINEL });
	const job = h.scheduler().list()[0];

	await h.handlers.get("session_compact")({}, h.ctx);
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.ok(textOf(h.sent.at(-1)).includes("task A"));
});

test("a long loop.md is truncated like Claude Code's", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${"x".repeat(100)}\n`.repeat(400)); // 40,400 characters
	await createCron(h, { cron: "*/10 * * * *", prompt: LOOP_SENTINEL });
	const job = h.scheduler().list()[0];
	makeDue(h, job.id);
	h.scheduler().tick();
	const content = textOf(h.sent.at(-1));
	assert.ok(content.length < 26_000, `${content.length} characters`);
	assert.match(content, /loop\.md was truncated to 25000 bytes/);
});

test("loop.md truncation counts UTF-8 bytes and never splits a multibyte character", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "你".repeat(9000), "utf8"); // 27,000 bytes; 25,000 cuts inside the next 你
	const result = readLoopFile(h.ctx.cwd);
	assert.ok(result);
	const [body, warning] = result.content.split("\n> WARNING: ");
	assert.ok(Buffer.byteLength(body, "utf8") <= LOOP_FILE_MAX_BYTES);
	assert.equal(Buffer.byteLength(body, "utf8"), 24_999, "the cut backs up to the preceding complete 你");
	assert.ok(!body.includes("\ufffd"), "no replacement character is introduced");
	assert.equal(Buffer.from(body, "utf8").toString("utf8"), body, "the kept text is valid UTF-8");
	assert.match(warning, /loop\.md was truncated to 25000 bytes/);
});

test("a bare /loop tells the model to run the loop.md tasks", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.ok(text.includes('"<<loop.md>>"'), "the model passes the sentinel back");
	assert.match(text, /Self-paced/);
	assert.match(text, /loop\.md/);
});

test("a cron tick says the schedule fires on its own, and refuses a wakeup", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	const job = h.scheduler().byKind("cron")[0];
	makeDue(h, job.id);
	h.scheduler().tick();

	const text = textOf(h.sent.at(-1));
	assert.match(text, /fires the next tick on its own, so do not call schedule_wakeup/);
	assert.ok(text.includes(`cron_delete with id ${job.id}`), "the job id, so cron_delete can be named too");
	const event = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.equal(guidelinesOf(event), "", "the envelope says it all: nothing is added to the run");

	// Following the habit anyway must not start a second schedule, and is not an
	// error: the schedule already covers the next tick.
	const result = await wakeup(h, { delaySeconds: 1200, prompt: "check the deploy" });
	assert.equal(result.details.suppressed, "fixed-interval");
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no chain was created");
	assert.match(result.content[0].text, /No wakeup needed/);
	assert.match(result.content[0].text, /Nothing was scheduled/);
});

test("after a cron tick, a turn the user starts may schedule again", async () => {
	const h = await start(makeHarness());
	await createCron(h, { cron: "*/5 * * * *", prompt: "check the deploy" });
	const job = h.scheduler().byKind("cron")[0];
	makeDue(h, job.id);
	h.scheduler().tick();
	await runTurn(h, { start: h.sent.at(-1) });

	const userTurn = { messageType: "user", prompt: "now check the deploy every 10 minutes instead", systemPromptOptions: { promptGuidelines: [] } };
	await h.handlers.get("before_agent_start")(userTurn, h.ctx);
	const armed = await wakeup(h, { delaySeconds: 600, prompt: "watch the deploy" });
	assert.equal(armed.details.stopped, false);
});

// --------------------------------------------------- schedule_wakeup contract

test("schedule_wakeup ends the turn, except when it stops the loop", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("check the deploy", h.ctx);
	const armed = await wakeup(h, { delaySeconds: 1200, prompt: "check the deploy" });
	assert.equal(armed.terminate, true, "Claude Code ends the turn when ScheduleWakeup returns");
	const stopped = await wakeup(h, { stop: true });
	assert.equal(stopped.terminate, undefined, "the model may still write the loop's outcome");
});

test("the requested delay is used as asked, only clamped to [60, 3600]", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("check the deploy", h.ctx);
	for (const [requested, expected, clamped] of [
		[300, 300, false],
		[299.4, 299, false],
		[285, 285, false],
		[1200, 1200, false],
		[30, 60, true],
		[7200, 3600, true],
	]) {
		const result = await wakeup(h, { delaySeconds: requested, prompt: "check the deploy" });
		assert.equal(result.details.clampedDelaySeconds, expected, `${requested}s`);
		assert.equal(result.details.wasClamped, clamped, `${requested}s clamped`);
	}
});

test("a chain older than 7 days ends when the model reschedules it", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h);
	h.scheduler().get(chain.id).chainStartedAt = Date.now() - 7 * 86_400_000 - 1000;
	const result = await wakeup(h, { delaySeconds: 600, prompt: "check the deploy" });
	assert.equal(result.details.agedOut, true);
	assert.match(result.content[0].text, /Wakeup not scheduled\. The loop reached its maximum duration/);
	assert.equal(h.scheduler().get(chain.id), undefined);
});

test("stop during a chain's tick stops only that chain", async () => {
	const h = await start(makeHarness());
	const ci = await startSelfPaced(h, "watch CI", 600);
	const deploy = await startSelfPaced(h, "watch deploy", 600);
	makeDue(h, ci.id);
	h.scheduler().tick();
	const tick = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(tick, h.ctx); // the run belongs to "watch CI"

	await wakeup(h, { stop: true });
	assert.equal(h.scheduler().get(ci.id), undefined, "the tick's own chain ended");
	assert.ok(h.scheduler().get(deploy.id), "the other loop keeps running");
});

test("a reworded prompt during a chain's tick re-arms that chain instead of starting another", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);

	const result = await wakeup(h, { delaySeconds: 600, prompt: "/loop watch the CI run" });
	assert.equal(result.details.id, chain.id);
	assert.equal(h.scheduler().byKind("wakeup").length, 1, "no duplicate chain");
});

test("a /loop prefix copied from Claude Code habits is ignored", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	const result = await wakeup(h, { delaySeconds: 600, prompt: "/loop watch CI" });
	assert.equal(result.details.id, chain.id);
});

test("cron_delete on a self-paced chain ends it like /loop stop", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	assert.ok(h.busEvents.some((event) => event.channel === "loop:stopped"), "its monitors are stopped");
	await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt: "watch CI" }), /was stopped/);
});

test("a stopped tick run cannot re-arm its chain, even under a reworded prompt", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx); // the tick's run
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	for (const prompt of ["watch CI", "watch the CI run"]) {
		await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt }), /was stopped/);
	}
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no replacement chain was created");
	// stop:true still works from the cancelled run and never aborts the turn.
	const stopped = await wakeup(h, { stop: true });
	assert.equal(stopped.details.stopped, true);
	assert.equal(stopped.terminate, undefined);
	// A fresh /loop from the user is a new run and may start the loop again.
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	assert.ok(await startSelfPaced(h, "watch CI", 600), "the same prompt arms in the new run");
});

test("a stopped first /loop run cannot re-arm under a reworded prompt either", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	const chain = await startSelfPaced(h, "watch CI", 600); // the run armed this chain
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	for (const prompt of ["watch CI", "watch the CI run"]) {
		await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt }), /was stopped/);
	}
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no replacement chain was created");
});

test("stop:true on the tick's own chain also blocks a reworded re-arm from that run", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	await wakeup(h, { stop: true });
	await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt: "watch the CI run" }), /was stopped/);
	assert.equal(h.scheduler().byKind("wakeup").length, 0);
});

test("stop:true after the first /loop arm blocks a reworded re-arm from that run", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h, "watch deploy", 600); // a chain from an earlier run
	await runTurn(h);
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	await startSelfPaced(h, "watch CI", 600); // the run armed this chain
	await wakeup(h, { stop: true, prompt: "watch deploy" }); // unrelated: the run stays free
	assert.ok(await wakeup(h, { delaySeconds: 600, prompt: "watch CI" }), "own chain re-arms after an unrelated stop");
	await wakeup(h, { stop: true }); // the agent stops the loop it just armed
	for (const prompt of ["watch CI", "watch the CI run"]) {
		await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt }), /was stopped/);
	}
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no replacement chain was created");
	// A fresh /loop from the user is a new run and may start the loop again.
	await runTurn(h);
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	assert.ok(await startSelfPaced(h, "watch CI", 600), "the same prompt arms in the new run");
});

test("stopping an unrelated chain leaves the tick run free to re-arm its own", async () => {
	const h = await start(makeHarness());
	const ci = await startSelfPaced(h, "watch CI", 600);
	const other = await startSelfPaced(h, "watch deploy", 600);
	await runTurn(h);
	makeDue(h, ci.id);
	h.scheduler().tick();
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	await h.tools.get("cron_delete").execute("c", { id: other.id }, undefined, undefined, h.ctx);
	const result = await wakeup(h, { delaySeconds: 600, prompt: "watch the CI run" });
	assert.equal(result.details.id, ci.id, "the tick's own chain is re-armed, not replaced");
	assert.equal(h.scheduler().byKind("wakeup").length, 1);
});

test("a tick whose chain was retired before its run started cannot re-arm", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick(); // the tick is queued; the host may compact before before_agent_start
	const tick = h.sent.at(-1);
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(tick), h.ctx); // the late run start
	for (const prompt of ["watch CI", "watch the CI run"]) {
		await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt }), /was stopped/);
	}
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no replacement chain was created");
});

test("a queued monitor of a stopped loop cannot re-arm it, but a fresh /loop can", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	await runTurn(h);
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	// The queued event outlived its chain; the monitor may quote the /loop prefix.
	const monitorEvent = {
		message: { customType: "Monitor", content: "queued old output", details: { loopPrompt: "/loop watch CI" } },
	};
	await h.handlers.get("before_agent_start")(runEvent({ kind: "custom", ...monitorEvent }), h.ctx);
	for (const prompt of ["watch CI", "watch the CI run"]) {
		await assert.rejects(() => wakeup(h, { delaySeconds: 600, prompt }), /was stopped/);
	}
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "no replacement chain was created");
	// A fresh /loop clears the memo and starts a new run: the restart is not poisoned.
	await runTurn(h);
	await h.commands.get("loop").handler("watch CI", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent.at(-1)), h.ctx);
	assert.ok(await startSelfPaced(h, "watch CI", 600), "the same prompt arms in the new run");
});

test("a monitor with no stopped memo still lets the run arm its loop", async () => {
	const h = await start(makeHarness());
	const monitorEvent = {
		message: { customType: "Monitor", content: "output", details: { loopPrompt: "watch CI" } },
	};
	await h.handlers.get("before_agent_start")(runEvent({ kind: "custom", ...monitorEvent }), h.ctx);
	assert.ok(await startSelfPaced(h, "watch CI", 600), "a not-yet-armed loop is not blocked");
});

// -------------------------------------------------------------- scheduling



test("the stopped-prompt memory is capped", async () => {
	const h = await start(makeHarness());
	for (let i = 0; i < 25; i++) {
		await startSelfPaced(h, `task ${i}`, 600);
		await wakeup(h, { stop: true });
		// Each pair is an independent turn in the host: settle the run and start
		// the next one, so this turn's stop cannot block the next turn's arm.
		await runTurn(h);
		await h.handlers.get("before_agent_start")(runEvent({ kind: "user", content: `task ${i + 1}` }), h.ctx);
	}
	assert.equal(h.lastState().stopped.length, 20);
	assert.ok(!h.lastState().stopped.includes("task 0"), "the oldest are forgotten first");
});

// ------------------------------------------------------------------ prompts

test("the tool descriptions carry Claude Code's guidance", async () => {
	const h = await start(makeHarness());
	const describe = (name) => h.tools.get(name).description;
	for (const phrase of ["half its period late", "5 minute cadence", "90 s early", "fire one final time", "NOT 0 or 30", "Monitor tool"]) {
		assert.ok(describe("cron_create").includes(phrase), `cron_create: ${phrase}`);
	}
	for (const phrase of ["Only for self-paced loops", "1200-1800s", "<<loop.md>>", "the turn ends as soon as it returns"]) {
		assert.ok(describe("schedule_wakeup").includes(phrase), `schedule_wakeup: ${phrase}`);
	}
	for (const name of ["cron_create", "cron_delete", "cron_list", "schedule_wakeup"]) {
		assert.ok(h.tools.get(name).promptSnippet, `${name} has a prompt snippet`);
	}
	assert.equal(h.tools.get("cron_create").parameters.properties.maxFires.type, "integer");
});

test("two loops armed in the same run stay separate, and Esc cancels both", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("watch CI and the deploy", h.ctx);
	await h.handlers.get("before_agent_start")(runEvent(h.sent[0]), h.ctx);
	await wakeup(h, { delaySeconds: 600, prompt: "watch CI" });
	await wakeup(h, { delaySeconds: 600, prompt: "watch deploy" });
	assert.equal(h.scheduler().byKind("wakeup").length, 2, "the second prompt starts its own chain");
	await runTurn(h, { aborted: true });
	assert.equal(h.scheduler().byKind("wakeup").length, 0, "both belong to the interrupted run");
});




// -------------------------------------------------- the tool result, worded like CC

test("a wakeup result gives the time, the delay and the turn-ends rule", async () => {
	const h = await start(makeHarness());
	const result = await wakeup(h, { delaySeconds: 300, prompt: "check the deploy" });
	const text = result.content[0].text;
	assert.match(text, /^Next wakeup scheduled for \d{2}:\d{2}:\d{2} \(in 300s\)\./);
	assert.match(text, /This turn ends when this call returns/);
	assert.equal(result.terminate, true);
});

test("a clamped wakeup says so in Claude Code's words", async () => {
	const h = await start(makeHarness());
	const result = await wakeup(h, { delaySeconds: 7200, prompt: "check the deploy" });
	assert.match(result.content[0].text, /\(clamped to 3600s from your requested value\)/);
});

test("reason is required unless stop is true", async () => {
	const h = await start(makeHarness());
	await assert.rejects(
		() => rawWakeup(h, { delaySeconds: 300, prompt: "check the deploy" }),
		/reason.*required/,
		"a reason keeps the wakeup explainable in the transcript",
	);
	await assert.rejects(() => rawWakeup(h, { delaySeconds: 300, reason: "  ", prompt: "check the deploy" }), /required/);
});

test("stopping says what was cancelled, and what a cron is not", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 600);
	const stopped = await rawWakeup(h, { stop: true });
	assert.match(stopped.content[0].text, /^Loop stopped \u2014 cancelled 1 pending wakeup\(s\)/);
	assert.match(stopped.content[0].text, /Write the loop's outcome for the user, then end the turn/);
	assert.equal(h.scheduler().get(chain.id), undefined);

	const again = await rawWakeup(h, { stop: true });
	assert.match(again.content[0].text, /there was no pending wakeup to cancel/);
	assert.match(again.content[0].text, /NOT stopped by this call \u2014 cancel it with cron_delete/);
});
