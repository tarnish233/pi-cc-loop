/**
 * L5: the loop.md delivery cache vs the model's actual context. Pi's real
 * _prepareRun compacts BEFORE before_agent_start, and tree navigation can
 * leave the branch without the full body: the current run must still see the
 * complete tasks, as a returned message collected into the run (no system
 * prompt change, no extra turn). The supplement is noncommitting, so a failed
 * run start still resends the full body on the next normal tick.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall } from "./helpers.mjs";
import { createCron, guidelinesOf, makeDue, makeHarness, runEvent, start, startSelfPaced, systemGuidelinesOf, textOf } from "./harness.mjs";

const { AgentSession, SessionManager } = await import(pathToFileURL(findPiInstall().piCodingAgent).href);
const { ExtensionRunner } = await import(
	pathToFileURL(path.join(path.dirname(findPiInstall().piCodingAgent), "core", "extensions", "runner.js")).href
);

const SENTINEL = "<<loop.md>>";
const TASK = "CONTEXT_TASK_MARKER";

function writeLoopFile(h, text = TASK) {
	const file = path.join(h.ctx.cwd, ".pi", "loop.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

/**
 * Pi 1.5.2's actual _prepareRun on a fixture session: compaction runs first,
 * and handler-returned messages are collected the way the real
 * emitBeforeAgentStart does (the audit's fake collector dropped them).
 */
function prepareRun(h, { compact = false } = {}) {
	const fixture = {
		_findLastAssistantMessage: () => ({ role: "assistant" }),
		_checkCompaction: async () => {
			if (compact) await h.handlers.get("session_compact")({}, h.ctx);
		},
		_baseSystemPromptOptions: { selectedTools: [] },
		_extensionRunner: {
			emitBeforeAgentStart: async (trigger, options) => {
				const result = await h.handlers.get("before_agent_start")(trigger, h.ctx);
				return { systemPromptOptions: options, messages: result?.message ? [result.message] : [] };
			},
		},
		getActiveToolNames: () => [],
		_pendingNextTurnMessages: [],
		_preparePromptAndToolLoadout: () => undefined,
	};
	return (message) => AgentSession.prototype._prepareRun.call(fixture, { messageType: "custom", message });
}

/** Fire a job now and return its tick message. */
function fire(h, jobId) {
	makeDue(h, jobId);
	h.scheduler().tick();
	return h.sent.at(-1).message;
}

/** Occurrences in the model-facing content only; `details` is extension metadata. */
const countOf = (messages, needle) =>
	messages
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n")
		.split(needle).length - 1;

/**
 * The same _prepareRun path, but with Pi's REAL before_agent_start collector
 * (ExtensionRunner.prototype.emitBeforeAgentStart), for receipt tests.
 */
function realPrepare(h, { compact = false } = {}) {
	const runner = {
		extensions: [{ path: "loop", handlers: new Map([["before_agent_start", [h.handlers.get("before_agent_start")]]]) }],
		createContext: () => h.ctx,
		emitError: (e) => {
			throw new Error(JSON.stringify(e));
		},
	};
	const fixture = {
		_findLastAssistantMessage: () => ({ role: "assistant" }),
		_checkCompaction: async () => {
			if (compact) await h.handlers.get("session_compact")({}, h.ctx);
		},
		_baseSystemPromptOptions: { selectedTools: [] },
		_extensionRunner: {
			emitBeforeAgentStart: (...args) => ExtensionRunner.prototype.emitBeforeAgentStart.call(runner, ...args),
		},
		getActiveToolNames: () => [],
		_pendingNextTurnMessages: [],
		_preparePromptAndToolLoadout: () => undefined,
	};
	return (message) => AgentSession.prototype._prepareRun.call(fixture, { messageType: "custom", message });
}

/**
 * Finalize prepared messages the way the host does: extension message_end
 * handlers first, then session persistence (agent-session._handleAgentEvent).
 */
async function finalize(h, sm, messages) {
	for (const message of messages) {
		await h.handlers.get("message_end")?.({ type: "message_end", message }, h.ctx);
		if (message.role === "custom") sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		else sm.appendMessage(message);
	}
}

