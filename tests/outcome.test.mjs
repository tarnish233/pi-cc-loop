import assert from "node:assert/strict";
import test from "node:test";
import { createCron, makeDue, makeHarness, runTurn, start, startSelfPaced } from "./harness.mjs";

const outcomes = (h) => h.sent.filter((entry) => entry.message?.customType === "pi-cc-loop-outcome");

async function harness(t) {
	const previous = process.env.PI_LOOP_MAX_AGE_DAYS;
	process.env.PI_LOOP_MAX_AGE_DAYS = "7";
	const h = await start(makeHarness());
	t.after(async () => {
		await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);
		if (previous === undefined) delete process.env.PI_LOOP_MAX_AGE_DAYS;
		else process.env.PI_LOOP_MAX_AGE_DAYS = previous;
	});
	return h;
}

function assertWake(h, pattern) {
	const messages = outcomes(h);
	assert.equal(messages.length, 1, "the terminal outcome is announced once");
	assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(messages[0].message.content, pattern);
	// The details name why the loop ended so the card can title itself; `ended`
	// remains the flag the renderer and tests key on.
	assert.equal(messages[0].message.details.ended, true);
	assert.ok(["stopped", "expired", "dispatch-failed"].includes(messages[0].message.details.cause), JSON.stringify(messages[0].message.details));
}

test("recurring expiry sends its own wakeup after the final accepted tick", async (t) => {
	const h = await harness(t);
	const job = await createCron(h, { cron: "*/5 * * * *", prompt: "check CI" });
	h.scheduler().update(job.id, { createdAt: Date.now() - 8 * 86_400_000 });
	makeDue(h, job.id);
	h.scheduler().tick();
	assert.equal(h.scheduler().get(job.id), undefined);
	assert.equal(h.sent.filter((entry) => entry.message?.customType === "pi-cc-loop-tick").length, 1);
	assertWake(h, /ran its final time.*Do not reschedule/);
	h.scheduler().tick();
	assert.equal(outcomes(h).length, 1, "the deleted job cannot announce expiry again");
});

test("a failed delivery wakes the model without consuming or deleting the one-shot", async (t) => {
	const h = await harness(t);
	const job = await createCron(h, { cron: "7 * * * *", prompt: "check CI", recurring: false });
	const send = h.pi.sendMessage;
	h.pi.sendMessage = (message, options) => {
		if (message.customType === "pi-cc-loop-tick") throw new Error("delivery rejected");
		send(message, options);
	};
	makeDue(h, job.id);
	assert.doesNotThrow(() => h.scheduler().tick());
	assert.ok(h.scheduler().get(job.id));
	assert.equal(h.scheduler().get(job.id).fireCount, undefined);
	assertWake(h, /failed to deliver \(delivery rejected\).*remains due for retry/);
});

test("stopping a self-paced chain announces the outcome and keeps late re-arms blocked", async (t) => {
	const h = await harness(t);
	const chain = await startSelfPaced(h, "watch CI", 1200);
	const result = await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	assert.equal(result.details.cancelled, true);
	assert.equal(h.scheduler().get(chain.id), undefined);
	assertWake(h, /stopped.*external runner jobs were not cancelled.*Do not reschedule this loop, re-arm those observations or resubmit/);
	await assert.rejects(() => startSelfPaced(h, "watch CI", 1200), /was stopped/);
});

test("ending a chain through schedule_wakeup also requests a follow-up response", async (t) => {
	const h = await harness(t);
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);
	assert.equal(h.scheduler().get(chain.id), undefined);
	assertWake(h, /stopped by the agent/);
});

test("Esc cancels the chain without a terminal wakeup that restarts the aborted reply", async (t) => {
	const h = await harness(t);
	const chain = await startSelfPaced(h, "watch CI", 1200);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await runTurn(h, { aborted: true, start: h.sent.at(-1) });
	assert.equal(h.scheduler().get(chain.id), undefined);
	assert.deepEqual(outcomes(h), []);
});

test("a stale sender cannot make stopping a chain fail or leave it armed", async (t) => {
	const h = await harness(t);
	const chain = await startSelfPaced(h, "watch CI", 1200);
	h.pi.sendMessage = () => { throw new Error("session replaced"); };
	const result = await h.tools.get("cron_delete").execute("c", { id: chain.id }, undefined, undefined, h.ctx);
	assert.equal(result.details.cancelled, true);
	assert.equal(h.scheduler().get(chain.id), undefined);
});
