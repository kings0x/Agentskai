import { randomUUID } from 'node:crypto';
import type { DatabaseStore } from '../persistence/database.js';
import type { PublicUser } from '../types.js';

export class AuditLog {
  constructor(private readonly store: DatabaseStore) {}

  record(actor: PublicUser | null, action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown> = {}, request?: { ip: string }): void {
    this.store.appendAudit({ id: randomUUID(), actorId: actor?.id ?? null, action, resourceType, resourceId, metadata, ipAddress: request?.ip ?? null, createdAt: new Date().toISOString() });
  }
}