test("pre-run compaction: the current tick's prepared context still carries the full tasks", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	assert.match(fire(h, job.id).content, new RegExp(TASK), "the first fire carries the tasks");

	const run = prepareRun(h, { compact: true });
	const messages = await run(fire(h, job.id));
	assert.match(messages[0].content, /no-op tick/, "the tick itself is still the short reminder");
	assert.equal(countOf(messages, TASK), 1, "the complete prepared context has the full tasks exactly once");
	assert.equal(messages[1].customType, "pi-cc-loop-rules", "the supplement rides along as a hidden message");
	assert.equal(messages[1].display, false);
});

test("the first full-body tick is not duplicated, even when compaction resets the cache", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	const first = fire(h, job.id);
	assert.match(first.content, new RegExp(TASK));
	// No compaction: nothing appended.
	const plain = await prepareRun(h)(first);
	assert.equal(plain.length, 1, "no supplement beside the full body");
	assert.equal(countOf(plain, TASK), 1);
	// Compaction before the same first tick: the body is already in the trigger.
	const compacted = await prepareRun(h, { compact: true })(first);
	assert.equal(countOf(compacted, TASK), 1, "no second copy of a body the tick already carries");
});

test("an unchanged normal cron tick gets no supplement", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	const second = fire(h, job.id);
	assert.match(second.content, /no-op tick/);
	const messages = await prepareRun(h)(second);
	assert.equal(messages.length, 1, "de-duplication unchanged: no extra message every minute");
	assert.equal(countOf(messages, TASK), 0);
});

test("a plain-prompt cron tick gets no supplement even after compaction", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	fire(h, job.id);
	const messages = await prepareRun(h, { compact: true })(fire(h, job.id));
	assert.equal(messages.length, 1);
});

test("a one-shot cron whose job is already removed still gets the full tasks", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const recurring = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, recurring.id);
	const oneShot = await createCron(h, { cron: "* * * * *", prompt: SENTINEL, recurring: false });
	const tick = fire(h, oneShot.id);
	assert.match(tick.content, /no-op tick/, "the one-shot fires a reminder");
	assert.equal(h.scheduler().get(oneShot.id), undefined, "the one-shot's job is gone before the run starts");
	const messages = await prepareRun(h, { compact: true })(tick);
	assert.equal(countOf(messages, TASK), 1, "the sentinel flag, not a scheduler lookup, drives the supplement");
});

test("the maintenance fallback is restored after compaction", async () => {
	const h = await start(makeHarness());
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	assert.match(fire(h, job.id).content, /You are running a scheduled maintenance pass/);
	const tick = fire(h, job.id);
	assert.match(tick.content, /maintenance pass/);
	assert.doesNotMatch(tick.content, /You are running a scheduled maintenance pass/);
	const messages = await prepareRun(h, { compact: true })(tick);
	assert.equal(countOf(messages, "You are running a scheduled maintenance pass."), 1);
});

test("tree navigation to a branch without the full body resends it on the next tick", async () => {
	const h = await start(makeHarness());
	const sm = SessionManager.inMemory(h.ctx.cwd);
	h.ctx.sessionManager = sm;
	const old = sm.appendMessage({ role: "user", content: "before loop", timestamp: Date.now() });
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	const first = fire(h, job.id);
	sm.appendCustomMessageEntry(first.customType, first.content, first.display, first.details);
	sm.branch(old);
	await h.handlers.get("session_before_tree")({ preparation: { targetId: old } }, h.ctx);
	await h.handlers.get("session_tree")({ newLeafId: old }, h.ctx);
	assert.ok(!JSON.stringify(sm.buildSessionContext().messages).includes(TASK), "the branch lost the full body");
	assert.match(fire(h, job.id).content, new RegExp(TASK), "the next tick resends the full tasks");
});

test("session_before_tree alone resets: a cancelled navigation costs one conservative resend", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	// An extension loaded earlier may start a model from its session_tree
	// handler; the reset must already have happened before navigation.
	await h.handlers.get("session_before_tree")({ preparation: { targetId: "x" } }, h.ctx);
	assert.match(fire(h, job.id).content, new RegExp(TASK), "the full body is resent once");
	assert.match(fire(h, job.id).content, /no-op tick/, "and remembered again afterwards");
});

