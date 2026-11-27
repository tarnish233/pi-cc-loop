/** Exercise the real online driver against an offline fake host, including workspace ownership. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script = fileURLToPath(new URL('../scripts/cache-check.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/cache-probe-host.mjs', import.meta.url));

for (const scenario of ['succeeded', 'failed']) for (const cleanup of ['succeeded', 'failed']) {
  test('scenario ' + scenario + ' / cleanup ' + cleanup + ' keeps or releases only its owned workspace', t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-probe-cleanup-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['--import', fixture, script, '--no-monitor', '--model', 'fixture/no-provider', '--timeout', '10'], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PI_MONITOR_ARTIFACT_DIR: cwd, PI_TEST_PROBE_SCENARIO: scenario, PI_TEST_PROBE_CLEANUP: cleanup },
    });
    assert.equal(result.status, scenario === 'succeeded' && cleanup === 'succeeded' ? 0 : 2, result.stderr || result.stdout);
    const workspaces = fs.readdirSync(cwd).filter(name => name.startsWith('pi-cc-cache-check-'));
    assert.equal(workspaces.length, cleanup === 'failed' ? 1 : 0, result.stdout + result.stderr);
    if (cleanup === 'failed') {
      assert.match(result.stderr, /cleanup is unconfirmed; keep the owned workspace/);
      if (scenario === 'failed') assert.match(result.stderr, /after: model returned an error: fixture scenario failure/);
      const owner = JSON.parse(fs.readFileSync(path.join(cwd, workspaces[0], 'owner.json'), 'utf8'));
      assert.equal(owner.schema, 'pi-cc-loop.cache-probe'); assert.equal(owner.path, path.join(cwd, workspaces[0]));
    }
    if (scenario === 'failed') assert.match(result.stdout, /inconclusive: model returned an error: fixture scenario failure/);
  });
}
