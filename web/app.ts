import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AppCapabilities, PublicUser, SessionSnapshot, Workspace, CredentialSummary, AuditEvent, Automation } from '../src/types.js';

type WorkspaceView = Workspace & { container: { exists: boolean; running: boolean; status: string } };
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
let user: PublicUser | null = null, workspaces: WorkspaceView[] = [], sessions: SessionSnapshot[] = [], automations: Automation[] = [], selectedSession = localStorage.getItem('agentskai.session'), secondarySession = localStorage.getItem('agentskai.secondarySession'), setupRequired = false;

type TerminalPane = { terminal: Terminal; fit: FitAddon; host: HTMLElement; socket: WebSocket | null; sessionId: string | null; pendingScroll: number; scrollTimer: number | null };

function createTerminalPane(host: HTMLElement): TerminalPane {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    lineHeight: 1.18,
    fontWeight: '400',
    fontFamily: '"Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace',
    theme: {
      background: '#181818', foreground: '#d4d7dd', cursor: '#d7dbe3', cursorAccent: '#181818',
      selectionBackground: '#3152a866', black: '#15171b', red: '#e06c75', green: '#8ccf7e', yellow: '#e5c07b',
      blue: '#6c91ff', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0', brightBlack: '#5c6370',
    },
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    scrollback: 15000,
    scrollOnUserInput: true,
    scrollSensitivity: 1,
    fastScrollSensitivity: 3,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  const pane: TerminalPane = { terminal, fit, host, socket: null, sessionId: null, pendingScroll: 0, scrollTimer: null };
  terminal.onData((data) => {
    if (pane.socket?.readyState === WebSocket.OPEN) pane.socket.send(JSON.stringify({ type: 'input', data, requestId: crypto.randomUUID() }));
  });
  terminal.attachCustomWheelEventHandler((event) => {
    if (event.ctrlKey || event.metaKey) return true;
    const divisor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? terminal.rows : 34;
    const lines = Math.min(8, Math.max(1, Math.ceil(Math.abs(event.deltaY) / divisor))) * (event.deltaY < 0 ? -1 : 1);
    const session = sessions.find((item) => item.id === pane.sessionId);
    if (session?.backend === 'tmux') {
      pane.pendingScroll = Math.max(-100, Math.min(100, pane.pendingScroll + lines));
      if (pane.scrollTimer === null) pane.scrollTimer = window.setTimeout(() => {
        if (pane.socket?.readyState === WebSocket.OPEN && pane.pendingScroll !== 0) pane.socket.send(JSON.stringify({ type: 'scroll', lines: pane.pendingScroll }));
        pane.pendingScroll = 0;
        pane.scrollTimer = null;
      }, 75);
    } else terminal.scrollLines(lines);
    event.preventDefault();
    event.stopPropagation();
    return false;
  });
  return pane;
}

