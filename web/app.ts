import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AppCapabilities, Automation, SessionSnapshot } from '../src/types.js';

const get = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const sessionsElement = get<HTMLDivElement>('#sessions');
const automationList = get<HTMLDivElement>('#automations');
const terminalElement = get<HTMLDivElement>('#terminal');
const emptyState = get<HTMLDivElement>('#empty-state');
const sessionName = get<HTMLDivElement>('#session-name');
const sessionMeta = get<HTMLDivElement>('#session-meta');
const connectionState = get<HTMLSpanElement>('#connection-state');
const stopButton = get<HTMLButtonElement>('#stop-session');
const restartButton = get<HTMLButtonElement>('#restart-session');
const deleteButton = get<HTMLButtonElement>('#delete-session');
const logoutButton = get<HTMLButtonElement>('#logout');
const dialog = get<HTMLDialogElement>('#session-dialog');
const form = get<HTMLFormElement>('#session-form');
const modeSelect = form.elements.namedItem('mode') as HTMLSelectElement;
const automationDialog = get<HTMLDialogElement>('#automation-dialog');
const automationForm = get<HTMLFormElement>('#automation-form');
const automationMode = automationForm.elements.namedItem('mode') as HTMLSelectElement;
const automationSchedule = automationForm.elements.namedItem('schedule') as HTMLSelectElement;
const authScreen = get<HTMLDivElement>('#auth-screen');
const loginForm = get<HTMLFormElement>('#login-form');
const loginError = get<HTMLDivElement>('#login-error');

