import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

const { registerTaskProvider } = await loadModule("tasks.ts");
const { KeybindingsManager, TUI_KEYBINDINGS, Text, TuiAltScreen, stripTerminalSequences, visibleWidth } =
	await import(pathToFileURL(findPiInstall().piTui).href);

const item = (id, createdAt = Number(id)) => ({ id: String(id), title: `task ${id}`, createdAt, state: "running", active: true });

/** Real native overlay compositing and SGR dispatch, without a terminal/timer loop or model. */
function view(t, { items = Array.from({ length: 31 }, (_, i) => item(i)), loopItems } = {}) {
	const state = { items, loopItems, effects: [] };
	const terminal = {
		columns: 100, rows: 30, isTTY: true,
		write() {}, start() {}, stop() {}, showCursor() {}, hideCursor() {},
		onData: () => () => {}, setRawMode() {}, getColorMode: () => "truecolor",
	};
	const tui = new TuiAltScreen(terminal, false, os.tmpdir(), { wheelScrollLines: 3 });
	tui.altScreenActive = true;
	tui.requestRender = () => {};
	tui.addChild(new Text(Array.from({ length: 100 }, (_, i) => `transcript ${i}`).join("\n"), 0, 0));
	tui.doRender();
	tui.implicitScrollView.scrollTo(10, { disableFollow: true });
	tui.doRender();

	const bus = new EventEmitter();
	const commands = new Map();
	const pi = {
		events: {
			emit: (channel, data) => bus.emit(channel, data),
			on(channel, handler) { bus.on(channel, handler); return () => bus.off(channel, handler); },
		},
		registerCommand: (name, command) => commands.set(name, command),
		on() {},
		sendMessage: () => state.effects.push("message"),
		sendUserMessage: () => state.effects.push("turn"),
		setActiveTools: () => state.effects.push("tools"),
	};
	const registrations = [];
	const provider = (id, label, list) => ({
		id, label, list,
		detail: (entry) => ({ rows: Array.from({ length: 40 }, (_, i) => ({ label: `Field ${i}`, value: `${entry.title} detail ${i}` })) }),
		stop: (id) => { state.effects.push(`stop ${id}`); return { stopped: true }; },
	});
	registrations.push(registerTaskProvider(pi, provider("monitor", "Monitor", () => state.items)));
	if (loopItems) registrations.push(registerTaskProvider(pi, provider("loop", "Loop", () => state.loopItems)));

	const theme = { fg: (_role, text) => text, bold: (text) => text };
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j" });
	let panel, handle, resolve;
	const ctx = {
		mode: "tui", hasUI: true,
		abort: () => state.effects.push("abort"),
		ui: {
			custom(factory, options) {
				panel = factory(tui, theme, keybindings, () => { handle?.hide(); panel.dispose(); resolve?.(); });
				handle = tui.showOverlay(panel, options.overlayOptions());
				return new Promise((done) => { resolve = done; });
			},
		},
	};
	const pending = commands.get("cc-tasks").handler("", ctx);
	t.after(async () => {
		for (const registration of registrations.reverse()) registration.close();
		await pending;
		tui.stop();
	});
	const render = () => { tui.doRender(); return panel.render(handle.getBounds()?.width ?? terminal.columns - 2); };
	render();
	return {
		state, terminal, tui, panel, pending, render,
		text: () => stripTerminalSequences(render().join("\n")),
		wheel(delta) {
			const bounds = handle.getBounds();
			return panel.handleMouse({
				type: "wheel", button: "none", x: 1, y: 1, screenX: bounds.col + 1, screenY: bounds.row + 1,
				width: bounds.width, height: bounds.height, shift: false, alt: false, ctrl: false, wheelDelta: delta,
			});
		},
		nativeWheel(code = 65) {
			const bounds = handle.getBounds();
			assert.ok(bounds, "native renderer supplied the overlay hitbox");
			const packet = `\x1b[<${code};${bounds.col + 2};${bounds.row + 2}M`;
			assert.deepEqual(tui.handleViewportInput(packet), { consume: true });
		},
		packet(code, x, y, final = "M") {
			const bounds = handle.getBounds();
			assert.ok(bounds, "native renderer supplied the overlay hitbox");
			assert.deepEqual(tui.handleViewportInput(`\x1b[<${code};${bounds.col + x + 1};${bounds.row + y + 1}${final}`), { consume: true });
		},
		click(x, y, count = 1) {
			for (let i = 0; i < count; i++) {
				this.packet(0, x, y);
				this.packet(0, x, y, "m");
			}
		},
		clickAction(kind, identity, count = 1) {
			const region = panel.hitRegions.findLast(({ action }) => action.kind === kind &&
				(identity === undefined || action.id === identity || action.key === identity || action.key === `monitor:${identity}`));
			assert.ok(region, `visible ${kind} hit region for ${identity ?? "action"}`);
			this.click(region.x + Math.floor(region.width / 2), region.y, count);
		},
		clickTask(id, count = 1) { this.clickAction("task", id, count); },
		dragScrollbar(toY) {
			const bar = panel.bodyScrollbar;
			assert.ok(bar, "overflow rendered a scrollbar");
			const x = bar.x;
			const y = bar.y + bar.thumbOffset;
			this.packet(0, x, y);
			this.packet(32, x, toY);
			this.packet(0, x, toY, "m");
		},
	};
}

