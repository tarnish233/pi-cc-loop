/**
 * Pi's validator, not TypeBox's, decides whether the model's arguments reach
 * `execute()`.
 *
 * Pi 1.5.0 moved tool-argument validation from TypeBox to `@earendil-works/pi-schema`,
 * and TypeBox features outside JSON Schema stopped applying. These tests run the
 * documented arguments of every tool through the exact function Pi calls, so a
 * later change to that validator (or a TypeBox-only feature creeping into a
 * schema) fails here instead of reaching the model as a validation error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertJsonRoundTrip, jsonSchemaProblems, loadValidators, unsupportedTypeboxUsages } from "./helpers.mjs";
import { makeHarness, start } from "./harness.mjs";

const { validateToolArguments, engine } = await loadValidators();

/** The arguments a model sends for one tool, and what coercion should make of them. */
const ARGUMENT_CASES = {
	cron_create: [
		["plain", { cron: "*/5 * * * *", prompt: "check the deploy" }],
		[
			"a model's strings for numbers and booleans",
			{ cron: "0 9 * * *", prompt: "morning report", recurring: "false", durable: "true", maxFires: "3" },
			{ cron: "0 9 * * *", prompt: "morning report", recurring: false, durable: true, maxFires: 3 },
		],
	],
	cron_delete: [["plain", { id: "job_1" }]],
	cron_list: [["no arguments", {}]],
	schedule_wakeup: [
		["self-paced", { delaySeconds: "120", reason: "waiting for CI", prompt: "check CI" }, { delaySeconds: 120, reason: "waiting for CI", prompt: "check CI" }],
		["stop", { stop: "true", reason: "done" }, { stop: true, reason: "done" }],
	],
};

/** Arguments that must not reach `execute()`, and the message the model sees. */
const REJECTED = [
	["cron_create", {}, engine === "pi-schema" ? /- cron: missing/ : /- cron: must have required properties/],
	["cron_create", { cron: "*/5 * * * *", prompt: "x", maxFires: 0 }, engine === "pi-schema" ? /- maxFires: expected >= 1/ : /- maxFires: must be >= 1/],
	["cron_delete", {}, engine === "pi-schema" ? /- id: missing/ : /- id: must have required properties/],
];

const call = (tool, args) =>
	validateToolArguments(tool, { type: "toolCall", id: "t", name: tool.name, arguments: args });

test("every tool's parameters take the arguments a model sends, with Pi's coercion", async () => {
	const h = await start(makeHarness());
	assert.deepEqual(
		[...h.tools.keys()].sort(),
		Object.keys(ARGUMENT_CASES).sort(),
		"each registered tool has argument cases",
	);
	for (const [name, cases] of Object.entries(ARGUMENT_CASES)) {
		const tool = h.tools.get(name);
		for (const [label, args, coerced] of cases) {
			const parsed = call(tool, args);
			assert.deepEqual(parsed, coerced ?? args, `${name} [${label}]`);
		}
	}
});

test("arguments Pi rejects never reach execute(), with Pi's error format", async () => {
	const h = await start(makeHarness());
	for (const [name, args, message] of REJECTED) {
		assert.throws(() => call(h.tools.get(name), args), message, `${name}: ${JSON.stringify(args)}`);
	}
});

test("tool schemas stay inside JSON Schema, which is all Pi validates", async () => {
	const h = await start(makeHarness());
	for (const [name, tool] of h.tools) {
		for (const key of ["parameters", "outputSchema"]) {
			const schema = tool[key];
			if (!schema) continue;
			assert.deepEqual(jsonSchemaProblems(schema), [], `${name}.${key}`);
			assertJsonRoundTrip(schema, `${name}.${key}`);
		}
	}
});

test("the sources use no TypeBox feature Pi's validator ignores", () => {
	assert.deepEqual(unsupportedTypeboxUsages(), [], "Type.Refine/BigInt/Undefined/Void/Codec, Format.Set");
});