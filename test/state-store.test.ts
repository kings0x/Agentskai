import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/persistence/state-store.js';
import type { SessionSnapshot } from '../src/types.js';

function snapshot(cwd: string, name = 'Test'): SessionSnapshot {
  return { id: 'one', name, cwd, mode: 'shell', status: 'exited', pid: null, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0, backend: 'pty' };
}

test('state store drains writes and loads session metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdock-'));
  try {
    const path = join(directory, 'state.json');
    const store = new StateStore(path); await store.load(); store.upsert(snapshot(directory)); await store.drain();
    assert.match(await readFile(path, 'utf8'), /"version": 1/);
    const loaded = new StateStore(path); await loaded.load(); assert.equal(loaded.list()[0]?.name, 'Test');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('state store recovers the previous valid snapshot from backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdock-'));
  try {
    const path = join(directory, 'state.json');
    const store = new StateStore(path); await store.load();
    store.upsert(snapshot(directory, 'First')); await store.drain();
    store.upsert(snapshot(directory, 'Second')); await store.drain();
    await writeFile(path, '{broken json', 'utf8');
    const recovered = new StateStore(path); await recovered.load();
    assert.equal(recovered.list()[0]?.name, 'First'); assert.equal(recovered.warnings.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
