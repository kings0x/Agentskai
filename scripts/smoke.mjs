import assert from 'node:assert/strict';

const baseUrl = process.env.AGENTDOCK_SMOKE_URL ?? 'http://127.0.0.1:3100';
const cwd = process.env.AGENTDOCK_SMOKE_CWD ?? process.cwd();
const createdSessions = [];
const createdAutomations = [];

async function api(path, init = {}) {
  const headers = init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers;
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function waitForTerminal(sessionId, marker, input) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timed out waiting for ${marker}`)); }, 10_000);
    const socketUrl = `${baseUrl.replace(/^http/, 'ws')}/api/sessions/${sessionId}/terminal/ws`;
    const socket = new WebSocket(socketUrl);
    let output = '';
    socket.addEventListener('open', () => { if (input) setTimeout(() => socket.send(JSON.stringify({ type: 'input', data: `${input}\r`, requestId: crypto.randomUUID() })), 150); });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if ((message.type === 'snapshot' || message.type === 'output') && message.data) output += message.data;
      if (output.includes(marker)) { clearTimeout(timer); socket.close(); resolve(output); }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Terminal WebSocket failed')); });
  });
}

try {
  const health = await api('/api/health'); assert.equal(health.version, '1.0.0');
  const config = await api('/api/config'); assert.equal(config.capabilities.persistentSessions, true);

  const direct = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'AgentDock v1 smoke terminal', cwd, mode: 'custom', command: 'bash', args: ['--noprofile', '--norc'], persist: true, recoverOnRestart: true }) });
  createdSessions.push(direct.session.id);
  await waitForTerminal(direct.session.id, 'V1_TERMINAL_OK', 'echo V1_TERMINAL_OK');

  const automation = await api('/api/automations', { method: 'POST', body: JSON.stringify({ name: 'AgentDock v1 smoke automation', cwd, mode: 'custom', command: 'bash', args: ['--noprofile', '--norc'], prompt: 'echo V1_AUTOMATION_OK', schedule: 'interval', intervalMinutes: 60, enabled: true }) });
  createdAutomations.push(automation.automation.id);
  const run = await api(`/api/automations/${automation.automation.id}/run`, { method: 'POST' });
  createdSessions.push(run.session.id);
  await waitForTerminal(run.session.id, 'V1_AUTOMATION_OK');
  const automations = await api('/api/automations');
  const updated = automations.automations.find((item) => item.id === automation.automation.id);
  assert.equal(updated.runCount, 1); assert.ok(updated.lastRunAt);
  console.log('AgentDock smoke test passed: health, tmux terminal, WebSocket input, and automation output.');
} finally {
  for (const id of createdSessions.reverse()) await api(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
  for (const id of createdAutomations.reverse()) await api(`/api/automations/${id}`, { method: 'DELETE' }).catch(() => undefined);
}
