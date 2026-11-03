import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertJsonRoundTrip, findPiInstall } from "./helpers.mjs";

const install = findPiInstall();

// Each child sees only the selected release, never the user's other releases.
// Symlinks are read-only fixtures: no installs or writes through them.
for (const version of install.versions) {
	test(`validator helpers work with only Pi ${version} installed`, (t) => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-validator-only-"));
		t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
		const releases = path.join(agentDir, "install", "releases");
		fs.mkdirSync(releases, { recursive: true });
		const release = path.resolve(install.root, "..", "..", version);
		fs.symlinkSync(release, path.join(releases, version), "dir");
		const expectedEngine = fs.existsSync(path.join(release, "node_modules", "@earendil-works", "pi-schema", "dist", "index.js"))
			? "pi-schema" : "typebox";
		const script = `
			import assert from "node:assert/strict";
			import { pathToFileURL } from "node:url";
			import { findPiInstall, loadValidators } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
			const install = findPiInstall();
			assert.deepEqual(install.versions, [${JSON.stringify(version)}]);
			const { validateToolArguments, compile, engine } = await loadValidators();
			assert.equal(engine, ${JSON.stringify(expectedEngine)});
			const real = await import(pathToFileURL(install.piAiValidation).href);
			assert.equal(validateToolArguments, real.validateToolArguments, "use Pi's actual validator");
			const parameters = {
				type: "object",
				properties: {
					maxFires: { type: "integer", minimum: 1 },
					durable: { type: "boolean" },
					cron: { type: "string" },
					prompt: { type: "string" },
					reason: { type: "string" },
				},
				required: ["maxFires", "durable", "cron", "prompt", "reason"],
			};
			const tool = { name: "probe", parameters };
			const args = { maxFires: "3", durable: "true", cron: "*/5 * * * *", prompt: "check CI", reason: "waiting for CI" };
			const call = (arguments_) => validateToolArguments(tool, { name: tool.name, arguments: arguments_ });
			const parsed = call(args);
			assert.deepEqual(parsed, { maxFires: 3, durable: true, cron: "*/5 * * * *", prompt: "check CI", reason: "waiting for CI" });
			assert.equal(typeof parsed.maxFires, "number", "a string must not pass a coercion assertion");
			assert.equal(args.maxFires, "3", "Pi must not mutate the tool call");
			const validator = compile(parameters);
			assert.equal(validator.check(parsed), true);
			assert.equal(validator.check(args), false, "check must not coerce numeric strings");
			assert.equal(validator.check({ ...parsed, maxFires: 0 }), false);
			assert.equal(validator.check({}), false);
			assert.throws(() => call({ ...parsed, maxFires: 0 }), /Validation failed for tool "probe"/);
			assert.throws(() => call({}), /Validation failed for tool "probe"/);
		`;
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			env: {
				...process.env,
				PI_AGENT_DIR: agentDir,
				PI_CC_CONFIG_FILE: path.join(agentDir, "config.json"),
				PI_CC_EXTENSIONS_CONFIG_FILE: path.join(agentDir, "extensions-config.json"),
			},
			encoding: "utf8",
			timeout: 30_000,
		});
	});
}

test("the JSON guard accepts real TypeBox schemas without claiming hidden string metadata is JSON", async () => {
	const { Type } = await import(pathToFileURL(install.typebox).href);
	const schema = Type.Object({ count: Type.Optional(Type.Integer({ minimum: 1 })) });
	assertJsonRoundTrip(schema, "TypeBox schema");
	const copy = JSON.parse(JSON.stringify(schema));
	assertJsonRoundTrip(copy, "serialized schema");
	// TypeBox's optional/kind metadata is non-enumerable, not symbol-carried.
	assert.ok(Object.getOwnPropertyNames(schema.properties.count).some((key) =>
		!Object.getOwnPropertyDescriptor(schema.properties.count, key).enumerable));
});

test("the JSON guard rejects symbol metadata at the root, nested, and hidden", () => {
	const metadata = Symbol("metadata");
	const root = { type: "string", [metadata]: 123 };
	const nested = { type: "object", properties: { field: { type: "string", [metadata]: 123 } } };
	const hidden = { type: "string" };
	Object.defineProperty(hidden, metadata, { value: 123 });
	const hiddenChild = { type: "string" };
	Object.defineProperty(hiddenChild, "metadata", { value: hidden });
	for (const schema of [root, nested, hidden, hiddenChild]) {
		assert.throws(() => assertJsonRoundTrip(schema), /symbol keys JSON drops/);
		assertJsonRoundTrip(JSON.parse(JSON.stringify(schema)), "symbols removed by serialization");
	}
});

test("the JSON guard rejects enumerable data lost or changed by serialization", () => {
	for (const value of [{ count: undefined }, { count: NaN }, { count: Infinity }, { count: () => 3 }, { count: Symbol("count") }]) {
		assert.throws(() => assertJsonRoundTrip(value), /preserves JSON-visible data/);
	}
	assertJsonRoundTrip({ count: 3, nested: [{ active: true }], absent: null });
});
