import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseStore } from '../src/persistence/database.js';
import { PlatformAuth } from '../src/platform-auth.js';
import { CredentialVault } from '../src/security/credential-vault.js';

test('database authentication persists sessions and never exposes password hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentskai-auth-'));
  const store = new DatabaseStore(join(directory, 'test.db')); await store.load();
  try {
    const auth = new PlatformAuth(store, 3600);
    const created = await auth.createUser('member.one', 'a-long-secure-password', 'member');
    assert.equal('passwordHash' in created, false);
    assert.equal(await auth.login('member.one', 'wrong-password'), null);
    const login = await auth.login('MEMBER.ONE', 'a-long-secure-password');
    assert.ok(login?.token);
    const restartedAuth = new PlatformAuth(store, 3600);
    assert.equal(restartedAuth.userFor({ headers: { cookie: `agentskai_session=${login!.token}` } })?.id, created.id);
    assert.equal(store.getAuthSessionUser(Buffer.from('wrong').toString('hex')), undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('credential vault encrypts values at rest and returns them only for runtime injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentskai-vault-'));
  const store = new DatabaseStore(join(directory, 'test.db')); await store.load();
  try {
    const auth = new PlatformAuth(store); const user = await auth.createUser('vault.user', 'another-secure-password', 'member');
    const now = new Date().toISOString();
    store.createWorkspace({ id: 'workspace', ownerId: user.id, name: 'Vault', slug: 'vault', hostPath: directory, execution: 'host', containerName: null, image: 'none', cpuLimit: 1, memoryMb: 512, pidsLimit: 64, networkMode: 'none', createdAt: now, updatedAt: now });
    const vault = new CredentialVault(store, Buffer.alloc(32, 7));
    const summary = vault.set(user.id, 'workspace', 'api_token', 'super-secret');
    assert.equal('encryptedValue' in summary, false);
    assert.notEqual(store.listCredentials('workspace')[0]?.encryptedValue, 'super-secret');
    assert.equal(vault.environment('workspace').API_TOKEN, 'super-secret');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
