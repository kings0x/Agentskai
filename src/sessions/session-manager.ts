import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Session } from './session.js';
import type { PlatformStore } from '../persistence/store.js';
import { randomUUID } from 'node:crypto';
import type { Automation, AutomationConfig, SessionConfig, SessionSnapshot } from '../types.js';
import { normalizeWorkingDirectory } from '../paths.js';
import { killTmuxSession, tmuxAvailable } from './tmux.js';

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private scheduler: NodeJS.Timeout | null = null;
  readonly maxSessions: number;

  private readonly prepareRuntime?: (config: SessionConfig, sessionId: string) => Promise<{ dockerEnvFile?: string }>;

  constructor(private readonly store: PlatformStore, options: { maxSessions?: number; prepareRuntime?: (config: SessionConfig, sessionId: string) => Promise<{ dockerEnvFile?: string }> } = {}) {
    this.maxSessions = options.maxSessions ?? Number(process.env.AGENTDOCK_MAX_SESSIONS ?? 20);
    this.prepareRuntime = options.prepareRuntime;
  }

  async load(): Promise<void> {
    await this.store.load();
    for (const snapshot of this.store.list()) {
      if (snapshot.status === 'orphaned' && snapshot.recoverOnRestart !== false) {
        await this.restore(snapshot);
      }
    }
    for (const automation of this.listAutomations()) {
      if (!automation.activeSessionId) continue;
      const session = this.sessions.get(automation.activeSessionId);
      if (!session) {
        this.store.upsertAutomation({ ...automation, activeSessionId: null, lastRunStatus: 'failed', lastError: 'Automation session could not be recovered' });
        continue;
      }
      this.watchAutomationSession(session, automation.id);
      if (!automation.promptSentAt && session.snapshot().status === 'running') this.scheduleAutomationPrompt(session, automation.id, automation.prompt, 300);
    }
    this.scheduler = setInterval(() => void this.runDueAutomations(), 5000);
    this.scheduler.unref();
  }

  list(): SessionSnapshot[] {
    const persisted = new Map(this.store.list().map((session) => [session.id, session]));
    for (const session of this.sessions.values()) persisted.set(session.id, session.snapshot());
    return [...persisted.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSnapshot(id: string): SessionSnapshot | undefined {
    return this.sessions.get(id)?.snapshot() ?? this.store.list().find((item) => item.id === id);
  }

  async create(input: SessionConfig): Promise<Session> {
    const activeCount = this.list().filter((item) => item.status === 'running' || item.status === 'starting').length;
    if (activeCount >= this.maxSessions) throw new Error(`Session limit reached (${this.maxSessions})`);
    const cwd = normalizeWorkingDirectory(input.cwd);
    await access(cwd, constants.F_OK);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory must be a directory');
    const id = randomUUID();
    const config = { persist: true, recoverOnRestart: true, ...input, cwd };
    const runtime = await this.prepareRuntime?.(config, id);
    const session = new Session(config, { id, ...runtime });
    this.bind(session);
    this.sessions.set(session.id, session);
    this.store.upsert(session.snapshot());
    session.start();
    return session;
  }

  private async restore(snapshot: SessionSnapshot): Promise<void> {
    try {
      await access(snapshot.cwd, constants.F_OK);
      if (!(await stat(snapshot.cwd)).isDirectory()) return;
      const config = { ...snapshot, persist: snapshot.persist !== false, recoverOnRestart: snapshot.recoverOnRestart !== false };
      const runtime = await this.prepareRuntime?.(config, snapshot.id);
      const session = new Session(config, { id: snapshot.id, createdAt: snapshot.createdAt, tmuxName: snapshot.tmuxName, ...runtime });
      this.bind(session);
      this.sessions.set(session.id, session);
      session.start({ requireExistingTmux: !snapshot.containerName });
    } catch {
      // Keep the orphaned record visible when its working directory disappeared.
    }
  }

  private bind(session: Session): void {
    session.on('state', (snapshot: SessionSnapshot) => this.store.upsert(snapshot));
  }

  stop(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) {
      const snapshot = this.getSnapshot(id);
      if (!snapshot) throw new Error('Session not found');
      if (snapshot.tmuxName) killTmuxSession(snapshot.tmuxName);
      const stopped = { ...snapshot, status: 'stopped' as const, pid: null, endedAt: new Date().toISOString() };
      this.store.upsert(stopped);
      return stopped;
    }
    session.stop();
    const snapshot = session.snapshot();
    this.store.upsert(snapshot);
    return snapshot;
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.stop();
    else {
      const snapshot = this.getSnapshot(id);
      if (snapshot?.tmuxName) killTmuxSession(snapshot.tmuxName);
    }
    this.sessions.delete(id);
    this.store.remove(id);
  }

  listAutomations(): Automation[] {
    return this.store.listAutomations().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createAutomation(input: AutomationConfig): Promise<Automation> {
    const cwd = normalizeWorkingDirectory(input.cwd);
    await access(cwd, constants.F_OK);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory must be a directory');
    const now = new Date();
    const runAt = input.runAt ? new Date(input.runAt) : now;
    if (input.schedule === 'once' && input.enabled && (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= now.getTime())) {
      throw new Error('One-time automation must be scheduled in the future');
    }
    const nextRunAt = input.enabled && input.schedule === 'once'
      ? runAt.toISOString()
      : input.enabled
        ? new Date(now.getTime() + (input.intervalMinutes ?? 60) * 60_000).toISOString()
        : null;
    const automation: Automation = { ...input, cwd, id: randomUUID(), createdAt: now.toISOString(), lastRunAt: null, nextRunAt, lastRunStatus: 'never', lastError: null, runCount: 0, activeSessionId: null, promptSentAt: null };
    this.store.upsertAutomation(automation);
    return automation;
  }

  async updateAutomation(id: string, patch: Partial<AutomationConfig>): Promise<Automation> {
    const current = this.listAutomations().find((item) => item.id === id);
    if (!current) throw new Error('Automation not found');
    const merged = { ...current, ...patch };
    const cwd = normalizeWorkingDirectory(merged.cwd);
    await access(cwd, constants.F_OK);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory must be a directory');
    const now = Date.now();
    let nextRunAt = current.nextRunAt;
    if (!merged.enabled) nextRunAt = null;
    else if (!current.enabled || patch.schedule || patch.runAt || patch.intervalMinutes) {
      if (merged.schedule === 'once') {
        const runAt = Date.parse(merged.runAt ?? '');
        if (!Number.isFinite(runAt) || runAt <= now) throw new Error('One-time automation must be scheduled in the future');
        nextRunAt = new Date(runAt).toISOString();
      } else nextRunAt = new Date(now + (merged.intervalMinutes ?? 60) * 60_000).toISOString();
    }
    const updated: Automation = { ...merged, cwd, nextRunAt };
    this.store.upsertAutomation(updated);
    return updated;
  }

  async runAutomation(id: string): Promise<Session> {
    const automation = this.listAutomations().find((item) => item.id === id);
    if (!automation) throw new Error('Automation not found');
    if (automation.activeSessionId) {
      const active = this.getSnapshot(automation.activeSessionId);
      if (active?.status === 'running' || active?.status === 'starting') throw new Error('Automation already has a running session');
    }
    let session: Session;
    try {
      session = await this.create({ name: `${automation.name} · ${new Date().toLocaleString()}`, cwd: automation.cwd, mode: automation.mode, command: automation.command, args: automation.args, automationId: id, workspaceId: automation.workspaceId, ownerId: automation.ownerId });
    } catch (error) {
      this.markAutomationFailure(automation, (error as Error).message);
      throw error;
    }
    this.markAutomationRun(automation, session.id);
    this.watchAutomationSession(session, id);
    this.scheduleAutomationPrompt(session, id, automation.prompt);
    return session;
  }

  deleteAutomation(id: string): void {
    this.store.removeAutomation(id);
  }

  private markAutomationRun(automation: Automation, sessionId: string): void {
    const now = new Date();
    const updated: Automation = automation.schedule === 'once'
      ? { ...automation, enabled: false, lastRunAt: now.toISOString(), nextRunAt: null, lastRunStatus: 'running', lastError: null, runCount: automation.runCount + 1, activeSessionId: sessionId, promptSentAt: null }
      : { ...automation, lastRunAt: now.toISOString(), nextRunAt: new Date(now.getTime() + (automation.intervalMinutes ?? 60) * 60_000).toISOString(), lastRunStatus: 'running', lastError: null, runCount: automation.runCount + 1, activeSessionId: sessionId, promptSentAt: null };
    this.store.upsertAutomation(updated);
  }

  private markAutomationFailure(automation: Automation, message: string): void {
    const now = new Date();
    this.store.upsertAutomation({ ...automation, enabled: automation.schedule === 'once' ? false : automation.enabled, lastRunAt: now.toISOString(), nextRunAt: automation.schedule === 'once' ? null : new Date(now.getTime() + (automation.intervalMinutes ?? 60) * 60_000).toISOString(), lastRunStatus: 'failed', lastError: message, runCount: automation.runCount + 1, activeSessionId: null, promptSentAt: null });
  }

  private async runDueAutomations(): Promise<void> {
    const now = Date.now();
    for (const automation of this.listAutomations()) {
      if (!automation.enabled || !automation.nextRunAt || Date.parse(automation.nextRunAt) > now) continue;
      try { await this.runAutomation(automation.id); } catch (error) { console.error(`[agentdock] Automation "${automation.name}" failed:`, error); }
    }
  }

  private watchAutomationSession(session: Session, automationId: string): void {
    const onState = (snapshot: SessionSnapshot) => {
      if (snapshot.status === 'running' || snapshot.status === 'starting') return;
      session.off('state', onState);
      const latest = this.listAutomations().find((item) => item.id === automationId);
      if (!latest || latest.activeSessionId !== session.id) return;
      const succeeded = snapshot.status === 'exited' && snapshot.exitCode === 0;
      this.store.upsertAutomation({ ...latest, activeSessionId: null, lastRunStatus: succeeded ? 'succeeded' : 'failed', lastError: succeeded ? null : `Session ended with status ${snapshot.status}` });
    };
    session.on('state', onState);
    onState(session.snapshot());
  }

  private scheduleAutomationPrompt(session: Session, automationId: string, prompt: string, delay = 700): void {
    setTimeout(() => {
      try {
        session.write(`${prompt.replace(/[\r\n]+/g, ' ')}\r`);
        const latest = this.listAutomations().find((item) => item.id === automationId);
        if (latest?.activeSessionId === session.id) this.store.upsertAutomation({ ...latest, promptSentAt: new Date().toISOString() });
      } catch { /* The state watcher records an early process exit. */ }
    }, delay).unref();
  }

  async restart(id: string): Promise<Session> {
    const snapshot = this.getSnapshot(id);
    if (!snapshot) throw new Error('Session not found');
    const current = this.sessions.get(id);
    if (current && (current.snapshot().status === 'running' || current.snapshot().status === 'starting')) current.stop();
    const config: SessionConfig = { name: snapshot.name, cwd: snapshot.cwd, mode: snapshot.mode, command: snapshot.command, args: snapshot.args, persist: snapshot.persist, recoverOnRestart: snapshot.recoverOnRestart, automationId: snapshot.automationId, workspaceId: snapshot.workspaceId, ownerId: snapshot.ownerId, containerName: snapshot.containerName };
    const runtime = await this.prepareRuntime?.(config, snapshot.id);
    const session = new Session(config, { id: snapshot.id, createdAt: snapshot.createdAt, tmuxName: snapshot.tmuxName, ...runtime });
    this.bind(session);
    this.sessions.set(id, session);
    this.store.upsert(session.snapshot());
    session.start();
    return session;
  }

  async shutdown(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
    for (const session of this.sessions.values()) {
      const snapshot = session.snapshot();
      if (snapshot.backend === 'tmux' && snapshot.status === 'running') session.detach();
      else if (snapshot.status === 'running' || snapshot.status === 'starting') session.stop();
      this.store.upsert(session.snapshot());
    }
    await this.store.drain();
  }

  persistentSessionsAvailable(): boolean {
    return tmuxAvailable();
  }
}
