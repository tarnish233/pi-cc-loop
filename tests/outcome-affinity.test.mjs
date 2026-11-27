/** An outcome is a fact, not ownership of another same-prompt activity. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { makeHarness, start, runEvent, runTurn } from './harness.mjs';

test('a stopped outcome cannot re-arm or stop a surviving same-prompt activity', async t => {
  const previousCwd = process.cwd(), h = await start(makeHarness()), task = 'same task';
  t.after(async () => {
    try { await h.handlers.get('session_shutdown')({ reason: 'quit' }, h.ctx); }
    finally { process.chdir(previousCwd); fs.rmSync(h.ctx.cwd, { recursive: true, force: true }); }
  });
  const wakeup = args => h.tools.get('schedule_wakeup').execute('c', args, undefined, undefined, h.ctx);
  const create = async () => {
    await h.commands.get('loop').handler(task, h.ctx);
    await h.handlers.get('before_agent_start')(runEvent(h.sent.at(-1)), h.ctx);
    const result = await wakeup({ delaySeconds: 1200, reason: 'fixture fallback', prompt: task });
    await runTurn(h);
    return result.details.id;
  };
  const first = await create(), second = await create();
  assert.notEqual(first, second);
  await h.tools.get('cron_delete').execute('delete', { id: first }, undefined, undefined, h.ctx);
  const outcome = h.sent.find(entry => entry.kind === 'custom' && entry.message.customType === 'pi-cc-loop-outcome' && entry.message.details?.jobId === first);
  assert.ok(outcome);
  await h.handlers.get('before_agent_start')(runEvent(outcome), h.ctx);
  await assert.rejects(() => wakeup({ delaySeconds: 1200, reason: 'not a new request', prompt: task }), /was stopped/);
  const stopped = await wakeup({ stop: true });
  assert.equal(stopped.details.cancelledWakeups, 0);
  assert.ok(h.scheduler().get(second));
});
