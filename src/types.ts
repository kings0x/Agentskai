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
  workspaceId?: string;
  ownerId?: string;
  containerName?: string;
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
  workspaceId?: string;
  ownerId?: string;
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
  dockerAvailable: boolean;
  multiUser: boolean;
}

export type UserRole = 'admin' | 'member';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export type PublicUser = Omit<UserRecord, 'passwordHash' | 'passwordSalt'>;
export type WorkspaceExecution = 'docker' | 'host';

export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  hostPath: string;
  execution: WorkspaceExecution;
  containerName: string | null;
  image: string;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  networkMode: 'bridge' | 'none';
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRecord {
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  encryptedValue: string;
  iv: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary extends Omit<CredentialRecord, 'encryptedValue' | 'iv' | 'authTag'> {}

export interface AuditEvent {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}