const terminal = new Terminal({ cursorBlink: true, fontSize: 14, theme: { background: '#05070d', foreground: '#dbe4f5', cursor: '#72e6a7' }, scrollback: 5000 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(terminalElement);

let sessions: SessionSnapshot[] = [];
let automations: Automation[] = [];
let selectedId: string | null = localStorage.getItem('agentdock.selectedSession');
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let socketGeneration = 0;
let capabilities: AppCapabilities | null = null;

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { error?: unknown; message?: unknown };
    if (record.error) return errorMessage(record.error);
    if (typeof record.message === 'string') return record.message;
  }
  return 'Request failed';
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try { response = await fetch(url, { ...init, headers }); }
  catch { throw new ApiError('AgentDock is unreachable. Is the WSL server running?', 0); }
  if (response.status === 401) {
    authScreen.classList.remove('hidden');
    socket?.close();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(errorMessage(body), response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  get<HTMLDivElement>('#toast-region').append(element);
  window.setTimeout(() => element.remove(), 4200);
}

async function ensureAuth(): Promise<boolean> {
  try {
    const status = await api<{ enabled: boolean; authenticated: boolean }>('/api/auth/status');
    logoutButton.classList.toggle('hidden', !status.enabled);
    authScreen.classList.toggle('hidden', !status.enabled || status.authenticated);
    return !status.enabled || status.authenticated;
  } catch (error) { toast((error as Error).message, 'error'); return false; }
}

async function loadCapabilities(): Promise<void> {
  const data = await api<{ capabilities: AppCapabilities }>('/api/config');
  capabilities = data.capabilities;
  get('#persistence-status').textContent = capabilities.persistentSessions ? '● tmux persistence ready' : '○ persistence unavailable';
  const help = capabilities.platform === 'linux' ? 'WSL paths and Windows paths such as C:\\Users\\Admin\\Code are accepted.' : `Default: ${capabilities.defaultCwd}`;
  get('#cwd-help').textContent = help;
  const persist = form.elements.namedItem('persist') as HTMLInputElement;
  persist.disabled = !capabilities.persistentSessions;
  persist.checked = capabilities.persistentSessions;
}

async function refreshSessions(): Promise<void> {
  const data = await api<{ sessions: SessionSnapshot[] }>('/api/sessions');
  sessions = data.sessions;
  if (selectedId && !sessions.some((item) => item.id === selectedId)) selectedId = null;
  if (!selectedId && sessions.length) selectedId = sessions[0]!.id;
  renderSessions();
  renderHeader();
}

async function refreshAutomations(): Promise<void> {
  automations = (await api<{ automations: Automation[] }>('/api/automations')).automations;
  renderAutomations();
}

function renderSessions(): void {
  sessionsElement.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${session.id === selectedId ? ' active' : ''}`;
    const dot = document.createElement('span'); dot.className = `status-dot ${session.status}`;
    const copy = document.createElement('span'); copy.className = 'session-item-copy';
    const name = document.createElement('span'); name.className = 'session-item-name'; name.textContent = session.name;
    const meta = document.createElement('span'); meta.className = 'session-item-meta'; meta.textContent = `${session.mode} · ${session.status}`;
    copy.append(name, meta); button.append(dot, copy);
    button.addEventListener('click', () => selectSession(session.id));
    sessionsElement.append(button);
  }
}

function renderAutomations(): void {
  automationList.replaceChildren();
  for (const automation of automations) {
    const row = document.createElement('div'); row.className = 'automation-item';
    const summary = document.createElement('div'); summary.className = 'automation-summary';
    const name = document.createElement('span'); name.className = 'automation-item-name'; name.textContent = automation.name;
    const state = document.createElement('span'); state.textContent = automation.enabled ? '●' : '○'; state.title = automation.enabled ? 'Enabled' : 'Paused';
    summary.append(name, state);
    const meta = document.createElement('div'); meta.className = 'automation-meta';
    const next = automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : 'not scheduled';
    meta.textContent = `${automation.lastRunStatus} · next ${next}`;
    if (automation.lastError) meta.title = automation.lastError;
    const actions = document.createElement('div'); actions.className = 'automation-actions';
    const run = actionButton('Run now', `Run ${automation.name}`, () => void runAutomation(automation.id));
    run.disabled = automation.lastRunStatus === 'running';
    const toggle = actionButton(automation.enabled ? 'Pause' : 'Enable', `${automation.enabled ? 'Pause' : 'Enable'} ${automation.name}`, () => void toggleAutomation(automation));
    const remove = actionButton('Delete', `Delete ${automation.name}`, () => void deleteAutomation(automation));
    actions.append(run, toggle, remove); row.append(summary, meta, actions); automationList.append(row);
  }
}

function actionButton(label: string, ariaLabel: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', ariaLabel); button.addEventListener('click', action); return button;
}

function selectedSession(): SessionSnapshot | undefined { return sessions.find((item) => item.id === selectedId); }

function renderHeader(): void {
  const session = selectedSession();
  if (!session) {
    sessionName.textContent = 'No session selected'; sessionMeta.textContent = 'Create a session to begin';
    stopButton.disabled = restartButton.disabled = deleteButton.disabled = true;
    emptyState.classList.remove('hidden'); connectionState.classList.add('hidden'); return;
  }
  sessionName.textContent = session.name;
  sessionMeta.textContent = `${session.mode} · ${session.cwd} · ${session.status} · ${session.backend}`;
  const active = session.status === 'running' || session.status === 'starting';
  stopButton.disabled = !active; restartButton.disabled = active; deleteButton.disabled = false;
  emptyState.classList.add('hidden');
}

function selectSession(id: string): void {
  if (!sessions.some((item) => item.id === id)) return;
  selectedId = id; localStorage.setItem('agentdock.selectedSession', id);
  renderSessions(); renderHeader(); connectTerminal(id);
}

function connectTerminal(id: string): void {
  socketGeneration += 1; const generation = socketGeneration;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  socket?.close(); terminal.reset(); reconnectAttempt = 0;
  openSocket(id, generation);
}

function openSocket(id: string, generation: number): void {
  if (generation !== socketGeneration || selectedId !== id) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  connectionState.textContent = reconnectAttempt ? 'Reconnecting…' : 'Connecting…'; connectionState.classList.remove('hidden');
  const current = new WebSocket(`${protocol}://${location.host}/api/sessions/${id}/terminal/ws`); socket = current;
  current.onopen = () => { if (generation !== socketGeneration) return; reconnectAttempt = 0; connectionState.classList.add('hidden'); sendResize(); };
  current.onmessage = (event) => {
    if (generation !== socketGeneration) return;
    const message = JSON.parse(event.data) as { type: string; data?: string; session?: SessionSnapshot; message?: string };
    if (message.type === 'snapshot') { terminal.reset(); if (message.data) terminal.write(message.data); }
    if (message.type === 'output' && message.data) terminal.write(message.data);
    if (message.type === 'state' && message.session) {
      const index = sessions.findIndex((item) => item.id === message.session!.id);
      if (index >= 0) sessions[index] = message.session!;
      renderSessions(); renderHeader();
    }
    if (message.type === 'error') terminal.writeln(`\r\n[agentdock] ${message.message ?? 'Terminal error'}`);
  };
  current.onclose = () => {
    if (generation !== socketGeneration || selectedId !== id) return;
    connectionState.textContent = 'Disconnected'; connectionState.classList.remove('hidden');
    const session = sessions.find((item) => item.id === id);
    if (session?.status === 'running' || session?.status === 'starting') {
      const delay = Math.min(10_000, 700 * 2 ** reconnectAttempt++);
      reconnectTimer = window.setTimeout(() => openSocket(id, generation), delay);
    }
  };
}

function sendResize(): void {
  try { fit.fit(); } catch { return; }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
}

function parseArguments(value: string): string[] | undefined {
  if (!value.trim()) return undefined;
  const result: string[] = []; let current = ''; let quote = ''; let escaped = false;
  for (const character of value.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if ((character === '"' || character === "'") && (!quote || quote === character)) { quote = quote ? '' : character; continue; }
    if (/\s/.test(character) && !quote) { if (current) { result.push(current); current = ''; } continue; }
    current += character;
  }
  if (quote) throw new Error('Arguments contain an unclosed quote');
  if (escaped) current += '\\';
  if (current) result.push(current);
  return result;
}

function openSessionDialog(): void {
  const cwd = form.elements.namedItem('cwd') as HTMLInputElement;
  if (!cwd.value) cwd.value = capabilities?.defaultCwd ?? '';
  get('#session-form-error').textContent = '';
  dialog.showModal();
}

async function createSession(event: SubmitEvent): Promise<void> {
  event.preventDefault(); const values = new FormData(form); const submit = get<HTMLButtonElement>('#create-session'); submit.disabled = true;
  try {
    const body = { name: String(values.get('name')), cwd: String(values.get('cwd')), mode: String(values.get('mode')), command: String(values.get('command') ?? '') || undefined, args: parseArguments(String(values.get('args') ?? '')), persist: values.get('persist') === 'on', recoverOnRestart: values.get('persist') === 'on' };
    const data = await api<{ session: SessionSnapshot }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    dialog.close(); form.reset(); toggleCustomFields(); await refreshSessions(); selectSession(data.session.id); toast('Session launched');
  } catch (error) { get('#session-form-error').textContent = (error as Error).message; }
  finally { submit.disabled = false; }
}

async function sessionAction(action: 'stop' | 'restart'): Promise<void> {
  if (!selectedId) return;
  try {
    const data = await api<{ session: SessionSnapshot }>(`/api/sessions/${selectedId}/${action}`, { method: 'POST' });
    await refreshSessions(); if (action === 'restart') selectSession(data.session.id); toast(`Session ${action === 'stop' ? 'stopped' : 'restarted'}`);
  } catch (error) { toast((error as Error).message, 'error'); }
}

async function deleteSelected(): Promise<void> {
  const session = selectedSession(); if (!session || !window.confirm(`Delete “${session.name}”? Its running process will be stopped.`)) return;
  try { await api<void>(`/api/sessions/${session.id}`, { method: 'DELETE' }); selectedId = null; localStorage.removeItem('agentdock.selectedSession'); socketGeneration += 1; socket?.close(); terminal.reset(); await refreshSessions(); if (selectedId) selectSession(selectedId); toast('Session deleted'); }
  catch (error) { toast((error as Error).message, 'error'); }
}

function openAutomationDialog(): void {
  const cwd = automationForm.elements.namedItem('cwd') as HTMLInputElement;
  if (!cwd.value) cwd.value = capabilities?.defaultCwd ?? '';
  get('#automation-form-error').textContent = ''; automationDialog.showModal();
}

async function createAutomation(event: SubmitEvent): Promise<void> {
  event.preventDefault(); const values = new FormData(automationForm); const schedule = String(values.get('schedule')); const localRunAt = String(values.get('runAt') ?? '');
  const submit = automationForm.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])')!; submit.disabled = true;
  try {
    const body = { name: String(values.get('name')), cwd: String(values.get('cwd')), mode: String(values.get('mode')), command: String(values.get('command') ?? '') || undefined, args: parseArguments(String(values.get('args') ?? '')), prompt: String(values.get('prompt')), schedule, intervalMinutes: schedule === 'interval' ? Number(values.get('intervalMinutes') ?? 60) : undefined, runAt: localRunAt ? new Date(localRunAt).toISOString() : undefined, enabled: true };
    await api('/api/automations', { method: 'POST', body: JSON.stringify(body) }); automationDialog.close(); automationForm.reset(); toggleAutomationFields(); await refreshAutomations(); toast('Automation saved');
  } catch (error) { get('#automation-form-error').textContent = (error as Error).message; }
  finally { submit.disabled = false; }
}

