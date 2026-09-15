import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/persistence/state-store.js';
import { SessionManager } from '../src/sessions/session-manager.js';

test('automations persist schedule state and can be paused and enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdock-'));
  try {
    const store = new StateStore(join(directory, 'state.json')); const manager = new SessionManager(store); await manager.load();
    const automation = await manager.createAutomation({ name: 'Tests', cwd: directory, mode: 'shell', prompt: 'echo test', schedule: 'interval', intervalMinutes: 10, enabled: true });
    assert.equal(automation.lastRunStatus, 'never'); assert.ok(automation.nextRunAt);
    const paused = await manager.updateAutomation(automation.id, { enabled: false }); assert.equal(paused.nextRunAt, null);
    const enabled = await manager.updateAutomation(automation.id, { enabled: true }); assert.ok(enabled.nextRunAt);
    await manager.shutdown(); const reloaded = new StateStore(join(directory, 'state.json')); await reloaded.load(); assert.equal(reloaded.listAutomations()[0]?.enabled, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one-time automations reject past dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdock-'));
  try {
    const manager = new SessionManager(new StateStore(join(directory, 'state.json'))); await manager.load();
    await assert.rejects(manager.createAutomation({ name: 'Past', cwd: directory, mode: 'shell', prompt: 'echo no', schedule: 'once', runAt: new Date(Date.now() - 1000).toISOString(), enabled: true }), /future/);
    await manager.shutdown();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
