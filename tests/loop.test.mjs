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
} from "./harness.mjs";

test("registers the /loop command and the four tools", async () => {
	const h = await start(makeHarness());
	assert.ok(h.commands.has("loop"));
	for (const name of ["cron_create", "cron_delete", "cron_list", "schedule_wakeup"]) {
		assert.ok(h.tools.has(name), `${name} tool registered`);
	}
	for (const event of ["session_start", "agent_settled", "before_agent_start", "session_shutdown"]) {
		assert.ok(h.handlers.has(event), `${event} handler registered`);
	}
});

test("/loop 5m creates a cron job and runs the prompt immediately", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);

	const job = h.lastState().jobs[0];
	assert.equal(job.kind, "cron");
	assert.equal(job.cron, "*/5 * * * *");
	assert.equal(job.prompt, "check the deploy");
	assert.equal(job.recurring, true);
	assert.ok(job.nextFireAt > Date.now());

	// Claude Code: "Then immediately execute the parsed prompt now".
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].kind, "custom");
	assert.equal(h.sent[0].options.deliverAs, "steer", "the immediate run lands in the current turn");
	assert.ok(h.sent[0].message.content.includes("check the deploy"));
	assert.ok(
		h.sent[0].message.content.includes("scheduled by /loop, not typed by the user"),
		"the tick carries a provenance header",
	);
	assert.ok(h.notifications.some((n) => n.message.includes(job.id)));
});

test("a scheduled tick is delivered low priority, between turns", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const job = h.lastState().jobs[0];

	makeDue(h, job.id);
	h.scheduler().tick();

	assert.equal(h.sent.length, 2, "one more message");
	assert.equal(h.sent[1].options.deliverAs, "followUp", "scheduled ticks use the low priority lane");
	assert.ok(h.sent[1].message.content.includes("loop tick #2"));
});

test("the tick number continues from the immediate run to the first job fire", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const job = h.lastState().jobs[0];
	assert.ok(h.sent[0].message.content.includes("loop tick #1"), "the immediate run is tick #1");

	makeDue(h, job.id);
	h.scheduler().tick();
	assert.ok(
		h.sent[1].message.content.includes("loop tick #2"),
		`the first job fire continues the numbering: ${h.sent[1].message.content}`,
	);
});

test("the tick number continues when the model creates the job itself", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("每30秒输出一次hello world", h.ctx);
	assert.ok(h.sent[0].message.content.includes("loop tick #1"));

	await h.tools
		.get("cron_create")
		.execute("c", { cron: "* * * * *", prompt: "每30秒输出一次hello world" }, undefined, undefined, h.ctx);
	const job = h.lastState().jobs.find((j) => j.prompt.includes("每30秒"));
	assert.equal(job.tickCount, 1, "the job starts after the immediate run");

	makeDue(h, job.id);
	h.scheduler().tick();
	assert.ok(
		h.sent[1].message.content.includes("loop tick #2"),
		`the first job fire continues the numbering: ${h.sent[1].message.content}`,
	);
});

test("a tick waits until the agent is idle", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const job = h.lastState().jobs[0];

	h.state.idle = false;
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.equal(h.sent.length, 1, "nothing dispatched while the agent is busy");

	h.state.idle = true;
	h.scheduler().tick();
	assert.equal(h.sent.length, 2, "dispatched once the agent went idle");
});

test("missed intervals coalesce into a single tick", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("1m check the deploy", h.ctx);
	const job = h.scheduler().get(h.lastState().jobs[0].id);

	// The agent stays busy for ten minutes on a one minute cadence.
	h.state.idle = false;
	for (let i = 0; i < 10; i++) {
		job.nextFireAt = Date.now() - 1;
		h.scheduler().tick();
	}
	assert.equal(h.sent.length, 1, "no backlog while the agent is busy");

	h.state.idle = true;
	h.scheduler().tick();
	assert.equal(h.sent.length, 2, "exactly one tick, not ten");
});

