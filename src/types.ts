export type SessionMode = 'shell' | 'claude' | 'custom';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'error' | 'orphaned';

export interface SessionConfig {
  name: string;
  cwd: string;
  mode: SessionMode;
  command?: string;
  args?: string[];
  persist?: boolean;
  recoverOnRestart?: boolean;
  automationId?: string;
}

export interface SessionSnapshot extends SessionConfig {
  id: string;
  status: SessionStatus;
  pid: number | null;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
  backend: 'pty' | 'tmux';
  tmuxName?: string;
}

export type AutomationSchedule = 'once' | 'interval';
export type AutomationRunStatus = 'never' | 'running' | 'succeeded' | 'failed';

export interface AutomationConfig {
  name: string;
  cwd: string;
  mode: SessionMode;
  command?: string;
  args?: string[];
  prompt: string;
  schedule: AutomationSchedule;
  runAt?: string;
  intervalMinutes?: number;
  enabled: boolean;
}

export interface Automation extends AutomationConfig {
  id: string;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: AutomationRunStatus;
  lastError: string | null;
  runCount: number;
  activeSessionId: string | null;
  promptSentAt: string | null;
}

export interface PersistedState {
  version: 1;
  sessions: SessionSnapshot[];
  automations: Automation[];
}

export interface AppCapabilities {
  platform: NodeJS.Platform;
  persistentSessions: boolean;
  persistenceBackend: 'tmux' | 'none';
  defaultCwd: string;
  maxSessions: number;
}