test("native SGR wheel scrolls task rows immediately and cannot scroll the transcript at either boundary", async (t) => {
	const v = view(t);
	assert.equal(v.panel.selected().id, "30", "the newest task is selected on open");
	assert.match(v.text(), /wheel scroll/);
	const transcriptTop = v.tui.viewportTop;
	v.nativeWheel();
	assert.equal(v.panel.listScroll, 3, "scroll the page, not merely the selection within it");
	assert.equal(v.panel.selected().id, "27", "selection stays on the visible page");
	assert.doesNotMatch(v.text(), /task 30\b/);
	assert.match(v.text(), /task 27\b/);

	v.nativeWheel(64);
	assert.equal(v.panel.listScroll, 0);
	assert.equal(v.panel.selected().id, "27", "scrolling does not change an already visible selection");
	v.render();
	v.nativeWheel(64);
	assert.equal(v.panel.listScroll, 0);
	assert.equal(v.tui.viewportTop, transcriptTop);

	v.wheel(10000);
	assert.equal(v.panel.listScroll, 19);
	assert.match(v.text(), /task 0\b/, "the oldest row remains reachable");
	v.nativeWheel();
	assert.equal(v.panel.listScroll, 19);
	assert.equal(v.tui.viewportTop, transcriptTop, "wheel at the end is still contained by the task panel");
	assert.deepEqual(v.state.effects, []);
	v.panel.handleInput("\x1b");
	await v.pending;
	assert.equal(v.tui.hasOverlay(), false);
});

test("wheel preserves a visible selection and keyboard navigation continues from the visible task", (t) => {
	const v = view(t);
	for (let i = 0; i < 5; i++) v.panel.handleInput("j");
	v.render();
	v.wheel(3);
	assert.equal(v.panel.selected().id, "25");
	assert.equal(v.panel.listScroll, 3);
	v.wheel(10);
	assert.equal(v.panel.selected().id, "17", "off-screen selection clamps to the nearest visible row");
	assert.equal(v.panel.listScroll, 13);
	v.panel.handleInput("j");
	assert.equal(v.panel.selected().id, "16", "injected keybindings still select the next row");
	v.render();
	v.panel.handleInput("\r");
	assert.equal(v.panel.detailKey, "monitor:16", "Enter opens the same task the reader sees selected");
	assert.deepEqual(v.state.effects, []);
});

