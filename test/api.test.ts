import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { AuthManager } from '../src/auth.js';
import { createApp } from '../src/server.js';
import type { SessionManager } from '../src/sessions/session-manager.js';

function fakeManager(): SessionManager {
  return { maxSessions: 20, persistentSessionsAvailable: () => true, list: () => [], listAutomations: () => [], get: () => undefined, getSnapshot: () => undefined, create: async () => { throw new Error('not used'); }, createAutomation: async () => { throw new Error('not used'); }, updateAutomation: async () => { throw new Error('not used'); }, runAutomation: async () => { throw new Error('not used'); }, stop: () => { throw new Error('not used'); }, restart: async () => { throw new Error('not used'); }, remove: () => undefined, deleteAutomation: () => undefined } as unknown as SessionManager;
}

test('API enforces auth, origin checks, validation, and security headers', async () => {
  const app = createApp(fakeManager(), new AuthManager('v1-password'), { publicDir: resolve('web'), logger: false, defaultCwd: '/work' }); await app.ready();
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/sessions' }); assert.equal(denied.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'v1-password' } }); assert.equal(login.statusCode, 200);
    const setCookie = login.headers['set-cookie']!; const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(';')[0]!;
    const config = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } });
    assert.equal(config.statusCode, 200); assert.equal(config.json().capabilities.defaultCwd, '/work'); assert.equal(config.headers['x-frame-options'], 'DENY'); assert.match(config.headers['content-security-policy']!, /frame-ancestors 'none'/);
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie, origin: 'https://evil.example', host: 'agentdock.local' }, payload: { name: 'x', cwd: '.', mode: 'shell' } }); assert.equal(crossOrigin.statusCode, 403);
    const invalidCustom = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: { name: 'x', cwd: '.', mode: 'custom' } }); assert.equal(invalidCustom.statusCode, 400);
  } finally { await app.close(); }
});
