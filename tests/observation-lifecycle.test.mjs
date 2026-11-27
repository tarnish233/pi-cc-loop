/** Cross-extension ownership boundaries, including first-arm races and fixed cron. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeHarness, start, runEvent, runTurn, createCron, startSelfPaced } from './harness.mjs';
import { loadModuleFrom, siblingExtensionDir } from './helpers.mjs';

const monitorDir = siblingExtensionDir('pi-cc-monitor');
const hasMonitor = fs.existsSync(path.join(monitorDir, 'index.ts'));
const monitorModule = hasMonitor ? await loadModuleFrom(monitorDir, 'index.ts') : undefined;
const FileObservation = hasMonitor ? (await loadModuleFrom(monitorDir, 'observation-source.ts')).FileObservation : undefined;
const needsMonitor = { skip: !hasMonitor };
async function until(predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Observation ownership fixture did not settle');
}
async function fixture(t) {
  const previousCwd = process.cwd(), h = await start(makeHarness());
  monitorModule.default(h.pi); h.setRegisteredTools([...h.tools.keys()]); h.ctx.mode = 'print'; h.ctx.hasUI = false;
  h.file = path.join(h.ctx.cwd, 'external.log'); fs.writeFileSync(h.file, '');
  h.snapshots = async () => (await h.tools.get('monitor_list').execute('inspect', {}, undefined, undefined, h.ctx)).details.monitors;
  h.observe = async (prompt, extra = {}) => {
    const result = await h.tools.get('Monitor').execute('observe', {
      source: { kind: 'file', stdout: h.file, from: 'now' }, description: 'ownership fixture', persistent: true,
      notify: { output: 'none' }, ...(prompt !== undefined ? { loopPrompt: prompt } : {}), ...extra,
    }, undefined, undefined, h.ctx);
    const request = h.busEvents.filter(event => event.channel === monitorModule.LOOP_OBSERVATION_BIND_CHANNEL).at(-1)?.data;
    return { id: result.details.taskId, group: request?.observationGroup };
  };
  h.initial = async prompt => {
    h.state.idle = true; await h.commands.get('loop').handler(prompt, h.ctx);
    h.state.idle = false;
    await h.handlers.get('before_agent_start')(runEvent(h.sent.at(-1)), h.ctx);
  };
  h.abort = async () => { h.state.idle = true; await h.handlers.get('agent_settled')({ aborted: true }, h.ctx); };
  h.wakeup = async prompt => {
    const args = { delaySeconds: 1200, reason: 'fixture fallback', prompt };
    h.setToolCalls([{ type: 'toolCall', id: 'wake', name: 'schedule_wakeup', arguments: args }]);
    return h.tools.get('schedule_wakeup').execute('wake', args, undefined, undefined, h.ctx);
  };
  h.oldMessage = async (observation, prompt) => {
    await h.handlers.get('before_agent_start')({ messageType: 'custom', message: {
      customType: 'Monitor', content: 'external fact', details: { monitorId: observation.id, loopPrompt: prompt, loopObservationGroup: observation.group },
    } }, h.ctx);
  };
  t.after(async () => {
    try { await h.handlers.get('session_shutdown')({ reason: 'quit' }, h.ctx); }
    finally { process.chdir(previousCwd); fs.rmSync(h.ctx.cwd, { recursive: true, force: true }); }
  });
  return h;
}

test('first-arm Esc fences queued events and late bindings, but a fresh explicit /loop can restart', needsMonitor, async t => {
  const h = await fixture(t), task = 'initial task';
  await h.initial(task); const old = await h.observe(task); assert.ok(old.group);
  assert.equal(h.scheduler().size, 0);
  await h.abort(); await until(async () => (await h.snapshots())[0].status === 'stopped');
  assert.ok(h.lastState().stopped.includes(task)); assert.ok(fs.existsSync(h.file));
  await h.oldMessage(old, task);
  for (const prompt of [task, 'reworded initial task']) await assert.rejects(() => h.wakeup(prompt), /was stopped/);
  await assert.rejects(() => createCron(h, { cron: '*/5 * * * *', prompt: 'replacement cron' }), /was stopped/);
  await assert.rejects(() => h.observe('reworded initial task'), /was stopped/);
  assert.equal((await h.snapshots()).length, 1, 'a rejected late binding allocates no observation');
  await h.initial(task); const fresh = await h.observe(task); assert.notEqual(fresh.group, old.group);
  const armed = await h.wakeup(task); assert.ok(armed.details.id); assert.equal(h.scheduler().size, 1);
});

