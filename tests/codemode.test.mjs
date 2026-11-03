import assert from "node:assert/strict";
import test from "node:test";
import { assertJsonRoundTrip, loadValidators } from "./helpers.mjs";
import { makeHarness, start } from "./harness.mjs";

// Use the installation's engine: TypeBox before 1.5.0, pi-schema since 1.5.0.
const { compile } = await loadValidators();

const check = (schema, value) => compile(schema).check(value);

test("the callable cron tools give scripts structuredContent matching their outputSchema", async () => {
	const h = await start(makeHarness());
	const created = await h.tools.get("cron_create").execute("c", { cron: "*/5 * * * *", prompt: "check the deploy" }, undefined, undefined, h.ctx);
	const calls = [
		["cron_create", { cron: "0 9 * * *", prompt: "morning report" }, created],
		["cron_list", {}, created],
		["cron_delete", { id: created.structuredContent.id }, created],
	];
	for (const [name, args, first] of calls) {
		const tool = h.tools.get(name);
		assert.ok(tool.outputSchema, `${name} declares an outputSchema`);
		const result = first && name === "cron_create" ? first : await tool.execute("c", args, undefined, undefined, h.ctx);
		assert.ok(result.structuredContent, `${name} returns structuredContent`);
		assert.equal(check(tool.outputSchema, result.structuredContent), true, `${name}: ${JSON.stringify(result.structuredContent)}`);
		assertJsonRoundTrip(result.structuredContent, `${name}.structuredContent`);
	}
});

test("a script gets the ids and times as values, not as text to parse", async () => {
	const h = await start(makeHarness());
	const created = await h.tools.get("cron_create").execute("c", { cron: "*/5 * * * *", prompt: "check the deploy" }, undefined, undefined, h.ctx);
	assert.match(created.details.id, /^\w+$/);
	assert.equal(created.structuredContent.id, created.details.id);
	assert.equal(typeof created.structuredContent.nextFireAt, "number");
	assert.equal(created.structuredContent.prompt, "check the deploy");
	assert.equal(created.structuredContent.runsHere, true);

	const list = await h.tools.get("cron_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.deepEqual(list.structuredContent.jobs.map((job) => job.id), [created.details.id]);
	assert.equal(list.structuredContent.jobs[0].kind, "cron");
	assert.equal(list.structuredContent.jobs[0].maxFires, undefined, "a field with no value is left out");

	const stopped = await h.tools.get("cron_delete").execute("c", { id: created.details.id }, undefined, undefined, h.ctx);
	assert.deepEqual(stopped.structuredContent, { cancelled: true, id: created.details.id });
});

test("a wakeup reports its schedule as values", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("schedule_wakeup").execute("c", { delaySeconds: 600, reason: "waiting for CI", prompt: "check CI" }, undefined, undefined, h.ctx);
	assert.equal(armed.structuredContent.stopped, false);
	assert.equal(armed.structuredContent.clampedDelaySeconds, 600);
	assert.equal(armed.structuredContent.wasClamped, false);
	assert.ok(armed.structuredContent.scheduledFor > Date.now());
	assert.equal(typeof armed.structuredContent.id, "string");
	const tool = h.tools.get("schedule_wakeup");
	assert.equal(tool.exposure, "model-only", "the structured output does not make a control tool script-callable");
	assert.equal(check(tool.outputSchema, armed.structuredContent), true);
	const stopped = await tool.execute("c", { stop: true }, undefined, undefined, h.ctx);
	assert.equal(check(tool.outputSchema, stopped.structuredContent), true);
});
