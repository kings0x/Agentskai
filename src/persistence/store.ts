import type { AuditEvent, Automation, CredentialRecord, PublicUser, SessionSnapshot, UserRecord, UserRole, Workspace } from '../types.js';

export interface PlatformStore {
  readonly warnings: string[];
  load(): Promise<void>;
  drain(): Promise<void>;
  close?(): void;
  list(): SessionSnapshot[];
  upsert(session: SessionSnapshot): void;
  remove(id: string): void;
  listAutomations(): Automation[];
  upsertAutomation(automation: Automation): void;
  removeAutomation(id: string): void;
  countUsers?(): number;
  createUser?(user: UserRecord): void;
  getUserByUsername?(username: string): UserRecord | undefined;
  getUserById?(id: string): UserRecord | undefined;
  listUsers?(): PublicUser[];
  updateUser?(id: string, patch: Partial<Pick<UserRecord, 'passwordHash' | 'passwordSalt' | 'role' | 'disabled' | 'lastLoginAt'>>): UserRecord;
  deleteUser?(id: string): void;
  createAuthSession?(tokenHash: string, userId: string, expiresAt: string): void;
  getAuthSessionUser?(tokenHash: string): UserRecord | undefined;
  deleteAuthSession?(tokenHash: string): void;
  purgeAuthSessions?(): void;
  listWorkspaces?(userId?: string): Workspace[];
  getWorkspace?(id: string): Workspace | undefined;
  createWorkspace?(workspace: Workspace): void;
  updateWorkspace?(workspace: Workspace): void;
  deleteWorkspace?(id: string): void;
  listCredentials?(workspaceId: string): CredentialRecord[];
  getCredential?(id: string): CredentialRecord | undefined;
  upsertCredential?(credential: CredentialRecord): void;
  deleteCredential?(id: string): void;
  appendAudit?(event: AuditEvent): void;
  listAudit?(limit: number, actorId?: string): AuditEvent[];
  createBackup?(destination: string): void;
}

export function publicUser(user: UserRecord): PublicUser {
  const { passwordHash: _hash, passwordSalt: _salt, ...safe } = user;
  return safe;
}