test("native wheel scrolls details in both directions, clamps at the end, and Esc returns to the list", (t) => {
	const v = view(t);
	const transcriptTop = v.tui.viewportTop;
	v.panel.handleInput("\r");
	v.render();
	v.nativeWheel();
	assert.equal(v.panel.detailScroll, 3);
	assert.match(v.text(), /wheel scroll/);
	v.nativeWheel(64);
	assert.equal(v.panel.detailScroll, 0);
	v.wheel(10000);
	v.render();
	const end = v.panel.detailLineCount - v.panel.detailViewport;
	assert.equal(v.panel.detailScroll, end);
	assert.match(v.text(), /detail 39/);
	v.nativeWheel();
	assert.equal(v.panel.detailScroll, end);
	assert.equal(v.tui.viewportTop, transcriptTop);
	v.nativeWheel(64);
	assert.equal(v.panel.detailScroll, end - 3);

	v.panel.handleInput("\x1b");
	assert.equal(v.panel.detailKey, undefined);
	assert.equal(v.tui.hasOverlay(), true, "first Esc only goes back");
	v.render();
	v.nativeWheel();
	assert.equal(v.panel.listScroll, 3, "wheel switches back to the list viewport");
	assert.deepEqual(v.state.effects, []);
});

test("confirmation and empty lists consume wheel safely; malformed deltas and unrelated events do nothing", async (t) => {
	const v = view(t);
	const contained = { handled: true, render: false };
	for (const delta of [undefined, 0, NaN, Infinity, -Infinity, 0.5]) {
		assert.deepEqual(v.wheel(delta), contained);
		assert.equal(v.panel.listScroll, 0);
	}
	assert.equal(v.panel.handleMouse({ type: "click" }), undefined);
	v.panel.handleInput("x");
	const target = v.panel.confirming;
	v.render();
	v.nativeWheel();
	assert.strictEqual(v.panel.confirming, target);
	assert.equal(v.panel.listScroll, 0);
	assert.equal(v.tui.viewportTop, 10);
	assert.deepEqual(v.state.effects, [], "scrolling must never confirm or stop a task");
	v.panel.handleInput("n");
	v.state.items = [];
	v.panel.refreshNow(false);
	v.render();
	v.nativeWheel();
	assert.equal(v.panel.listScroll, 0);
	assert.equal(v.panel.selected(), undefined);
	assert.equal(v.tui.viewportTop, 10);
	v.panel.handleInput("\x1b");
	await v.pending;
	assert.equal(v.panel.handleMouse({ type: "wheel", wheelDelta: 1 }), undefined, "disposed overlays ignore mouse input");
});

test("wheel uses the live page size after resize and synchronizes keyboard moves made before a render", (t) => {
	const v = view(t);
	v.panel.handleInput("\x1b[6~");
	v.wheel(3);
	assert.equal(v.panel.selected().id, "18");
	assert.equal(v.panel.listScroll, 4, "PageDown's pending viewport is applied before the wheel delta");
	v.render();

	v.terminal.columns = 4;
	v.terminal.rows = 10;
	v.wheel(1); // Before any render at the new width: borderless, six body rows inside the margins.
	assert.equal(v.panel.listScroll, 8);
	assert.equal(v.panel.selected().id, "18");
	const lines = v.render();
	assert.equal(lines.length, 8);
	assert.ok(lines.every((line) => visibleWidth(line) === 2));
	assert.ok(v.panel.selectedIndexHint >= v.panel.listScroll);
	assert.ok(v.panel.selectedIndexHint < v.panel.listScroll + v.panel.pageSize());

	v.panel.handleInput("\r");
	v.terminal.columns = 100;
	v.terminal.rows = 30;
	v.wheel(3);
	assert.equal(v.panel.detailViewport, 12, "detail bounds also use the resized layout before render");
	assert.equal(v.panel.detailScroll, 3);
	assert.deepEqual(v.state.effects, []);
});

