import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'agentdock_session';

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value));
}

export class AuthManager {
  private readonly revokedTokens = new Set<string>();
  private readonly secret: Buffer;
  readonly enabled: boolean;

  constructor(private readonly password = process.env.AGENTDOCK_PASSWORD, private readonly ttlSeconds = 43_200) {
    this.enabled = Boolean(password);
    this.secret = createHmac('sha256', 'agentdock-auth-v1').update(password ?? randomBytes(32)).digest();
  }

  isAuthenticated(request: FastifyRequest): boolean {
    if (!this.enabled) return true;
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!token || this.revokedTokens.has(token)) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !this.matches(signature, this.sign(payload))) return false;
    const expiresAt = Number(Buffer.from(payload, 'base64url').toString('utf8').split(':')[0]);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  login(candidate: string): string | null {
    if (!this.enabled) return 'disabled';
    const expected = Buffer.from(this.password ?? '');
    const actual = Buffer.from(candidate);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const payload = Buffer.from(`${Date.now() + this.ttlSeconds * 1000}:${randomBytes(18).toString('base64url')}`).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  logout(request: FastifyRequest): void {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (token) this.revokedTokens.add(token);
  }

  setCookie(reply: FastifyReply, token: string, secure = false): void {
    reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${this.ttlSeconds}; SameSite=Strict${secure ? '; Secure' : ''}`);
  }

  clearCookie(reply: FastifyReply): void {
    reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private matches(actual: string, expected: string): boolean {
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
