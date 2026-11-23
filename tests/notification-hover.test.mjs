import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extensionDir, findPiInstall, loadModule, loadModuleFrom } from "./helpers.mjs";

const install = findPiInstall();
const { Text, TuiAltScreen, TuiMainScreen } = await import(pathToFileURL(install.piTui).href);
const { createInteractiveTuiReference } = await import(pathToFileURL(path.join(path.dirname(install.piCodingAgent), "modes/interactive/tui-renderer.js")).href);
const renderer = await loadModule("render.ts");
const sibling = path.resolve(extensionDir, "..", path.basename(extensionDir) === "pi-cc-monitor" ? "pi-cc-loop" : "pi-cc-monitor");
const peer = fs.existsSync(path.join(sibling, "render.ts")) ? await loadModuleFrom(sibling, "render.ts") : undefined;
const theme = {
	fg: (role, text) => `\x1b[${role === "text" ? 97 : 90}m${text}\x1b[39m`,
	bg: (_role, text) => text,
	bold: (text) => text,
};
const lit = (card) => card.render(100)[0].includes("\x1b[97mclick to show more");

/** Real Pi proxy, layout and input dispatch; only terminal I/O and scheduling are stubbed. */
function view(t, { together = false, long = false } = {}) {
	renderer.releaseNotificationHover();
	peer?.releaseNotificationHover();
	const terminals = [];
	let requests = 0;
	const create = (mode) => {
		const terminal = { columns: 100, rows: 20, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} };
		const raw = mode === "fullscreen" ? new TuiAltScreen(terminal, false, os.tmpdir()) : new TuiMainScreen(terminal, false, os.tmpdir());
		raw.altScreenActive = mode === "fullscreen";
		raw.requestRender = raw.requestViewRender = () => { requests += 1; };
		terminals.push(raw);
		return raw;
	};
	let raw = create("fullscreen");
	const tui = createInteractiveTuiReference(() => raw);
	const baseListeners = [...raw.inputListeners];
	const nativeViewportInput = raw.handleViewportInput;
	renderer.setNotificationTui(tui);
	if (together) peer.setNotificationTui(tui);
	const build = (module, title) => module.renderNotificationCard({}, {
		expanded: false, outputPad: 1, keyHint: (_key, description) => `custom+o ${description}`,
	}, theme, { title, tone: "accent", sections: [] });
	const a = build(renderer, "card A");
	const b = build(together ? peer : renderer, "card B");
	const outside = new Text(long ? Array.from({ length: 80 }, (_, i) => `outside ${i}`).join("\n") : "outside", 0, 0);
	const mount = () => { raw.addChild(a); raw.addChild(b); raw.addChild(outside); raw.doRender(); };
	mount();
	if (long) { raw.implicitScrollView.scrollTo(0, { disableFollow: true }); raw.doRender(); }
	t.after(() => {
		renderer.releaseNotificationHover();
		peer?.releaseNotificationHover();
		for (const terminal of terminals) terminal.stop();
	});
	return {
		tui, a, b, baseListeners, nativeViewportInput,
		get raw() { return raw; },
		get requests() { return requests; },
		render() { raw.doRender(); },
		input(data) { raw.handleTerminalInput(data); raw.doRender(); },
		motion(card = a, row = card === a ? 1 : 2) { this.input(`\x1b[<35;${card.hintStart + 5};${row}M`); },
		click(row = 1, col = 2) { this.input(`\x1b[<0;${col};${row}M`); this.input(`\x1b[<0;${col};${row}m`); },
		flags() { return [lit(a), lit(b)]; },
		patchViewport() {
			// ccstyle captures the prototype, bypassing existing instance wrappers.
			const native = Object.getPrototypeOf(raw).handleViewportInput;
			const patch = function (data) { return Reflect.apply(native, this, [data]); };
			raw.handleViewportInput = patch;
			return patch;
		},
		switchMode(mode) { raw = create(mode); mount(); },
	};
}

test("a competing viewport patch cannot strand hover on cards", (t) => {
	const v = view(t);
	assert.equal(v.raw.handleViewportInput, v.nativeViewportInput, "the native entry point is not wrapped either");
	const patch = v.patchViewport();
	v.render();
	v.motion(v.a);
	assert.deepEqual(v.flags(), [true, false]);
	v.motion(v.b);
	assert.deepEqual(v.flags(), [false, true]);
	const before = v.requests;
	v.input("\x1b[<35;1;3M");
	assert.deepEqual(v.flags(), [false, false]);
	assert.ok(v.requests > before, "leaving requests a repaint even when native dispatch finds no card");
	assert.equal(v.raw.handleViewportInput, patch, "notification hover never replaces ccstyle's entry point");
	assert.equal(v.raw.inputListeners.size, v.baseListeners.length + 1);
});

