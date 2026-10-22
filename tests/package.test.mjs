/**
 * The npm package must ship every source module: a module missing from the
 * tarball makes the extension fail to load after `pi install`.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { extensionDir } from "./helpers.mjs";

const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: extensionDir,
	encoding: "utf8",
});

test("every source module is in the npm package", { skip: pack.status !== 0 && "npm pack is not available" }, () => {
	const packed = new Set(JSON.parse(pack.stdout)[0].files.map((file) => file.path));
	const sources = fs.readdirSync(extensionDir).filter((name) => name.endsWith(".ts"));
	assert.ok(sources.length > 0);
	for (const source of sources) assert.ok(packed.has(source), `${source} is missing from the package`);
	for (const required of ["package.json", "README.md", "LICENSE"]) assert.ok(packed.has(required), required);
	assert.ok(![...packed].some((file) => file.startsWith("tests/")), "tests are not shipped");
});