test("All and provider tabs are newest-first, and refresh retains identity while announcing the newest addition", (t) => {
	const v = view(t, { loopItems: [{ ...item("loop", 50), state: "scheduled" }] });
	assert.equal(v.panel.selected().id, "loop", "All sorts by time across providers, not provider registration order");
	assert.equal(v.panel.entries[1].id, "30");
	v.panel.handleInput("\t");
	assert.equal(v.panel.selected().id, "30");
	v.panel.handleInput("\t");
	assert.equal(v.panel.selected().id, "loop");

	v.state.items.push(item("older addition", 100), item("newest addition", 200), { ...item("new child", 190), parentId: "1" });
	v.panel.refreshNow(false);
	assert.equal(v.panel.selected().id, "loop", "a new task never steals the reader's selection");
	assert.equal(v.panel.entries[0].id, "newest addition");
	assert.equal(v.panel.recentTask, "task newest addition", "a grouped child must not make the new-task hint name an older addition");
	const sourceIndex = v.panel.entries.findIndex((entry) => entry.id === "1");
	assert.equal(v.panel.entries[sourceIndex + 1].id, "new child", "subscriptions remain attached to their source");
	v.panel.handleInput("\x1b[Z");
	assert.equal(v.panel.selected().id, "newest addition", "the Monitor tab has the same chronological order");
	assert.deepEqual(v.state.effects, []);
});

test("native clicks switch tabs, select/open tasks, navigate back, and close without side effects", async (t) => {
	const v = view(t, { loopItems: [{ ...item("loop", 50), state: "scheduled" }] });
	v.clickAction("tab", "monitor");
	assert.equal(v.panel.tab, "monitor");
	assert.equal(v.panel.selected().id, "30");
	v.render();
	v.clickTask("29");
	assert.equal(v.panel.selected().id, "29");
	assert.equal(v.panel.detailKey, undefined, "single click only selects");
	v.render();
	v.clickTask("29", 2);
	assert.equal(v.panel.detailKey, "monitor:29", "double click opens the same task");
	v.render();
	v.clickAction("back");
	assert.equal(v.panel.detailKey, undefined);
	v.render();
	v.clickAction("detail");
	assert.equal(v.panel.detailKey, "monitor:29");
	v.render();
	v.clickAction("tab", "loop");
	assert.equal(v.panel.tab, "loop");
	assert.equal(v.panel.detailKey, undefined, "a tab click also leaves details");
	assert.equal(v.panel.selected().id, "loop");
	v.render();
	v.clickAction("close");
	await v.pending;
	assert.equal(v.tui.hasOverlay(), false);
	assert.deepEqual(v.state.effects, []);
});

test("mouse stop is separately confirmed, cancel is safe, and double-click confirms at most once", async (t) => {
	const v = view(t, { items: [item("safe")] });
	v.clickAction("stop");
	assert.equal(v.panel.confirming.id, "safe");
	assert.deepEqual(v.state.effects, [], "the first Stop click only opens confirmation");
	v.render();
	v.clickAction("cancelStop");
	assert.equal(v.panel.confirming, undefined);
	assert.deepEqual(v.state.effects, []);
	v.render();
	v.clickAction("stop");
	v.render();
	v.clickAction("confirmStop", undefined, 2);
	await Promise.resolve();
	assert.deepEqual(v.state.effects, ["stop safe"], "double-click cannot stop twice");
	v.panel.handleInput("y");
	assert.deepEqual(v.state.effects, ["stop safe"], "the dismissed confirmation cannot be reused by keyboard");
});