test("a failed run start after a supplement still resends the full body on the next tick", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	const tick = fire(h, job.id);
	const messages = await prepareRun(h, { compact: true })(tick);
	assert.equal(countOf(messages, TASK), 1, "the run was given the full tasks");
	// The run never starts (startup failure): the supplement must not have
	// marked the body as delivered.
	assert.match(fire(h, job.id).content, new RegExp(TASK), "the next normal tick resends the full body");
	assert.match(fire(h, job.id).content, /no-op tick/, "once delivered, the reminder returns");
});

test("an active self-paced tick gets its rules and the full tasks after compaction", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const chain = await startSelfPaced(h, SENTINEL, 600);
	fire(h, chain.id);
	const tick = fire(h, chain.id);
	const messages = await prepareRun(h, { compact: true })(tick);
	assert.equal(countOf(messages, TASK), 1);
	assert.match(messages[1].content, /A self-paced `\/loop` is running/, "the loop rules survive alongside the tasks");
	// The same path via the raw event: the system prompt stays untouched.
	await h.handlers.get("session_compact")({}, h.ctx);
	const event = runEvent({ kind: "custom", message: tick });
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.equal(systemGuidelinesOf(event), "");
	assert.equal(event.result?.systemPrompt, undefined);
	assert.ok(guidelinesOf(event).includes(TASK));
});

test("a retired chain's queued tick gets no supplement and stays cancelled", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const chain = await startSelfPaced(h, SENTINEL, 600);
	const tick = fire(h, chain.id);
	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	await h.handlers.get("session_compact")({}, h.ctx);
	const event = runEvent({ kind: "custom", message: tick });
	await h.handlers.get("before_agent_start")(event, h.ctx);
	assert.equal(event.result?.message, undefined, "a stopped chain is not instructed back to life");
	await assert.rejects(
		() => h.tools.get("schedule_wakeup").execute("c", { delaySeconds: 600, reason: "waiting", prompt: "reworded task" }, undefined, undefined, h.ctx),
		/must not be rescheduled/,
		"the phase1 cancelled-run protection survives",
	);
});

test("a Monitor of an active sentinel chain restores missing tasks; a stopped one stays barred", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const chain = await startSelfPaced(h, SENTINEL, 600);
	fire(h, chain.id);
	const monitor = (loopPrompt) => ({
		kind: "custom",
		message: { role: "custom", customType: "Monitor", content: "monitor m1 · loop\nEVENT", details: { loopPrompt } },
	});
	await h.handlers.get("session_compact")({}, h.ctx);
	const active = runEvent(monitor(SENTINEL));
	await h.handlers.get("before_agent_start")(active, h.ctx);
	assert.ok(guidelinesOf(active).includes(TASK), "the monitor run sees the full tasks again");
	assert.doesNotMatch(guidelinesOf(active), /A self-paced `\/loop` is running/, "no re-arm rules from a monitor event");
	assert.equal(systemGuidelinesOf(active), "");

	await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	await h.handlers.get("session_compact")({}, h.ctx);
	const stopped = runEvent(monitor(SENTINEL));
	await h.handlers.get("before_agent_start")(stopped, h.ctx);
	assert.equal(stopped.result?.message, undefined, "a stopped chain gets no instructions");
	await assert.rejects(
		() => h.tools.get("schedule_wakeup").execute("c", { delaySeconds: 600, reason: "waiting", prompt: "reworded task" }, undefined, undefined, h.ctx),
		/must not be rescheduled/,
		"the stopped memo still bars a re-arm",
	);

	// No chain and no memo: a genuinely new loop, not a cancelled run.
	const unknown = runEvent(monitor("a never-seen task"));
	await h.handlers.get("before_agent_start")(unknown, h.ctx);
	assert.equal(unknown.result?.message, undefined);
	const armed = await h.tools.get("schedule_wakeup").execute("c", { delaySeconds: 600, reason: "waiting", prompt: "a never-seen task" }, undefined, undefined, h.ctx);
	assert.equal(armed.details.stopped, false, "an unknown loop is not treated as stopped");
});
// ------------------------------------------------- supplement receipts