async function runAutomation(id: string): Promise<void> {
  try { const data = await api<{ session: SessionSnapshot }>(`/api/automations/${id}/run`, { method: 'POST' }); await Promise.all([refreshSessions(), refreshAutomations()]); selectSession(data.session.id); toast('Automation started'); }
  catch (error) { toast((error as Error).message, 'error'); }
}

async function toggleAutomation(automation: Automation): Promise<void> {
  try { await api(`/api/automations/${automation.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !automation.enabled }) }); await refreshAutomations(); toast(automation.enabled ? 'Automation paused' : 'Automation enabled'); }
  catch (error) { toast((error as Error).message, 'error'); }
}

async function deleteAutomation(automation: Automation): Promise<void> {
  if (!window.confirm(`Delete automation “${automation.name}”?`)) return;
  try { await api<void>(`/api/automations/${automation.id}`, { method: 'DELETE' }); await refreshAutomations(); toast('Automation deleted'); }
  catch (error) { toast((error as Error).message, 'error'); }
}

function toggleCustomFields(): void {
  const visible = modeSelect.value === 'custom'; get('#custom-command-label').classList.toggle('hidden', !visible); get('#custom-args-label').classList.toggle('hidden', !visible);
}
function toggleAutomationFields(): void {
  const custom = automationMode.value === 'custom'; get('#automation-command-label').classList.toggle('hidden', !custom); get('#automation-args-label').classList.toggle('hidden', !custom);
  const once = automationSchedule.value === 'once'; get('#interval-label').classList.toggle('hidden', once); get('#run-at-label').classList.toggle('hidden', !once);
  const runAt = automationForm.elements.namedItem('runAt') as HTMLInputElement; runAt.required = once;
  if (once && !runAt.value) { const future = new Date(Date.now() + 3_600_000); future.setMinutes(future.getMinutes() - future.getTimezoneOffset()); runAt.value = future.toISOString().slice(0, 16); }
}

terminal.onData((data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data, requestId: crypto.randomUUID() })); });
window.addEventListener('resize', sendResize);
get('#new-session').addEventListener('click', openSessionDialog); get('#empty-new-session').addEventListener('click', openSessionDialog);
get('#close-session-dialog').addEventListener('click', () => dialog.close()); get('#cancel-session-dialog').addEventListener('click', () => dialog.close());
get('#new-automation').addEventListener('click', openAutomationDialog); get('#close-automation-dialog').addEventListener('click', () => automationDialog.close()); get('#cancel-automation-dialog').addEventListener('click', () => automationDialog.close());
form.addEventListener('submit', (event) => void createSession(event)); automationForm.addEventListener('submit', (event) => void createAutomation(event));
modeSelect.addEventListener('change', toggleCustomFields); automationMode.addEventListener('change', toggleAutomationFields); automationSchedule.addEventListener('change', toggleAutomationFields);
stopButton.addEventListener('click', () => void sessionAction('stop')); restartButton.addEventListener('click', () => void sessionAction('restart')); deleteButton.addEventListener('click', () => void deleteSelected());
logoutButton.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); authScreen.classList.remove('hidden'); socketGeneration += 1; socket?.close(); });
loginForm.addEventListener('submit', async (event) => { event.preventDefault(); loginError.textContent = ''; try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: get<HTMLInputElement>('#login-password').value }) }); get<HTMLInputElement>('#login-password').value = ''; authScreen.classList.add('hidden'); await bootstrap(); } catch (error) { loginError.textContent = (error as Error).message; } });

async function bootstrap(): Promise<void> {
  try {
    await loadCapabilities(); await Promise.all([refreshSessions(), refreshAutomations()]);
    if (selectedId) selectSession(selectedId); else renderHeader(); sendResize();
  } catch (error) { toast((error as Error).message, 'error'); }
}

toggleCustomFields(); toggleAutomationFields();
void ensureAuth().then((authenticated) => { if (authenticated) void bootstrap(); });
window.setInterval(() => { if (authScreen.classList.contains('hidden')) void Promise.all([refreshSessions(), refreshAutomations()]).catch(() => undefined); }, 5000);