test("/loop without an interval leaves the schedule to the model", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("check the deploy", h.ctx);

	// No chain yet: the model has not decided how often to repeat.
	assert.equal(h.lastState().jobs.length, 0, "no job until the model schedules one");
	assert.equal(h.sent.length, 1, "the prompt runs once to start");

	// The model applies the schedule rules and picks the cadence.
	const chain = await startSelfPaced(h, "check the deploy");
	assert.equal(chain.kind, "wakeup");
	assert.equal(chain.prompt, "check the deploy");
	assert.ok(chain.scheduledFor > Date.now());
});

test("the schedule rules are injected when the interval could not be parsed", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("每30秒输出一次hello world", h.ctx);

	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const guidelines = guidelinesOf(event);
	assert.ok(guidelines.includes("cron_create"), "the model is told how to make a fixed interval job");
	assert.ok(guidelines.includes("schedule_wakeup"), "and how to self-pace");
	assert.ok(guidelines.includes("minimum granularity is 1 minute"), "including the rounding rule");
	assert.ok(guidelines.includes("每30秒输出一次hello world"), "and the original prompt");
});

test("schedule_wakeup clamps the delay to [60, 3600]", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	const tool = h.tools.get("schedule_wakeup");

	const low = await tool.execute("c1", { delaySeconds: 5, prompt: "check the deploy" }, undefined, undefined, h.ctx);
	assert.equal(low.details.clampedDelaySeconds, 60);
	assert.equal(low.details.wasClamped, true);

	const high = await tool.execute("c2", { delaySeconds: 99999, prompt: "check the deploy" }, undefined, undefined, h.ctx);
	assert.equal(high.details.clampedDelaySeconds, 3600);

	const job = h.scheduler().byKind("wakeup")[0];
	assert.ok(job.scheduledFor > Date.now());
	assert.equal(job.keepaliveUsed, false);
	assert.equal(job.awaitingReschedule, false, "the model rescheduled, so no keepalive is owed");
});

test("a turn that does not reschedule arms one 20 minute keepalive", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h);

	// The wakeup fires and the model does not schedule the next one.
	makeDue(h, chain.id);
	h.scheduler().tick();
	await runTurn(h);

	const job = h.lastState().jobs.find((j) => j.kind === "wakeup");
	assert.equal(job.keepaliveUsed, true);
	assert.ok(job.scheduledFor - Date.now() > 19 * 60 * 1000);
	assert.ok(h.notifications.some((n) => n.message.includes("keepalive armed")));
});

test("the keepalive turn is the model's last chance", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h);

	makeDue(h, chain.id);
	h.scheduler().tick();
	await runTurn(h);
	const armed = h.lastState().jobs.find((j) => j.kind === "wakeup");
	assert.equal(armed.keepaliveUsed, true);

	// The keepalive fires and re-enters the loop.
	makeDue(h, armed.id);
	h.scheduler().tick();
	assert.equal(h.sent.length, 3, "the keepalive re-entered the loop");

	await runTurn(h);
	assert.equal(h.lastState().jobs.filter((j) => j.kind === "wakeup").length, 0, "the chain ended");
	assert.ok(h.notifications.some((n) => n.message.includes("keepalive budget exhausted")));
});

test("an explicit reschedule resets the keepalive budget", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await runTurn(h);
	await h.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 300, prompt: "check the deploy" }, undefined, undefined, h.ctx);
	await runTurn(h);

	const job = h.lastState().jobs.find((j) => j.kind === "wakeup");
	assert.ok(job, "the chain is still alive");
	assert.equal(job.keepaliveUsed, false);
});

test("schedule_wakeup with stop:true ends the loop", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	const result = await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);
	assert.equal(result.details.stopped, true);
	assert.equal(h.lastState().jobs.filter((j) => j.kind === "wakeup").length, 0);
});

