import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, Automation, CredentialRecord, PublicUser, SessionSnapshot, UserRecord, Workspace } from '../types.js';
import type { PlatformStore } from './store.js';
import { publicUser } from './store.js';

type Row = Record<string, unknown>;

export class DatabaseStore implements PlatformStore {
  readonly warnings: string[] = [];
  private readonly db: DatabaseSync;

  constructor(readonly filePath: string, private readonly legacyStatePath?: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  }

  async load(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, host_path TEXT NOT NULL, execution TEXT NOT NULL CHECK(execution IN ('docker','host')), container_name TEXT UNIQUE, image TEXT NOT NULL, cpu_limit REAL NOT NULL, memory_mb INTEGER NOT NULL, pids_limit INTEGER NOT NULL, network_mode TEXT NOT NULL CHECK(network_mode IN ('bridge','none')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, automation_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, encrypted_value TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,name));
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, metadata_json TEXT NOT NULL, ip_address TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'));
    `);
    this.purgeAuthSessions();
    this.migrateLegacyState();
    for (const session of this.list()) {
      if (session.status === 'running' || session.status === 'starting') this.upsert({ ...session, status: 'orphaned', pid: null });
    }
  }

  async drain(): Promise<void> { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }
  close(): void { this.db.close(); }

  list(): SessionSnapshot[] { return (this.db.prepare('SELECT snapshot_json FROM sessions').all() as Row[]).map((row) => JSON.parse(String(row.snapshot_json)) as SessionSnapshot); }
  upsert(session: SessionSnapshot): void { this.db.prepare('INSERT INTO sessions(id,owner_id,workspace_id,snapshot_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,workspace_id=excluded.workspace_id,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at').run(session.id, session.ownerId ?? null, session.workspaceId ?? null, JSON.stringify(session), new Date().toISOString()); }
  remove(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  listAutomations(): Automation[] { return (this.db.prepare('SELECT automation_json FROM automations').all() as Row[]).map((row) => JSON.parse(String(row.automation_json)) as Automation); }
  upsertAutomation(item: Automation): void { this.db.prepare('INSERT INTO automations(id,owner_id,workspace_id,automation_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,workspace_id=excluded.workspace_id,automation_json=excluded.automation_json,updated_at=excluded.updated_at').run(item.id, item.ownerId ?? null, item.workspaceId ?? null, JSON.stringify(item), new Date().toISOString()); }
  removeAutomation(id: string): void { this.db.prepare('DELETE FROM automations WHERE id=?').run(id); }

  countUsers(): number { return Number((this.db.prepare('SELECT COUNT(*) count FROM users').get() as Row).count); }
  createUser(user: UserRecord): void { this.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,role,disabled,created_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id, user.username, user.passwordHash, user.passwordSalt, user.role, user.disabled ? 1 : 0, user.createdAt, user.lastLoginAt); }
  getUserByUsername(username: string): UserRecord | undefined { return this.userFromRow(this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as Row | undefined); }
  getUserById(id: string): UserRecord | undefined { return this.userFromRow(this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as Row | undefined); }
  listUsers(): PublicUser[] { return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map((row) => publicUser(this.userFromRow(row)!)); }
  updateUser(id: string, patch: Partial<Pick<UserRecord, 'passwordHash' | 'passwordSalt' | 'role' | 'disabled' | 'lastLoginAt'>>): UserRecord {
    const current = this.getUserById(id); if (!current) throw new Error('User not found');
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = { ...current, ...definedPatch } as UserRecord;
    this.db.prepare('UPDATE users SET password_hash=?,password_salt=?,role=?,disabled=?,last_login_at=? WHERE id=?').run(next.passwordHash, next.passwordSalt, next.role, next.disabled ? 1 : 0, next.lastLoginAt, id); return next;
  }
  deleteUser(id: string): void { this.db.prepare('DELETE FROM users WHERE id=?').run(id); }
  createAuthSession(tokenHash: string, userId: string, expiresAt: string): void { this.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(tokenHash, userId, expiresAt, new Date().toISOString()); }
  getAuthSessionUser(tokenHash: string): UserRecord | undefined { return this.userFromRow(this.db.prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0').get(tokenHash, new Date().toISOString()) as Row | undefined); }
  deleteAuthSession(tokenHash: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash); }
  purgeAuthSessions(): void { this.db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(new Date().toISOString()); }

  listWorkspaces(userId?: string): Workspace[] { const rows = userId ? this.db.prepare('SELECT * FROM workspaces WHERE owner_id=? ORDER BY updated_at DESC').all(userId) : this.db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all(); return (rows as Row[]).map(this.workspaceFromRow); }
  getWorkspace(id: string): Workspace | undefined { const row = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Row | undefined; return row ? this.workspaceFromRow(row) : undefined; }
  createWorkspace(item: Workspace): void { this.db.prepare('INSERT INTO workspaces(id,owner_id,name,slug,host_path,execution,container_name,image,cpu_limit,memory_mb,pids_limit,network_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id,item.ownerId,item.name,item.slug,item.hostPath,item.execution,item.containerName,item.image,item.cpuLimit,item.memoryMb,item.pidsLimit,item.networkMode,item.createdAt,item.updatedAt); }
  updateWorkspace(item: Workspace): void { this.db.prepare('UPDATE workspaces SET name=?,slug=?,host_path=?,execution=?,container_name=?,image=?,cpu_limit=?,memory_mb=?,pids_limit=?,network_mode=?,updated_at=? WHERE id=?').run(item.name,item.slug,item.hostPath,item.execution,item.containerName,item.image,item.cpuLimit,item.memoryMb,item.pidsLimit,item.networkMode,item.updatedAt,item.id); }
  deleteWorkspace(id: string): void { this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id); }

  listCredentials(workspaceId: string): CredentialRecord[] { return (this.db.prepare('SELECT * FROM credentials WHERE workspace_id=? ORDER BY name').all(workspaceId) as Row[]).map(this.credentialFromRow); }
  getCredential(id: string): CredentialRecord | undefined { const row=this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as Row|undefined; return row ? this.credentialFromRow(row) : undefined; }
  upsertCredential(item: CredentialRecord): void { this.db.prepare('INSERT INTO credentials(id,owner_id,workspace_id,name,encrypted_value,iv,auth_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at').run(item.id,item.ownerId,item.workspaceId,item.name,item.encryptedValue,item.iv,item.authTag,item.createdAt,item.updatedAt); }
  deleteCredential(id: string): void { this.db.prepare('DELETE FROM credentials WHERE id=?').run(id); }
  appendAudit(item: AuditEvent): void { this.db.prepare('INSERT INTO audit_events(id,actor_id,action,resource_type,resource_id,metadata_json,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?)').run(item.id,item.actorId,item.action,item.resourceType,item.resourceId,JSON.stringify(item.metadata),item.ipAddress,item.createdAt); }
  listAudit(limit: number, actorId?: string): AuditEvent[] { const rows=actorId ? this.db.prepare('SELECT * FROM audit_events WHERE actor_id=? ORDER BY created_at DESC LIMIT ?').all(actorId,limit) : this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(limit); return (rows as Row[]).map((row)=>({id:String(row.id),actorId:row.actor_id?String(row.actor_id):null,action:String(row.action),resourceType:String(row.resource_type),resourceId:row.resource_id?String(row.resource_id):null,metadata:JSON.parse(String(row.metadata_json)),ipAddress:row.ip_address?String(row.ip_address):null,createdAt:String(row.created_at)})); }
  createBackup(destination: string): void { mkdirSync(dirname(destination),{recursive:true}); this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }

  private userFromRow(row?: Row): UserRecord | undefined { if (!row) return undefined; return { id:String(row.id),username:String(row.username),passwordHash:String(row.password_hash),passwordSalt:String(row.password_salt),role:String(row.role) as UserRecord['role'],disabled:Boolean(row.disabled),createdAt:String(row.created_at),lastLoginAt:row.last_login_at?String(row.last_login_at):null }; }
  private workspaceFromRow = (row: Row): Workspace => ({ id:String(row.id),ownerId:String(row.owner_id),name:String(row.name),slug:String(row.slug),hostPath:String(row.host_path),execution:String(row.execution) as Workspace['execution'],containerName:row.container_name?String(row.container_name):null,image:String(row.image),cpuLimit:Number(row.cpu_limit),memoryMb:Number(row.memory_mb),pidsLimit:Number(row.pids_limit),networkMode:String(row.network_mode) as Workspace['networkMode'],createdAt:String(row.created_at),updatedAt:String(row.updated_at) });
  private credentialFromRow = (row: Row): CredentialRecord => ({ id:String(row.id),ownerId:String(row.owner_id),workspaceId:String(row.workspace_id),name:String(row.name),encryptedValue:String(row.encrypted_value),iv:String(row.iv),authTag:String(row.auth_tag),createdAt:String(row.created_at),updatedAt:String(row.updated_at) });
  private migrateLegacyState(): void {
    if (!this.legacyStatePath || !existsSync(this.legacyStatePath) || this.list().length || this.listAutomations().length) return;
    try {
      const legacy=JSON.parse(readFileSync(this.legacyStatePath,'utf8')) as {sessions?:SessionSnapshot[];automations?:Automation[]};
      this.db.exec('BEGIN');
      for (const session of legacy.sessions ?? []) this.upsert(session);
      for (const automation of legacy.automations ?? []) this.upsertAutomation({
        ...automation,
        lastRunStatus: automation.lastRunStatus ?? 'never',
        lastError: automation.lastError ?? null,
        runCount: automation.runCount ?? 0,
        activeSessionId: automation.activeSessionId ?? null,
        promptSentAt: automation.promptSentAt ?? null,
      });
      this.db.exec('COMMIT'); this.warnings.push('Migrated legacy JSON state into SQLite.');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.warnings.push(`Legacy state migration failed: ${(error as Error).message}`); }
  }
}

export function newId(): string { return randomUUID(); }
