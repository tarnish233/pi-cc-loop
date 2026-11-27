/** Offline RPC/cleanup fixture: no Pi binary, model, authentication or real job PID. */
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

const PID = 424242, realKill = process.kill, realNow = Date.now;
let alive = true, cleanup = false, clock = realNow();
const child = Object.assign(new EventEmitter(), { pid: PID, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough() });
const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
const assistant = () => emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 0, cacheRead: 1000, cost: { total: 0 } } } });
const settle = () => emit({ type: 'agent_settled' });
const tick = kind => setTimeout(() => {
  emit({ type: 'message_start', message: { role: 'custom', customType: 'pi-cc-loop-tick', details: { kind } } });
  assistant(); settle();
}, 0);
child.stdin.write = line => {
  const { message } = JSON.parse(line);
  if (process.env.PI_TEST_PROBE_SCENARIO === 'failed') {
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'fixture scenario failure', usage: {} } });
  } else {
    if (message.startsWith('/loop 1m')) emit({ type: 'message_end', message: { role: 'toolResult', toolName: 'cron_create', isError: false } });
    else if (message.startsWith('/loop ') && !message.startsWith('/loop stop')) emit({ type: 'message_end', message: { role: 'toolResult', toolName: 'schedule_wakeup', isError: false } });
    assistant(); settle();
    if (message.startsWith('/loop 1m') || !message.startsWith('/loop ')) tick('cron');
    else if (!message.startsWith('/loop stop')) tick('wakeup');
  }
  return true;
};
cp.spawn = command => { if (command !== 'pi') throw new Error('unexpected fixture command'); return child; };
syncBuiltinESMExports();
process.kill = (pid, signal) => {
  if (pid !== -PID) return realKill.call(process, pid, signal);
  if (signal === 0) {
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  }
  cleanup = true;
  if (process.env.PI_TEST_PROBE_CLEANUP === 'failed') throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
  alive = false; child.exitCode = 0; child.stdout.end(); return true;
};
// Advance only cleanup deadlines; scenario ordering still exercises the real probe driver.
Date.now = () => cleanup ? clock += 2000 : realNow();
