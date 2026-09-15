import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseStore } from '../persistence/database.js';
import type { CredentialRecord, CredentialSummary } from '../types.js';

export function loadOrCreateMasterKey(path: string, configured?: string): Buffer {
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('AGENTSKAI_MASTER_KEY must be a base64-encoded 32-byte key');
    return key;
  }
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Invalid master key file: ${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows does not support POSIX file modes. */ }
  return key;
}

export class CredentialVault {
  constructor(private readonly store: DatabaseStore, private readonly key: Buffer) {}

  list(workspaceId: string): CredentialSummary[] {
    return this.store.listCredentials(workspaceId).map(({ encryptedValue: _value, iv: _iv, authTag: _tag, ...summary }) => summary);
  }

  set(ownerId: string, workspaceId: string, name: string, value: string): CredentialSummary {
    const cleanName = name.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(cleanName)) throw new Error('Credential name must be a valid environment variable');
    if (!value || value.length > 65_536 || /[\r\n]/.test(value)) throw new Error('Credential value must be a single line of 1-65536 characters');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encryptedValue = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
    const now = new Date().toISOString();
    const existing = this.store.listCredentials(workspaceId).find((item) => item.name === cleanName);
    const record: CredentialRecord = { id: existing?.id ?? randomUUID(), ownerId, workspaceId, name: cleanName, encryptedValue, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.store.upsertCredential(record);
    const { encryptedValue: _value, iv: _iv, authTag: _tag, ...summary } = record;
    return summary;
  }

  environment(workspaceId: string): Record<string, string> {
    return Object.fromEntries(this.store.listCredentials(workspaceId).map((record) => {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const value = Buffer.concat([decipher.update(Buffer.from(record.encryptedValue, 'base64')), decipher.final()]).toString('utf8');
      return [record.name, value];
    }));
  }
}