test("repeated successful Monitor runs append the full body exactly once, even while the fallback is rearmed", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const chain = await startSelfPaced(h, SENTINEL, 600);
	const sm = SessionManager.inMemory(h.ctx.cwd);
	h.ctx.sessionManager = sm;
	const old = sm.appendMessage({ role: "user", content: "before loop", timestamp: Date.now() });
	const tick = fire(h, chain.id);
	sm.appendCustomMessageEntry(tick.customType, tick.content, tick.display, tick.details);
	// One compaction wipes the body from the branch; only Monitor runs follow.
	sm.branch(old);
	await h.handlers.get("session_compact")({}, h.ctx);
	const run = realPrepare(h);
	for (let i = 1; i <= 4; i++) {
		const prepared = await run({
			role: "custom",
			customType: "Monitor",
			content: `monitor m1 · loop\nEVENT ${i}`,
			display: true,
			details: { loopPrompt: SENTINEL },
			timestamp: Date.now(),
		});
		assert.equal(countOf(prepared, TASK), i === 1 ? 1 : 0, `run ${i}: only the first supplement carries the body`);
		assert.equal(countOf(sm.buildSessionContext().messages, TASK), i === 1 ? 0 : 1, "before this run's persistence");
		if (i === 1) {
			const receipt = prepared[1].details?.loopFileReceipt;
			assert.equal(typeof receipt, "number", "a primitive JSON-safe token, not the body");
			assert.deepEqual(JSON.parse(JSON.stringify(prepared[1].details)), prepared[1].details);
		}
		await finalize(h, sm, prepared);
		assert.equal(countOf(sm.buildSessionContext().messages, TASK), 1, "exactly one persisted copy throughout");
		// The model re-arms the fallback every run; the chain stays active. The
		// real branch needs the finalized standalone assistant batch the tool checks.
		sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "schedule_wakeup", arguments: {} }], timestamp: Date.now() });
		await h.tools.get("schedule_wakeup").execute("c", { delaySeconds: 600, reason: "still watching", prompt: SENTINEL }, undefined, undefined, h.ctx);
		assert.ok(chain.scheduledFor > Date.now(), "the fallback keeps being rearmed");
	}
	assert.equal(chain.tickCount, 1, "no normal tick was needed to stop the repeats");
});

test("a file edit between preparation and message_end commits the captured snapshot, not the new file", async () => {
	const h = await start(makeHarness());
	const file = writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	const prepared = await prepareRun(h, { compact: true })(fire(h, job.id));
	fs.writeFileSync(file, "EDITED_TASK_BODY");
	await finalize(h, SessionManager.inMemory(h.ctx.cwd), prepared);
	// The receipt acknowledged the OLD snapshot, so the edited body goes out in full.
	const next = fire(h, job.id);
	assert.match(next.content, /EDITED_TASK_BODY/);
	assert.doesNotMatch(next.content, new RegExp(TASK), "a fresh read at receipt time would have skipped this resend");
	assert.match(fire(h, job.id).content, /no-op tick/, "the changed body is remembered in turn");
});

test("a reset between preparation and a late message_end voids the outstanding receipt", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	const prepared = await prepareRun(h, { compact: true })(fire(h, job.id));
	await h.handlers.get("session_compact")({}, h.ctx);
	await finalize(h, SessionManager.inMemory(h.ctx.cwd), prepared);
	assert.match(fire(h, job.id).content, new RegExp(TASK), "the voided receipt cannot mark the snapshot delivered");
});

test("only the latest outstanding receipt can acknowledge; a stale token is ignored", async () => {
	const h = await start(makeHarness());
	writeLoopFile(h);
	const job = await createCron(h, { cron: "* * * * *", prompt: SENTINEL });
	fire(h, job.id);
	const reminder = fire(h, job.id);
	// Preparations without a finalize: each newer peek replaces the receipt.
	const first = await prepareRun(h, { compact: true })(reminder);
	const second = await prepareRun(h)(reminder);
	assert.notEqual(first[1].details.loopFileReceipt, second[1].details.loopFileReceipt);
	await h.handlers.get("message_end")({ type: "message_end", message: first[1] }, h.ctx);
	const third = await prepareRun(h)(reminder);
	assert.equal(countOf(third, TASK), 1, "the stale receipt committed nothing: a supplement is still offered");
	await h.handlers.get("message_end")({ type: "message_end", message: second[1] }, h.ctx);
	const fourth = await prepareRun(h)(reminder);
	assert.equal(countOf(fourth, TASK), 1, "the superseded receipt is stale too");
	await h.handlers.get("message_end")({ type: "message_end", message: fourth[1] }, h.ctx);
	assert.match(fire(h, job.id).content, /no-op tick/, "the latest receipt commits the snapshot");
});