test("click expansion and collapse keep working without a stale hover", (t) => {
	const v = view(t);
	v.patchViewport();
	v.motion();
	assert.equal(lit(v.a), true);
	v.click();
	assert.equal(v.a.expanded, true);
	v.input("\x1b[<35;1;10M");
	v.click();
	assert.equal(v.a.expanded, false);
	assert.equal(lit(v.a), false);
});

test("focus loss, drag, native wheel and keyboard scrolling clear hover without consuming input", (t) => {
	const v = view(t, { long: true });
	v.patchViewport();
	for (const packet of ["\x1b[O", "\x1b[<0;2;3M", "\x1b[<32;3;3M", "\x1b[<65;2;3M", "\x1b[Ma##", "\x1b[6~"]) {
		v.input("\x1b[O");
		v.raw.implicitScrollView.scrollTo(0, { disableFollow: true });
		v.render();
		v.motion();
		assert.equal(lit(v.a), true);
		v.input(packet);
		assert.deepEqual(v.flags(), [false, false], JSON.stringify(packet));
		if (packet === "\x1b[<65;2;3M" || packet === "\x1b[6~") assert.ok(v.raw.implicitScrollView.scrollTop > 0, "native scrolling is preserved");
	}
	const received = [];
	v.raw.addInputListener((data) => { received.push(data); });
	v.input("hello");
	v.input("\x1b[200~paste\x1b[201~");
	assert.deepEqual(received, ["hello", "\x1b[200~paste\x1b[201~"], "keys and paste reach the remaining native input chain unchanged");
});

test("shutdown clears hover, redraw cannot re-arm it, and repeated reloads do not add listeners", (t) => {
	const v = view(t);
	const patch = v.patchViewport();
	for (let i = 0; i < 20; i++) {
		v.motion();
		assert.equal(lit(v.a), true);
		renderer.releaseNotificationHover();
		v.render();
		assert.equal(lit(v.a), false);
		assert.deepEqual([...v.raw.inputListeners], v.baseListeners, "shutdown removes only our observer and preserves listener order");
		v.motion();
		assert.equal(lit(v.a), false, "rendering or moving over an old card cannot revive a disposed observer");
		renderer.setNotificationTui(v.tui);
		v.render();
		assert.equal(v.raw.inputListeners.size, v.baseListeners.length + 1);
		assert.equal(v.raw.handleViewportInput, patch);
	}
});

test("the same native proxy follows regular/fullscreen renderer swaps without leaking observers", (t) => {
	const v = view(t);
	const fullscreen = v.raw;
	v.motion();
	assert.equal(lit(v.a), true);
	v.switchMode("regular");
	assert.deepEqual([...fullscreen.inputListeners], v.baseListeners);
	assert.equal(v.raw.inputListeners.size, 0, "regular mode has no notification mouse observer");
	assert.match(v.a.render(100)[0], /custom\+o to show more/);
	assert.equal(lit(v.a), false);
	v.switchMode("fullscreen");
	const patch = v.patchViewport();
	for (let i = 0; i < 100; i++) v.render();
	assert.equal(v.raw.inputListeners.size, 2, "one native viewport listener and one observer, regardless of frame count");
	assert.equal(v.raw.handleViewportInput, patch);
	v.motion();
	assert.equal(lit(v.a), true);
	v.input("\x1b[<35;1;3M");
	assert.equal(lit(v.a), false);
});

test("Monitor and Loop observers coexist and releasing one cannot disable the other", { skip: !peer }, (t) => {
	const v = view(t, { together: true });
	assert.notEqual(renderer.setNotificationTui, peer.setNotificationTui, "the packages own distinct module state");
	const patch = v.patchViewport();
	v.motion(v.a);
	assert.deepEqual(v.flags(), [true, false]);
	v.motion(v.b);
	assert.deepEqual(v.flags(), [false, true]);
	v.input("\x1b[<35;1;3M");
	assert.deepEqual(v.flags(), [false, false]);
	v.motion(v.b);
	renderer.releaseNotificationHover();
	assert.equal(lit(v.b), true, "releasing one package does not touch the other's card");
	v.input("\x1b[<35;1;3M");
	assert.equal(lit(v.b), false);
	assert.equal(v.raw.inputListeners.size, v.baseListeners.length + 1);
	assert.equal(v.raw.handleViewportInput, patch);
});

test("a host without pre-dispatch input access leaves hints dim but still permits clicks", (t) => {
	renderer.setNotificationTui({ mode: "fullscreen" });
	t.after(() => renderer.releaseNotificationHover());
	const card = renderer.renderNotificationCard({}, { expanded: false, outputPad: 1 }, theme, { title: "unsupported", tone: "accent", sections: [] });
	card.render(100);
	const mouse = { type: "move", button: "none", x: card.hintStart + 5, y: 0, screenX: 0, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false };
	card.handleMouse(mouse);
	assert.equal(lit(card), false, "never enable a hover that this host cannot clear on leaving");
	card.handleMouse({ ...mouse, type: "click", button: "left" });
	assert.equal(card.expanded, true);
});
