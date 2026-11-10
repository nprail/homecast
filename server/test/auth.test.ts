import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { bearer, createUser, registerAdmin, startApp } from './helpers.js';

let a: App;
beforeEach(async () => {
  a = await startApp();
});
afterEach(async () => {
  await a.close();
});

const login = (username: string, password: string, extra = {}) =>
  a.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password, ...extra } });

describe('bootstrap and registration', () => {
  it('creates the first admin with the bootstrap token, once', async () => {
    const bad = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'x1', password: 'longenoughpass', bootstrapToken: 'wrong-token-value' } });
    expect(bad.statusCode).toBe(403);
    const admin = await registerAdmin(a);
    const me = await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(admin) });
    expect(me.json().user.role).toBe('admin');
    expect(a.ctx.bootstrap.token).toBeNull();
  });

  it('is invite-only: invites are single-use and expiring', async () => {
    const admin = await registerAdmin(a);
    const none = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'maya', password: 'longenoughpass' } });
    expect(none.statusCode).toBe(400);
    const inv = (await a.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: bearer(admin), payload: {} })).json();
    const reg = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'maya', password: 'longenoughpass', inviteCode: inv.code } });
    expect(reg.statusCode).toBe(201);
    const reuse = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'eli', password: 'longenoughpass', inviteCode: inv.code } });
    expect(reuse.statusCode).toBe(400);
    const inv2 = (await a.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: bearer(admin), payload: {} })).json();
    a.ctx.db.invites.get(inv2.invite.id)!.expiresAt = Date.now() - 1000;
    const expired = await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'eli', password: 'longenoughpass', inviteCode: inv2.code } });
    expect(expired.statusCode).toBe(400);
    const list = (await a.app.inject({ method: 'GET', url: '/api/v1/admin/invites', headers: bearer(admin) })).json().invites;
    expect(list.map((i: { status: string }) => i.status).sort()).toEqual(['expired', 'used']);
  });

  it('enforces the 10 character minimum password and unique usernames', async () => {
    const admin = await registerAdmin(a);
    const inv = (await a.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: bearer(admin), payload: {} })).json();
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'maya', password: 'short', inviteCode: inv.code } })).statusCode).toBe(400);
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'DEMO', password: 'longenoughpass', inviteCode: inv.code } })).statusCode).toBe(409);
  });

  it('can close registration', async () => {
    const admin = await registerAdmin(a);
    await a.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: bearer(admin), payload: { registrationOpen: false } });
    const inv = (await a.app.inject({ method: 'POST', url: '/api/v1/admin/invites', headers: bearer(admin), payload: {} })).json();
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'maya', password: 'longenoughpass', inviteCode: inv.code } })).statusCode).toBe(403);
  });
});

