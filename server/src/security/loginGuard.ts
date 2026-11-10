/**
 * Login throttling (spec §7): 5 attempts/min per IP and per username, with progressive lockout
 * (15 min, doubling per repeated lockout, capped at 24 h). Unknown usernames are tracked the same
 * way so lockouts don't reveal which accounts exist.
 */
interface Entry {
  failures: number[]; // timestamps within the window
  lockedUntil: number;
  lockouts: number;
  lastSeen: number;
}

const WINDOW_MS = 60_000;
const MAX_FAILS = 5;
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 3600_000;

export interface GuardResult {
  allowed: boolean;
  retryAfterSec: number;
}

export class LoginGuard {
  private entries = new Map<string, Entry>();

  constructor(private clock: () => number = Date.now) {}

  private get(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: [], lockedUntil: 0, lockouts: 0, lastSeen: this.clock() };
      this.entries.set(key, e);
    }
    return e;
  }

  check(ip: string, username: string): GuardResult {
    const t = this.clock();
    let until = 0;
    for (const key of [`ip:${ip}`, `user:${username.toLowerCase()}`]) {
      const e = this.entries.get(key);
      if (e && e.lockedUntil > t) until = Math.max(until, e.lockedUntil);
    }
    return until > t ? { allowed: false, retryAfterSec: Math.ceil((until - t) / 1000) } : { allowed: true, retryAfterSec: 0 };
  }

  /** Record a failed attempt. Returns lock info when this failure triggered a lockout. */
  fail(ip: string, username: string): { locked: boolean; attempts: number; lockMinutes: number } {
    const t = this.clock();
    let result = { locked: false, attempts: 0, lockMinutes: 0 };
    for (const key of [`ip:${ip}`, `user:${username.toLowerCase()}`]) {
      const e = this.get(key);
      e.lastSeen = t;
      e.failures = e.failures.filter((x) => t - x < WINDOW_MS);
      e.failures.push(t);
      if (e.failures.length >= MAX_FAILS && e.lockedUntil <= t) {
        const lock = Math.min(BASE_LOCK_MS * 2 ** e.lockouts, MAX_LOCK_MS);
        e.lockouts += 1;
        e.lockedUntil = t + lock;
        e.failures = [];
        result = { locked: true, attempts: MAX_FAILS, lockMinutes: Math.round(lock / 60000) };
      } else if (!result.locked) {
        result.attempts = Math.max(result.attempts, e.failures.length);
      }
    }
    return result;
  }

  succeed(ip: string, username: string): void {
    this.entries.delete(`user:${username.toLowerCase()}`);
    const e = this.entries.get(`ip:${ip}`);
    if (e) e.failures = [];
  }

  /** Drop stale entries so the map can't grow without bound. */
  sweep(): void {
    const t = this.clock();
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < t && t - e.lastSeen > 24 * 3600_000) this.entries.delete(k);
    }
  }
}
