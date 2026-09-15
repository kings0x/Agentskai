import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Automation, PersistedState, SessionSnapshot } from '../types.js';

const EMPTY_STATE: PersistedState = { version: 1, sessions: [], automations: [] };

export class StateStore {
  private state: PersistedState = structuredClone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  readonly warnings: string[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = this.parse(raw);
      // A process that was running before a server restart is not attached yet.
      this.state.sessions = this.state.sessions.map((session) =>
        session.status === 'running' || session.status === 'starting'
          ? { ...session, status: 'orphaned', pid: null }
          : session,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = structuredClone(EMPTY_STATE);
        return;
      }
      try {
        this.state = this.parse(await readFile(`${this.filePath}.bak`, 'utf8'));
        this.warnings.push('Recovered state from backup after the primary state file became unreadable.');
      } catch {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        try { await rename(this.filePath, corruptPath); } catch { /* best effort */ }
        this.warnings.push(`State was corrupt and moved to ${corruptPath}.`);
        this.state = structuredClone(EMPTY_STATE);
      }
    }
  }

  list(): SessionSnapshot[] {
    return this.state.sessions.map((session) => ({ ...session, args: session.args ? [...session.args] : undefined }));
  }

  upsert(session: SessionSnapshot): void {
    const index = this.state.sessions.findIndex((item) => item.id === session.id);
    if (index === -1) this.state.sessions.push(session);
    else this.state.sessions[index] = session;
    void this.flush();
  }

  listAutomations(): Automation[] {
    return this.state.automations.map((automation) => ({ ...automation, args: automation.args ? [...automation.args] : undefined }));
  }

  upsertAutomation(automation: Automation): void {
    const index = this.state.automations.findIndex((item) => item.id === automation.id);
    if (index === -1) this.state.automations.push(automation);
    else this.state.automations[index] = automation;
    void this.flush();
  }

  removeAutomation(id: string): void {
    this.state.automations = this.state.automations.filter((automation) => automation.id !== id);
    void this.flush();
  }

  remove(id: string): void {
    this.state.sessions = this.state.sessions.filter((session) => session.id !== id);
    void this.flush();
  }

  async drain(): Promise<void> {
    await this.writeQueue;
    if (this.writeError) throw this.writeError;
  }

  private parse(raw: string): PersistedState {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.automations)) throw new Error('Invalid state shape');
    const automations = parsed.automations.map((automation) => ({
      ...automation,
      lastRunStatus: automation.lastRunStatus ?? 'never',
      lastError: automation.lastError ?? null,
      runCount: automation.runCount ?? 0,
      activeSessionId: automation.activeSessionId ?? null,
      promptSentAt: automation.promptSentAt ?? null,
    }));
    return { version: 1, sessions: parsed.sessions, automations } as PersistedState;
  }

  private flush(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      try { await copyFile(this.filePath, `${this.filePath}.bak`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
      this.writeError = null;
    }).catch((error: Error) => {
      this.writeError = error;
    });
    return this.writeQueue;
  }
}
