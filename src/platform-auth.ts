import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { DatabaseStore } from './persistence/database.js';
import type { PublicUser, UserRecord, UserRole } from './types.js';
import { publicUser } from './persistence/store.js';

const COOKIE_NAME = 'agentskai_session';

function cookies(header?: string): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => part.trim().split('=', 2)).filter(([key, value]) => key && value));
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PlatformAuth {
  constructor(private readonly store: DatabaseStore, private readonly ttlSeconds = 43_200) {}

  async bootstrap(password?: string, username = 'admin'): Promise<PublicUser | null> {
    if (this.store.countUsers() > 0 || !password) return null;
    return this.createUser(username, password, 'admin');
  }

  setupRequired(): boolean { return this.store.countUsers() === 0; }

  async createUser(username: string, password: string, role: UserRole): Promise<PublicUser> {
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanUsername)) throw new Error('Username must be 3-32 lowercase letters, numbers, dots, underscores, or hyphens');
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    if (this.store.getUserByUsername(cleanUsername)) throw new Error('Username already exists');
    const salt = randomBytes(16).toString('base64url');
    const passwordHash = await this.hash(password, salt);
    const user: UserRecord = { id: randomUUID(), username: cleanUsername, passwordHash, passwordSalt: salt, role, disabled: false, createdAt: new Date().toISOString(), lastLoginAt: null };
    this.store.createUser(user);
    return publicUser(user);
  }

  async changePassword(userId: string, password: string): Promise<void> {
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    const salt = randomBytes(16).toString('base64url');
    this.store.updateUser(userId, { passwordSalt: salt, passwordHash: await this.hash(password, salt) });
  }

  async login(username: string, password: string): Promise<{ token: string; user: PublicUser } | null> {
    const user = this.store.getUserByUsername(username.trim());
    if (!user || user.disabled) { await this.dummyHash(password); return null; }
    const actual = Buffer.from(await this.hash(password, user.passwordSalt), 'hex');
    const expected = Buffer.from(user.passwordHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const token = randomBytes(32).toString('base64url');
    this.store.createAuthSession(tokenHash(token), user.id, new Date(Date.now() + this.ttlSeconds * 1000).toISOString());
    const updated = this.store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    return { token, user: publicUser(updated) };
  }

  userFor(request: { headers: { cookie?: string } }): PublicUser | null {
    const token = cookies(request.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const user = this.store.getAuthSessionUser(tokenHash(token));
    return user ? publicUser(user) : null;
  }

  logout(request: { headers: { cookie?: string } }): void {
    const token = cookies(request.headers.cookie)[COOKIE_NAME];
    if (token) this.store.deleteAuthSession(tokenHash(token));
  }

  setCookie(reply: { header: (name: string, value: string) => unknown }, token: string, secure: boolean): void {
    reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${this.ttlSeconds}; SameSite=Strict${secure ? '; Secure' : ''}`);
  }

  clearCookie(reply: { header: (name: string, value: string) => unknown }): void {
    reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
  }

  private async hash(password: string, salt: string): Promise<string> {
    const result = await new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    return result.toString('hex');
  }

  private async dummyHash(password: string): Promise<void> { await this.hash(password, 'agentskai-invalid-user'); }
}