test('cancelling a new initial attempt does not retire an older same-prompt loop or observation', needsMonitor, async t => {
  const h = await fixture(t), task = 'same task';
  const chain = await startSelfPaced(h, task, 1200); const old = await h.observe(task); await runTurn(h);
  await h.initial(task); const fresh = await h.observe(task); assert.notEqual(fresh.group, old.group);
  await h.abort(); await until(async () => (await h.snapshots()).find(record => record.id === fresh.id).status === 'stopped');
  assert.equal(h.scheduler().get(chain.id)?.id, chain.id);
  assert.equal((await h.snapshots()).find(record => record.id === old.id).status, 'running');
  assert.ok(!h.lastState().stopped?.includes(task));
  await h.oldMessage(fresh, task); await assert.rejects(() => h.wakeup('a reworded task'), /was stopped/);
  assert.equal(h.scheduler().get(chain.id)?.id, chain.id);
});

test('a first wakeup registers on the observation identity even if its prompt is reworded', needsMonitor, async t => {
  const h = await fixture(t); await h.initial('original task'); const observation = await h.observe('original task');
  const armed = await h.wakeup('reworded task');
  assert.equal(armed.details.id, observation.group, 'the wakeup uses the existing activity identity');
  assert.equal((await h.snapshots())[0].loopPrompt, 'reworded task');
  await runTurn(h);
  await h.tools.get('cron_delete').execute('delete', { id: armed.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots())[0].status === 'stopped');
  // A pre-adoption message still carries the old prompt, but its group is retired.
  await h.oldMessage(observation, 'original task');
  await assert.rejects(() => h.wakeup('another rewording'), /was stopped/);
  assert.equal(h.scheduler().size, 0);
});

for (const observeFirst of [true, false]) test(`fixed cron survives initial Esc (observation ${observeFirst ? 'before' : 'after'} cron_create)`, needsMonitor, async t => {
  const h = await fixture(t), task = 'fixed task'; await h.initial('5m ' + task);
  const observation = observeFirst ? await h.observe(task) : undefined;
  const job = await createCron(h, { cron: '*/5 * * * *', prompt: task, recurring: true });
  const observed = observation ?? await h.observe(task);
  await h.abort();
  assert.ok(h.scheduler().get(job.id), 'Esc does not cancel the fixed schedule');
  assert.equal((await h.snapshots()).find(record => record.id === observed.id).status, 'running');
});

test('stop:true before first arm stops only the current unarmed attempt and remains idempotent', needsMonitor, async t => {
  const h = await fixture(t), old = await startSelfPaced(h, 'unrelated task', 1200); await runTurn(h);
  await h.initial('new task'); const observation = await h.observe('new task');
  const stop = () => h.tools.get('schedule_wakeup').execute('stop', { stop: true }, undefined, undefined, h.ctx);
  const result = await stop(); assert.equal(result.details.stopped, true); assert.equal(result.details.cancelledWakeups, 0);
  await until(async () => (await h.snapshots()).find(record => record.id === observation.id).status === 'stopped');
  assert.ok(h.scheduler().get(old.id)); await stop(); assert.ok(h.scheduler().get(old.id), 'a repeat cannot cancel unrelated chains');
});

