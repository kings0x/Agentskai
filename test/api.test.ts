import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { DatabaseStore } from '../src/persistence/database.js';
import { PlatformAuth } from '../src/platform-auth.js';
import { CredentialVault } from '../src/security/credential-vault.js';
import { WorkspaceService } from '../src/platform/workspace-service.js';
import { AuditLog } from '../src/platform/audit.js';
import type { DockerManager } from '../src/docker/docker-manager.js';
import type { SessionManager } from '../src/sessions/session-manager.js';

function fakeManager(): SessionManager {
  return { maxSessions: 20, persistentSessionsAvailable: () => true, list: () => [], listAutomations: () => [], get: () => undefined, getSnapshot: () => undefined, create: async () => { throw new Error('not used'); }, createAutomation: async () => { throw new Error('not used'); }, runAutomation: async () => { throw new Error('not used'); }, stop: () => { throw new Error('not used'); }, restart: async () => { throw new Error('not used'); }, remove: () => undefined, deleteAutomation: () => undefined } as unknown as SessionManager;
}

test('API enforces auth, RBAC, origin checks, and security headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentskai-api-'));
  const store = new DatabaseStore(join(directory, 'test.db')); await store.load();
  const auth = new PlatformAuth(store); await auth.createUser('admin', 'v1-password-long', 'admin');
  const docker = { available: async () => true, status: async () => ({ exists: false, running: false, status: 'missing' }) } as unknown as DockerManager;
  const app = createApp({ manager: fakeManager(), store, auth, docker, workspaces: new WorkspaceService(store, docker), vault: new CredentialVault(store, Buffer.alloc(32, 1)), audit: new AuditLog(store), publicDir: resolve('web'), logger: false });
  await app.ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'v1-password-long' } });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers['set-cookie']!; const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(';')[0]!;
    const config = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } });
    assert.equal(config.statusCode, 200); assert.equal(config.json().capabilities.multiUser, true); assert.equal(config.headers['x-frame-options'], 'DENY');
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie, origin: 'https://evil.example', host: 'agentskai.local' }, payload: { name: 'x', hostPath: directory } });
    assert.equal(crossOrigin.statusCode, 403);
    assert.ok(store.listAudit(10).some((event) => event.action === 'auth.login'));
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