test("cron_create validates its input", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("cron_create");
	await assert.rejects(
		() => tool.execute("c", { cron: "not a cron", prompt: "x" }, undefined, undefined, h.ctx),
		/Invalid cron expression/,
	);
	await assert.rejects(
		() => tool.execute("c", { cron: "0 0 30 2 *", prompt: "x" }, undefined, undefined, h.ctx),
		/does not match any date/,
	);

	const created = await tool.execute("c", { cron: "*/10 * * * *", prompt: "ping" }, undefined, undefined, h.ctx);
	assert.ok(created.details.id);
	assert.ok(created.details.nextFireAt > Date.now());

	const list = await h.tools.get("cron_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.jobs.length, 1);

	const removed = await h.tools.get("cron_delete").execute("c", { id: created.details.id }, undefined, undefined, h.ctx);
	assert.equal(removed.details.cancelled, true);
});

test("/loop status and /loop stop", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m ping", h.ctx);

	h.notifications.length = 0;
	await h.commands.get("loop").handler("status", h.ctx);
	assert.ok(h.notifications.some((n) => n.message.includes("*/5")));

	h.notifications.length = 0;
	await h.commands.get("loop").handler("stop", h.ctx);
	assert.ok(h.notifications.some((n) => n.message.includes("Cancelled")));
	assert.equal(h.lastState().jobs.length, 0);
});

test("--durable writes .pi/scheduled_tasks.json", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m ping --durable", h.ctx);

	const file = path.join(h.ctx.cwd, ".pi", "scheduled_tasks.json");
	assert.ok(fs.existsSync(file));
	const payload = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(payload.jobs.length, 1);
	assert.equal(payload.jobs[0].durable, true);
});

test("--max N caps the number of fires", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("1m ping --max 2", h.ctx);
	const job = h.lastState().jobs[0];
	assert.equal(job.maxFires, 2);

	// The immediate run counts as the first fire.
	assert.equal(job.fireCount, 1);

	makeDue(h, job.id);
	h.scheduler().tick();
	assert.equal(h.lastState().jobs.length, 0, "the job is removed once it hits the cap");
	assert.ok(h.notifications.some((n) => n.message.includes("reached its cap")));
});

test("a one-shot cron job deletes itself after firing", async () => {
	const h = await start(makeHarness());
	const created = await h.tools
		.get("cron_create")
		.execute("c", { cron: "*/10 * * * *", prompt: "ping", recurring: false }, undefined, undefined, h.ctx);

	makeDue(h, created.details.id);
	h.scheduler().tick();
	assert.equal(h.sent.length, 1, "the one-shot fired");
	assert.equal(h.lastState().jobs.length, 0, "and then deleted itself");
});

test("/loop with no prompt reads .pi/loop.md", async () => {
	const h = await start(makeHarness());
	fs.mkdirSync(path.join(h.ctx.cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(h.ctx.cwd, ".pi", "loop.md"), "check the release branch\n");
	await h.handlers.get("session_start")({}, h.ctx);
	await h.commands.get("loop").handler("", h.ctx);

	// The loop file becomes the prompt the model works from.
	const sent = h.sent[0].message.content;
	assert.ok(sent.includes("check the release branch"), sent);
	assert.ok(sent.includes("loop.md"), sent);
});

test("/loop with no prompt and no loop.md uses the maintenance prompt", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("", h.ctx);
	assert.ok(h.sent[0].message.content.includes("maintenance"), h.sent[0].message.content);
});

test("the trailing 'every N units' form schedules a cron job", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("check the deploy every 20m", h.ctx);
	const job = h.lastState().jobs[0];
	assert.equal(job.kind, "cron");
	assert.equal(job.cron, "*/20 * * * *");
	assert.equal(job.prompt, "check the deploy");
});

test("a turn woken by a monitor event keeps the fallback heartbeat", async () => {
	const h = await start(makeHarness());
	// 600s, so the 1200s keepalive could not be mistaken for it.
	const chain = await startSelfPaced(h, "check the deploy", 600);
	await runTurn(h); // the /loop run ends; the model scheduled the next wakeup
	const armed = h.scheduler().get(chain.id).scheduledFor;
	assert.ok(armed > Date.now());

	// Claude Code leaves the pending wakeup alone when a Monitor event wakes
	// the agent: the model re-arms it if it wants a different time.
	h.handlers.get("bus:monitor:wake")?.({ loopPrompt: "check the deploy" }, h.ctx);
	await runTurn(h);

	assert.equal(h.scheduler().get(chain.id).scheduledFor, armed, "the heartbeat is still armed");
});

