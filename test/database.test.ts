import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseStore, newId } from '../src/persistence/database.js';
import type { AuditEvent, CredentialRecord, SessionSnapshot, UserRecord, Workspace } from '../src/types.js';

test('SQLite store persists platform records and creates a valid backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentskai-db-'));
  const databasePath = join(directory, 'agentskai.db');
  const backupPath = join(directory, 'backups', 'agentskai.db');
  const store = new DatabaseStore(databasePath);
  try {
    await store.load();
    const now = new Date().toISOString();
    const user: UserRecord = { id: newId(), username: 'admin', passwordHash: 'hash', passwordSalt: 'salt', role: 'admin', disabled: false, createdAt: now, lastLoginAt: null };
    store.createUser(user);
    const workspace: Workspace = { id: newId(), ownerId: user.id, name: 'Main', slug: 'main', hostPath: directory, execution: 'docker', containerName: 'agentskai-ws-main', image: 'agentskai/workspace:1', cpuLimit: 2, memoryMb: 2048, pidsLimit: 256, networkMode: 'bridge', createdAt: now, updatedAt: now };
    store.createWorkspace(workspace);
    const session: SessionSnapshot = { id: newId(), ownerId: user.id, workspaceId: workspace.id, name: 'Shell', cwd: directory, mode: 'shell', status: 'exited', pid: null, createdAt: now, endedAt: now, exitCode: 0, backend: 'pty' };
    store.upsert(session);
    const credential: CredentialRecord = { id: newId(), ownerId: user.id, workspaceId: workspace.id, name: 'TOKEN', encryptedValue: 'cipher', iv: 'iv', authTag: 'tag', createdAt: now, updatedAt: now };
    store.upsertCredential(credential);
    const audit: AuditEvent = { id: newId(), actorId: user.id, action: 'workspace.create', resourceType: 'workspace', resourceId: workspace.id, metadata: { name: workspace.name }, ipAddress: '127.0.0.1', createdAt: now };
    store.appendAudit(audit);
    store.createBackup(backupPath);

    assert.equal(store.getUserByUsername('ADMIN')?.id, user.id);
    assert.equal(store.listWorkspaces(user.id)[0]?.id, workspace.id);
    assert.equal(store.list()[0]?.workspaceId, workspace.id);
    assert.equal(store.listCredentials(workspace.id)[0]?.name, 'TOKEN');
    assert.equal(store.listAudit(10)[0]?.action, 'workspace.create');
    assert.ok((await stat(backupPath)).size > 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
