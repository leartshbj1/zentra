import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { createSupabaseAuthClient } from './supabase-auth';

type Context = { jar: Map<string, string>; updates: Map<string, { value: string; options: Record<string, unknown> }> };
type Statement = ReturnType<typeof prepare>;
const state = vi.hoisted(() => ({
  db: null as unknown as { prepare: typeof prepare; batch: (statements: Statement[]) => Promise<unknown> },
  client: null as unknown as ReturnType<typeof createSupabaseAuthClient>,
  context: null as unknown as AsyncLocalStorage<Context>,
}));
vi.mock('next/headers', () => ({ cookies: async () => {
  const context = state.context.getStore();
  if (!context) throw new Error('Missing synthetic HTTP request context');
  return {
    get: (name: string) => context.jar.has(name) ? { value: context.jar.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      context.jar.set(name, value); context.updates.set(name, { value, options });
    },
  };
} }));
vi.mock('@/lib/runtime', () => ({ database: () => state.db }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: vi.fn(), normalizedEmail: (value: string) => value.trim().toLowerCase() }));
vi.mock('@/lib/password-recovery-rate-limit', () => ({ enforcePasswordRecoveryRateLimit: vi.fn() }));
vi.mock('@/lib/founder-access', () => ({ registerAccessIdentity: vi.fn() }));
vi.mock('@/lib/automation/founder-access', () => ({ attachAutomationAccess: vi.fn() }));
vi.mock('@/lib/supabase-auth-runtime', () => ({
  supabaseAuthClient: () => state.client, optionalSupabaseAuthClient: () => state.client,
  supabaseAuthSiteOrigin: () => 'https://zentra.example',
}));

import { createSupabaseAuthClient as createClient } from './supabase-auth';
import { accountSessionAllowed, revokeAccountSessions } from './account-session-policy';
import { GET as session } from '@/app/api/auth/session/route';
import { POST as signIn } from '@/app/api/auth/connexion/route';
import { PUT as recoverPassword } from '@/app/api/auth/mot-de-passe/route';
import { PUT as profile } from '@/app/api/account/profile/route';
import { SUPABASE_ACCESS_COOKIE, SUPABASE_REFRESH_COOKIE, SUPABASE_RECOVERY_COOKIE } from './supabase-auth-cookie-policy';

const now = 1_800_000_000;
let db: DatabaseSync;
let browser: Map<string, string>;
let issued: Map<string, { id: string; email: string }>;
let sequence: number;
let grantIat: number;
let refreshMode: 'new' | 'same' | 'wrong-user' | 'wrong-email' | 'unconfirmed' | 'unavailable';
let passwordSession: ReturnType<typeof payload>;
let calls: { operation: string; refreshToken?: string }[];
let policyReads: number;