describe('login, sessions, tokens', () => {
  it('logs in, rotates refresh tokens, and detects reuse', async () => {
    await registerAdmin(a);
    const res = await login('demo', 'correct horse battery', { deviceName: 'Pixel 9' });
    expect(res.statusCode).toBe(200);
    const { accessToken, refreshToken } = res.json();
    const r1 = await a.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
    expect(r1.statusCode).toBe(200);
    const next = r1.json().refreshToken;
    expect(next).not.toBe(refreshToken);
    // replaying the old token kills the whole family
    const replay = await a.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
    expect(replay.statusCode).toBe(401);
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: next } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${accessToken}` } })).statusCode).toBe(401);
  });

  it('web clients get an HttpOnly SameSite=Strict cookie and no refresh token in the body', async () => {
    await registerAdmin(a);
    const res = await login('demo', 'correct horse battery', { client: 'web' });
    expect(res.json().refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const rt = /rt=([^;]+)/.exec(cookie)![1]!;
    const ref = await a.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { rt }, payload: {} });
    expect(ref.statusCode).toBe(200);
    const cross = await a.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { rt }, headers: { origin: 'https://evil.example' }, payload: {} });
    expect(cross.statusCode).toBe(403);
  });

  it('revokes sessions immediately (logout, admin revoke, disable)', async () => {
    const admin = await registerAdmin(a);
    const maya = await createUser(a, admin, 'maya');
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(maya) })).statusCode).toBe(200);
    await a.app.inject({ method: 'POST', url: `/api/v1/admin/users/${maya.id}/revoke-sessions`, headers: bearer(admin) });
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(maya) })).statusCode).toBe(401);
    const again = (await login('maya', 'another long password')).json();
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${maya.id}`, headers: bearer(admin), payload: { disabled: true } });
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${again.accessToken}` } })).statusCode).toBe(401);
    expect((await login('maya', 'another long password')).statusCode).toBe(401);
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${maya.id}`, headers: bearer(admin), payload: { disabled: false } });
    const ok = await login('maya', 'another long password');
    expect(ok.statusCode).toBe(200);
    const out = await a.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${ok.json().accessToken}` } });
    expect(out.statusCode).toBe(204);
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${ok.json().accessToken}` } })).statusCode).toBe(401);
  });

  it('locks out after repeated failures with a progressive lockout, and audits it', async () => {
    await registerAdmin(a);
    for (let i = 0; i < 5; i++) expect((await login('demo', 'wrong password!!')).statusCode).toBe(401);
    const locked = await login('demo', 'correct horse battery');
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    const audit = a.ctx.db.auditLog.find().filter((e) => e.action === 'login.failed');
    expect(audit.some((e) => e.detail?.includes('locked 15 min'))).toBe(true);
  });

  it('does not reveal whether a username exists', async () => {
    await registerAdmin(a);
    const a1 = await login('demo', 'bad password!!!');
    const a2 = await login('nobody', 'bad password!!!');
    expect(a1.json()).toEqual(a2.json());
  });

  it('password reset link is one-time and revokes sessions', async () => {
    const admin = await registerAdmin(a);
    const maya = await createUser(a, admin, 'maya');
    const link = (await a.app.inject({ method: 'POST', url: `/api/v1/admin/users/${maya.id}/reset-link`, headers: bearer(admin) })).json();
    const token = new URL(link.url).searchParams.get('token')!;
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password: 'brand new password' } })).statusCode).toBe(200);
    expect((await a.app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password: 'yet another password' } })).statusCode).toBe(400);
    expect((await a.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(maya) })).statusCode).toBe(401);
    expect((await login('maya', 'brand new password')).statusCode).toBe(200);
  });
});

describe('admin authorization and guards', () => {
  it('every /admin route rejects anonymous and non-admin callers', async () => {
    const admin = await registerAdmin(a);
    const maya = await createUser(a, admin, 'maya');
    const routes: [string, string][] = [
      ['GET', '/admin/overview'], ['GET', '/admin/users'], ['GET', '/admin/invites'], ['POST', '/admin/invites'], ['GET', '/admin/feeds'], ['GET', '/admin/jobs'],
      ['GET', '/admin/usage'], ['GET', '/admin/audit'], ['GET', '/admin/settings'], ['PATCH', '/admin/settings'], ['POST', '/admin/backup'],
      ['PATCH', `/admin/users/${admin.id}`], ['DELETE', `/admin/users/${admin.id}`], ['POST', `/admin/users/${admin.id}/reset-link`], ['DELETE', '/admin/feeds/orphans'],
    ];
    for (const [method, url] of routes) {
      expect((await a.app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: {} })).statusCode, `${method} ${url} anon`).toBe(401);
      expect((await a.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: bearer(maya), payload: {} })).statusCode, `${method} ${url} user`).toBe(403);
    }
  });

  it("the last admin can't be demoted, disabled or deleted", async () => {
    const admin = await registerAdmin(a);
    for (const payload of [{ role: 'user' }, { disabled: true }]) {
      expect((await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${admin.id}`, headers: bearer(admin), payload })).statusCode).toBe(409);
    }
    expect((await a.app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${admin.id}`, headers: bearer(admin) })).statusCode).toBe(409);
    const maya = await createUser(a, admin, 'maya');
    await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${maya.id}`, headers: bearer(admin), payload: { role: 'admin' } });
    expect((await a.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${admin.id}`, headers: bearer(maya), payload: { role: 'user' } })).statusCode).toBe(200);
    expect((await a.app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${maya.id}`, headers: bearer(maya) })).statusCode).toBe(409);
  });
});
