import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StateStore } from './persistence/state-store.js';
import { SessionManager } from './sessions/session-manager.js';
import type { Session } from './sessions/session.js';
import { AuthManager } from './auth.js';
import type { AutomationConfig } from './types.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = fileURLToPath(new URL('.', import.meta.url));
const isBuiltRuntime = runtimeDir.endsWith('dist\\') || runtimeDir.endsWith('dist/');
const publicDir = isBuiltRuntime ? join(rootDir, 'dist', 'public') : join(rootDir, 'web');
const dataDir = process.env.AGENTDOCK_DATA_DIR ?? join(rootDir, 'data');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const sessionInput = z.object({
  name: z.string().trim().min(1).max(80),
  cwd: z.string().trim().min(1),
  mode: z.enum(['shell', 'claude', 'custom']).default('shell'),
  command: z.string().trim().min(1).max(200).optional(),
  args: z.array(z.string().max(500)).max(20).optional(),
  persist: z.boolean().default(true),
  recoverOnRestart: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.mode === 'custom' && !value.command) context.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'Command is required for custom sessions' });
});

const resizeInput = z.object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(3).max(200) });
const loginInput = z.object({ password: z.string().min(1).max(500) });
const automationInput = z.object({
  name: z.string().trim().min(1).max(80), cwd: z.string().trim().min(1), mode: z.enum(['shell', 'claude', 'custom']).default('claude'),
  command: z.string().trim().min(1).max(200).optional(), args: z.array(z.string().max(500)).max(20).optional(),
  prompt: z.string().trim().min(1).max(10_000), schedule: z.enum(['once', 'interval']), runAt: z.string().datetime().optional(),
  intervalMinutes: z.number().int().min(1).max(43_200).optional(), enabled: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.mode === 'custom' && !value.command) context.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'Command is required for custom automations' });
  if (value.schedule === 'once' && !value.runAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ['runAt'], message: 'Run time is required' });
});
const automationPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(), cwd: z.string().trim().min(1).optional(), mode: z.enum(['shell', 'claude', 'custom']).optional(),
  command: z.string().trim().min(1).max(200).nullable().optional(), args: z.array(z.string().max(500)).max(20).nullable().optional(),
  prompt: z.string().trim().min(1).max(10_000).optional(), schedule: z.enum(['once', 'interval']).optional(), runAt: z.string().datetime().nullable().optional(),
  intervalMinutes: z.number().int().min(1).max(43_200).nullable().optional(), enabled: z.boolean().optional(),
});

class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  isBlocked(key: string): boolean {
    const item = this.failures.get(key);
    if (!item || item.resetAt <= Date.now()) { this.failures.delete(key); return false; }
    return item.count >= 5;
  }
  fail(key: string): void {
    const item = this.failures.get(key);
    this.failures.set(key, !item || item.resetAt <= Date.now() ? { count: 1, resetAt: Date.now() + 300_000 } : { ...item, count: item.count + 1 });
  }
  clear(key: string): void { this.failures.delete(key); }
}