function prepare(query: string) {
  let args: SQLInputValue[] = [];
  return { bind(...values: SQLInputValue[]) { args = values; return this; },
    async first() { if (query.includes('account_session_policy')) policyReads++; return db.prepare(query).get(...args) ?? null; },
    async run() { const result = db.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
  };
}
function token(account: string, iat: number) {
  const value = `synthetic.${Buffer.from(JSON.stringify({ sub: account, iat, session_id: `session-${++sequence}` })).toString('base64url')}.unsigned-fixture`;
  issued.set(value, { id: account, email: `${account}@example.test` }); return value;
}
function payload(account: string, iat = Math.floor(Date.now() / 1000)) {
  return { access_token: token(account, iat), refresh_token: `synthetic-refresh-${++sequence}`, expires_in: 3600,
    user: { id: account, email: `${account}@example.test`, email_confirmed_at: '2026-01-01T00:00:00Z' as string | null } };
}
async function syntheticFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input));
  if (url.origin !== 'https://synthetic-auth.invalid') throw new Error('Non-synthetic network forbidden');
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const access = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  const verified = issued.get(access);
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    calls.push({ operation: 'password.signin' });
    passwordSession = payload(String(body.email).split('@')[0], grantIat);
    return Response.json(passwordSession);
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    calls.push({ operation: 'session.refresh', refreshToken: body.refresh_token });
    if (refreshMode === 'unavailable') return Response.json({ message: 'private-provider-detail', code: 'upstream_failure' }, { status: 503 });
    if (refreshMode === 'same') return Response.json(passwordSession);
    const renewed = payload(refreshMode === 'wrong-user' ? 'account-b' : passwordSession.user.id);
    if (refreshMode === 'wrong-email') renewed.user.email = 'account-b@example.test';
    if (refreshMode === 'unconfirmed') renewed.user.email_confirmed_at = null;
    return Response.json(renewed);
  }
  if (url.pathname === '/auth/v1/user' && init?.method === 'GET') {
    calls.push({ operation: 'session.verify' });
    if (!verified) return Response.json({ code: 'invalid_credentials' }, { status: 401 });
    return Response.json({ ...verified, email_confirmed_at: '2026-01-01T00:00:00Z' });
  }
  if (url.pathname === '/auth/v1/user' && init?.method === 'PUT' && verified) {
    calls.push({ operation: 'password.update' }); return Response.json({});
  }
  if (url.pathname === '/auth/v1/logout' && verified) {
    calls.push({ operation: `logout.${url.searchParams.get('scope')}` }); return Response.json({});
  }
  throw new Error('Unimplemented synthetic request');
}
function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://zentra.example${path}`, { method, headers: { origin: 'https://zentra.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(handler: (request: Request) => Promise<Response>, req: Request) {
  const context: Context = { jar: new Map(browser), updates: new Map() };
  const response = await state.context.run(context, () => handler(req));
  for (const [name, cookie] of context.updates) {
    if (cookie.options.maxAge === 0) browser.delete(name); else browser.set(name, cookie.value);
  }
  return { response, updates: context.updates };
}
const loginRequest = () => request('/api/auth/connexion', { email: 'account-a@example.test', password: 'fictional-password-123' });
const readBody = async (response: Response) => await response.json() as { authenticated?: boolean; user?: { id: string }; error?: string };
async function waitForBoundaryTimer() {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve();
    if (policyReads >= 2 && calls.some(call => call.operation === 'password.signin') && vi.getTimerCount() === 1) return;
  }
  throw new Error('Boundary timer not reached');
}
function policy(revokedAt = now, deletedAt: number | null = null) {
  db.prepare('INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)').run('account-a', revokedAt, deletedAt);
}
function expectNoAuthCookies(updates: Context['updates']) {
  expect(updates.has(SUPABASE_ACCESS_COOKIE)).toBe(false); expect(updates.has(SUPABASE_REFRESH_COOKIE)).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now * 1000 + 250);
  vi.stubGlobal('fetch', () => { throw new Error('Actual network forbidden'); });
  state.context = new AsyncLocalStorage<Context>(); browser = new Map(); issued = new Map(); sequence = 0; calls = []; policyReads = 0; grantIat = now; refreshMode = 'new';
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  state.db = { prepare, async batch(statements: Statement[]) {
    db.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  state.client = createClient({ url: 'https://synthetic-auth.invalid', publishableKey: `sb_publishable_${'fictional'.repeat(4)}` }, syntheticFetch);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Password-session admission through real routes, client and migrations', () => {
  it('publishes an immediately allowed session without refresh or boundary wait', async () => {
    const result = await call(signIn, loginRequest());
    expect(result.response.status).toBe(200); expect((await readBody(result.response)).authenticated).toBe(true);
    expect(calls.filter(call => call.operation === 'session.refresh')).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect((await readBody((await call(session, request('/api/auth/session'))).response)).authenticated).toBe(true);
  });

  it.each(['recovery', 'password', 'signout-all'])('admits a fresh same-second password login after %s only after one strict recheck', async action => {
    const old = payload('account-a', now - 1);
    if (action === 'recovery') {
      browser.set(SUPABASE_RECOVERY_COOKIE, old.access_token);
      expect((await call(recoverPassword, request('/api/auth/mot-de-passe', { expectedEmail: 'account-a@example.test', password: 'fictional-password-123' }, 'PUT'))).response.status).toBe(200);
    } else {
      grantIat = now - 1;
      expect((await call(signIn, loginRequest())).response.status).toBe(200);
      grantIat = now;
      browser.set(SUPABASE_ACCESS_COOKIE, old.access_token); browser.set(SUPABASE_REFRESH_COOKIE, old.refresh_token);
      expect((await call(profile, request('/api/account/profile', { expectedUserId: 'account-a', action, currentPassword: 'fictional-password-123', password: 'fictional-new-password-123' }, 'PUT'))).response.status).toBe(200);
    }
    calls = []; policyReads = 0;
    let settled = false;
    const pending = call(signIn, loginRequest()).then(result => { settled = true; return result; });
    await waitForBoundaryTimer();
    expect(settled).toBe(false); expect(browser.has(SUPABASE_ACCESS_COOKIE)).toBe(false);
    await vi.advanceTimersByTimeAsync(749); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.response.status).toBe(200); expect((await readBody(result.response)).authenticated).toBe(true);
    expect(calls.filter(call => call.operation === 'password.signin')).toHaveLength(1);
    expect(calls.filter(call => call.operation === 'session.refresh')).toEqual([{ operation: 'session.refresh', refreshToken: passwordSession.refresh_token }]);
    expect(await accountSessionAllowed('account-a', old.access_token)).toBe(false);
    expect(await accountSessionAllowed('account-a', token('account-a', now))).toBe(false);
    expect(await accountSessionAllowed('account-a', browser.get(SUPABASE_ACCESS_COOKIE)!)).toBe(true);
    expect((await readBody((await call(session, request('/api/auth/session'))).response)).user?.id).toBe('account-a');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['same', 'wrong-user', 'wrong-email', 'unconfirmed', 'unavailable'] as const)('fails honestly without auth cookies or retries when refresh is %s', async mode => {
    policy(); refreshMode = mode;
    const pending = call(signIn, loginRequest()); await waitForBoundaryTimer(); await vi.advanceTimersByTimeAsync(750);
    const result = await pending;
    expect(result.response.status).toBe(mode === 'unavailable' ? 502 : 409);
    const body = await readBody(result.response); expect(body.authenticated).toBeUndefined(); expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('private-provider-detail');
    expectNoAuthCookies(result.updates); expect(calls.filter(call => call.operation === 'session.refresh')).toHaveLength(1);
    expect(calls.some(call => call.operation.startsWith('logout.'))).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deleted', 'future', 'older-iat'])('does not wait or refresh a refused %s session', async reason => {
    policy(reason === 'future' ? now + 10 : now, reason === 'deleted' ? now : null);
    if (reason === 'older-iat') grantIat = now - 1;
    const result = await call(signIn, loginRequest());
    expect(result.response.status).toBe(409); expectNoAuthCookies(result.updates);
    expect(calls.filter(call => call.operation === 'session.refresh')).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['revoked-again', 'deleted-during-wait'])('rechecks a changed policy after the boundary (%s)', async reason => {
    policy(); const pending = call(signIn, loginRequest()); await waitForBoundaryTimer();
    db.prepare('UPDATE account_session_policy SET revoked_before=?,deleted_at=? WHERE user_id=?').run(now + 1, reason === 'deleted-during-wait' ? now + 1 : null, 'account-a');
    await vi.advanceTimersByTimeAsync(750); const result = await pending;
    expect(result.response.status).toBe(409); expectNoAuthCookies(result.updates);
    expect(calls.filter(call => call.operation === 'session.refresh')).toHaveLength(1);
  });

  it('never promotes old cookies and refreshes only this request’s password-grant session', async () => {
    grantIat = now - 1;
    expect((await call(signIn, loginRequest())).response.status).toBe(200);
    const old = passwordSession; grantIat = now; policy();
    browser.set(SUPABASE_ACCESS_COOKIE, old.access_token); browser.set(SUPABASE_REFRESH_COOKIE, old.refresh_token);
    const refused = await call(session, request('/api/auth/session'));
    expect(await refused.response.json()).toEqual({ authenticated: false });
    expect(calls.filter(call => call.operation === 'session.refresh')).toHaveLength(0);
    const pending = call(signIn, loginRequest()); await waitForBoundaryTimer(); await vi.advanceTimersByTimeAsync(750);
    expect((await pending).response.status).toBe(200);
    const refreshes = calls.filter(call => call.operation === 'session.refresh');
    expect(refreshes).toEqual([{ operation: 'session.refresh', refreshToken: passwordSession.refresh_token }]);
    expect(refreshes[0].refreshToken).not.toBe(old.refresh_token);
  });
});