test('Esc during initial observation setup closes it and rejects the unpublished attachment', needsMonitor, async t => {
  const h = await fixture(t); await h.initial('setup task');
  const prepare = FileObservation.prototype.prepare;
  let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  FileObservation.prototype.prepare = async function(...args) { began(); await gate; return prepare.apply(this, args); };
  const attachment = h.observe('setup task').then(value => ({ value }), error => ({ error }));
  try {
    await started; await h.abort(); release();
    const result = await attachment; assert.match(result.error?.message ?? '', /ended during setup|stopped during setup/);
    await until(async () => (await h.snapshots()).length === 0);
    assert.equal(h.scheduler().size, 0); assert.ok(fs.existsSync(h.file));
  } finally { release(); FileObservation.prototype.prepare = prepare; await attachment; }
});

test('unbound observations are not cancelled by the initial Loop Esc scope', needsMonitor, async t => {
  const h = await fixture(t), independent = await h.observe(undefined);
  await h.initial('owned task'); const owned = await h.observe('owned task');
  await h.abort(); await until(async () => (await h.snapshots()).find(record => record.id === owned.id).status === 'stopped');
  assert.equal((await h.snapshots()).find(record => record.id === independent.id).status, 'running');
});

test('one initial activity owns differently worded bindings before its first wakeup', needsMonitor, async t => {
  const h = await fixture(t); await h.initial('original task');
  const first = await h.observe('original task'), second = await h.observe('reworded task');
  assert.equal(first.group, second.group);
  const armed = await h.wakeup('final wording');
  assert.equal(armed.details.id, first.group);
  await h.abort();
  await until(async () => (await h.snapshots()).every(record => record.status === 'stopped'));
  assert.equal(h.scheduler().size, 0);
});

test('two explicit same-prompt activities keep separate wakeups and observations after first arm', needsMonitor, async t => {
  const h = await fixture(t), task = 'same task';
  await h.initial(task); const a = await h.observe(task), first = await h.wakeup(task); await runTurn(h);
  await h.initial(task); const b = await h.observe(task), second = await h.wakeup(task); await runTurn(h);
  assert.notEqual(first.details.id, second.details.id);
  assert.equal(a.group, first.details.id); assert.equal(b.group, second.details.id);
  assert.equal(h.scheduler().size, 2);
  await h.tools.get('cron_delete').execute('delete', { id: first.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots()).find(record => record.id === a.id).status === 'stopped');
  assert.equal((await h.snapshots()).find(record => record.id === b.id).status, 'running');
  assert.ok(h.scheduler().get(second.details.id));
  await h.oldMessage(a, task); await assert.rejects(() => h.wakeup(task), /was stopped/);
  await h.oldMessage(b, task);
  assert.equal((await h.wakeup(task)).details.id, second.details.id, 'the surviving identity wins over the old stop memo');
});

test('retiring an older chain does not cancel a same-prompt initial activity', needsMonitor, async t => {
  const h = await fixture(t), task = 'same task';
  await h.initial(task); const a = await h.observe(task), first = await h.wakeup(task); await runTurn(h);
  await h.initial(task); const b = await h.observe(task);
  await h.tools.get('cron_delete').execute('delete', { id: first.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots()).find(record => record.id === a.id).status === 'stopped');
  assert.equal((await h.snapshots()).find(record => record.id === b.id).status, 'running');
  const second = await h.wakeup(task);
  assert.equal(second.details.id, b.group);
  assert.notEqual(second.details.id, first.details.id);
});

test('a Monitor event re-arms its own activity even when its text names another live Loop', needsMonitor, async t => {
  const h = await fixture(t);
  await h.initial('task A'); const a = await h.observe('task A'), first = await h.wakeup('task A'); await runTurn(h);
  await h.initial('task B'); const b = await h.observe('task B'), second = await h.wakeup('task B'); await runTurn(h);
  await h.oldMessage(b, 'task A');
  assert.equal((await h.observe('task A')).group, b.group);
  assert.equal((await h.wakeup('task A')).details.id, second.details.id);
  const stopped = await h.tools.get('schedule_wakeup').execute('stop', { stop: true, prompt: 'task A' }, undefined, undefined, h.ctx);
  assert.equal(stopped.details.cancelledWakeups, 1);
  await until(async () => (await h.snapshots()).filter(record => record.id !== a.id).every(record => record.status === 'stopped'));
  assert.ok(h.scheduler().get(first.details.id));
  assert.equal((await h.snapshots()).find(record => record.id === a.id).status, 'running');
});

