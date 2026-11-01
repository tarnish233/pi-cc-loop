import assert from "node:assert/strict";
import test from "node:test";
import { guidelinesOf, makeHarness, runEvent, start, startSelfPaced } from "./harness.mjs";

const args = { delaySeconds: 600, reason: "waiting for CI", prompt: "check CI" };
const call = (name, id, input = {}) => ({ type: "toolCall", name, id, arguments: input });
const arm = (h, id = "c") => h.tools.get("schedule_wakeup").execute(id, args, undefined, undefined, h.ctx);

async function harness(t) {
	const h = await start(makeHarness());
	t.after(() => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx));
	return h;
}

test("wakeup remains model-visible, but is model-only rather than callable from codemode", async (t) => {
	const h = await harness(t);
	assert.equal(h.tools.get("schedule_wakeup").exposure, "model-only");
	assert.equal(h.tools.get("cron_create").exposure, undefined, "the ordinary tools keep their existing direct default");
	assert.equal((await arm(h)).terminate, true);
});

test("an arm in any multi-call assistant response is rejected before scheduling", async (t) => {
	const h = await harness(t);
	for (const batch of [
		[call("schedule_wakeup", "c", args), call("Monitor", "other")],
		[call("Monitor", "other"), call("schedule_wakeup", "c", args)],
		[call("schedule_wakeup", "c", args), call("schedule_wakeup", "other", { ...args, prompt: "another task" })],
	]) {
		h.setToolCalls(batch);
		await assert.rejects(() => arm(h), /only tool call.*not through codemode or in a batch/);
		assert.deepEqual(h.scheduler().list(), [], "the rejected call created no job");
		assert.deepEqual(h.lastState().jobs, [], "no pending wakeup was persisted");
	}
});

test("a rejected batch does not re-arm or mutate an existing chain", async (t) => {
	const h = await harness(t);
	const chain = await startSelfPaced(h, args.prompt, 1200);
	const before = structuredClone(h.scheduler().get(chain.id));
	const saved = JSON.stringify(h.lastState());
	h.setToolCalls([call("schedule_wakeup", "c", args), call("cron_list", "list")]);
	await assert.rejects(() => arm(h), /No wakeup was scheduled/);
	assert.deepEqual(h.scheduler().get(chain.id), before);
	assert.equal(JSON.stringify(h.lastState()), saved);
});

test("nested, stale and unverifiable arm calls fail closed", async (t) => {
	const h = await harness(t);
	h.setToolCalls([call("codemode", "parent", { code: "await tools.schedule_wakeup(...)" })]);
	await assert.rejects(() => arm(h, "parent/1"), /called directly/);
	h.setToolCalls([call("schedule_wakeup", "another-turn", args)]);
	await assert.rejects(() => arm(h), /called directly/);
	h.setToolCalls([]);
	await assert.rejects(() => arm(h), /called directly/);
	delete h.ctx.sessionManager.getBranch;
	await assert.rejects(() => arm(h), /called directly/);
	assert.deepEqual(h.scheduler().list(), []);
});

test("stopping in a batch still cancels the loop and permits a follow-up outcome", async (t) => {
	const h = await harness(t);
	await startSelfPaced(h, args.prompt, 1200);
	h.setToolCalls([call("schedule_wakeup", "c", { stop: true }), call("monitor_list", "list")]);
	const stopped = await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);
	assert.equal(stopped.terminate, undefined);
	assert.equal(stopped.structuredContent.stopped, true);
	assert.deepEqual(h.scheduler().list(), []);
});

test("a standalone call can be found after a sibling result from an earlier turn", async (t) => {
	const h = await harness(t);
	h.ctx.sessionManager.getBranch = () => [
		{ type: "message", message: { role: "assistant", content: [call("schedule_wakeup", "old", args), call("Monitor", "m")] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "m", content: [] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "CI is still running." }, call("schedule_wakeup", "c", args)] } },
		{ type: "custom", customType: "status", data: {} },
	];
	assert.equal((await arm(h)).terminate, true);
});

test("wakeup instructions require direct singleton calls and arm monitors before the final wakeup", async (t) => {
	const h = await harness(t);
	const description = h.tools.get("schedule_wakeup").description;
	assert.match(description, /only tool call in that assistant response/);
	assert.match(description, /never through codemode or in a batch/);
	await h.commands.get("loop").handler("check CI", h.ctx);
	const event = runEvent(h.sent.at(-1));
	await h.handlers.get("before_agent_start")(event, h.ctx);
	const selfPaced = guidelinesOf(event).split("## Self-paced (no interval)")[1];
	assert.ok(selfPaced.indexOf("arm `Monitor`") < selfPaced.indexOf("then call `schedule_wakeup`"));
	assert.match(selfPaced, /only tool call in that assistant response/);
});
