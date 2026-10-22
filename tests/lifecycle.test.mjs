/**
 * Loop lifecycle: Esc, restore, loop.md, the wakeup tool's contract and what
 * gets persisted.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	guidelinesOf,
	makeDue,
	makeHarness,
	runEvent,
	runTurn,
	start,
	startSelfPaced,
	stateEntries,
} from "./harness.mjs";

const wakeup = (h, args) => h.tools.get("schedule_wakeup").execute("c", args, undefined, undefined, h.ctx);

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
		message: { customType: "pi-cc-monitor-event", content: "[monitor \u00b7 ci]\nFAILED", details: { loopPrompt: "watch CI" } },
	};
	await runTurn(h, { aborted: true, start: monitorEvent });
	assert.equal(h.scheduler().get(chain.id), undefined);
});

test("Esc on an unrelated turn keeps the loops; fixed-interval jobs are never stopped by Esc", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the build", h.ctx);
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
	const otherMonitor = { message: { customType: "pi-cc-monitor-event", content: "x", details: { loopPrompt: "watch deploy" } } };
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

	await h.commands.get("loop").handler("5m", h.ctx);
	const job = h.scheduler().list()[0];
	assert.equal(job.cron, "*/5 * * * *");
	assert.equal(job.prompt, "<<loop.md>>", "the prompt is the sentinel, not the file text");
	assert.ok(h.sent[0].message.content.includes("check the release branch"), "the first run gets the tasks");
});

test("loop.md is read at fire time: edits apply, unchanged tasks are not resent", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "task A\n");
	await h.commands.get("loop").handler("10m", h.ctx);
	const job = h.scheduler().list()[0];
	const fire = () => {
		makeDue(h, job.id);
		h.scheduler().tick();
		return h.sent.at(-1).message.content;
	};

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
	await h.commands.get("loop").handler("10m", h.ctx);
	const job = h.scheduler().list()[0];

	await h.handlers.get("session_compact")({}, h.ctx);
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.ok(h.sent.at(-1).message.content.includes("task A"));
});

test("a long loop.md is truncated like Claude Code's", async () => {
	const h = await start(makeHarness());
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${"x".repeat(100)}\n`.repeat(400)); // 40,400 characters
	await h.commands.get("loop").handler("", h.ctx);
	const content = h.sent[0].message.content;
	assert.ok(content.length < 26_000, `${content.length} characters`);
	assert.match(content, /loop\.md was truncated to 25000 bytes/);
});

test("a bare /loop is self-paced and schedules with the sentinel", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.ok(text.includes("A self-paced `/loop` is running"), text);
	assert.ok(text.includes('"<<loop.md>>"'), "the model passes the sentinel back");
	assert.ok(!text.includes("Decide how it should repeat"), "no fixed-or-open-ended decision for a bare /loop");
});

test("a cron tick says the schedule fires on its own, and refuses a wakeup", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const job = h.scheduler().byKind("cron")[0];
	makeDue(h, job.id);
	h.scheduler().tick();

	const event = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.match(text, /fixed-interval \/loop/);
	assert.match(text, /Do not call `schedule_wakeup`/);
	assert.ok(text.includes(job.id), "the job id, so cron_delete can be named too");

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
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
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

// -------------------------------------------------------------- scheduling

test("a slow turn start does not send the same tick twice", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m ping", h.ctx);
	const job = h.scheduler().list()[0];
	makeDue(h, job.id);
	h.scheduler().tick(); // tick #2 goes out
	h.state.idle = false; // the run is starting (a slow compaction)
	h.scheduler().tick(Date.now() + 31_000);
	h.state.idle = true;
	await runTurn(h);
	assert.equal(h.sent.length, 2, h.sent.map((entry) => entry.message.content.split("\n")[0]).join("\n"));
});

test("cron fires do not add session entries; structural changes do", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("1m ping", h.ctx);
	const before = h.appended.length;
	const job = h.scheduler().list()[0];
	for (let i = 0; i < 10; i++) {
		makeDue(h, job.id);
		h.scheduler().tick();
		await runTurn(h);
	}
	assert.equal(h.appended.length, before, "ten fires, no new entries");

	await h.commands.get("loop").handler(`stop ${job.id}`, h.ctx);
	assert.equal(h.appended.length, before + 1, "removing the job is persisted");
});

test("the stopped-prompt memory is capped", async () => {
	const h = await start(makeHarness());
	for (let i = 0; i < 25; i++) {
		await startSelfPaced(h, `task ${i}`, 600);
		await wakeup(h, { stop: true });
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

test("the first run of a fixed-interval /loop already says not to self-pace", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.match(text, /A recurring \/loop job was created/);
	assert.match(text, /do not call `schedule_wakeup` for this loop, now or on a later tick/);
	assert.ok(!text.includes("Decide how it should repeat"), "no mode choice: the interval was given");
});