test("stale Detail and Stop buttons cannot act on a fallback task after refresh", async (t) => {
	const detailView = view(t, { items: [item("rendered", 100), item("fallback", 90)] });
	detailView.state.items = [item("fallback", 90)];
	detailView.panel.refreshNow(true);
	assert.equal(detailView.panel.selected().id, "fallback", "the provider repair is synchronous");
	detailView.clickAction("detail"); // Hit region still belongs to the old painted frame.
	assert.equal(detailView.panel.detailKey, undefined);
	detailView.render();
	detailView.clickAction("detail");
	assert.equal(detailView.panel.detailKey, "monitor:fallback", "the repainted button explicitly names its task");
	detailView.panel.handleInput("\x1b");
	detailView.panel.handleInput("\x1b");
	await detailView.pending;

	const stopView = view(t, { items: [item("rendered-stop", 100), item("fallback", 90)] });
	stopView.state.items = [item("fallback", 90)];
	stopView.panel.refreshNow(true);
	stopView.clickAction("stop");
	assert.equal(stopView.panel.confirming, undefined, "a vanished task cannot arm a fallback stop");
	assert.deepEqual(stopView.state.effects, []);
	stopView.render();
	stopView.clickAction("stop");
	assert.equal(stopView.panel.confirming.id, "fallback", "the newly painted Stop button remains usable");
});

test("ended tasks expose no enabled stop hit region", (t) => {
	const v = view(t, { items: [{ ...item("done"), state: "completed", active: false }] });
	assert.equal(v.panel.hitRegions.some(({ action }) => action.kind === "stop"), false);
	v.clickTask("done", 2);
	v.render();
	assert.equal(v.panel.hitRegions.some(({ action }) => action.kind === "stop"), false);
	assert.deepEqual(v.state.effects, []);
});

test("list and detail scrollbars support native dragging and expose their visible ranges", (t) => {
	const v = view(t);
	assert.equal(v.panel.bodyScrollbar.total, 31);
	assert.match(v.text(), /1-12\/31/);
	v.dragScrollbar(v.panel.bodyScrollbar.y + v.panel.bodyScrollbar.height - 1);
	assert.equal(v.panel.listScroll, 19);
	assert.equal(v.tui.viewportTop, 10);
	v.render();
	assert.match(v.text(), /20-31\/31/);
	v.clickTask("0", 2);
	v.render();
	assert.ok(v.panel.bodyScrollbar);
	v.dragScrollbar(v.panel.bodyScrollbar.y + v.panel.bodyScrollbar.height - 1);
	v.render();
	assert.equal(v.panel.detailScroll, v.panel.detailLineCount - v.panel.detailViewport);
	assert.match(v.text(), /detail 39/);
	assert.match(v.text(), /31-42\/42/);
	assert.equal(v.tui.viewportTop, 10);
	assert.deepEqual(v.state.effects, []);
});

test("scrollbar track clicks work and a refresh that removes overflow cannot stale-hit a removed bar", (t) => {
	const v = view(t);
	let bar = v.panel.bodyScrollbar;
	v.packet(0, bar.x, bar.y + bar.height - 1);
	v.packet(0, bar.x, bar.y + bar.height - 1, "m");
	assert.equal(v.panel.listScroll, 19, "track press jumps without requiring a drag");
	v.render();
	assert.equal(v.tui.viewportTop, 10);

	v.state.items = [item("only")];
	v.panel.refreshNow(false); // The old scrollbar remains until the next native render.
	bar = v.panel.bodyScrollbar;
	assert.doesNotThrow(() => {
		v.click(bar.x, bar.y, 2);
	});
	assert.equal(v.panel.bodyScrollbar, undefined);
	assert.equal(v.panel.listScroll, 0);
	assert.equal(v.panel.detailKey, undefined, "neither click of a stale double-click reaches the replacement row");
	assert.equal(v.tui.viewportTop, 10);
	assert.deepEqual(v.state.effects, []);
});