test("after its keepalive a chain still ends instead of getting stuck", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await runTurn(h); // the model did not reschedule: the keepalive is armed
	assert.equal(h.scheduler().get(chain.id).keepaliveUsed, true);

	// A monitor event wakes the agent, and the model still does not reschedule.
	h.handlers.get("bus:monitor:wake")?.({ loopPrompt: "check the deploy" }, h.ctx);
	await runTurn(h);
	assert.ok(h.scheduler().get(chain.id)?.scheduledFor > Date.now(), "the keepalive is still pending");

	makeDue(h, chain.id);
	h.scheduler().tick();
	await runTurn(h); // the keepalive turn was the model's last chance
	assert.equal(h.scheduler().get(chain.id), undefined, "the chain ended");
});

test("/loop stop tells the monitor extension to stop the chain's monitors", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	const chain = h.lastState().jobs.find((j) => j.kind === "wakeup");

	await h.commands.get("loop").handler("stop", h.ctx);

	const stopped = h.busEvents.filter((e) => e.channel === "loop:stopped");
	assert.equal(stopped.length, 1, "one loop:stopped event was published");
	assert.equal(stopped[0].data.prompt, "check the deploy");
	assert.equal(h.lastState().jobs.length, 0, "the chain is gone");
	assert.ok(chain, "the chain existed before the stop");
});

test("a stopped chain stays stopped through later turns", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await h.commands.get("loop").handler("stop", h.ctx);

	// A turn woken by a late monitor event must not revive it.
	await runTurn(h);
	assert.equal(h.lastState().jobs.length, 0);
});

test("a stopped chain cannot be resurrected by a late schedule_wakeup", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await h.commands.get("loop").handler("stop", h.ctx);

	await assert.rejects(
		() =>
			h.tools
				.get("schedule_wakeup")
				.execute("c", { delaySeconds: 60, prompt: "check the deploy" }, undefined, undefined, h.ctx),
		/was stopped and must not be rescheduled/,
	);
	assert.equal(h.lastState().jobs.length, 0, "no chain came back");
});

test("the agent's own stop also retires the chain", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);

	const stopped = h.busEvents.filter((e) => e.channel === "loop:stopped");
	assert.equal(stopped.length, 1, "the monitor extension was told");
	assert.equal(h.lastState().jobs.length, 0);
});

test("starting the same prompt again clears the stop marker", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await h.commands.get("loop").handler("stop", h.ctx);

	// The user starts it again on purpose.
	await startSelfPaced(h);
	const chain = h.lastState().jobs.find((j) => j.kind === "wakeup");
	assert.ok(chain, "a new chain was created");

	const result = await h.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 60, prompt: "check the deploy" }, undefined, undefined, h.ctx);
	assert.equal(result.details.stopped, false);
	assert.equal(result.details.id, chain.id, "it re-armed the new chain");
});

test("the stop marker survives a session restore", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	await h.commands.get("loop").handler("stop", h.ctx);

	// A new session sees the persisted stop marker.
	const h2 = makeHarness();
	const entries = h.appended
		.filter((e) => e.customType === "pi-cc-loop-state")
		.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
	h2.ctx.sessionManager.getEntries = () => entries;
	await start(h2);
	await assert.rejects(
		() =>
			h2.tools
				.get("schedule_wakeup")
				.execute("c", { delaySeconds: 60, prompt: "check the deploy" }, undefined, undefined, h2.ctx),
		/was stopped and must not be rescheduled/,
	);
});

test("the status widget is off by default, like Claude Code", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m ping", h.ctx);
	assert.equal(h.widgets.length, 0, "Claude Code shows no loop status in the session");
});

