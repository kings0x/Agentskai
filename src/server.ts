import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DatabaseStore } from './persistence/database.js';
import { SessionManager } from './sessions/session-manager.js';
import type { Session } from './sessions/session.js';
import { PlatformAuth } from './platform-auth.js';
import { DockerManager } from './docker/docker-manager.js';
import { CredentialVault, loadOrCreateMasterKey } from './security/credential-vault.js';
import { WorkspaceService } from './platform/workspace-service.js';
import { AuditLog } from './platform/audit.js';
import type { AutomationConfig, PublicUser, SessionConfig } from './types.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = fileURLToPath(new URL('.', import.meta.url));
const isBuiltRuntime = runtimeDir.endsWith('dist\\') || runtimeDir.endsWith('dist/');
const publicDir = isBuiltRuntime ? join(rootDir, 'dist', 'public') : join(rootDir, 'web');

const loginInput = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(500) });
const userInput = z.object({ username: z.string().min(3).max(32), password: z.string().min(12).max(500), role: z.enum(['admin', 'member']).default('member') });
const userPatch = z.object({ role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional(), password: z.string().min(12).max(500).optional() });
const workspaceInput = z.object({ name: z.string().trim().min(1).max(80), hostPath: z.string().trim().min(1), execution: z.enum(['docker', 'host']).default('docker'), image: z.string().trim().min(1).max(200).optional(), cpuLimit: z.number().min(0.25).max(32).default(2), memoryMb: z.number().int().min(256).max(131072).default(2048), pidsLimit: z.number().int().min(32).max(4096).default(256), networkMode: z.enum(['bridge', 'none']).default('bridge') });
const credentialInput = z.object({ name: z.string().min(1).max(64), value: z.string().min(1).max(65_536) });
const sessionInput = z.object({ name: z.string().trim().min(1).max(80), workspaceId: z.string().uuid(), mode: z.enum(['shell', 'claude', 'custom']).default('shell'), command: z.string().trim().min(1).max(200).optional(), args: z.array(z.string().max(500)).max(20).optional(), persist: z.boolean().default(true), recoverOnRestart: z.boolean().default(true) }).superRefine((value, context) => { if (value.mode === 'custom' && !value.command) context.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'Command is required' }); });
const resizeInput = z.object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(3).max(200) });
const automationInput = z.object({ name: z.string().trim().min(1).max(80), workspaceId: z.string().uuid(), mode: z.enum(['shell', 'claude', 'custom']).default('shell'), command: z.string().trim().min(1).max(200).optional(), args: z.array(z.string().max(500)).max(20).optional(), prompt: z.string().trim().min(1).max(10_000), schedule: z.enum(['once', 'interval']), runAt: z.string().datetime().optional(), intervalMinutes: z.number().int().min(1).max(43_200).optional(), enabled: z.boolean().default(true) });
const automationPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), prompt: z.string().trim().min(1).max(10_000).optional(), enabled: z.boolean().optional(), intervalMinutes: z.number().int().min(1).max(43_200).optional(), runAt: z.string().datetime().optional() });

class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  blocked(key: string): boolean { const item = this.failures.get(key); if (!item || item.resetAt <= Date.now()) { this.failures.delete(key); return false; } return item.count >= 5; }
  fail(key: string): void { const item = this.failures.get(key); this.failures.set(key, !item || item.resetAt <= Date.now() ? { count: 1, resetAt: Date.now() + 300_000 } : { ...item, count: item.count + 1 }); }
  clear(key: string): void { this.failures.delete(key); }
}

export interface AppContext {
  manager: SessionManager; store: DatabaseStore; auth: PlatformAuth; workspaces: WorkspaceService;
  docker: DockerManager; vault: CredentialVault; audit: AuditLog; publicDir?: string; logger?: boolean; trustProxy?: boolean;
  https?: { cert: Buffer; key: Buffer };
}

