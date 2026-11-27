/** Outbox handoff, retry, idle fallback and disposal without an agent/provider. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
const { TerminalOutbox } = await loadModule('terminal-outbox.ts');
const { writeAtomic } = await loadModule('plugin-settings.ts');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const message = content => ({ customType: 'pi-cc-loop-outcome', content, display: true, details: { ended: true } });
function fixture(t) {
  let key = 0;
  const sent = [], state = { idle: false, fail: false };
  const pi = { sendMessage(value, options) { if (state.fail) throw new Error('sender unavailable'); sent.push({ value, options }); } };
  const delivery = new TerminalOutbox(pi, () => state.idle);
  t.after(() => delivery.dispose());
  return { sent, state, pi, delivery, enqueue: (content, wake) => delivery.enqueue(++key, message(content), wake) };
}

test('busy outcomes remain outside ordinary queues and a boundary hands each off once', t => {
  const f = fixture(t); f.enqueue('first'); f.enqueue('second');
  assert.equal(f.delivery.size, 2); assert.deepEqual(f.sent, []);
  assert.equal(f.delivery.flush(false), true);
  assert.deepEqual(f.sent.map(item => item.options), [{ deliverAs: 'followUp', triggerTurn: false }, { deliverAs: 'followUp', triggerTurn: false }]);
  assert.equal(f.delivery.size, 0); assert.equal(f.delivery.flush(false), false);
});

test('a rejected handoff stays due and never requests an empty continuation', t => {
  const f = fixture(t); f.state.fail = true; f.enqueue('retry');
  assert.equal(f.delivery.flush(false), false); assert.equal(f.delivery.size, 1); assert.deepEqual(f.sent, []);
  f.state.fail = false;
  assert.equal(f.delivery.flush(false), true); assert.equal(f.delivery.size, 0);
  assert.equal(f.sent.length, 1); assert.equal(f.delivery.flush(false), false);
});

test('an idle batch stores earlier facts before requesting one run with the last outcome', t => {
  const f = fixture(t); f.enqueue('first'); f.enqueue('last');
  f.state.idle = true;
  assert.equal(f.delivery.flush(true), true);
  assert.deepEqual(f.sent.map(item => item.value.content), ['first', 'last']);
  assert.deepEqual(f.sent.map(item => item.options.triggerTurn), [false, true]);
});

async function waitForEmpty(f) {
  const end = Date.now() + 2000;
  while (f.delivery.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.delivery.size, 0);
}

for (const interrupted of [false, true]) test(`a rejected batch wake is retried only if its idle opportunity survives (interrupted: ${interrupted})`, async t => {
  const f = fixture(t), attempts = [];
  let failed = false;
  f.pi.sendMessage = (value, options) => {
    attempts.push([value.content, options.triggerTurn]);
    if (options.triggerTurn && !failed) { failed = true; throw new Error('transient handoff failure'); }
    f.sent.push({ value, options });
  };
  f.enqueue('earlier'); f.enqueue('last'); f.state.idle = true;
  assert.equal(f.delivery.flush(true), true);
  assert.deepEqual(attempts, [['earlier', false], ['last', true]]);
  if (interrupted) f.delivery.cancelWakeRetry();
  await waitForEmpty(f);
  assert.deepEqual(attempts, [['earlier', false], ['last', true], ['last', !interrupted]]);
  assert.equal(f.sent.length, 2, 'the earlier message is never re-sent');
});

test('two rejected batch wakes fall back to context-only without looping', async t => {
  const f = fixture(t), attempts = [];
  f.pi.sendMessage = (value, options) => {
    attempts.push([value.content, options.triggerTurn]);
    if (options.triggerTurn) throw new Error('wake unavailable');
    f.sent.push({ value, options });
  };
  f.enqueue('earlier'); f.enqueue('last'); f.state.idle = true;
  f.delivery.flush(true);
  await waitForEmpty(f);
  assert.deepEqual(attempts, [['earlier', false], ['last', true], ['last', true], ['last', false]]);
  assert.equal(f.sent.length, 2);
});

test('a failed/cancelled navigation recovering idle stores facts without restarting', async t => {
  const f = fixture(t); f.enqueue('retained'); f.state.idle = true;
  assert.equal(f.delivery.timer.hasRef(), false, 'fallback never owns the Pi process lifetime');
  const end = Date.now() + 2000;
  while (f.delivery.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.delivery.size, 0); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.triggerTurn, false);
});

test('shutdown discards pending wakeups and every late path is a no-op', t => {
  const f = fixture(t); f.enqueue('pending'); f.delivery.dispose();
  f.state.idle = true; f.pi.sendMessage = () => { throw new Error('stale API'); };
  assert.equal(f.delivery.flush(true), false); f.enqueue('late');
  assert.equal(f.delivery.size, 0); assert.equal(f.delivery.timer, undefined); assert.deepEqual(f.sent, []);
});

test('reentrant disposal during handoff cannot call a stale sender for the rest of a batch', t => {
  const f = fixture(t); f.enqueue('first'); f.enqueue('late');
  f.pi.sendMessage = (value, options) => { f.sent.push({ value, options }); f.delivery.dispose(); };
  assert.equal(f.delivery.flush(false), true); assert.equal(f.sent.length, 1); assert.equal(f.delivery.size, 0);
});

test('an idle flush aborts waking the final item if an earlier handoff made the session busy', t => {
  const f = fixture(t);
  f.enqueue('A'); f.enqueue('B');
  f.state.idle = true;
  f.pi.sendMessage = (value, options) => { f.sent.push({ value, options }); f.state.idle = false; };
  assert.equal(f.delivery.flush(true), true);
  assert.equal(f.delivery.size, 1);
  assert.deepEqual(f.sent.map(item => [item.value.content, item.options.triggerTurn]), [['A', false]]);
  f.state.idle = true;
  assert.equal(f.delivery.flush(true), true);
  assert.deepEqual(f.sent.map(item => [item.value.content, item.options.triggerTurn]), [['A', false], ['B', true]]);
});

test('explicit removal cancels the pending fallback for an obsolete observation', t => {
  const f = fixture(t);
  f.delivery.enqueue('activity-A', message('retired'));
  assert.equal(f.delivery.has('activity-A'), true);
  f.delivery.delete('activity-A');
  assert.equal(f.delivery.has('activity-A'), false);
  assert.equal(f.delivery.timer, undefined);
  assert.equal(f.delivery.flush(true), false);
});

test('writeAtomic replaces files atomically and removes temp files on rename failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  writeAtomic(file, '{"ok":true}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  const orig = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('rename boom'); };
    assert.throws(() => writeAtomic(file, '{"ok":false}\n'), /rename boom/);
  } finally {
    fs.renameSync = orig;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});