const primaryPane = createTerminalPane($('#terminal-primary'));
const secondaryPane = createTerminalPane($('#terminal-secondary'));
const terminalPanes = [primaryPane, secondaryPane];

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function message(value: unknown): string { if (typeof value === 'string') return value; if (value && typeof value === 'object') { const data = value as { error?: unknown; message?: string }; return data.message ?? message(data.error); } return 'Request failed'; }
async function api<T>(url: string, init: RequestInit = {}): Promise<T> { const headers = new Headers(init.headers); if (init.body) headers.set('content-type', 'application/json'); let response: Response; try { response = await fetch(url, { ...init, headers }); } catch { throw new ApiError('AgentSkai is unreachable', 0); } if (response.status === 401) showAuth(); if (!response.ok) throw new ApiError(message(await response.json().catch(() => ({}))), response.status); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
function toast(text: string, kind: 'info'|'error' = 'info'): void { const item = document.createElement('div'); item.className = `toast ${kind}`; item.textContent = text; $('#toast-region').append(item); setTimeout(() => item.remove(), 4500); }
function showAuth(): void { $('#auth-screen').classList.remove('hidden'); terminalPanes.forEach((pane) => pane.socket?.close()); }
function hideAuth(): void { $('#auth-screen').classList.add('hidden'); }
function formError(form: HTMLFormElement, error = ''): void { form.querySelector<HTMLElement>('.form-error')!.textContent = error; }
function openDialog(id: string): void { $<HTMLDialogElement>(id).showModal(); }

async function authenticate(): Promise<boolean> {
  const status = await api<{ setupRequired: boolean; authenticated: boolean; user: PublicUser|null }>('/api/auth/status');
  setupRequired = status.setupRequired; user = status.user;
  $('#auth-title').textContent = setupRequired ? 'Create your administrator' : 'Welcome back';
  $('#auth-copy').textContent = setupRequired ? 'Finish securing this AgentSkai instance.' : 'Sign in to your control plane.';
  if (status.authenticated && user) { hideAuth(); return true; }
  showAuth(); return false;
}

async function refresh(): Promise<void> {
  const [config, workspaceData, sessionData, automationData] = await Promise.all([
    api<{ capabilities: AppCapabilities; user: PublicUser }>('/api/config'), api<{ workspaces: WorkspaceView[] }>('/api/workspaces'), api<{ sessions: SessionSnapshot[] }>('/api/sessions'), api<{ automations: Automation[] }>('/api/automations'),
  ]);
  user = config.user; workspaces = workspaceData.workspaces; sessions = sessionData.sessions; automations = automationData.automations;
  $('#username').textContent = user.username; $('#user-avatar').textContent = user.username[0]!.toUpperCase(); $('#admin-tab').classList.toggle('hidden', user.role !== 'admin');
  $('#runtime-status').textContent = config.capabilities.dockerAvailable ? '● Docker connected' : '○ Docker unavailable';
  $('#workspace-count').textContent = String(workspaces.length); $('#session-count').textContent = String(sessions.filter((item) => ['running','starting'].includes(item.status)).length); $('#docker-state').textContent = config.capabilities.dockerAvailable ? 'Online' : 'Offline';
  if (selectedSession && !sessions.some((item) => item.id === selectedSession)) selectedSession = null;
  if (secondarySession && !sessions.some((item) => item.id === secondarySession)) closeSplit();
  renderWorkspaces(); renderSessions(); renderTerminalTabs(); renderAutomations(); fillWorkspaceSelects(); fillSecondarySessions(); renderSessionHeader();
  if (selectedSession) connectTerminalPane(primaryPane, selectedSession);
  if (!$('#secondary-terminal-pane').classList.contains('hidden') && secondarySession) connectTerminalPane(secondaryPane, secondarySession);
}

function renderWorkspaces(): void {
  const side = $('#workspaces'), cards = $('#workspace-cards'); side.replaceChildren(); cards.replaceChildren();
  if (!workspaces.length) { cards.innerHTML = '<div class="workspace-card"><h3>No workspaces yet</h3><p>Create a Docker workspace to begin.</p></div>'; return; }
  for (const workspace of workspaces) {
    const button = document.createElement('button'); button.className = 'side-item'; button.innerHTML = `<i>◫</i><span><b></b><small></small></span>`; button.querySelector('b')!.textContent = workspace.name; button.querySelector('small')!.textContent = workspace.container.running ? 'Running' : workspace.execution; button.onclick = () => { ($('#credential-workspace') as HTMLSelectElement).value = workspace.id; switchView('overview'); }; side.append(button);
    const card = document.createElement('article'); card.className = 'workspace-card';
    const active = workspace.execution === 'host' || workspace.container.running;
    card.innerHTML = `<header><h3></h3><span class="status ${active?'':'stopped'}">${active?'Running':'Stopped'}</span></header><p></p><dl><div><dt>EXECUTION</dt><dd>${workspace.execution}</dd></div><div><dt>RESOURCES</dt><dd>${workspace.cpuLimit} CPU · ${workspace.memoryMb} MB</dd></div><div><dt>NETWORK</dt><dd>${workspace.networkMode}</dd></div><div><dt>SESSIONS</dt><dd>${sessions.filter(s=>s.workspaceId===workspace.id).length}</dd></div></dl><div class="card-actions"><button class="primary launch">New session</button>${workspace.containerName?`<button class="secondary power">${active?'Stop':'Start'}</button>`:''}<button class="danger remove">Delete</button></div>`;
    card.querySelector('h3')!.textContent = workspace.name; card.querySelector('p')!.textContent = workspace.hostPath;
    card.querySelector<HTMLButtonElement>('.launch')!.onclick = () => openSession(workspace.id);
    card.querySelector<HTMLButtonElement>('.power')?.addEventListener('click', () => void workspacePower(workspace, active ? 'stop' : 'start'));
    card.querySelector<HTMLButtonElement>('.remove')!.onclick = () => void deleteWorkspace(workspace); cards.append(card);
  }
}

function renderSessions(): void {
  const list = $('#sessions'); list.replaceChildren();
  for (const session of sessions) { const button = document.createElement('button'); button.className = `side-item${session.id===selectedSession?' active':''}`; button.innerHTML = `<i class="dot ${session.status}"></i><span><b></b><small></small></span>`; button.querySelector('b')!.textContent = session.name; button.querySelector('small')!.textContent = `${session.mode} · ${session.status}`; button.onclick = () => selectSession(session.id); list.append(button); }
}

function renderTerminalTabs(): void {
  const tabs = $('#terminal-tabs'); tabs.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = `terminal-tab${session.id === selectedSession ? ' active' : ''}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(session.id === selectedSession));
    button.title = `${session.name} — ${session.mode} · ${session.status}`;
    button.innerHTML = `<i class="agent-mark ${session.mode}"></i><b></b><span class="tab-state ${session.status}"></span>`;
    button.querySelector('b')!.textContent = session.name;
    button.onclick = () => selectSession(session.id);
    tabs.append(button);
  }
  if (!sessions.length) {
    const label = document.createElement('span'); label.className = 'terminal-tab active'; label.textContent = 'No open sessions'; tabs.append(label);
  }
}

function fillSecondarySessions(): void {
  const select = $('#secondary-session') as HTMLSelectElement;
  const candidates = sessions.filter((item) => item.id !== selectedSession);
  select.replaceChildren(...candidates.map((item) => new Option(`${item.name} · ${item.mode}`, item.id)));
  if (secondarySession && candidates.some((item) => item.id === secondarySession)) select.value = secondarySession;
  else secondarySession = candidates[0]?.id ?? null;
  ($('#split-terminal') as HTMLButtonElement).disabled = sessions.length < 2;
  renderSecondaryChrome();
}

function renderAutomations(): void {
  const list = $('#automations'); list.replaceChildren();
  if (!automations.length) { list.innerHTML = '<div class="workspace-card"><h3>No automations yet</h3><p>Schedule a recurring agent task or one-time command.</p></div>'; return; }
  for (const automation of automations) {
    const card = document.createElement('article'); card.className = 'workspace-card automation-card';
    const workspace = workspaces.find((item) => item.id === automation.workspaceId);
    card.innerHTML = `<header><h3></h3><span class="status ${automation.enabled ? '' : 'stopped'}">${automation.enabled ? 'Enabled' : 'Paused'}</span></header><p></p><dl><div><dt>WORKSPACE</dt><dd></dd></div><div><dt>LAST RUN</dt><dd>${automation.lastRunStatus}</dd></div><div><dt>SCHEDULE</dt><dd>${automation.schedule === 'interval' ? `Every ${automation.intervalMinutes ?? 60} min` : 'One time'}</dd></div><div><dt>NEXT RUN</dt><dd>${automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : '—'}</dd></div></dl><div class="card-actions"><button class="primary run">Run now</button><button class="secondary toggle">${automation.enabled ? 'Pause' : 'Enable'}</button><button class="danger remove">Delete</button></div>`;
    card.querySelector('h3')!.textContent = automation.name; card.querySelector('p')!.textContent = automation.prompt; card.querySelector('dd')!.textContent = workspace?.name ?? 'Removed workspace';
    card.querySelector<HTMLButtonElement>('.run')!.disabled = automation.lastRunStatus === 'running';
    card.querySelector<HTMLButtonElement>('.run')!.onclick = () => void runAutomation(automation.id);
    card.querySelector<HTMLButtonElement>('.toggle')!.onclick = () => void toggleAutomation(automation);
    card.querySelector<HTMLButtonElement>('.remove')!.onclick = () => void deleteAutomation(automation);
    list.append(card);
  }
}
function fillWorkspaceSelects(): void { for (const select of [$('#credential-workspace') as HTMLSelectElement, $('#session-form select[name=workspaceId]') as HTMLSelectElement, $('#automation-form select[name=workspaceId]') as HTMLSelectElement]) { const old = select.value; select.replaceChildren(...workspaces.map((w) => new Option(w.name, w.id))); if (workspaces.some(w=>w.id===old)) select.value=old; } }

function switchView(name: string): void { $$('.view').forEach((view) => view.classList.add('hidden')); $(`#${name}-view`).classList.remove('hidden'); $$('.topbar nav button').forEach((button) => button.classList.toggle('active', button.getAttribute('data-view')===name)); const titles: Record<string,[string,string]> = {overview:['Overview','Your persistent coding workspaces'],terminal:['Terminal','Multi-session cloud workbench'],automations:['Automations','Scheduled prompts and commands'],security:['Secrets','Encrypted workspace environment'],admin:['Administration','Users, audit events, and backups']}; $('#page-title').textContent=titles[name]![0]; $('#page-subtitle').textContent=titles[name]![1]; if(name==='security') void loadCredentials(); if(name==='admin') void loadAdmin(); if(name==='terminal') setTimeout(fitTerminals,0); }

function selectSession(id: string): void {
  const previous = selectedSession;
  if (!$('#secondary-terminal-pane').classList.contains('hidden') && secondarySession === id && previous && previous !== id) {
    secondarySession = previous; localStorage.setItem('agentskai.secondarySession', previous); connectTerminalPane(secondaryPane, previous);
  }
  selectedSession=id; localStorage.setItem('agentskai.session',id);
  renderSessions(); renderTerminalTabs(); fillSecondarySessions(); renderSessionHeader(); switchView('terminal'); connectTerminalPane(primaryPane, id);
}

function renderSessionHeader(): void {
  const session=sessions.find(s=>s.id===selectedSession), empty=$('#terminal-empty');
  const primaryStatus = $('#primary-terminal-pane .pane-status');
  if(!session){
    $('#session-name').textContent='No session selected'; $('#session-meta').textContent='Choose or create a session to connect.'; $('#primary-pane-name').textContent='Terminal';
    primaryStatus.className='pane-status'; empty.classList.remove('hidden');
    for(const id of ['#restart-session','#stop-session','#delete-session']) ($(id) as HTMLButtonElement).disabled=true;
    return;
  }
  $('#session-name').textContent=session.name; $('#session-meta').textContent=`${session.mode} · ${session.status} · ${session.backend}`; $('#primary-pane-name').textContent=session.name;
  primaryStatus.className=`pane-status ${session.status}`; empty.classList.add('hidden');
  ($('#stop-session') as HTMLButtonElement).disabled=!['running','starting'].includes(session.status); ($('#restart-session') as HTMLButtonElement).disabled=['running','starting'].includes(session.status); ($('#delete-session') as HTMLButtonElement).disabled=false;
}

function renderSecondaryChrome(): void {
  const session = sessions.find((item) => item.id === secondarySession);
  const status = $('#secondary-terminal-pane .pane-status'); status.className = `pane-status ${session?.status ?? ''}`;
}

function sendPaneResize(pane: TerminalPane): void {
  if (pane.socket?.readyState === WebSocket.OPEN) pane.socket.send(JSON.stringify({type:'resize',cols:pane.terminal.cols,rows:pane.terminal.rows}));
}

function fitPane(pane: TerminalPane): void {
  if (!pane.host.offsetParent) return;
  try { pane.fit.fit(); sendPaneResize(pane); } catch { /* Hidden or not laid out yet. */ }
}

function fitTerminals(): void {
  terminalPanes.forEach(fitPane);
  $('#terminal-dimensions').textContent = primaryPane.sessionId ? `${primaryPane.terminal.cols} × ${primaryPane.terminal.rows}` : '—';
}

function connectTerminalPane(pane: TerminalPane, id: string | null): void {
  if (pane.sessionId === id && pane.socket && pane.socket.readyState <= WebSocket.OPEN) { fitPane(pane); return; }
  pane.socket?.close(); pane.socket=null; pane.sessionId=id; pane.pendingScroll=0;
  if (pane.scrollTimer !== null) { window.clearTimeout(pane.scrollTimer); pane.scrollTimer=null; }
  pane.terminal.reset();
  if (!id) return;
  const protocol=location.protocol==='https:'?'wss':'ws', current=new WebSocket(`${protocol}://${location.host}/api/sessions/${id}/terminal/ws`); pane.socket=current;
  current.onopen=()=>{if(pane.socket!==current)return;fitPane(pane);sendPaneResize(pane);};
  current.onmessage=(event)=>{
    if(pane.socket!==current)return;
    const msg=JSON.parse(event.data) as {type:string;data?:string;session?:SessionSnapshot};
    if(msg.type==='snapshot'){pane.terminal.reset();if(msg.data)pane.terminal.write(msg.data);}
    if(msg.type==='output'&&msg.data)pane.terminal.write(msg.data);
    if(msg.type==='state'&&msg.session){const index=sessions.findIndex(s=>s.id===msg.session!.id);if(index>=0)sessions[index]=msg.session!;renderSessions();renderTerminalTabs();renderSessionHeader();renderSecondaryChrome();}
  };
  current.onclose=()=>{if(pane.socket===current)pane.socket=null;};
}

function openSplit(): void {
  const candidates=sessions.filter((item)=>item.id!==selectedSession);
  if(!candidates.length){toast('Start another session before splitting the terminal','error');openSession();return;}
  if(!secondarySession||!candidates.some((item)=>item.id===secondarySession))secondarySession=candidates[0]!.id;
  localStorage.setItem('agentskai.secondarySession',secondarySession); ($('#secondary-session') as HTMLSelectElement).value=secondarySession;
  $('#secondary-terminal-pane').classList.remove('hidden'); $('#terminal-grid').classList.add('split'); renderSecondaryChrome(); connectTerminalPane(secondaryPane,secondarySession); setTimeout(fitTerminals,0);
}

function closeSplit(): void {
  secondarySession=null; localStorage.removeItem('agentskai.secondarySession'); connectTerminalPane(secondaryPane,null);
  $('#secondary-terminal-pane').classList.add('hidden'); $('#terminal-grid').classList.remove('split'); setTimeout(fitTerminals,0);
}

window.addEventListener('resize',fitTerminals);
new ResizeObserver(()=>fitTerminals()).observe($('#terminal-grid'));

function openSession(workspaceId?:string):void{if(!workspaces.length){toast('Create a workspace first','error');openDialog('#workspace-dialog');return;}const select=$('#session-form select[name=workspaceId]') as HTMLSelectElement;if(workspaceId)select.value=workspaceId;openDialog('#session-dialog');}
function parseArgs(value:string):string[]|undefined{return value.trim()?value.trim().split(/\s+/):undefined;}
async function submitForm(form:HTMLFormElement, work:()=>Promise<void>):Promise<void>{formError(form);const submit=form.querySelector<HTMLButtonElement>('button:not([type=button])')!;submit.disabled=true;try{await work();form.reset();form.closest('dialog')?.close();}catch(error){formError(form,(error as Error).message);}finally{submit.disabled=false;}}

async function workspacePower(workspace:WorkspaceView,action:'start'|'stop'){try{await api(`/api/workspaces/${workspace.id}/${action}`,{method:'POST'});toast(`Workspace ${action}ed`);await refresh();}catch(e){toast((e as Error).message,'error');}}
async function deleteWorkspace(workspace:WorkspaceView){if(!confirm(`Delete “${workspace.name}” and its managed container? Project files are kept.`))return;try{await api(`/api/workspaces/${workspace.id}`,{method:'DELETE'});toast('Workspace removed');await refresh();}catch(e){toast((e as Error).message,'error');}}
async function sessionAction(action:'stop'|'restart'){if(!selectedSession)return;try{const data=await api<{session:SessionSnapshot}>(`/api/sessions/${selectedSession}/${action}`,{method:'POST'});toast(`Session ${action}ed`);await refresh();if(action==='restart')selectSession(data.session.id);}catch(e){toast((e as Error).message,'error');}}
async function deleteSession(){const session=sessions.find(s=>s.id===selectedSession);if(!session||!confirm(`Delete “${session.name}”?`))return;try{await api(`/api/sessions/${session.id}`,{method:'DELETE'});const promoted=$('#secondary-terminal-pane').classList.contains('hidden')?null:secondarySession;closeSplit();selectedSession=promoted;if(promoted)localStorage.setItem('agentskai.session',promoted);else localStorage.removeItem('agentskai.session');connectTerminalPane(primaryPane,null);await refresh();toast('Session deleted');}catch(e){toast((e as Error).message,'error');}}
async function runAutomation(id:string){try{const data=await api<{session:SessionSnapshot}>(`/api/automations/${id}/run`,{method:'POST'});await refresh();selectSession(data.session.id);toast('Automation started');}catch(e){toast((e as Error).message,'error');}}
async function toggleAutomation(automation:Automation){try{await api(`/api/automations/${automation.id}`,{method:'PATCH',body:JSON.stringify({enabled:!automation.enabled})});await refresh();toast(automation.enabled?'Automation paused':'Automation enabled');}catch(e){toast((e as Error).message,'error');}}
async function deleteAutomation(automation:Automation){if(!confirm(`Delete “${automation.name}”?`))return;try{await api(`/api/automations/${automation.id}`,{method:'DELETE'});await refresh();toast('Automation deleted');}catch(e){toast((e as Error).message,'error');}}

async function loadCredentials():Promise<void>{const workspaceId=($('#credential-workspace') as HTMLSelectElement).value;const list=$('#credentials');if(!workspaceId){list.innerHTML='<div class="table-row"><small>Create a workspace first.</small></div>';return;}const data=await api<{credentials:CredentialSummary[]}>(`/api/workspaces/${workspaceId}/credentials`);list.replaceChildren();if(!data.credentials.length)list.innerHTML='<div class="table-row"><small>No secrets configured.</small></div>';for(const c of data.credentials){const row=document.createElement('div');row.className='table-row';row.innerHTML='<b></b><small>Encrypted value</small><small></small><button>Delete</button>';row.querySelector('b')!.textContent=c.name;row.querySelectorAll('small')[1]!.textContent=new Date(c.updatedAt).toLocaleString();row.querySelector('button')!.onclick=async()=>{await api(`/api/credentials/${c.id}`,{method:'DELETE'});await loadCredentials();};list.append(row);}}
async function loadAdmin():Promise<void>{if(user?.role!=='admin')return;const [usersData,auditData]=await Promise.all([api<{users:PublicUser[]}>('/api/users'),api<{events:AuditEvent[]}>('/api/audit')]);const users=$('#users');users.replaceChildren();for(const item of usersData.users){const row=document.createElement('div');row.className='table-row';row.innerHTML='<b></b><small></small><small></small><span></span>';row.querySelector('b')!.textContent=item.username;row.querySelectorAll('small')[0]!.textContent=item.role;row.querySelectorAll('small')[1]!.textContent=item.lastLoginAt?`Last login ${new Date(item.lastLoginAt).toLocaleDateString()}`:'Never signed in';row.querySelector('span')!.textContent=item.disabled?'Disabled':'Active';users.append(row);}const audit=$('#audit');audit.replaceChildren();for(const event of auditData.events){const row=document.createElement('div');row.className='audit-item';row.innerHTML='<b></b><span></span>';row.querySelector('b')!.textContent=event.action;row.querySelector('span')!.textContent=`${event.resourceType}${event.resourceId?` · ${event.resourceId.slice(0,8)}`:''} · ${new Date(event.createdAt).toLocaleString()}`;audit.append(row);}}

$$<HTMLButtonElement>('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog')?.close());
$$<HTMLButtonElement>('.topbar nav button').forEach(button=>button.onclick=()=>switchView(button.dataset.view!));
$('#new-workspace').addEventListener('click',()=>openDialog('#workspace-dialog'));$('#overview-new-workspace').addEventListener('click',()=>openDialog('#workspace-dialog'));$('#new-session').addEventListener('click',()=>openSession());$('#terminal-new-session').addEventListener('click',()=>openSession());$('#empty-new-session').addEventListener('click',()=>openSession());
$('#split-terminal').addEventListener('click',openSplit);$('#close-split').addEventListener('click',closeSplit);
$('#secondary-session').addEventListener('change',(event)=>{secondarySession=(event.target as HTMLSelectElement).value;localStorage.setItem('agentskai.secondarySession',secondarySession);renderSecondaryChrome();connectTerminalPane(secondaryPane,secondarySession);setTimeout(fitTerminals,0);});
$('#new-credential').addEventListener('click',()=>{if(workspaces.length)openDialog('#credential-dialog');else toast('Create a workspace first','error');});$('#new-user').addEventListener('click',()=>openDialog('#user-dialog'));$('#credential-workspace').addEventListener('change',()=>void loadCredentials());
$('#new-automation').addEventListener('click',()=>{if(workspaces.length)openDialog('#automation-dialog');else toast('Create a workspace first','error');});
($('#session-form select[name=mode]') as HTMLSelectElement).onchange=(event)=>{const custom=(event.target as HTMLSelectElement).value==='custom';$('#custom-command').classList.toggle('hidden',!custom);$('#custom-args').classList.toggle('hidden',!custom);};
$('#workspace-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);await api('/api/workspaces',{method:'POST',body:JSON.stringify({name:values.get('name'),hostPath:values.get('hostPath'),execution:values.get('execution'),networkMode:values.get('networkMode'),cpuLimit:Number(values.get('cpuLimit')),memoryMb:Number(values.get('memoryMb'))})});toast('Workspace created');await refresh();});});
$('#session-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);const data=await api<{session:SessionSnapshot}>('/api/sessions',{method:'POST',body:JSON.stringify({name:values.get('name'),workspaceId:values.get('workspaceId'),mode:values.get('mode'),command:String(values.get('command')||'')||undefined,args:parseArgs(String(values.get('args')||'')),persist:values.get('persist')==='on',recoverOnRestart:values.get('persist')==='on'})});toast('Session launched');await refresh();selectSession(data.session.id);});});
$('#credential-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form),workspaceId=($('#credential-workspace') as HTMLSelectElement).value;await api(`/api/workspaces/${workspaceId}/credentials`,{method:'POST',body:JSON.stringify({name:values.get('name'),value:values.get('value')})});toast('Secret encrypted');await loadCredentials();});});
$('#automation-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form),schedule=String(values.get('schedule')),localRunAt=String(values.get('runAt')??'');await api('/api/automations',{method:'POST',body:JSON.stringify({name:values.get('name'),workspaceId:values.get('workspaceId'),mode:values.get('mode'),prompt:values.get('prompt'),schedule,intervalMinutes:schedule==='interval'?Number(values.get('intervalMinutes')??60):undefined,runAt:localRunAt?new Date(localRunAt).toISOString():undefined,enabled:true})});toast('Automation saved');await refresh();switchView('automations');});});
$('#user-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);await api('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(values))});toast('Account created');await loadAdmin();});});
$('#stop-session').addEventListener('click',()=>void sessionAction('stop'));$('#restart-session').addEventListener('click',()=>void sessionAction('restart'));$('#delete-session').addEventListener('click',()=>void deleteSession());
$('#create-backup').addEventListener('click',async()=>{try{const data=await api<{backup:{path:string}}>('/api/backups',{method:'POST'});toast(`Backup created: ${data.backup.path}`);}catch(e){toast((e as Error).message,'error');}});
$('#logout').addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});showAuth();});
$('#login-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;formError(form);void (async()=>{try{const body={username:($('#login-username') as HTMLInputElement).value,password:($('#login-password') as HTMLInputElement).value};if(setupRequired)await api('/api/auth/setup',{method:'POST',body:JSON.stringify({...body,role:'admin'})});await api('/api/auth/login',{method:'POST',body:JSON.stringify(body)});($('#login-password') as HTMLInputElement).value='';hideAuth();await refresh();}catch(e){formError(form,(e as Error).message);}})();});

($('#automation-form select[name=schedule]') as HTMLSelectElement).addEventListener('change',(event)=>{const once=(event.target as HTMLSelectElement).value==='once';$('#automation-interval').classList.toggle('hidden',once);$('#automation-run-at').classList.toggle('hidden',!once);const input=$('#automation-form input[name=runAt]') as HTMLInputElement;input.required=once;if(once&&!input.value){const future=new Date(Date.now()+3_600_000);future.setMinutes(future.getMinutes()-future.getTimezoneOffset());input.value=future.toISOString().slice(0,16);}});

void authenticate().then(ok=>{if(ok)return refresh();}).catch(e=>toast((e as Error).message,'error')); setInterval(()=>{if($('#auth-screen').classList.contains('hidden'))void refresh().catch(()=>undefined);},7000);