test("/loop widget on shows the status line", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m ping", h.ctx);
	await h.commands.get("loop").handler("widget on", h.ctx);
	assert.equal(h.widgets.length, 1);
	assert.ok(h.widgets[0].includes("ping"), h.widgets[0]);

	await h.commands.get("loop").handler("widget off", h.ctx);
	assert.equal(h.widgets.length, 0);
});

test("the cron_create result matches Claude Code's wording", async () => {
	const h = await start(makeHarness());
	const created = await h.tools
		.get("cron_create")
		.execute("c", { cron: "*/5 * * * *", prompt: "ping" }, undefined, undefined, h.ctx);
	const text = created.content[0].text;
	assert.match(text, /^Scheduled [a-z0-9]{8} \(Every 5 minutes, next run /);
	assert.ok(text.includes('cron_delete { "id":'), "the job id can be cancelled");
});

test("the Monitor tool is only mentioned when it is installed", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);

	const without = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(without, h.ctx);
	assert.ok(!guidelinesOf(without).includes("Monitor"));

	// Start it again so the next run picks up the guidelines again.
	h.setRegisteredTools(["Monitor"]);
	await startSelfPaced(h);
	const with_ = runEvent(h.sent[1]);
	await h.handlers.get("before_agent_start")(with_, h.ctx);
	assert.ok(guidelinesOf(with_).includes("Monitor"));
	assert.ok(guidelinesOf(with_).includes("loopPrompt"));
});

test("/loop typed while the agent is busy waits for the turn and leaks nothing", async () => {
	const h = await start(makeHarness());
	h.state.idle = false; // the agent is in the middle of a turn
	await h.commands.get("loop").handler("check the deploy", h.ctx);
	assert.equal(h.state.waited, 1, "the command waited for the current turn to finish");
	assert.equal(h.sent.length, 1);

	// Another run (say, the user's next prompt) must not pick up the loop's rules.
	const unrelated = { messageType: "user", prompt: "what time is it?", systemPromptOptions: { promptGuidelines: [] } };
	await h.handlers.get("before_agent_start")(unrelated, h.ctx);
	assert.deepEqual(unrelated.systemPromptOptions.promptGuidelines, [], "nothing leaks into an unrelated run");

	// The loop's own run gets them.
	const own = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(own, h.ctx);
	assert.ok(guidelinesOf(own).includes("This is a `/loop` request"), guidelinesOf(own));
});

test("the Monitor guidance names the real loop prompt and is a condition", async () => {
	const h = await start(makeHarness());
	h.setRegisteredTools(["Monitor"]);
	await h.commands.get("loop").handler("check the deploy", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);

	assert.ok(text.includes('`loopPrompt` to "check the deploy"'), text);
	assert.ok(!text.includes('the /loop prompt"'), "no placeholder in place of the prompt");
	assert.ok(!text.includes("This iteration is waiting on an external event"), "the event gate is a condition, not a claim");
	assert.ok(text.includes("monitor_list"), "arm once: check for a running monitor first");
});

test("a scheduled tick of a self-paced chain gets the chain guidelines", async () => {
	const h = await start(makeHarness());
	await startSelfPaced(h);
	const chain = h.lastState().jobs.find((j) => j.kind === "wakeup");

	// The model reschedules, then the wakeup fires.
	await h.tools
		.get("schedule_wakeup")
		.execute("c", { delaySeconds: 60, prompt: "check the deploy" }, undefined, undefined, h.ctx);
	makeDue(h, chain.id);
	h.scheduler().tick();
	assert.equal(h.sent.length, 2, "the chain ticked");

	const event = runEvent(h.sent[1]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.ok(guidelinesOf(event).includes("schedule_wakeup"), "the tick's turn is told to schedule the next iteration");
	assert.ok(guidelinesOf(event).includes('"check the deploy"'), "with the chain's prompt");
});

test("a cron tick's turn gets no self-paced guidelines", async () => {
	const h = await start(makeHarness());
	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	const job = h.lastState().jobs[0];
	makeDue(h, job.id);
	h.scheduler().tick();

	const event = runEvent(h.sent[1]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.ok(!guidelinesOf(event).includes("schedule_wakeup"), guidelinesOf(event));
});