test('legacy text-only stop cannot cancel an identity-bound observation', needsMonitor, async t => {
  const h = await fixture(t), task = 'identified task';
  await h.initial(task); const observation = await h.observe(task); await h.wakeup(task); await runTurn(h);
  h.pi.events.emit('loop:stopped', { prompt: task, reason: 'legacy text-only stop' });
  assert.equal((await h.snapshots()).find(record => record.id === observation.id).status, 'running');
});

test('identity retirement leaves detached same-prompt cron observations running', needsMonitor, async t => {
  const h = await fixture(t), task = 'shared task';
  await h.initial('5m ' + task); const fixed = await h.observe(task);
  const cron = await createCron(h, { cron: '*/5 * * * *', prompt: task, recurring: true }); await runTurn(h);
  await h.initial(task); const own = await h.observe(task), wakeup = await h.wakeup(task); await runTurn(h);
  await h.tools.get('cron_delete').execute('delete', { id: wakeup.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots()).find(record => record.id === own.id).status === 'stopped');
  assert.equal((await h.snapshots()).find(record => record.id === fixed.id).status, 'running');
  assert.ok(h.scheduler().get(cron.id));
});

test('ambiguous legacy prompt lookup cannot choose between two identified activities', needsMonitor, async t => {
  const h = await fixture(t), task = 'shared task';
  await h.initial(task); await h.observe(task); await h.wakeup(task); await runTurn(h);
  await h.initial(task); await h.observe(task); await h.wakeup(task); await runTurn(h);
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'unrelated work' }, h.ctx);
  await assert.rejects(() => h.observe(task), /[Aa]mbiguous/);
  assert.equal((await h.snapshots()).length, 2, 'ambiguity allocates no observation resources');
  await h.oldMessage({ id: 'legacy' }, task);
  await assert.rejects(() => h.wakeup('another task'), /was stopped/);
  assert.equal(h.scheduler().size, 2);
});

test('a binder with no activity in its reply cannot create a text-only stop target', needsMonitor, async t => {
  const h = await fixture(t), task = 'legacy compatibility';
  await h.initial(task); const identified = await h.observe(task); await h.wakeup(task); await runTurn(h);
  // An incomplete reply must not grant affinity to a new observation.
  const unsubscribe = h.pi.events.on('loop:bind-observation', request => { delete request.canonicalPrompt; delete request.observationGroup; });
  let legacy;
  try { legacy = await h.observe(task); } finally { unsubscribe(); }
  assert.equal(legacy.group, undefined);
  h.pi.events.emit('loop:stopped', { prompt: task, reason: 'legacy text-only stop' });
  assert.equal((await h.snapshots()).find(record => record.id === legacy.id).status, 'running');
  assert.equal((await h.snapshots()).find(record => record.id === legacy.id).loopPrompt, undefined);
  assert.equal((await h.snapshots()).find(record => record.id === identified.id).status, 'running');
});

test('same-prompt schedules count their own ticks, including a later-created activity', needsMonitor, async t => {
  const h = await fixture(t), task = 'same title, different ticks';
  const create = async () => { await h.initial(task); const result = await h.wakeup(task); await runTurn(h); return h.scheduler().get(result.details.id); };
  const fire = chain => {
    chain.scheduledFor = Date.now() - 1;
    h.state.idle = true; h.scheduler().tick();
    const message = h.sent.at(-1).message;
    assert.equal(message.details.jobId, chain.id);
    return message.details.tickCount;
  };
  const first = await create();
  assert.equal(fire(first), 1);
  const second = await create();
  assert.notEqual(first.id, second.id);
  assert.equal(fire(second), 1);
  assert.equal(fire(first), 2);
  assert.equal(first.tickCount, 2);
  assert.equal(second.tickCount, 1);
});

