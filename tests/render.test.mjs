/**
 * Rendering tests: a scheduled fire draws Claude Code's block, and the
 * provenance line addressed to the model never reaches the reader.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
function makeTheme() {
	const bgCalls = { count: 0 };
	return {
		bgCalls,
		theme: {
			fg: (_color, text) => text,
			bg: (_color, text) => {
				bgCalls.count += 1;
				return text;
			},
			bold: (text) => text,
		},
	};
}

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-render-"));
	process.chdir(workdir);

	const renderers = new Map();
	const tools = new Map();
	const handlers = new Map();

	const pi = {
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerToolRenderer() {},
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
		events: { emit() {}, on() { return () => {}; } },
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	mod.default(pi);
	return { renderers, tools, handlers };
}

function render(renderer, message, expanded) {
	const { theme, bgCalls } = makeTheme();
	const component = renderer(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(100);
	return { text: lines.join("\n"), lines, bgCalls };
}

function tickMessage(content, details = {}) {
	return {
		role: "custom",
		customType: "pi-cc-loop-tick",
		display: true,
		content,
		details: { tickCount: 7, ...details },
		timestamp: Date.now(),
	};
}







test("clock times read like Claude Code's '6:16pm'", async () => {
	const { formatClock } = await loadModule("renderers.ts");
	assert.equal(formatClock(new Date(2026, 9, 22, 18, 16).getTime()), "6:16pm");
	assert.equal(formatClock(new Date(2026, 9, 22, 0, 5).getTime()), "12:05am");
	assert.equal(formatClock(new Date(2026, 9, 22, 12, 0).getTime()), "12:00pm");
	assert.equal(formatClock(new Date(2026, 9, 22, 9, 3).getTime()), "9:03am");
	assert.equal(formatClock(undefined), "unknown");
});

test("a scheduled fire draws Claude Code's block, without the provenance line", async () => {
	const { renderers } = makeHarness();
	const message = tickMessage(
		"[scheduled task 91e7u72h \u00b7 Every minute \u00b7 started by the schedule, not typed by the user; it fires the next tick on its own, so do not call schedule_wakeup]\nprint hi",
		{ kind: "cron", jobId: "91e7u72h", cron: "* * * * *", prompt: "print hi" },
	);
	const { text } = render(renderers.get("pi-cc-loop-tick"), message, false);
	assert.match(text, /\u273b Running scheduled task \u00b7 \d{1,2}:\d{2}(am|pm)/);
	assert.match(text, /print hi/);
	assert.ok(!text.includes("[scheduled task"), "the envelope is for the model only");
	assert.ok(!text.includes("schedule_wakeup"), "and so is the instruction");
});

test("a self-paced tick is a loop, not a scheduled task", async () => {
	const { renderers } = makeHarness();
	const message = tickMessage("[loop tick #7 \u00b7 scheduled by /loop, not typed by the user]\nwatch CI", {
		kind: "wakeup",
		jobId: "abc",
		prompt: "watch CI",
	});
	const { text } = render(renderers.get("pi-cc-loop-tick"), message, false);
	assert.match(text, /\u273b loop #7/);
	assert.ok(!text.includes("Running scheduled task"));
	assert.ok(!text.includes("[loop tick"));
});

test("the expanded block names the job, and collapsed hides long prompts", async () => {
	const { renderers } = makeHarness();
	const renderer = renderers.get("pi-cc-loop-tick");
	const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = tickMessage(`[scheduled task x \u00b7 Every minute \u00b7 y]\n${long}`, {
		kind: "cron",
		jobId: "x",
		cron: "* * * * *",
		prompt: long,
	});

	const collapsed = render(renderer, message, false).text;
	assert.match(collapsed, /line 3/);
	assert.ok(!collapsed.includes("line 10"), "collapsed stops after three lines");
	assert.match(collapsed, /\+7 more lines/);

	const expanded = render(renderer, message, true).text;
	assert.match(expanded, /line 10/);
	assert.match(expanded, /job x/);
});

test("the reason for the delay rides in the header", async () => {
	const { renderers } = makeHarness();
	const message = tickMessage("[loop tick #8 \u00b7 scheduled by /loop, not typed by the user]\nwatch CI", {
		kind: "wakeup",
		jobId: "abc",
		prompt: "watch CI",
		reason: "CI run still going",
	});
	const { text } = render(renderers.get("pi-cc-loop-tick"), message, false);
	assert.match(text, /\u273b loop #7 \u00b7 \d{1,2}:\d{2}(am|pm) \u00b7 CI run still going/);
});

test("with compactMessages off, a scheduled fire is still a scheduled task, not a loop tick", async () => {
	const { renderers } = makeHarness();
	fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: false }), "utf8");
	(await loadModule("config.ts")).invalidateConfig();
	try {
		const cron = tickMessage("[scheduled task j1 \u00b7 Every minute \u00b7 ...]\nprint hi", {
			kind: "cron",
			jobId: "j1",
			cron: "* * * * *",
			prompt: "print hi",
		});
		const card = render(renderers.get("pi-cc-loop-tick"), cron, false);
		assert.ok(card.bgCalls.count > 0, "the padded card");
		assert.match(card.text, /Running scheduled task \u00b7 print hi/);
		assert.ok(!card.text.includes("loop tick"), card.text);

		const wakeup = tickMessage("[loop tick #7 \u00b7 ...]\nwatch CI", { kind: "wakeup", jobId: "abc", prompt: "watch CI" });
		assert.match(render(renderers.get("pi-cc-loop-tick"), wakeup, false).text, /loop #7 \u00b7 watch CI/);
	} finally {
		fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: true }), "utf8");
		(await loadModule("config.ts")).invalidateConfig();
	}
});
