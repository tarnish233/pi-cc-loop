import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeHarness } from "./harness.mjs";
import { loadModule } from "./helpers.mjs";

const { registerTaskProvider } = await loadModule("tasks.ts");

test("stop result messages strip terminal controls, bidi overrides, and embedded newlines", async () => {
	const previousCwd = process.cwd();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-stop-sanitization-"));
	const h = makeHarness(cwd);
	let panel;
	const theme = { fg: (_token, text) => text, bold: (text) => text };
	const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {} };
	const keybindings = {
		matches: (data, action) => action === "tui.select.cancel" && data === "\x1b",
	};
	h.ctx.ui.custom = (factory) => new Promise((resolve) => {
		panel = factory(tui, theme, keybindings, (value) => {
			panel.dispose();
			resolve(value);
		});
	});
	const registration = registerTaskProvider(h.pi, {
		id: "monitor",
		label: "Monitor",
		list: () => [{ id: "safe-stop", title: "test monitor", state: "running", active: true }],
		stop: () => ({
			stopped: true,
			message: "Stopped (\x1b]0;test-title\x07\x1b[31msafe text\x1b[0m\u202e\nsecond line).",
		}),
	});
	try {
		const shown = h.commands.get("cc-tasks").handler("", h.ctx);
		panel.handleInput("x");
		panel.handleInput("y");
		await Promise.resolve();
		await Promise.resolve();
		const lines = panel.render(100);
		const rendered = lines.join("\n");
		assert.equal(rendered.includes("\x1b"), false, "provider notices cannot inject terminal sequences");
		assert.equal(rendered.includes("\u202e"), false, "provider notices cannot reverse displayed text");
		assert.ok(lines.every((line) => !line.includes("\n")), "notice newlines cannot escape a rendered row");
		assert.match(rendered, /safe text second line/);
		assert.deepEqual(h.sent, [], "rendering notices never sends model messages");
		panel.handleInput("\x1b");
		await shown;
	} finally {
		registration.close();
		panel?.dispose();
		process.chdir(previousCwd);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
