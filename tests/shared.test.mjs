/**
 * render.ts and config.ts are copied verbatim between pi-cc-loop
 * and pi-cc-monitor (they are separate npm packages). This test fails when the
 * copies drift apart; it is skipped when the sibling checkout is missing.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { extensionDir, siblingExtensionDir } from "./helpers.mjs";

const self = path.basename(extensionDir);
const sibling = siblingExtensionDir(self === "pi-cc-loop" ? "pi-cc-monitor" : "pi-cc-loop");
const hasSibling = fs.existsSync(path.join(sibling, "package.json"));

for (const file of ["render.ts", "config.ts"]) {
	test(`${file} is identical in both packages`, { skip: !hasSibling && "sibling checkout not found" }, () => {
		const mine = fs.readFileSync(path.join(extensionDir, file), "utf8");
		const theirs = fs.readFileSync(path.join(sibling, file), "utf8");
		assert.ok(mine === theirs, `${file} differs from ${path.join(sibling, file)}; copy the newer one over`);
	});
}
