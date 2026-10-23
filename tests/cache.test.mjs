/**
 * Prompt-cache invariants. A provider caches the request by prefix (tools, then
 * system prompt, then messages), so an extension keeps the cache only if it
 * never changes anything before the end of the transcript:
 *
 *   - the system prompt: no per-run guidelines, no replacement prompt;
 *   - the tool set: every tool registered at load, never swapped or re-described;
 *   - earlier messages: no `context`-style hooks that rewrite history per request.
 *
 * What a run needs (the /loop rules) is appended as a message instead.
 */
import assert from "node:assert";
import test from "node:test";
import { createCron, makeDue, makeHarness, runEvent, runTurn, start, startSelfPaced } from "./harness.mjs";

/** Hooks that rewrite the request or the history it carries. */
const PREFIX_REWRITING_HOOKS = ["context", "context_with_system", "before_provider_request"];

function instrument(h) {
	const calls = { lateTools: [], loadoutChanges: [] };
	for (const method of ["setActiveTools", "setModel", "setThinkingLevel"]) {
		h.pi[method] = (...args) => calls.loadoutChanges.push({ method, args });
	}
	return calls;
}

/** Run a before_agent_start the way Pi does and report what it changed. */
async function startRun(h, sent) {
	const event = runEvent(sent);
	event.systemPromptOptions.selectedTools = ["read", "bash"];
	const before = JSON.stringify(event.systemPromptOptions);
	const result = await h.handlers.get("before_agent_start")(event, h.ctx);
	return { changed: JSON.stringify(event.systemPromptOptions) !== before, result };
}

test("no loop path changes the system prompt, the tool set or earlier messages", async () => {
	const h = makeHarness();
	const calls = instrument(h);
	await start(h);
	// Tools registered from here on would change the tool block mid-session.
	const registerTool = h.pi.registerTool;
	h.pi.registerTool = (tool) => {
		calls.lateTools.push(tool.name);
		registerTool(tool);
	};
	const toolsAtLoad = [...h.tools.values()].map((tool) => JSON.stringify([tool.name, tool.description, tool.parameters]));

	const runs = [];
	const check = async (label, sent) => {
		const { changed, result } = await startRun(h, sent);
		runs.push({ label, changed, systemPrompt: result?.systemPrompt !== undefined });
	};

	await h.commands.get("loop").handler("5m check the deploy", h.ctx);
	await check("/loop request", h.sent.at(-1));
	const job = await createCron(h, { cron: "* * * * *", prompt: "print hi" });
	makeDue(h, job.id);
	h.scheduler().tick();
	await check("cron tick", h.sent.at(-1));
	await runTurn(h);

	const chain = await startSelfPaced(h, "watch CI", 60);
	await runTurn(h);
	makeDue(h, chain.id);
	h.scheduler().tick();
	await check("self-paced tick", h.sent.at(-1));
	await check("monitor event", {
		kind: "custom",
		message: { role: "custom", customType: "Monitor", content: "monitor m1 \u00b7 ci\nFAILED", details: { loopPrompt: "watch CI" } },
	});
	await h.tools.get("schedule_wakeup").execute("c", { stop: true }, undefined, undefined, h.ctx);
	await h.tools.get("cron_list").execute("c", {}, undefined, undefined, h.ctx);
	await h.tools.get("cron_delete").execute("c", { id: job.id }, undefined, undefined, h.ctx);
	await h.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, h.ctx);
	await h.handlers.get("session_start")({ type: "session_start", reason: "reload" }, h.ctx);

	for (const run of runs) {
		assert.equal(run.changed, false, `${run.label}: systemPromptOptions untouched`);
		assert.equal(run.systemPrompt, false, `${run.label}: no replacement system prompt`);
	}
	assert.deepEqual(calls.lateTools, [], "every tool is registered at load");
	assert.deepEqual(calls.loadoutChanges, [], "no active-tool, model or thinking changes");
	assert.deepEqual(
		[...h.tools.values()].map((tool) => JSON.stringify([tool.name, tool.description, tool.parameters])),
		toolsAtLoad,
		"tool declarations are static",
	);
	for (const hook of PREFIX_REWRITING_HOOKS) {
		assert.ok(!h.handlers.has(hook), `no ${hook} handler: it would rewrite history per request`);
	}
});
