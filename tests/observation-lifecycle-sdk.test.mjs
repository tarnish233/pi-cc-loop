/** Actual Pi lifecycle/queues with scripted responses: no provider/network requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { extensionDir, findPiInstall, siblingExtensionDir } from './helpers.mjs';

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(findPiInstall().piCodingAgent).href);
const monitorPath = path.join(siblingExtensionDir('pi-cc-monitor'), 'index.ts');
const hasMonitor = fs.existsSync(monitorPath);
const callBlock = (name, id, args) => ({ type: 'toolCall', name, id, arguments: args });
const outcomeEntries = session => session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'pi-cc-loop-outcome');
const queuedOutcomes = session => session.agent.peekQueuedMessages().filter(message => message.customType === 'pi-cc-loop-outcome');
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function until(predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('SDK lifecycle fixture did not reach its expected state');
}
function response(model, content, reason) {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
    stopReason: reason ?? (content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop'), timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(model, content, options, { blocked, during } = {}) {
  let message = response(model, content);
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: { ...message, content: [], stopReason: 'pending' } };
      await during?.();
      if (blocked) {
        assert.ok(options.signal); blocked.resolve();
        if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        message = response(model, [], 'aborted'); message.errorMessage = 'fixture abort';
      }
      yield { type: 'done', reason: message.stopReason, message };
    }, async result() { return message; },
  };
}
async function setup(t, name, withMonitor = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-observation-sdk-')), cwd = path.join(root, 'project'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_CC_CONFIG_FILE = path.join(agentDir, 'fixture-settings.json');
  process.env.PI_LOOP_SCAN_MS = '600000'; process.env.PI_LOOP_DURABLE_SYNC_MS = '0';
  const model = { id: 'scripted', name: 'scripted', api: 'openai-completions', provider: 'loop-regression-' + name,
    baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model],
    streamSimple() { throw new Error('Network/provider calls forbidden in SDK regression'); } });
  const bindings = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [pi => { pi.events.on('loop:bind-observation', request => bindings.push(request)); }],
    additionalExtensionPaths: [path.join(extensionDir, 'index.ts'), ...(withMonitor ? [monitorPath] : [])],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, thinkingLevel: 'off', settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: true });
  const errors = [], events = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  session.subscribe(event => events.push(event.type));
  t.after(async () => {
    try {
      session.clearQueue(); await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally { session.dispose(); modelRuntime.unregisterProvider(model.provider); fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { session, cwd, model, errors, events, bindings,
    async call(name, args, id = 'inspect') {
      return session.extensionRunner.getToolDefinition(name).execute(id, args, undefined, undefined, session.extensionRunner.createContext());
    } };
}

test('Esc before the first wakeup arm stops the initial observation without recreating the loop', { skip: !hasMonitor }, async t => {
  const f = await setup(t, 'initial-esc', true), task = 'observe the existing initial run', file = path.join(f.cwd, 'external.log');
  fs.writeFileSync(file, '');
  const blocked = deferred(), requests = [];
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < 2, 'no provider request may be restarted by a cancelled initial observation');
    return index === 0
      ? stream(f.model, [callBlock('Monitor', 'attach', { source: { kind: 'file', stdout: file, from: 'now' }, description: 'initial observation', persistent: true, loopPrompt: task })], options)
      : stream(f.model, [{ type: 'text', text: 'before the first wakeup arm' }], options, { blocked });
  };
  await f.session.prompt('/loop ' + task); await blocked.promise;
  assert.deepEqual((await f.call('cron_list', {})).details.jobs, []);
  f.session.clearQueue(); await f.session.abort();
  await until(async () => (await f.call('monitor_list', {})).details.monitors.every(record => record.status === 'stopped'));
  const monitors = (await f.call('monitor_list', {})).details.monitors;
  assert.equal(monitors.length, 1); assert.equal(monitors[0].resourceActive, undefined);
  assert.ok(fs.existsSync(file), 'only the observation is stopped, not its external source');
  fs.appendFileSync(file, 'AFTER ESC\n'); await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(requests.length, 2); assert.deepEqual((await f.call('cron_list', {})).details.jobs, []);
  assert.equal(outcomeEntries(f.session).length, 0, 'Esc cancellation stays silent and does not restart a reply');
  assert.deepEqual(f.errors, []);
});

for (const clearQueue of [true, false]) test(`${clearQueue ? 'TUI clearQueue' : 'RPC abort'} preserves a stopped Loop outcome without restarting`, async t => {
  const f = await setup(t, clearQueue ? 'outcome-clear' : 'outcome-abort'), task = 'watch the outcome';
  const blocked = deferred(), requests = [];
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < 3, 'no extra run after aborted settlement');
    if (index === 0) return stream(f.model, [callBlock('schedule_wakeup', 'arm', { delaySeconds: 1200, reason: 'fixture fallback', prompt: task })], options);
    if (index === 1) return stream(f.model, [{ type: 'text', text: 'unrelated analysis' }], options, { blocked });
    assert.ok(context.messages.some(message => message.customType === 'pi-cc-loop-outcome'));
    return stream(f.model, [{ type: 'text', text: 'normal conversation after the abort' }], options);
  };
  await f.session.prompt('Arm a self-paced fixture');
  const chain = (await f.call('cron_list', {})).details.jobs[0]; assert.ok(chain);
  const longRun = f.session.prompt('Unrelated work'); await blocked.promise;
  await f.call('cron_delete', { id: chain.id }, 'panel-stop');
  assert.deepEqual(queuedOutcomes(f.session), [], 'outcomes must wait outside Pi\'s clearable follow-up queue');
  assert.equal(outcomeEntries(f.session).length, 0, 'the active response must not be split');
  if (clearQueue) f.session.clearQueue();
  await f.session.abort(); await longRun;
  assert.equal(outcomeEntries(f.session).length, 1); assert.equal(requests.length, 2);
  assert.equal(outcomeEntries(f.session)[0].details.jobId, chain.id);
  assert.equal(f.session.isIdle, true); assert.deepEqual(queuedOutcomes(f.session), []);
  await f.session.prompt('Continue normal conversation');
  assert.equal(requests.length, 3); assert.equal(outcomeEntries(f.session).length, 1);
  assert.deepEqual((await f.call('cron_list', {})).details.jobs, []); assert.deepEqual(f.errors, []);
});

for (const count of [1, 2]) test(`${count} Loop outcomes at a streamed-text boundary request one continuation`, async t => {
  const f = await setup(t, 'boundary-' + count), requests = [], chains = [];
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < count + 2, 'a boundary must not create duplicate continuation requests');
    if (index < count) return stream(f.model, [callBlock('schedule_wakeup', 'arm-' + index, { delaySeconds: 1200, reason: 'fixture fallback', prompt: 'task ' + index })], options);
    if (index === count) return stream(f.model, [{ type: 'text', text: 'the unrelated response finishes first' }], options, {
      async during() {
        for (const chain of chains) await f.call('cron_delete', { id: chain.id }, 'stop-' + chain.id);
        assert.equal(outcomeEntries(f.session).length, 0);
        assert.deepEqual(queuedOutcomes(f.session), []);
      },
    });
    assert.equal(outcomeEntries(f.session).length, count);
    assert.equal(context.messages.filter(message => message.customType === 'pi-cc-loop-outcome').length, count);
    return stream(f.model, [{ type: 'text', text: 'incorporated the stopped outcomes' }], options);
  };
  for (let index = 0; index < count; index++) await f.session.prompt('Arm task ' + index);
  chains.push(...(await f.call('cron_list', {})).details.jobs);
  await f.session.prompt('Continue independent work');
  assert.equal(requests.length, count + 2);
  assert.equal(f.events.filter(type => type === 'agent_start').length, count + 1, 'continuation stays in the original run');
  assert.equal(f.events.filter(type => type === 'agent_settled').length, count + 1);
  const branch = f.session.sessionManager.getBranch();
  const independent = branch.findIndex(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.content.some(block => block.type === 'text' && block.text === 'the unrelated response finishes first'));
  const firstOutcome = branch.findIndex(entry => entry.type === 'custom_message' && entry.customType === 'pi-cc-loop-outcome');
  assert.ok(independent >= 0 && firstOutcome > independent);
  assert.equal(f.session.isIdle, true); assert.deepEqual(f.errors, []);
});

test('SDK initial bindings and the first wakeup share one stable identity despite rewording', { skip: !hasMonitor }, async t => {
  const f = await setup(t, 'stable-initial', true), requests = [], task = 'original activity';
  const files = [path.join(f.cwd, 'first.log'), path.join(f.cwd, 'second.log')];
  for (const file of files) fs.writeFileSync(file, '');
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < 3, 'the standalone wakeup ends the initial run');
    return stream(f.model, [index < 2
      ? callBlock('Monitor', 'attach-' + index, { source: { kind: 'file', stdout: files[index], from: 'now' },
          description: 'stable activity observation', persistent: true, notify: { output: 'none' }, loopPrompt: index ? 'reworded activity' : task })
      : callBlock('schedule_wakeup', 'arm', { delaySeconds: 1200, reason: 'fixture fallback', prompt: 'final activity wording' })], options);
  };
  await f.session.prompt('/loop ' + task); await f.session.waitForIdle();
  const jobs = (await f.call('cron_list', {})).details.jobs;
  assert.equal(jobs.length, 1); assert.equal(requests.length, 3);
  assert.equal(f.bindings.length, 2);
  assert.equal(f.bindings[0].observationGroup, jobs[0].id);
  assert.equal(f.bindings[1].observationGroup, jobs[0].id);
  const monitors = (await f.call('monitor_list', {})).details.monitors;
  assert.equal(monitors.length, 2);
  for (const record of [...jobs, ...monitors]) {
    assert.equal(Object.hasOwn(record, 'activityId'), false, 'activity metadata stays out of public tool snapshots');
    assert.equal(Object.hasOwn(record, 'loopObservationGroup'), false);
  }
  assert.deepEqual(f.errors, []);
});

test('SDK independent observations carry explicit no-affinity metadata and cannot stop another Loop', { skip: !hasMonitor }, async t => {
  const f = await setup(t, 'explicit-unbound', true), requests = [], task = 'other activity';
  const ownFile = path.join(f.cwd, 'owned.log'), independentFile = path.join(f.cwd, 'independent.log');
  fs.writeFileSync(ownFile, ''); fs.writeFileSync(independentFile, '');
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < 4, 'an independent observation must not restart or retire an unrelated Loop');
    if (index === 0) return stream(f.model, [callBlock('Monitor', 'owned', { source: { kind: 'file', stdout: ownFile, from: 'now' }, description: 'owned', persistent: true, loopPrompt: task })], options);
    if (index === 1) return stream(f.model, [callBlock('schedule_wakeup', 'arm', { delaySeconds: 1200, reason: 'fixture fallback', prompt: task })], options);
    if (index === 2) return stream(f.model, [callBlock('schedule_wakeup', 'stop-unbound', { stop: true })], options);
    return stream(f.model, [{ type: 'text', text: 'independent fact acknowledged' }], options);
  };
  await f.session.prompt('/loop ' + task); await f.session.waitForIdle();
  const first = (await f.call('cron_list', {})).details.jobs[0];
  const independent = await f.call('Monitor', { source: { kind: 'file', stdout: independentFile, from: 'now' }, description: 'independent', persistent: true });
  fs.appendFileSync(independentFile, 'READY\n');
  await until(() => requests.length === 4); await f.session.waitForIdle();
  assert.deepEqual((await f.call('cron_list', {})).details.jobs.map(job => job.id), [first.id]);
  const event = f.session.sessionManager.getBranch().find(entry => entry.type === 'custom_message' && entry.customType === 'Monitor' && entry.details?.monitorId === independent.details.taskId);
  assert.equal(event?.details.loopObservationGroup, null, 'new unbound events cannot be mistaken for legacy text-only bindings');
  assert.deepEqual(f.errors, []);
});

test('SDK same-prompt activities remain separate and only the survivor reacts to output', { skip: !hasMonitor }, async t => {
  const f = await setup(t, 'stable-same-prompt', true), requests = [], task = 'same activity text';
  const files = [path.join(f.cwd, 'a.log'), path.join(f.cwd, 'b.log')];
  for (const file of files) fs.writeFileSync(file, '');
  f.session.agent.streamFunction = async (_model, context, options) => {
    const index = requests.length; requests.push(structuredClone(context.messages));
    assert.ok(index < 6, 'no duplicate or retired activity may restart');
    if (index === 4) return stream(f.model, [{ type: 'text', text: 'activity A stopped' }], options);
    if (index === 0 || index === 2) return stream(f.model, [callBlock('Monitor', 'attach-' + index, {
      source: { kind: 'file', stdout: files[index / 2], from: 'now' }, description: 'same-prompt observation',
      persistent: true, loopPrompt: task,
    })], options);
    return stream(f.model, [callBlock('schedule_wakeup', 'arm-' + index, {
      delaySeconds: 1200, reason: 'fixture fallback', prompt: task,
    })], options);
  };
  await f.session.prompt('/loop ' + task); await f.session.waitForIdle();
  const first = (await f.call('cron_list', {})).details.jobs[0];
  await f.session.prompt('/loop ' + task); await f.session.waitForIdle();
  const jobs = (await f.call('cron_list', {})).details.jobs, second = jobs.find(job => job.id !== first.id);
  assert.equal(jobs.length, 2); assert.ok(second);
  assert.equal(f.bindings[0].observationGroup, first.id);
  assert.equal(f.bindings[1].observationGroup, second.id);
  assert.equal(f.bindings[1].acceptedVersion, 1);
  assert.ok(JSON.stringify(requests[2]).includes('loopPrompt'), 'the actual Pi event bus resolved Monitor discovery');
  await assert.rejects(() => f.call('Monitor', {
    source: { kind: 'file', stdout: files[0] }, description: 'ambiguous legacy request', loopPrompt: task,
  }), /Ambiguous \/loop prompt/);
  assert.equal((await f.call('monitor_list', {})).details.monitors.length, 2, 'the refused binding allocates no resources');
  await f.call('cron_delete', { id: first.id }, 'stop-A'); await f.session.waitForIdle();
  await until(async () => (await f.call('monitor_list', {})).details.monitors.some(record => record.status === 'stopped'));
  const monitors = (await f.call('monitor_list', {})).details.monitors;
  assert.equal(monitors.find(record => record.source.stdout === files[0]).status, 'stopped');
  assert.equal(monitors.find(record => record.source.stdout === files[1]).status, 'running');
  fs.appendFileSync(files[0], 'OLD OUTPUT\n'); fs.appendFileSync(files[1], 'READY\n');
  await until(() => requests.length === 6); await f.session.waitForIdle();
  const remaining = (await f.call('cron_list', {})).details.jobs;
  assert.deepEqual(remaining.map(job => job.id), [second.id]);
  const delivered = f.session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'Monitor' && entry.details?.loopObservationGroup === second.id);
  assert.ok(delivered.some(entry => String(entry.content).includes('READY')), 'the persisted event belongs to the surviving activity');
  assert.ok(JSON.stringify(requests[5]).includes('READY'), 'the model receives the external fact');
  assert.ok(!requests[5].some(message => message.details?.loopObservationGroup), 'internal custom-message details are not sent to the model');
  assert.deepEqual(f.errors, []);
});
