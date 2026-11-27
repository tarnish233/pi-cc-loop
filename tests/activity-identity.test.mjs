/** Stable activity identity starts before observation/timer allocation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers.mjs';

const { ObservationOwnership, LOOP_OBSERVATION_BIND_CHANNEL } = await loadModule('observation-ownership.ts');
function fixture(t) {
  const listeners = new Map(), chains = new Map(), stopped = new Set();
  let run = {}, sequence = 0, legacyLookups = 0;
  const pi = { events: {
    on(channel, listener) { listeners.set(channel, listener); return () => listeners.delete(channel); },
    emit(channel, data) { listeners.get(channel)?.(data); },
  } };
  const ownership = new ObservationOwnership(pi, {
    run: () => run, createId: () => `activity-${++sequence}`,
    normalize: prompt => prompt.trim().replace(/^\/loop\s+/i, '').trim(),
    findChain(prompt) {
      legacyLookups++;
      const matches = [...chains.values()].filter(chain => chain.prompt === prompt);
      if (matches.length > 1) throw new Error('Ambiguous legacy prompt');
      return matches[0];
    },
    getChain: id => chains.get(id), isStopped: prompt => stopped.has(prompt),
  });
  t.after(() => ownership.dispose());
  return {
    ownership, chains, stopped,
    get run() { return run; },
    get legacyLookups() { return legacyLookups; },
    begin(prompt) { run = { loopRequest: true }; ownership.begin(run, prompt); return run.activityId; },
    bind(prompt, version) { const request = { prompt, version }; pi.events.emit(LOOP_OBSERVATION_BIND_CHANNEL, request); return request; },
    replaceRun(value) { run = value; },
    setSequence(value) { sequence = value; },
  };
}

test('a new Loop gets its identity before any observation or wakeup exists', t => {
  const h = fixture(t), id = h.begin('original task');
  assert.ok(id);
  assert.equal(h.ownership.owner(id).prompt, 'original task');
  assert.equal(h.ownership.owner(id).chainId, undefined);
  assert.equal(h.chains.size, 0, 'identity allocation does not schedule a timer');
  assert.equal(h.legacyLookups, 0);
});

test('binding acknowledges the supported version and rejects ambiguous legacy text in-band', t => {
  const h = fixture(t);
  h.chains.set('one', { id: 'one', prompt: 'shared' });
  h.chains.set('two', { id: 'two', prompt: 'shared' });
  assert.deepEqual(h.bind('shared', 2), { prompt: 'shared', version: 2 });
  assert.equal(h.legacyLookups, 0);
  const reply = h.bind('shared', 1);
  assert.equal(reply.acceptedVersion, 1);
  assert.match(reply.error, /Ambiguous/);
  assert.equal(reply.observationGroup, undefined);
});

test('all bindings in the initial activity use its identity, not their prompt text', t => {
  const h = fixture(t), id = h.begin('original task');
  h.chains.set('other', { id: 'other', prompt: 'other task' });
  for (const prompt of ['original task', 'reworded task', '/loop other task']) {
    const reply = h.bind(prompt);
    assert.equal(reply.observationGroup, id);
    assert.equal(reply.canonicalPrompt, 'original task');
    assert.equal(reply.error, undefined);
  }
  assert.equal(h.legacyLookups, 0, 'an explicit activity never guesses by text');
});

test('the first wakeup registers on the existing identity without replacing it', t => {
  const h = fixture(t), id = h.begin('original task'), before = h.bind('original task');
  const chain = { id, prompt: 'reworded task' }; h.chains.set(id, chain);
  h.ownership.link(h.run, chain);
  const after = h.bind('another spelling');
  assert.equal(after.observationGroup, before.observationGroup);
  assert.equal(after.observationGroup, id);
  assert.equal(after.canonicalPrompt, chain.prompt);
  assert.equal(h.ownership.owner(id).chainId, id);
});

test('retiring a chain does not retire a same-prompt initial activity', t => {
  const h = fixture(t), a = h.begin('same task'); h.bind('same task');
  const chain = { id: a, prompt: 'same task' }; h.chains.set(a, chain); h.ownership.link(h.run, chain);
  const b = h.begin('same task'); h.bind('same task');
  assert.notEqual(a, b);
  assert.deepEqual(h.ownership.retire(chain), [a]); h.chains.delete(a); h.stopped.add('same task');
  assert.equal(h.ownership.owner(a), undefined);
  assert.equal(h.bind('same task').observationGroup, b, 'the surviving activity is authoritative over the legacy stop memo');
  assert.deepEqual(h.ownership.cancelPending(h.run), [{ id: b, prompt: 'same task' }]);
});

test('a retired activity cannot bind to a live same-prompt replacement', t => {
  const h = fixture(t), a = h.begin('same task'); h.bind('same task');
  h.ownership.cancelPending(h.run);
  h.chains.set('replacement', { id: 'replacement', prompt: 'same task' });
  assert.match(h.bind('same task').error, /was stopped/);
  assert.equal(h.legacyLookups, 0);
});

test('fixed cron detaches the initial identity and stays outside Esc ownership', t => {
  const h = fixture(t), id = h.begin('fixed task'); h.bind('fixed task');
  h.run.createdCronPrompts = new Set(['fixed task']);
  h.ownership.detachForCron(h.run, 'fixed task');
  assert.equal(h.ownership.owner(id), undefined);
  assert.equal(h.run.activityId, undefined);
  assert.equal(h.bind('fixed task').observationGroup, undefined);
  assert.deepEqual(h.ownership.cancelPending(h.run), []);
});

test('settlement removes empty initial identities but retains an observed activity', t => {
  const h = fixture(t), empty = h.begin('empty task');
  h.ownership.settle(h.run);
  assert.equal(h.ownership.owner(empty), undefined);
  const observed = h.begin('observed task'); h.bind('observed task');
  h.ownership.settle(h.run);
  assert.ok(h.ownership.owner(observed), 'a queued observation event can still find its activity');
});

test('restored wakeups recover identity from their existing id, never from prompt', t => {
  const h = fixture(t), chain = { id: 'existing-wakeup', prompt: 'restored task' };
  h.chains.set(chain.id, chain);
  assert.equal(h.ownership.forChain(chain), chain.id);
  assert.equal(h.ownership.forChain({ ...chain }), chain.id);
  h.replaceRun({ activityId: chain.id, chainId: chain.id });
  assert.equal(h.bind('different task text').observationGroup, chain.id);
  assert.equal(h.legacyLookups, 0);
});

test('initial cancellation fences identity even without an observation or timer', t => {
  const h = fixture(t), id = h.begin('empty activity');
  assert.deepEqual(h.ownership.cancelPending(h.run), [{ id, prompt: 'empty activity' }]);
  assert.match(h.bind('another spelling').error, /was stopped/);
  assert.equal(h.chains.size, 0);
});

test('new activities never recycle retired identities in the same runtime', t => {
  const h = fixture(t), first = h.begin('task'); h.ownership.cancelPending(h.run);
  h.setSequence(0);
  const second = h.begin('task');
  assert.notEqual(second, first);
  assert.equal(h.ownership.owner(first), undefined);
});

test('fixed-cron tick bindings never select a same-prompt self-paced activity', t => {
  const h = fixture(t), chain = { id: 'self-paced', prompt: 'shared task' };
  h.chains.set(chain.id, chain); h.ownership.forChain(chain);
  h.replaceRun({ cronId: 'fixed-cron' });
  assert.equal(h.bind('shared task').observationGroup, undefined);
  assert.equal(h.legacyLookups, 0);
});

test('disposed ownership cannot allocate an identity through a late begin', t => {
  const h = fixture(t); h.ownership.dispose();
  assert.throws(() => h.begin('late task'), /was stopped/);
  assert.equal(h.run.activityId, undefined);
});

test('an explicitly unbound modern run never uses legacy prompt matching', t => {
  const h = fixture(t), chain = { id: 'other-activity', prompt: 'same task' };
  h.chains.set(chain.id, chain); h.ownership.forChain(chain);
  h.replaceRun({ activityId: null });
  assert.equal(h.bind('same task').observationGroup, undefined);
  assert.equal(h.legacyLookups, 0);
});

test('an activity cannot be reassigned to a different wakeup identity', t => {
  const h = fixture(t), id = h.begin('task');
  assert.throws(() => h.ownership.link(h.run, { id: 'another-wakeup', prompt: 'task' }), /identity/);
  assert.equal(h.ownership.owner(id).chainId, undefined);
});