test('stop:true with another prompt still cancels only the current initial activity', needsMonitor, async t => {
  const h = await fixture(t);
  await h.initial('task A'); const a = await h.observe('task A'), first = await h.wakeup('task A'); await runTurn(h);
  await h.initial('task B'); const b = await h.observe('task B');
  const stopped = await h.tools.get('schedule_wakeup').execute('stop', { stop: true, prompt: 'task A' }, undefined, undefined, h.ctx);
  assert.equal(stopped.details.cancelledWakeups, 0);
  await until(async () => (await h.snapshots()).find(record => record.id === b.id).status === 'stopped');
  assert.equal((await h.snapshots()).find(record => record.id === a.id).status, 'running');
  assert.ok(h.scheduler().get(first.details.id));
});

test('an explicitly unbound modern event cannot stop a same-prompt activity', needsMonitor, async t => {
  const h = await fixture(t), task = 'same text';
  await h.initial(task); const observation = await h.observe(task), armed = await h.wakeup(task); await runTurn(h);
  await h.oldMessage({ id: 'unbound-modern', group: null }, task);
  const stopped = await h.tools.get('schedule_wakeup').execute('stop', { stop: true }, undefined, undefined, h.ctx);
  assert.equal(stopped.details.cancelledWakeups, 0);
  await h.abort();
  assert.ok(h.scheduler().get(armed.details.id));
  assert.equal((await h.snapshots()).find(record => record.id === observation.id).status, 'running');
});

test('a wakeup from an unbound modern event creates a new activity rather than reusing task text', needsMonitor, async t => {
  const h = await fixture(t), task = 'same text';
  await h.initial(task); const observation = await h.observe(task), first = await h.wakeup(task); await runTurn(h);
  await h.oldMessage({ id: 'unbound-modern', group: null }, task);
  const second = await h.wakeup(task);
  assert.notEqual(second.details.id, first.details.id);
  assert.equal(h.scheduler().size, 2);
  await h.abort();
  assert.ok(h.scheduler().get(first.details.id));
  assert.equal((await h.snapshots()).find(record => record.id === observation.id).status, 'running');
});

test('a detached fixed-cron observation event has no self-paced affinity despite matching text', needsMonitor, async t => {
  const h = await fixture(t), task = 'shared text', file = path.join(h.ctx.cwd, 'fixed.log');
  fs.writeFileSync(file, '');
  await h.initial('5m ' + task);
  const fixed = await h.observe(task, { source: { kind: 'file', stdout: file, from: 'now' }, notify: { output: 'turn' } });
  const cron = await createCron(h, { cron: '*/5 * * * *', prompt: task, recurring: true }); await runTurn(h);
  await h.initial(task); const own = await h.observe(task), armed = await h.wakeup(task); await runTurn(h);
  fs.appendFileSync(file, 'READY\n');
  const event = () => h.sent.find(entry => entry.kind === 'custom' && entry.message.customType === 'Monitor' && entry.message.details?.monitorId === fixed.id);
  await until(event);
  assert.equal(event().message.details.loopObservationGroup, null);
  await h.handlers.get('before_agent_start')(runEvent(event()), h.ctx); await h.abort();
  assert.ok(h.scheduler().get(armed.details.id)); assert.ok(h.scheduler().get(cron.id));
  assert.equal((await h.snapshots()).find(record => record.id === own.id).status, 'running');
});

