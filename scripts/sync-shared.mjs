#!/usr/bin/env node
/** pi-cc-loop is the source for the files copied into its three sibling repos. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siblings = ["pi-cc-monitor", "pi-cc-plugins", "pi-cc-compaction"];
const check = process.argv.includes("--check");
let different = false;
for (const name of siblings) {
	const target = path.resolve(source, "..", name);
	if (!fs.existsSync(path.join(target, "package.json"))) continue;
	for (const file of name === "pi-cc-monitor" ? ["config.ts", "settings.ts", "render.ts"] : ["config.ts", "settings.ts"]) {
		const from = path.join(source, file);
		const to = path.join(target, file);
		if (fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to))) continue;
		different = true;
		if (!check) fs.copyFileSync(from, to);
		console.log(`${check ? "Out of sync" : "Synced"}: ${name}/${file}`);
	}
}
if (check && different) process.exitCode = 1;