test("long stop scope scrolls independently while Cancel and Stop stay visible and safe", async (t) => {
	const v = view(t, { items: [{ ...item("long"), stopConfirmation: Array.from({ length: 12 }, (_, i) => `scope ${i}`).join(" ") + " END-SCOPE" }] });
	v.terminal.columns = 50;
	v.terminal.rows = 12;
	v.render();
	v.clickAction("stop");
	v.render();
	assert.ok(v.panel.confirmationLineCount > v.panel.confirmationViewport);
	assert.ok(v.panel.bodyScrollbar);
	assert.match(v.text(), /Cancel[\s\S]*Stop[\s\S]*y stop · n\/Esc cancel/);
	v.nativeWheel();
	assert.equal(v.panel.confirmationScroll, Math.min(3, v.panel.confirmationLineCount - v.panel.confirmationViewport));
	v.render();
	v.dragScrollbar(v.panel.bodyScrollbar.y + v.panel.bodyScrollbar.height - 1);
	v.render();
	assert.equal(v.panel.confirmationScroll, v.panel.confirmationLineCount - v.panel.confirmationViewport);
	assert.match(v.text(), /END-SCOPE/);
	assert.equal(v.tui.viewportTop, 10);
	v.clickAction("cancelStop");
	assert.deepEqual(v.state.effects, []);
	v.render();
	v.clickAction("stop");
	assert.equal(v.panel.confirmationScroll, 0, "reopening resets the confirmation viewport");
	v.render();
	v.clickAction("confirmStop");
	await Promise.resolve();
	assert.deepEqual(v.state.effects, ["stop long"]);
});

test("group arrows collapse real descendants, keyboard can restore them, and hidden selection is repaired", (t) => {
	const v = view(t, { items: [
		{ ...item("parent", 100) }, { ...item("child-a", 90), parentId: "parent" },
		{ ...item("other", 95) }, { ...item("child-b", 80), parentId: "parent" },
	] });
	assert.equal(v.panel.visible().length, 4);
	v.clickAction("toggle", "parent");
	assert.deepEqual(v.panel.visible().map(({ id }) => id), ["parent", "other"]);
	assert.equal(v.panel.selected().id, "parent");
	v.render();
	assert.doesNotMatch(v.text(), /child-a|child-b/);
	v.panel.handleInput("\x1b[C");
	assert.equal(v.panel.visible().length, 4, "Right expands the selected group");
	v.render();
	v.clickTask("child-a");
	assert.equal(v.panel.selected().id, "child-a");
	v.render();
	v.clickAction("toggle", "parent");
	assert.equal(v.panel.visible().some(({ id }) => id === "child-a"), false);
	assert.equal(v.panel.visible().some(({ id }) => id === v.panel.selected().id), true, "selection never remains hidden");
	v.render();
	v.clickTask("parent");
	v.panel.handleInput("\x1b[C");
	assert.equal(v.panel.visible().length, 4, "Right expands a collapsed selected group");
	v.panel.handleInput("\x1b[D");
	assert.equal(v.panel.visible().length, 2, "Left collapses an expanded selected group");
	assert.deepEqual(v.state.effects, []);
});

test("clicks retain task identity across refresh and use fresh Unicode geometry after resize", (t) => {
	const v = view(t, { items: Array.from({ length: 31 }, (_, i) => ({ ...item(i), title: `任务 ${i} 中文 🚀` })) });
	v.state.items.push(item("newest", 200));
	v.panel.refreshNow(false); // Reorder without rebuilding the rendered hit regions.
	v.clickTask("25");
	assert.equal(v.panel.selected().id, "25");
	assert.equal(v.panel.selectedIndexHint, 6, "the bound key wins over the stale row number");
	v.terminal.columns = 54;
	v.terminal.rows = 20;
	v.render();
	v.clickTask("21", 2);
	assert.equal(v.panel.detailKey, "monitor:21");
	v.render();
	assert.ok(v.render().every((line) => visibleWidth(line) === v.tui.renderedOverlayLayouts.at(-1).width));
	const press = v.panel.handleMouse({ type: "press", button: "left", x: 5, y: 5, screenX: 5, screenY: 5,
		width: 48, height: 18, shift: false, alt: false, ctrl: false });
	assert.equal(press, undefined, "ordinary detail text remains available to native selection");
	assert.deepEqual(v.state.effects, []);
});
