import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { AuthManager } from '../src/auth.js';

const request = (cookie?: string) => ({ headers: { cookie } }) as FastifyRequest;

test('signed authentication survives an AgentDock process restart', () => {
  const first = new AuthManager('correct horse'); assert.equal(first.login('wrong'), null);
  const token = first.login('correct horse'); assert.ok(token);
  const second = new AuthManager('correct horse'); assert.equal(second.isAuthenticated(request(`agentdock_session=${token}`)), true);
  second.logout(request(`agentdock_session=${token}`)); assert.equal(second.isAuthenticated(request(`agentdock_session=${token}`)), false);
});

test('expired signed authentication is rejected', () => {
  const auth = new AuthManager('password', -1); const token = auth.login('password'); assert.ok(token);
  assert.equal(auth.isAuthenticated(request(`agentdock_session=${token}`)), false);
});
