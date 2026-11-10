import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { RefreshToken, User } from '../db/types.js';
import { now, randomToken, safeEqualHex, sha256, uuid } from '../util/misc.js';
import { unauthorized } from '../util/errors.js';

export const ACCESS_TTL_MS = 14 * 86_400_000;
export const REFRESH_TTL_MS = 90 * 86_400_000;

interface SessionRecord {
  userId: string;
  expiresAt: number;
  revoked: boolean;
}

/**
 * Sessions and tokens (spec §7). Access tokens are 14-day signed JWTs carrying a session id;
 * each request is checked against the in-memory session record so revocation is immediate.
 * Refresh tokens (90 days, `sid.secret`) rotate on every use; replaying an old one revokes the session.
 */
export class SessionService {
  private sessions = new Map<string, SessionRecord>();
  private key: Uint8Array;

  constructor(
    private db: Database,
    config: Config,
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
    for (const t of db.refreshTokens.find()) this.sessions.set(t.id, { userId: t.userId, expiresAt: t.expiresAt, revoked: t.revokedAt !== null });
  }

  async signAccess(userId: string, sid: string): Promise<{ token: string; expiresAt: number }> {
    const expiresAt = now() + ACCESS_TTL_MS;
    const token = await new SignJWT({ sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  /** Verify a bearer token and the live session + user behind it. */
  async authenticate(token: string): Promise<{ user: User; sid: string }> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] }));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const sid = typeof payload.sid === 'string' ? payload.sid : '';
    const userId = payload.sub ?? '';
    const s = this.sessions.get(sid);
    if (!s || s.revoked || s.expiresAt < now() || s.userId !== userId) throw unauthorized('Session ended');
    const user = this.db.users.get(userId);
    if (!user || user.disabled) throw unauthorized('Account unavailable');
    return { user, sid };
  }

  createSession(user: User, deviceName: string, ip: string | null): { sid: string; refreshToken: string } {
    const sid = uuid();
    const secret = randomToken(32);
    const t = now();
    const rec: Omit<RefreshToken, 'id'> & { id: string } = {
      id: sid,
      userId: user.id,
      tokenHash: sha256(secret),
      previousTokenHash: null,
      deviceName: deviceName || 'Unknown device',
      createdAt: t,
      lastUsedAt: t,
      expiresAt: t + REFRESH_TTL_MS,
      revokedAt: null,
      ip,
    };
    this.db.refreshTokens.insert(rec);
    this.sessions.set(sid, { userId: user.id, expiresAt: rec.expiresAt, revoked: false });
    return { sid, refreshToken: `${sid}.${secret}` };
  }

  /** Rotate a refresh token. Reuse of a superseded token revokes the whole session. */
  rotate(refreshToken: string, ip: string | null): { user: User; sid: string; refreshToken: string; reuse?: false } {
    const dot = refreshToken.indexOf('.');
    if (dot < 1) throw unauthorized('Invalid refresh token');
    const sid = refreshToken.slice(0, dot);
    const secretHash = sha256(refreshToken.slice(dot + 1));
    const rec = this.db.refreshTokens.get(sid);
    if (!rec || rec.revokedAt !== null || rec.expiresAt < now()) throw unauthorized('Invalid refresh token');
    if (!safeEqualHex(secretHash, rec.tokenHash)) {
      if (rec.previousTokenHash && safeEqualHex(secretHash, rec.previousTokenHash)) {
        this.revoke(sid); // reuse detected
        throw Object.assign(unauthorized('Refresh token reuse detected; session revoked'), { reuseOf: rec });
      }
      throw unauthorized('Invalid refresh token');
    }
    const user = this.db.users.get(rec.userId);
    if (!user || user.disabled) throw unauthorized('Account unavailable');
    const secret = randomToken(32);
    rec.previousTokenHash = rec.tokenHash;
    rec.tokenHash = sha256(secret);
    rec.lastUsedAt = now();
    rec.expiresAt = now() + REFRESH_TTL_MS;
    rec.ip = ip;
    this.db.refreshTokens.saveQuiet(rec);
    const s = this.sessions.get(sid);
    if (s) s.expiresAt = rec.expiresAt;
    return { user, sid, refreshToken: `${sid}.${secret}` };
  }

  revoke(sid: string): boolean {
    const rec = this.db.refreshTokens.get(sid);
    if (!rec || rec.revokedAt !== null) return false;
    rec.revokedAt = now();
    this.db.refreshTokens.saveQuiet(rec);
    const s = this.sessions.get(sid);
    if (s) s.revoked = true;
    return true;
  }

  revokeAllForUser(userId: string, exceptSid?: string): number {
    let n = 0;
    for (const rec of this.db.refreshTokens.find({ userId })) {
      if (rec.id !== exceptSid && this.revoke(rec.id)) n++;
    }
    return n;
  }

  listForUser(userId: string): RefreshToken[] {
    const t = now();
    return this.db.refreshTokens.find({ userId }).filter((r) => r.revokedAt === null && r.expiresAt > t);
  }

  activeCount(userId: string): number {
    return this.listForUser(userId).length;
  }

  /** Drop long-dead session records. */
  prune(): void {
    const cutoff = now() - 7 * 86_400_000;
    for (const r of this.db.refreshTokens.where((d) => d.expiresAt < cutoff || (d.revokedAt !== null && d.revokedAt < cutoff))) {
      this.db.refreshTokens.remove(r);
      this.sessions.delete(r.id);
    }
  }
}
