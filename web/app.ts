import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AppCapabilities, PublicUser, SessionSnapshot, Workspace, CredentialSummary, AuditEvent } from '../src/types.js';

type WorkspaceView = Workspace & { container: { exists: boolean; running: boolean; status: string } };
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
let user: PublicUser | null = null, workspaces: WorkspaceView[] = [], sessions: SessionSnapshot[] = [], selectedSession = localStorage.getItem('agentskai.session'), socket: WebSocket | null = null, setupRequired = false;

const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'SFMono-Regular,Consolas,monospace', theme: { background: '#03060c', foreground: '#d7e2f7', cursor: '#6395ff', selectionBackground: '#244b8c' }, scrollback: 8000 });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($('#terminal'));

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function message(value: unknown): string { if (typeof value === 'string') return value; if (value && typeof value === 'object') { const data = value as { error?: unknown; message?: string }; return data.message ?? message(data.error); } return 'Request failed'; }
async function api<T>(url: string, init: RequestInit = {}): Promise<T> { const headers = new Headers(init.headers); if (init.body) headers.set('content-type', 'application/json'); let response: Response; try { response = await fetch(url, { ...init, headers }); } catch { throw new ApiError('AgentSkai is unreachable', 0); } if (response.status === 401) showAuth(); if (!response.ok) throw new ApiError(message(await response.json().catch(() => ({}))), response.status); return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
function toast(text: string, kind: 'info'|'error' = 'info'): void { const item = document.createElement('div'); item.className = `toast ${kind}`; item.textContent = text; $('#toast-region').append(item); setTimeout(() => item.remove(), 4500); }
function showAuth(): void { $('#auth-screen').classList.remove('hidden'); socket?.close(); }
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
  const [config, workspaceData, sessionData] = await Promise.all([
    api<{ capabilities: AppCapabilities; user: PublicUser }>('/api/config'), api<{ workspaces: WorkspaceView[] }>('/api/workspaces'), api<{ sessions: SessionSnapshot[] }>('/api/sessions'),
  ]);
  user = config.user; workspaces = workspaceData.workspaces; sessions = sessionData.sessions;
  $('#username').textContent = user.username; $('#user-avatar').textContent = user.username[0]!.toUpperCase(); $('#admin-tab').classList.toggle('hidden', user.role !== 'admin');
  $('#runtime-status').textContent = config.capabilities.dockerAvailable ? '● Docker connected' : '○ Docker unavailable';
  $('#workspace-count').textContent = String(workspaces.length); $('#session-count').textContent = String(sessions.filter((item) => ['running','starting'].includes(item.status)).length); $('#docker-state').textContent = config.capabilities.dockerAvailable ? 'Online' : 'Offline';
  renderWorkspaces(); renderSessions(); fillWorkspaceSelects(); renderSessionHeader();
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
function fillWorkspaceSelects(): void { for (const select of [$('#credential-workspace') as HTMLSelectElement, $('#session-form select[name=workspaceId]') as HTMLSelectElement]) { const old = select.value; select.replaceChildren(...workspaces.map((w) => new Option(w.name, w.id))); if (workspaces.some(w=>w.id===old)) select.value=old; } }

function switchView(name: string): void { $$('.view').forEach((view) => view.classList.add('hidden')); $(`#${name}-view`).classList.remove('hidden'); $$('.topbar nav button').forEach((button) => button.classList.toggle('active', button.getAttribute('data-view')===name)); const titles: Record<string,[string,string]> = {overview:['Overview','Your persistent coding workspaces'],terminal:['Terminal','Live session connection'],security:['Secrets','Encrypted workspace environment'],admin:['Administration','Users, audit events, and backups']}; $('#page-title').textContent=titles[name]![0]; $('#page-subtitle').textContent=titles[name]![1]; if(name==='security') void loadCredentials(); if(name==='admin') void loadAdmin(); if(name==='terminal') setTimeout(()=>fit.fit(),0); }

function selectSession(id: string): void { selectedSession=id; localStorage.setItem('agentskai.session',id); renderSessions(); renderSessionHeader(); switchView('terminal'); connectTerminal(id); }
function renderSessionHeader(): void { const session=sessions.find(s=>s.id===selectedSession); const empty=$('#terminal-empty'); if(!session){$('#session-name').textContent='No session selected';$('#session-meta').textContent='Choose or create a session to connect.'; empty.classList.remove('hidden'); for(const id of ['#restart-session','#stop-session','#delete-session']) ($(id) as HTMLButtonElement).disabled=true;return;} $('#session-name').textContent=session.name;$('#session-meta').textContent=`${session.mode} · ${session.status} · ${session.backend}`;empty.classList.add('hidden');($('#stop-session') as HTMLButtonElement).disabled=!['running','starting'].includes(session.status);($('#restart-session') as HTMLButtonElement).disabled=['running','starting'].includes(session.status);($('#delete-session') as HTMLButtonElement).disabled=false; }
function connectTerminal(id:string):void{socket?.close();terminal.reset();const protocol=location.protocol==='https:'?'wss':'ws';const current=new WebSocket(`${protocol}://${location.host}/api/sessions/${id}/terminal/ws`);socket=current;current.onopen=()=>{fit.fit();current.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows}));};current.onmessage=(event)=>{const msg=JSON.parse(event.data) as {type:string;data?:string;session?:SessionSnapshot};if(msg.type==='snapshot'){terminal.reset();if(msg.data)terminal.write(msg.data);}if(msg.type==='output'&&msg.data)terminal.write(msg.data);if(msg.type==='state'&&msg.session){const index=sessions.findIndex(s=>s.id===msg.session!.id);if(index>=0)sessions[index]=msg.session!;renderSessions();renderSessionHeader();}};}
terminal.onData((data)=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',data,requestId:crypto.randomUUID()}));}); window.addEventListener('resize',()=>{try{fit.fit();}catch{}});

function openSession(workspaceId?:string):void{if(!workspaces.length){toast('Create a workspace first','error');openDialog('#workspace-dialog');return;}const select=$('#session-form select[name=workspaceId]') as HTMLSelectElement;if(workspaceId)select.value=workspaceId;openDialog('#session-dialog');}
function parseArgs(value:string):string[]|undefined{return value.trim()?value.trim().split(/\s+/):undefined;}
async function submitForm(form:HTMLFormElement, work:()=>Promise<void>):Promise<void>{formError(form);const submit=form.querySelector<HTMLButtonElement>('button:not([type=button])')!;submit.disabled=true;try{await work();form.reset();form.closest('dialog')?.close();}catch(error){formError(form,(error as Error).message);}finally{submit.disabled=false;}}

async function workspacePower(workspace:WorkspaceView,action:'start'|'stop'){try{await api(`/api/workspaces/${workspace.id}/${action}`,{method:'POST'});toast(`Workspace ${action}ed`);await refresh();}catch(e){toast((e as Error).message,'error');}}
async function deleteWorkspace(workspace:WorkspaceView){if(!confirm(`Delete “${workspace.name}” and its managed container? Project files are kept.`))return;try{await api(`/api/workspaces/${workspace.id}`,{method:'DELETE'});toast('Workspace removed');await refresh();}catch(e){toast((e as Error).message,'error');}}
async function sessionAction(action:'stop'|'restart'){if(!selectedSession)return;try{const data=await api<{session:SessionSnapshot}>(`/api/sessions/${selectedSession}/${action}`,{method:'POST'});toast(`Session ${action}ed`);await refresh();if(action==='restart')selectSession(data.session.id);}catch(e){toast((e as Error).message,'error');}}
async function deleteSession(){const session=sessions.find(s=>s.id===selectedSession);if(!session||!confirm(`Delete “${session.name}”?`))return;try{await api(`/api/sessions/${session.id}`,{method:'DELETE'});selectedSession=null;socket?.close();terminal.reset();await refresh();toast('Session deleted');}catch(e){toast((e as Error).message,'error');}}

async function loadCredentials():Promise<void>{const workspaceId=($('#credential-workspace') as HTMLSelectElement).value;const list=$('#credentials');if(!workspaceId){list.innerHTML='<div class="table-row"><small>Create a workspace first.</small></div>';return;}const data=await api<{credentials:CredentialSummary[]}>(`/api/workspaces/${workspaceId}/credentials`);list.replaceChildren();if(!data.credentials.length)list.innerHTML='<div class="table-row"><small>No secrets configured.</small></div>';for(const c of data.credentials){const row=document.createElement('div');row.className='table-row';row.innerHTML='<b></b><small>Encrypted value</small><small></small><button>Delete</button>';row.querySelector('b')!.textContent=c.name;row.querySelectorAll('small')[1]!.textContent=new Date(c.updatedAt).toLocaleString();row.querySelector('button')!.onclick=async()=>{await api(`/api/credentials/${c.id}`,{method:'DELETE'});await loadCredentials();};list.append(row);}}
async function loadAdmin():Promise<void>{if(user?.role!=='admin')return;const [usersData,auditData]=await Promise.all([api<{users:PublicUser[]}>('/api/users'),api<{events:AuditEvent[]}>('/api/audit')]);const users=$('#users');users.replaceChildren();for(const item of usersData.users){const row=document.createElement('div');row.className='table-row';row.innerHTML='<b></b><small></small><small></small><span></span>';row.querySelector('b')!.textContent=item.username;row.querySelectorAll('small')[0]!.textContent=item.role;row.querySelectorAll('small')[1]!.textContent=item.lastLoginAt?`Last login ${new Date(item.lastLoginAt).toLocaleDateString()}`:'Never signed in';row.querySelector('span')!.textContent=item.disabled?'Disabled':'Active';users.append(row);}const audit=$('#audit');audit.replaceChildren();for(const event of auditData.events){const row=document.createElement('div');row.className='audit-item';row.innerHTML='<b></b><span></span>';row.querySelector('b')!.textContent=event.action;row.querySelector('span')!.textContent=`${event.resourceType}${event.resourceId?` · ${event.resourceId.slice(0,8)}`:''} · ${new Date(event.createdAt).toLocaleString()}`;audit.append(row);}}

$$<HTMLButtonElement>('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog')?.close());
$$<HTMLButtonElement>('.topbar nav button').forEach(button=>button.onclick=()=>switchView(button.dataset.view!));
$('#new-workspace').addEventListener('click',()=>openDialog('#workspace-dialog'));$('#overview-new-workspace').addEventListener('click',()=>openDialog('#workspace-dialog'));$('#new-session').addEventListener('click',()=>openSession());$('#empty-new-session').addEventListener('click',()=>openSession());
$('#new-credential').addEventListener('click',()=>{if(workspaces.length)openDialog('#credential-dialog');else toast('Create a workspace first','error');});$('#new-user').addEventListener('click',()=>openDialog('#user-dialog'));$('#credential-workspace').addEventListener('change',()=>void loadCredentials());
($('#session-form select[name=mode]') as HTMLSelectElement).onchange=(event)=>{const custom=(event.target as HTMLSelectElement).value==='custom';$('#custom-command').classList.toggle('hidden',!custom);$('#custom-args').classList.toggle('hidden',!custom);};
$('#workspace-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);await api('/api/workspaces',{method:'POST',body:JSON.stringify({name:values.get('name'),hostPath:values.get('hostPath'),execution:values.get('execution'),networkMode:values.get('networkMode'),cpuLimit:Number(values.get('cpuLimit')),memoryMb:Number(values.get('memoryMb'))})});toast('Workspace created');await refresh();});});
$('#session-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);const data=await api<{session:SessionSnapshot}>('/api/sessions',{method:'POST',body:JSON.stringify({name:values.get('name'),workspaceId:values.get('workspaceId'),mode:values.get('mode'),command:String(values.get('command')||'')||undefined,args:parseArgs(String(values.get('args')||'')),persist:values.get('persist')==='on',recoverOnRestart:values.get('persist')==='on'})});toast('Session launched');await refresh();selectSession(data.session.id);});});
$('#credential-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form),workspaceId=($('#credential-workspace') as HTMLSelectElement).value;await api(`/api/workspaces/${workspaceId}/credentials`,{method:'POST',body:JSON.stringify({name:values.get('name'),value:values.get('value')})});toast('Secret encrypted');await loadCredentials();});});
$('#user-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void submitForm(form,async()=>{const values=new FormData(form);await api('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(values))});toast('Account created');await loadAdmin();});});
$('#stop-session').addEventListener('click',()=>void sessionAction('stop'));$('#restart-session').addEventListener('click',()=>void sessionAction('restart'));$('#delete-session').addEventListener('click',()=>void deleteSession());
$('#create-backup').addEventListener('click',async()=>{try{const data=await api<{backup:{path:string}}>('/api/backups',{method:'POST'});toast(`Backup created: ${data.backup.path}`);}catch(e){toast((e as Error).message,'error');}});
$('#logout').addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});showAuth();});
$('#login-form').addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;formError(form);void (async()=>{try{const body={username:($('#login-username') as HTMLInputElement).value,password:($('#login-password') as HTMLInputElement).value};if(setupRequired)await api('/api/auth/setup',{method:'POST',body:JSON.stringify({...body,role:'admin'})});await api('/api/auth/login',{method:'POST',body:JSON.stringify(body)});($('#login-password') as HTMLInputElement).value='';hideAuth();await refresh();}catch(e){formError(form,(e as Error).message);}})();});

void authenticate().then(ok=>{if(ok)return refresh();}).catch(e=>toast((e as Error).message,'error')); setInterval(()=>{if($('#auth-screen').classList.contains('hidden'))void refresh().catch(()=>undefined);},7000);
