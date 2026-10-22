/**
 * The /loop command is a skill, not an imperative scheduler: every request goes
 * in as an ordinary user message and the model drives the cron_* tools. These
 * tests cover the command surface, the injected messages and the tick lanes.
 */
import assert from "node:assert";
import test from "node:test";
import {
	createCron,
	guidelinesOf,
	makeDue,
	makeHarness,
	runEvent,
	runTurn,
	start,
	startSelfPaced,
} from "./harness.mjs";

const loop = (h) => h.commands.get("loop");

test("/loop becomes a normal user message and creates nothing itself", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("5m check the deploy", h.ctx);

	assert.equal(h.sent.length, 1, "one message");
	assert.equal(h.sent[0].kind, "user", "an ordinary user message, not a custom block");
	assert.equal(h.sent[0].content, "/loop 5m check the deploy", "the request is kept verbatim");
	assert.equal(h.scheduler().size, 0, "the model creates the job, not the command");
});

test("a fixed interval is explained to the model, including the no-wakeup rule", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("5m check the deploy", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.match(text, /Fixed interval/);
	assert.match(text, /cron_create/);
	assert.match(text, /Never call `schedule_wakeup` for this loop/);
	assert.ok(text.includes('"5m check the deploy"'), "the request is quoted for the model");
});

test("a request without an interval is explained as self-paced", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("check the deploy", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.match(text, /Self-paced/);
	assert.match(text, /schedule_wakeup/);
	assert.match(text, /Monitor/);
});

test("a bare /loop points at loop.md", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("", h.ctx);
	assert.equal(h.sent[0].content, "/loop");
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.match(guidelinesOf(event), /<<loop\.md>>/);
});

test("stop and status are forwarded too, and tell the model which tools to use", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("stop", h.ctx);
	assert.equal(h.sent[0].content, "/loop stop");
	const stopEvent = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(stopEvent, h.ctx);
	assert.match(guidelinesOf(stopEvent), /cron_list/);
	assert.match(guidelinesOf(stopEvent), /cron_delete/);

	await loop(h).handler("status", h.ctx);
	const statusEvent = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(statusEvent, h.ctx);
	assert.match(guidelinesOf(statusEvent), /cron_list/);
});

test("settings and help stay in code: they are not loop requests", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("settings", h.ctx);
	assert.equal(h.sent.length, 0, "no message to the model");
	assert.match(h.notifications.at(-1).message, /pi-cc settings/);

	await loop(h).handler("help", h.ctx);
	assert.equal(h.sent.length, 0);
	assert.match(h.notifications.at(-1).message, /\/loop \[interval\]/);
});

test("the run's rules do not leak into the next turn", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("5m check the deploy", h.ctx);
	const first = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(first, h.ctx);
	assert.match(guidelinesOf(first), /Fixed interval/);

	// A turn the user starts afterwards gets nothing from us.
	const userTurn = { messageType: "user", prompt: "what is this loop doing?", systemPromptOptions: { promptGuidelines: [] } };
	await h.handlers.get("before_agent_start")(userTurn, h.ctx);
	assert.equal(guidelinesOf(userTurn), "");
});

test("a scheduled fire is a user message that says it fires on its own", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	makeDue(h, job.id);
	h.scheduler().tick();

	const sent = h.sent.at(-1);
	assert.equal(sent.kind, "user", "ticks are user messages too");
	assert.match(sent.content, /^\[scheduled task \w+ \u00b7 Every minute/);
	assert.match(sent.content, /do not call schedule_wakeup/);
	assert.equal(sent.options.deliverAs, "followUp", "between turns, low priority");

	const event = runEvent(sent);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.match(guidelinesOf(event), /fixed-interval \/loop/);
});

test("a self-paced tick keeps the loop framing and the reschedule rules", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 60);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();

	const sent = h.sent.at(-1);
	assert.match(sent.content, /^\[loop tick #1 /, "the first fire is tick #1");
	const event = runEvent(sent);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const text = guidelinesOf(event);
	assert.match(text, /A self-paced `\/loop` is running/);
	assert.ok(text.includes('"watch CI"'), "the chain's prompt is handed back");
});

test("the immediate /loop turn also gets loop.md content when the prompt needs it", async () => {
	const h = await start(makeHarness());
	await loop(h).handler("10m", h.ctx);
	const event = runEvent(h.sent[0]);
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.match(guidelinesOf(event), /loop\.md/);
});

test("the Monitor guidance names the real loop prompt", async () => {
	const h = await start(makeHarness());
	h.setRegisteredTools(["Monitor"]);
	const chain = await startSelfPaced(h, "watch CI", 60);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	const event = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.ok(guidelinesOf(event).includes('"watch CI"'));
	assert.match(guidelinesOf(event), /Monitor/);
});

test("the Monitor guidance is skipped when the tool is absent", async () => {
	const h = await start(makeHarness());
	const chain = await startSelfPaced(h, "watch CI", 60);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	const event = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.ok(!guidelinesOf(event).includes("`Monitor` tool"));
});

test("a tick waits until the agent is idle", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	h.state.idle = false;
	makeDue(h, job.id);
	const before = h.sent.length;
	h.scheduler().tick();
	assert.equal(h.sent.length, before, "nothing is delivered while busy");
	assert.ok(h.scheduler().get(job.id)?.pending, "the fire is remembered");

	h.state.idle = true;
	h.scheduler().tick();
	assert.equal(h.sent.length, before + 1, "delivered once the agent is idle");
});

test("missed fires coalesce into one tick", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	h.state.idle = false;
	makeDue(h, job.id);
	h.scheduler().tick();
	makeDue(h, job.id);
	h.scheduler().tick();
	h.state.idle = true;
	const before = h.sent.length;
	h.scheduler().tick();
	assert.equal(h.sent.length, before + 1);
});

test("cron fires add no session entries; structural changes do", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	const afterCreate = h.appended.length;
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.equal(h.appended.length, afterCreate, "a fire is not a state change");

	await h.tools.get("cron_delete").execute("d", { id: job.id }, undefined, undefined, h.ctx);
	assert.ok(h.appended.length > afterCreate, "removing a job is persisted");
});
