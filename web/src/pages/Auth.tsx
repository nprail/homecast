import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BrandMark } from '../components/icons';
import { Button, ErrorNote, Field, inputCls } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark size={44} />
          <div>
            <div className="font-display text-xl leading-6 font-bold tracking-[-0.02em]">Homecast</div>
            <div className="text-sm text-muted">{subtitle ?? 'Self-hosted server'}</div>
          </div>
        </div>
        <div className="rounded-[14px] border border-line bg-white p-6">
          <h1 className="m-0 mb-4 font-display text-2xl font-bold">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await signIn(username, password);
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : u.role === 'admin' ? '/admin' : '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell title="Sign in">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorNote error={error} />
        <Field label="Username">{(id) => <input id={id} className={inputCls} autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <input id={id} className={inputCls} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-4 mb-0 text-center text-[13px] text-muted">
        Have an invite? <Link to="/register" className="font-medium text-brand">Create an account</Link>
      </p>
    </Shell>
  );
}

export function RegisterPage() {
  const { signUp } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [setup, setSetup] = useState(params.has('bootstrap'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await signUp({ username, password, ...(setup ? { bootstrapToken: token.trim() } : { inviteCode: code.trim() }) });
      nav(u.role === 'admin' ? '/admin' : '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell title={setup ? 'Create the admin account' : 'Create your account'} subtitle={setup ? 'First-time setup' : 'Registration is invite-only'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorNote error={error} />
        {setup ? (
          <Field label="Bootstrap token" hint="Printed in the server log on first run.">
            {(id) => <input id={id} className={`${inputCls} font-mono`} required autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}
          </Field>
        ) : (
          <Field label="Invite code">{(id) => <input id={id} className={`${inputCls} font-mono`} required autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        )}
        <Field label="Username">{(id) => <input id={id} className={inputCls} autoComplete="username" required minLength={2} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label="Password" hint="At least 10 characters.">
          {(id) => <input id={id} className={inputCls} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 mb-0 text-center text-[13px] text-muted">
        <button type="button" onClick={() => setSetup(!setup)} className="border-0 bg-transparent p-0 font-medium text-brand">
          {setup ? 'I have an invite code' : 'Setting up a new server?'}
        </button>
        {' · '}
        <Link to="/login" className="font-medium text-brand">Sign in</Link>
      </p>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const token = params.get('token') ?? '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell title="Reset password">
      {done ? (
        <p className="m-0 text-sm">
          Your password was changed and all devices were signed out. <Link to="/login" className="font-medium text-brand">Sign in</Link>
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ErrorNote error={error} />
          {!token && <ErrorNote error="This reset link is missing its token." />}
          <Field label="New password" hint="At least 10 characters.">
            {(id) => <input id={id} className={inputCls} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !token}>
            {busy ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </Shell>
  );
}