test('a wakeup cannot overwrite a different schedule occupying its activity identity', needsMonitor, async t => {
  const h = await fixture(t); await h.initial('initial activity'); const observation = await h.observe('initial activity');
  h.scheduler().add({ id: observation.group, kind: 'cron', cron: '*/5 * * * *', prompt: 'unrelated cron', recurring: true, durable: false, createdAt: Date.now(), source: 'collision fixture' });
  await assert.rejects(() => h.wakeup('initial activity'), /identity|different schedule/);
  assert.equal(h.scheduler().get(observation.group).kind, 'cron');
  const stopped = await h.tools.get('schedule_wakeup').execute('stop', { stop: true }, undefined, undefined, h.ctx);
  assert.equal(stopped.details.cancelledWakeups, 0);
  await until(async () => (await h.snapshots())[0].status === 'stopped');
  assert.equal(h.scheduler().get(observation.group).kind, 'cron', 'initial cancellation does not cancel the occupying schedule');
});

test('a queued /loop command cannot outlive shutdown even when the facade is rebound', async t => {
  const previousCwd = process.cwd(), h = await start(makeHarness());
  let release; const idle = new Promise(resolve => { release = resolve; });
  h.state.idle = false; h.ctx.waitForIdle = () => idle;
  t.after(async () => {
    try { await h.handlers.get('session_shutdown')({ reason: 'quit' }, h.ctx); }
    finally { process.chdir(previousCwd); fs.rmSync(h.ctx.cwd, { recursive: true, force: true }); }
  });
  await h.commands.get('loop').handler('late command', h.ctx);
  await h.handlers.get('session_shutdown')({ reason: 'reload' }, h.ctx);
  h.state.idle = true; await h.handlers.get('session_start')({ reason: 'reload' }, h.ctx);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.sent.filter(entry => entry.kind === 'user'), []);
  assert.equal(h.scheduler().size, 0);
});

test('natural-language user turn binds Monitor before schedule_wakeup onto one Loop identity', needsMonitor, async t => {
  const h = await fixture(t), task = 'plain-language deploy watch';
  h.state.idle = false;
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Observe the deploy log and check back until green' }, h.ctx);
  const observation = await h.observe(task);
  assert.ok(observation.group, 'Monitor receives a stable activity id during a plain user turn');
  const armed = await h.wakeup(task);
  assert.equal(armed.details.id, observation.group, 'schedule_wakeup links onto the same activity id');
  await runTurn(h);
  await h.tools.get('cron_delete').execute('delete', { id: armed.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots())[0].status === 'stopped');
});

test('plain user activity A cannot capture an explicitly named existing Loop B', needsMonitor, async t => {
  const h = await fixture(t);
  const b = await startSelfPaced(h, 'existing B', 1200);
  await runTurn(h);
  h.state.idle = false;
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Set up A and add a watch to existing B' }, h.ctx);
  const a = await h.observe('new A');
  const other = await h.observe('existing B');
  assert.notEqual(a.group, b.id);
  assert.equal(other.group, b.id, 'B is selected explicitly, not by A’s turn-local identity');
  await assert.rejects(() => h.observe('unrelated C'), /different self-paced Loop/);
  await h.abort();
  await until(async () => (await h.snapshots()).find(record => record.id === a.id).status === 'stopped');
  assert.ok(h.scheduler().get(b.id));
  assert.equal((await h.snapshots()).find(record => record.id === other.id).status, 'running');
});

for (const observeFirst of [true, false]) test(`an unrelated cron does not change a plain user Loop’s ownership (observe first: ${observeFirst})`, needsMonitor, async t => {
  const h = await fixture(t), task = 'watch evaluation A';
  h.state.idle = false;
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Watch A and separately remind me about B daily' }, h.ctx);
  let observation = observeFirst ? await h.observe(task) : undefined;
  const cron = await createCron(h, { cron: '3 9 * * *', prompt: 'daily reminder B' });
  observation ??= await h.observe(task);
  assert.ok(observation.group);
  assert.equal((await h.snapshots()).find(record => record.id === observation.id).loopPrompt, task);
  const arm = await h.wakeup(task);
  assert.equal(arm.details.id, observation.group);
  await runTurn(h);
  await h.tools.get('cron_delete').execute('delete', { id: arm.details.id }, undefined, undefined, h.ctx);
  await until(async () => (await h.snapshots()).find(record => record.id === observation.id).status === 'stopped');
  assert.ok(h.scheduler().get(cron.id), 'stopping A does not stop B');
});