export function createApp(manager: SessionManager, auth = new AuthManager(), options: { publicDir?: string; defaultCwd?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, forceCloseConnections: true, bodyLimit: 1_100_000 });
  const loginLimiter = new LoginLimiter();
  const defaultWorkingDirectory = options.defaultCwd ?? process.cwd();

  app.register(fastifyWebsocket);
  app.register(fastifyStatic, { root: options.publicDir ?? publicDir, wildcard: false });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const isTerminalSocket = request.url.endsWith('/terminal/ws');
    if ((isMutation || isTerminalSocket) && origin) {
      try {
        if (new URL(origin).host !== request.headers.host) return reply.code(403).send({ error: 'Cross-origin request rejected' });
      } catch { return reply.code(403).send({ error: 'Invalid request origin' }); }
    }
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/auth/') || request.url === '/api/health') return;
    if (!auth.isAuthenticated(request)) return reply.code(401).send({ error: 'Authentication required' });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'agentdock', version: '1.0.0' }));
  app.get('/api/config', async () => ({ capabilities: { platform: process.platform, persistentSessions: manager.persistentSessionsAvailable(), persistenceBackend: manager.persistentSessionsAvailable() ? 'tmux' : 'none', defaultCwd: defaultWorkingDirectory, maxSessions: manager.maxSessions } }));

  app.get('/api/auth/status', async (request) => ({ enabled: auth.enabled, authenticated: auth.isAuthenticated(request) }));

  app.post('/api/auth/login', async (request, reply) => {
    const limiterKey = request.ip;
    if (loginLimiter.isBlocked(limiterKey)) return reply.code(429).send({ error: 'Too many login attempts. Try again in a few minutes.' });
    const parsed = loginInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Password is required' });
    const token = auth.login(parsed.data.password);
    if (!token) { loginLimiter.fail(limiterKey); return reply.code(401).send({ error: 'Invalid password' }); }
    loginLimiter.clear(limiterKey);
    auth.setCookie(reply, token, request.protocol === 'https');
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (request, reply) => { auth.logout(request); auth.clearCookie(reply); return { authenticated: false }; });

  app.get('/api/sessions', async () => ({ sessions: manager.list() }));

  app.get('/api/automations', async () => ({ automations: manager.listAutomations() }));

  app.post('/api/automations', async (request, reply) => {
    const parsed = automationInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try { return reply.code(201).send({ automation: await manager.createAutomation(parsed.data as AutomationConfig) }); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });

  app.post('/api/automations/:id/run', async (request, reply) => {
    try { const session = await manager.runAutomation((request.params as { id: string }).id); return { session: session.snapshot() }; }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });

  app.patch('/api/automations/:id', async (request, reply) => {
    const parsed = automationPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const patch = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key, value === null ? undefined : value])) as Partial<AutomationConfig>;
    try { return { automation: await manager.updateAutomation((request.params as { id: string }).id, patch) }; }
    catch (error) { return reply.code((error as Error).message === 'Automation not found' ? 404 : 400).send({ error: (error as Error).message }); }
  });

  app.delete('/api/automations/:id', async (request, reply) => { manager.deleteAutomation((request.params as { id: string }).id); return reply.code(204).send(); });

  app.post('/api/sessions', async (request, reply) => {
    const parsed = sessionInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const session = await manager.create(parsed.data);
      return reply.code(201).send({ session: session.snapshot() });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snapshot = manager.getSnapshot(id);
    if (!snapshot) return reply.code(404).send({ error: 'Session not found' });
    return { session: snapshot };
  });

  app.post('/api/sessions/:id/restart', async (request, reply) => {
    try { return { session: (await manager.restart((request.params as { id: string }).id)).snapshot() }; }
    catch (error) { return reply.code((error as Error).message === 'Session not found' ? 404 : 400).send({ error: (error as Error).message }); }
  });

  app.post('/api/sessions/:id/stop', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      return { session: manager.stop(id) };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    manager.remove(id);
    return reply.code(204).send();
  });

  app.post('/api/sessions/:id/resize', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = manager.get(id);
    if (!session) return reply.code(404).send({ error: 'Session is not active' });
    const parsed = resizeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    session.resize(parsed.data.cols, parsed.data.rows);
    return { ok: true };
  });

  app.get('/api/sessions/:id/terminal', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = manager.get(id);
    if (!session) return reply.code(404).send({ error: 'Session is not active' });
    return { output: session.terminalOutput() };
  });

  app.register(async (instance) => {
    instance.get('/api/sessions/:id/terminal/ws', { websocket: true }, (socket, request) => {
      const id = getWebsocketSessionId(request);
      if (!id) {
        socket.close(1008, 'Invalid session');
        return;
      }
      const session = manager.get(id);
      if (!session) {
        socket.send(JSON.stringify({ type: 'error', message: 'Session is not active' }));
        socket.close(1008, 'Unknown session');
        return;
      }
      attachTerminal(socket, session);
    });
  });

  return app;
}

function getWebsocketSessionId(request: unknown): string | null {
  const candidate = request as { params?: { id?: string }; url?: string };
  if (candidate.params?.id) return candidate.params.id;
  const match = candidate.url?.match(/^\/api\/sessions\/([^/]+)\/terminal\/ws/);
  return match?.[1] ?? null;
}

function attachTerminal(socket: { send: (data: string) => void; on: (event: string, handler: (...args: any[]) => void) => void; close: () => void }, session: Session): void {
  const onOutput = (data: string) => socket.send(JSON.stringify({ type: 'output', data }));
  const onState = () => socket.send(JSON.stringify({ type: 'state', session: session.snapshot() }));
  session.on('output', onOutput);
  session.on('state', onState);
  socket.send(JSON.stringify({ type: 'snapshot', data: session.terminalOutput() }));
  socket.send(JSON.stringify({ type: 'state', session: session.snapshot() }));

  socket.on('message', (raw: Buffer | string) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number; requestId?: string };
      if (message.type === 'input' && typeof message.data === 'string') {
        if (message.data.length > 65_536 || (message.requestId?.length ?? 0) > 100) throw new Error('Terminal input is too large');
        session.write(message.data, message.requestId);
        if (message.requestId) socket.send(JSON.stringify({ type: 'ack', requestId: message.requestId }));
      } else if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
        session.resize(message.cols, message.rows);
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid terminal message' }));
    }
  });

  socket.on('close', () => {
    session.off('output', onOutput);
    session.off('state', onState);
  });
}

async function main(): Promise<void> {
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && !process.env.AGENTDOCK_PASSWORD) {
    throw new Error('AGENTDOCK_PASSWORD is required when HOST is not loopback');
  }
  await mkdir(dataDir, { recursive: true });
  const store = new StateStore(join(dataDir, 'state.json'));
  const manager = new SessionManager(store);
  await manager.load();
  const app = createApp(manager, new AuthManager(), { defaultCwd: process.env.AGENTDOCK_DEFAULT_CWD ?? process.cwd() });
  await app.listen({ port, host });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    app.log.info('Shutting down AgentDock');
    await manager.shutdown();
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.env.AGENTDOCK_DISABLE_MAIN !== '1') void main().catch((error) => { console.error(error); process.exitCode = 1; });
