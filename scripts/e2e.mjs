import WebSocket from 'ws';
import { execFileSync, execSync } from 'node:child_process';

const baseUrl = process.env.AGENTSKAI_URL ?? 'http://127.0.0.1:3000';
const username = process.env.AGENTSKAI_USERNAME ?? 'admin';
const password = process.env.AGENTSKAI_PASSWORD ?? process.env.AGENTDOCK_PASSWORD;
const workspacePath = process.env.AGENTSKAI_E2E_PATH;
const restartCommand = process.env.AGENTSKAI_RESTART_COMMAND;
if (!password || !workspacePath) throw new Error('Set AGENTSKAI_PASSWORD and AGENTSKAI_E2E_PATH');

let cookie = '', workspaceId = '', sessionId = '';
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), cookie, ...options.headers } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return { body, response };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForHealth() { for (let attempt = 0; attempt < 30; attempt += 1) { try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {} await pause(500); } throw new Error('AgentSkai did not recover after restart'); }
async function cleanupE2e() {
  const sessionData = await api('/api/sessions');
  for (const session of sessionData.body.sessions.filter((item) => item.name.startsWith('E2E '))) await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
  const workspaceData = await api('/api/workspaces');
  for (const workspace of workspaceData.body.workspaces.filter((item) => item.name.startsWith('E2E '))) await api(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
}
async function terminalUntil(id, trigger, expected) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/sessions/${id}/terminal/ws`;
    const socket = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
    let output = '', sent = false;
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`Terminal timed out. Output: ${output}`)); }, 15_000);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'snapshot' || event.type === 'output') output += event.data ?? '';
      if (!sent && (!trigger.waitFor || output.includes(trigger.waitFor))) { sent = true; socket.send(JSON.stringify({ type: 'input', data: trigger.input, requestId: crypto.randomUUID() })); }
      if (output.includes(expected)) { clearTimeout(timeout); socket.close(); resolve(output); }
    });
    socket.on('error', reject);
  });
}

async function verifyTmuxScrollRecovery(id, tmuxName) {
  if (!tmuxName || process.platform === 'win32') return false;
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/sessions/${id}/terminal/ws`;
  const socket = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  let output = '';
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'snapshot' || event.type === 'output') output += event.data ?? '';
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const waitForCount = async (needle, count) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (output.split(needle).length - 1 >= count) return;
      await pause(100);
    }
    throw new Error(`Terminal did not emit ${needle} ${count} times. Output: ${output}`);
  };
  socket.send(JSON.stringify({ type: 'input', data: 'echo arrow-history-ok\r', requestId: crypto.randomUUID() }));
  await waitForCount('arrow-history-ok', 2);
  await pause(100);
  const baselineOccurrences = output.split('arrow-history-ok').length - 1;
  socket.send(JSON.stringify({ type: 'input', data: '\u001b[<64;10;5M', requestId: crypto.randomUUID() }));
  await pause(250);
  const modeAfterWheel = execFileSync('tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_in_mode}'], { encoding: 'utf8' }).trim();
  if (modeAfterWheel !== '1') throw new Error(`Wheel input did not enter tmux copy mode (mode=${modeAfterWheel})`);
  socket.send(JSON.stringify({ type: 'input', data: '\u001b[A\r', requestId: crypto.randomUUID() }));
  await waitForCount('arrow-history-ok', baselineOccurrences + 2);
  await pause(100);
  const modeAfterArrow = execFileSync('tmux', ['display-message', '-p', '-t', tmuxName, '#{pane_in_mode}'], { encoding: 'utf8' }).trim();
  socket.close();
  if (modeAfterArrow !== '0') throw new Error(`Arrow input left tmux in copy mode (mode=${modeAfterArrow})`);
  return true;
}

try {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('Login did not return a session cookie');
  await cleanupE2e();
  const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: `E2E ${Date.now()}`, hostPath: workspacePath, execution: 'docker', cpuLimit: 1, memoryMb: 512, pidsLimit: 128, networkMode: 'none' }) });
  workspaceId = workspace.body.workspace.id;
  await api(`/api/workspaces/${workspaceId}/credentials`, { method: 'POST', body: JSON.stringify({ name: 'AGENTSKAI_E2E_SECRET', value: 'credential-injection-ok' }) });
  const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'E2E terminal', workspaceId, mode: 'custom', command: '/bin/bash', args: ['-lc', 'echo boot-ok:$AGENTSKAI_E2E_SECRET; exec bash -l'], persist: true, recoverOnRestart: true }) });
  sessionId = session.body.session.id;

  const terminalOutput = await terminalUntil(sessionId, { waitFor: 'boot-ok:credential-injection-ok', input: 'echo websocket-input-ok\r' }, 'websocket-input-ok');
  if (!terminalOutput.includes('credential-injection-ok')) throw new Error('Credential injection was not observed');
  const checks = ['login', 'docker workspace', 'encrypted credential injection', 'websocket input', 'audit log'];
  if (await verifyTmuxScrollRecovery(sessionId, session.body.session.tmuxName)) checks.push('tmux wheel-to-arrow recovery');
  if (restartCommand) {
    execSync(restartCommand, { stdio: 'inherit' }); await waitForHealth();
    await terminalUntil(sessionId, { input: 'echo restart-recovery-ok\r' }, 'restart-recovery-ok');
    checks.push('server-restart recovery');
  }
  const audit = await api('/api/audit');
  for (const action of ['auth.login', 'workspace.create', 'credential.set', 'session.create']) if (!audit.body.events.some((event) => event.action === action)) throw new Error(`Missing audit event: ${action}`);
  console.log(JSON.stringify({ ok: true, workspaceId, sessionId, checks }, null, 2));
} finally {
  if (sessionId) await api(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
  if (workspaceId) { await pause(250); await api(`/api/workspaces/${workspaceId}`, { method: 'DELETE' }).catch(() => undefined); }
  if (cookie) await cleanupE2e();
}