export function createApp(context: AppContext) {
  const { manager, store, auth, workspaces, docker, vault, audit } = context;
  const app = Fastify({ logger: context.logger ?? true, forceCloseConnections: true, bodyLimit: 1_100_000, trustProxy: context.trustProxy ?? false, https: context.https } as Parameters<typeof Fastify>[0]);
  const limiter = new LoginLimiter();
  app.register(fastifyWebsocket);
  app.register(fastifyStatic, { root: context.publicDir ?? publicDir, wildcard: false });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
    if (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if ((!['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.url.endsWith('/terminal/ws')) && origin) {
      try { if (new URL(origin).host !== request.headers.host) return reply.code(403).send({ error: 'Cross-origin request rejected' }); }
      catch { return reply.code(403).send({ error: 'Invalid request origin' }); }
    }
    if (!request.url.startsWith('/api/') || request.url === '/api/health' || request.url.startsWith('/api/auth/')) return;
    if (!auth.userFor(request)) return reply.code(401).send({ error: 'Authentication required' });
  });

  type RequestLike = { headers: { cookie?: string; 'x-forwarded-proto'?: string|string[] }; protocol: string; ip: string };
  const currentUser = (request: RequestLike): PublicUser => { const user = auth.userFor(request); if (!user) throw new Error('Authentication required'); return user; };
  const isSecure = (request: RequestLike) => request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  const ownsSession = (request: RequestLike, id: string) => { const user = currentUser(request); const session = manager.getSnapshot(id); return session && (user.role === 'admin' || session.ownerId === user.id) ? session : null; };

  app.get('/api/health', async () => ({ ok: true, service: 'agentskai', version: '1.0.0' }));
  app.get('/api/auth/status', async (request) => ({ setupRequired: auth.setupRequired(), authenticated: Boolean(auth.userFor(request)), user: auth.userFor(request) }));
  app.post('/api/auth/setup', async (request, reply) => { if (!auth.setupRequired()) return reply.code(409).send({ error: 'Setup is complete' }); const parsed = userInput.safeParse({ ...(request.body as object), role: 'admin' }); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); const user = await auth.createUser(parsed.data.username, parsed.data.password, 'admin'); audit.record(user, 'auth.setup', 'user', user.id, {}, request); return reply.code(201).send({ user }); });
  app.post('/api/auth/login', async (request, reply) => { if (limiter.blocked(request.ip)) return reply.code(429).send({ error: 'Too many login attempts. Try again later.' }); const parsed = loginInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: 'Username and password are required' }); const result = await auth.login(parsed.data.username, parsed.data.password); if (!result) { limiter.fail(request.ip); audit.record(null, 'auth.login_failed', 'user', null, { username: parsed.data.username }, request); return reply.code(401).send({ error: 'Invalid username or password' }); } limiter.clear(request.ip); auth.setCookie(reply, result.token, isSecure(request)); audit.record(result.user, 'auth.login', 'user', result.user.id, {}, request); return { authenticated: true, user: result.user }; });
  app.post('/api/auth/logout', async (request, reply) => { const user = auth.userFor(request); auth.logout(request); auth.clearCookie(reply); audit.record(user, 'auth.logout', 'user', user?.id ?? null, {}, request); return { authenticated: false }; });

  app.get('/api/config', async (request) => ({ capabilities: { platform: process.platform, persistentSessions: manager.persistentSessionsAvailable(), persistenceBackend: manager.persistentSessionsAvailable() ? 'tmux' : 'none', defaultCwd: process.cwd(), maxSessions: manager.maxSessions, dockerAvailable: await docker.available(), multiUser: true }, user: currentUser(request) }));
  app.get('/api/users', async (request, reply) => { if (currentUser(request).role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' }); return { users: store.listUsers() }; });
  app.post('/api/users', async (request, reply) => { const actor = currentUser(request); if (actor.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' }); const parsed = userInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const user = await auth.createUser(parsed.data.username, parsed.data.password, parsed.data.role); audit.record(actor, 'user.create', 'user', user.id, { username: user.username, role: user.role }, request); return reply.code(201).send({ user }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.patch('/api/users/:id', async (request, reply) => { const actor = currentUser(request); if (actor.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' }); const id = (request.params as { id: string }).id; const target = store.getUserById(id); if (!target) return reply.code(404).send({ error: 'User not found' }); const parsed = userPatch.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); if (id === actor.id && (parsed.data.disabled || parsed.data.role === 'member')) return reply.code(400).send({ error: 'You cannot disable or demote your own account' }); try { if (parsed.data.password) await auth.changePassword(id, parsed.data.password); const updated = store.updateUser(id, { role: parsed.data.role, disabled: parsed.data.disabled }); const safe = store.listUsers().find((item) => item.id === updated.id)!; audit.record(actor, 'user.update', 'user', id, { role: parsed.data.role, disabled: parsed.data.disabled }, request); return { user: safe }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });

  app.get('/api/workspaces', async (request) => { const user = currentUser(request); const items = await Promise.all(workspaces.list(user).map(async (workspace) => ({ ...workspace, container: workspace.containerName ? await docker.status(workspace.containerName) : { exists: false, running: false, status: 'host' } }))); return { workspaces: items }; });
  app.post('/api/workspaces', async (request, reply) => { const user = currentUser(request); const parsed = workspaceInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const workspace = await workspaces.create(user, parsed.data); audit.record(user, 'workspace.create', 'workspace', workspace.id, { name: workspace.name, execution: workspace.execution }, request); return reply.code(201).send({ workspace }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.delete('/api/workspaces/:id', async (request, reply) => { const user = currentUser(request); try { const workspace = workspaces.getAllowed((request.params as { id: string }).id, user); if (manager.list().some((item) => item.workspaceId === workspace.id && ['running', 'starting'].includes(item.status))) return reply.code(409).send({ error: 'Stop active sessions before deleting this workspace' }); await workspaces.remove(workspace); audit.record(user, 'workspace.delete', 'workspace', workspace.id, { name: workspace.name }, request); return reply.code(204).send(); } catch (error) { return reply.code(404).send({ error: (error as Error).message }); } });
  app.post('/api/workspaces/:id/start', async (request, reply) => { const user = currentUser(request); try { const workspace = workspaces.getAllowed((request.params as { id: string }).id, user); await workspaces.ensure(workspace); audit.record(user, 'container.start', 'workspace', workspace.id, {}, request); return { container: workspace.containerName ? await docker.status(workspace.containerName) : null }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.post('/api/workspaces/:id/stop', async (request, reply) => { const user = currentUser(request); try { const workspace = workspaces.getAllowed((request.params as { id: string }).id, user); if (workspace.containerName) await docker.stop(workspace.containerName); audit.record(user, 'container.stop', 'workspace', workspace.id, {}, request); return { container: workspace.containerName ? await docker.status(workspace.containerName) : null }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.get('/api/workspaces/:id/credentials', async (request, reply) => { try { const workspace = workspaces.getAllowed((request.params as { id: string }).id, currentUser(request)); return { credentials: vault.list(workspace.id) }; } catch (error) { return reply.code(404).send({ error: (error as Error).message }); } });
  app.post('/api/workspaces/:id/credentials', async (request, reply) => { const user = currentUser(request); const parsed = credentialInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const workspace = workspaces.getAllowed((request.params as { id: string }).id, user); const credential = vault.set(workspace.ownerId, workspace.id, parsed.data.name, parsed.data.value); audit.record(user, 'credential.set', 'credential', credential.id, { name: credential.name, workspaceId: workspace.id }, request); return reply.code(201).send({ credential }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.delete('/api/credentials/:id', async (request, reply) => { const user = currentUser(request); const credential = store.getCredential((request.params as { id: string }).id); if (!credential) return reply.code(404).send({ error: 'Credential not found' }); try { workspaces.getAllowed(credential.workspaceId, user); store.deleteCredential(credential.id); audit.record(user, 'credential.delete', 'credential', credential.id, { name: credential.name }, request); return reply.code(204).send(); } catch { return reply.code(404).send({ error: 'Credential not found' }); } });

  app.get('/api/sessions', async (request) => { const user = currentUser(request); return { sessions: manager.list().filter((item) => user.role === 'admin' || item.ownerId === user.id) }; });
  app.post('/api/sessions', async (request, reply) => { const user = currentUser(request); const parsed = sessionInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const workspace = workspaces.getAllowed(parsed.data.workspaceId, user); const session = await manager.create({ ...parsed.data, cwd: workspace.hostPath, ownerId: user.id, containerName: workspace.containerName ?? undefined }); audit.record(user, 'session.create', 'session', session.id, { workspaceId: workspace.id, mode: parsed.data.mode }, request); return reply.code(201).send({ session: session.snapshot() }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.get('/api/sessions/:id', async (request, reply) => { const session = ownsSession(request, (request.params as { id: string }).id); return session ? { session } : reply.code(404).send({ error: 'Session not found' }); });
  app.post('/api/sessions/:id/restart', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; if (!ownsSession(request, id)) return reply.code(404).send({ error: 'Session not found' }); try { const session = await manager.restart(id); audit.record(user, 'session.restart', 'session', id, {}, request); return { session: session.snapshot() }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.post('/api/sessions/:id/stop', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; if (!ownsSession(request, id)) return reply.code(404).send({ error: 'Session not found' }); const session = manager.stop(id); audit.record(user, 'session.stop', 'session', id, {}, request); return { session }; });
  app.delete('/api/sessions/:id', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; if (!ownsSession(request, id)) return reply.code(404).send({ error: 'Session not found' }); manager.remove(id); audit.record(user, 'session.delete', 'session', id, {}, request); return reply.code(204).send(); });
  app.post('/api/sessions/:id/resize', async (request, reply) => { const id = (request.params as { id: string }).id; if (!ownsSession(request, id)) return reply.code(404).send({ error: 'Session not found' }); const session = manager.get(id); if (!session) return reply.code(409).send({ error: 'Session is not active' }); const parsed = resizeInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); session.resize(parsed.data.cols, parsed.data.rows); return { ok: true }; });
  app.get('/api/sessions/:id/terminal', async (request, reply) => { const id = (request.params as { id: string }).id; if (!ownsSession(request, id)) return reply.code(404).send({ error: 'Session not found' }); const session = manager.get(id); return session ? { output: session.terminalOutput() } : reply.code(409).send({ error: 'Session is not active' }); });
  app.register(async (instance) => { instance.get('/api/sessions/:id/terminal/ws', { websocket: true }, (socket, request) => { const id = (request.params as { id: string }).id; if (!auth.userFor(request) || !ownsSession(request, id)) return socket.close(1008, 'Forbidden'); const session = manager.get(id); if (!session) return socket.close(1008, 'Session inactive'); attachTerminal(socket, session); }); });

  app.get('/api/automations', async (request) => { const user = currentUser(request); return { automations: manager.listAutomations().filter((item) => user.role === 'admin' || item.ownerId === user.id) }; });
  app.post('/api/automations', async (request, reply) => { const user = currentUser(request); const parsed = automationInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const workspace = workspaces.getAllowed(parsed.data.workspaceId, user); const config: AutomationConfig = { ...parsed.data, cwd: workspace.hostPath, ownerId: user.id }; const automation = await manager.createAutomation(config); audit.record(user, 'automation.create', 'automation', automation.id, { workspaceId: workspace.id }, request); return reply.code(201).send({ automation }); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.post('/api/automations/:id/run', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; const automation = manager.listAutomations().find((item) => item.id === id && (user.role === 'admin' || item.ownerId === user.id)); if (!automation) return reply.code(404).send({ error: 'Automation not found' }); try { const session = await manager.runAutomation(id); audit.record(user, 'automation.run', 'automation', id, {}, request); return { session: session.snapshot() }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.patch('/api/automations/:id', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; const automation = manager.listAutomations().find((item) => item.id === id && (user.role === 'admin' || item.ownerId === user.id)); if (!automation) return reply.code(404).send({ error: 'Automation not found' }); const parsed = automationPatch.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() }); try { const updated = await manager.updateAutomation(id, parsed.data); audit.record(user, 'automation.update', 'automation', id, {}, request); return { automation: updated }; } catch (error) { return reply.code(400).send({ error: (error as Error).message }); } });
  app.delete('/api/automations/:id', async (request, reply) => { const user = currentUser(request); const id = (request.params as { id: string }).id; const automation = manager.listAutomations().find((item) => item.id === id && (user.role === 'admin' || item.ownerId === user.id)); if (!automation) return reply.code(404).send({ error: 'Automation not found' }); manager.deleteAutomation(id); audit.record(user, 'automation.delete', 'automation', id, {}, request); return reply.code(204).send(); });
  app.get('/api/audit', async (request, reply) => { const user = currentUser(request); if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' }); return { events: store.listAudit(250) }; });
  app.post('/api/backups', async (request, reply) => { const user = currentUser(request); if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' }); const destination = join(process.env.AGENTSKAI_BACKUP_DIR ?? join(process.env.AGENTDOCK_DATA_DIR ?? join(rootDir, 'data'), 'backups'), `agentskai-${new Date().toISOString().replaceAll(':', '-')}.db`); store.createBackup(destination); audit.record(user, 'backup.create', 'database', null, { destination }, request); return reply.code(201).send({ backup: { path: destination } }); });
  return app;
}

function attachTerminal(socket: { send: (data: string) => void; on: (event: string, handler: (...args: any[]) => void) => void; close: (code?: number, reason?: string) => void }, session: Session): void {
  const onOutput = (data: string) => socket.send(JSON.stringify({ type: 'output', data }));
  const onState = () => socket.send(JSON.stringify({ type: 'state', session: session.snapshot() }));
  session.on('output', onOutput); session.on('state', onState); socket.send(JSON.stringify({ type: 'snapshot', data: session.terminalOutput() })); onState();
  socket.on('message', (raw: Buffer | string) => { try { const message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number; requestId?: string }; if (message.type === 'input' && typeof message.data === 'string') { if (message.data.length > 65_536) throw new Error(); session.write(message.data, message.requestId); if (message.requestId) socket.send(JSON.stringify({ type: 'ack', requestId: message.requestId })); } else if (message.type === 'resize' && message.cols && message.rows) session.resize(message.cols, message.rows); } catch { socket.send(JSON.stringify({ type: 'error', message: 'Invalid terminal message' })); } });
  socket.on('close', () => { session.off('output', onOutput); session.off('state', onState); });
}

async function main(): Promise<void> {
  const dataDir = process.env.AGENTDOCK_DATA_DIR ?? join(rootDir, 'data'); const host = process.env.HOST ?? '127.0.0.1'; const port = Number(process.env.PORT ?? 3000);
  await mkdir(dataDir, { recursive: true });
  const store = new DatabaseStore(join(dataDir, 'agentskai.db'), join(dataDir, 'state.json')); await store.load();
  const auth = new PlatformAuth(store); await auth.bootstrap(process.env.AGENTDOCK_PASSWORD, process.env.AGENTSKAI_ADMIN_USERNAME ?? 'admin');
  if (auth.setupRequired() && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Set AGENTDOCK_PASSWORD (12+ characters) for the initial administrator before exposing the server');
  const docker = new DockerManager(); const vault = new CredentialVault(store, loadOrCreateMasterKey(join(dataDir, 'master.key'), process.env.AGENTSKAI_MASTER_KEY)); const workspaces = new WorkspaceService(store, docker);
  const secretsDir = join(dataDir, 'runtime-secrets'); await mkdir(secretsDir, { recursive: true });
  const manager = new SessionManager(store, { prepareRuntime: async (config: SessionConfig, sessionId: string) => {
    if (!config.workspaceId) return {}; const workspace = store.getWorkspace(config.workspaceId); if (!workspace) throw new Error('Workspace not found'); await workspaces.ensure(workspace);
    config.cwd = workspace.hostPath; config.containerName = workspace.containerName ?? undefined; if (!config.containerName) return {};
    const environment = vault.environment(workspace.id); if (!Object.keys(environment).length) return {};
    const path = join(secretsDir, `${sessionId}.env`); await writeFile(path, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 }); try { await chmod(path, 0o600); } catch {}
    return { dockerEnvFile: path };
  } });
  await manager.load();
  const https = process.env.AGENTSKAI_TLS_CERT && process.env.AGENTSKAI_TLS_KEY ? { cert: await readFile(process.env.AGENTSKAI_TLS_CERT), key: await readFile(process.env.AGENTSKAI_TLS_KEY) } : undefined;
  const app = createApp({ manager, store, auth, workspaces, docker, vault, audit: new AuditLog(store), trustProxy: process.env.AGENTSKAI_TRUST_PROXY === '1', https });
  await app.listen({ port, host });
  let closing = false; const shutdown = async () => { if (closing) return; closing = true; await manager.shutdown(); await app.close(); store.close(); };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
}

if (process.env.AGENTDOCK_DISABLE_MAIN !== '1') void main().catch((error) => { console.error(error); process.exitCode = 1; });