test('plain user wakeups and stop requests do not silently target another prompt’s activity', needsMonitor, async t => {
  const h = await fixture(t);
  const existing = await startSelfPaced(h, 'existing B', 1200);
  await runTurn(h);
  h.state.idle = false;
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Start A and reschedule B' }, h.ctx);
  const observation = await h.observe('new A');
  await assert.rejects(() => h.wakeup('unrelated C'), /different self-paced Loop/);
  await assert.rejects(() => h.tools.get('schedule_wakeup').execute('stop', { stop: true, prompt: 'existing B' }, undefined, undefined, h.ctx), /cron_delete/);
  const b = await h.wakeup('existing B');
  assert.equal(b.details.id, existing.id);
  const a = await h.wakeup('new A');
  assert.equal(a.details.id, observation.group);
  assert.notEqual(a.details.id, b.details.id);
});

test('/loop list uses read-only status guidelines without allocating a self-paced activity', needsMonitor, async t => {
  const h = await fixture(t);
  await h.commands.get('loop').handler('list', h.ctx);
  const sent = h.sent.at(-1);
  assert.equal(sent.content, '/loop list');
  const rules = await h.handlers.get('before_agent_start')(runEvent(sent), h.ctx);
  assert.match(rules.message.content, /Call `cron_list` once/);
  const obs = await h.observe('unrelated');
  assert.equal(obs.group, undefined, '/loop list did not allocate an activity id');
});

test('aborted settlement on an unrelated turn does not consume a chain awaiting reschedule', async t => {
  const previousCwd = process.cwd(), h = await start(makeHarness());
  t.after(async () => {
    try { await h.handlers.get('session_shutdown')({ reason: 'quit' }, h.ctx); }
    finally { process.chdir(previousCwd); fs.rmSync(h.ctx.cwd, { recursive: true, force: true }); }
  });
  const chain = await startSelfPaced(h, 'background loop', 1200);
  await runTurn(h);
  chain.keepaliveTurn = true;
  chain.awaitingReschedule = true;
  await h.handlers.get('before_agent_start')({ messageType: 'user', prompt: 'unrelated user question' }, h.ctx);
  h.state.idle = true;
  await h.handlers.get('agent_settled')({ aborted: true }, h.ctx);
  assert.ok(h.scheduler().get(chain.id), 'unrelated Esc must not retire the background chain via settleChains');
});

test('agent_settled flushes Loop outcomes before dispatching a pending cron job', async t => {
  const previousCwd = process.cwd(), h = await start(makeHarness());
  t.after(async () => {
    try { await h.handlers.get('session_shutdown')({ reason: 'quit' }, h.ctx); }
    finally { process.chdir(previousCwd); fs.rmSync(h.ctx.cwd, { recursive: true, force: true }); }
  });
  const chain = await startSelfPaced(h, 'expiring loop', 1200);
  await runTurn(h);
  chain.keepaliveTurn = true;
  chain.awaitingReschedule = true;
  const cron = await createCron(h, { cron: '* * * * *', prompt: 'other cron', recurring: true });
  h.scheduler().get(cron.id).nextFireAt = Date.now() - 1000;
  const order = [];
  const origSend = h.pi.sendMessage;
  h.pi.sendMessage = (msg, opts) => {
    order.push({ type: msg.customType, triggerTurn: opts?.triggerTurn });
    if (opts?.triggerTurn) h.state.idle = false;
    return origSend(msg, opts);
  };
  h.state.idle = true;
  await h.handlers.get('agent_settled')({ aborted: false }, h.ctx);
  assert.equal(order[0]?.type, 'pi-cc-loop-outcome', 'outcome is flushed before scheduler.notifyIdle()');
  assert.equal(order[0]?.triggerTurn, true);
  assert.equal(order.length, 1, 'pending cron waits while the outcome turn is active');
});
