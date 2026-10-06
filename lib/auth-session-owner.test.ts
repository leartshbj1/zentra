import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { createSupabaseAuthClient } from './supabase-auth';

type Cookie = { value: string; options: Record<string, unknown> };
type Context = { jar: Map<string, string>; updates: Map<string, Cookie>; writes: { name: string; cookie: Cookie }[] };
const state = vi.hoisted(() => ({
  db: null as unknown as { prepare: typeof prepare; batch: (statements: ReturnType<typeof prepare>[]) => Promise<unknown> },
  client: null as unknown as ReturnType<typeof createSupabaseAuthClient>,
  context: null as unknown as AsyncLocalStorage<Context>,
}));
vi.mock('next/headers', () => ({ cookies: async () => {
  const context = state.context.getStore();
  if (!context) throw new Error('Missing synthetic request context');
  return { get: (name: string) => context.jar.has(name) ? { value: context.jar.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      const cookie = { value, options };
      context.jar.set(name, value); context.updates.set(name, cookie); context.writes.push({ name, cookie });
    } };
} }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/runtime', () => ({ database: () => state.db }));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: vi.fn() }));
vi.mock('@/lib/founder-access', () => ({ registerAccessIdentity: vi.fn() }));
vi.mock('@/lib/automation/founder-access', () => ({ attachAutomationAccess: vi.fn() }));
vi.mock('@/lib/supabase-auth-runtime', () => ({
  supabaseAuthClient: () => state.client, optionalSupabaseAuthClient: () => state.client,
}));

import { createSupabaseAuthClient as createClient } from './supabase-auth';
import { GET as session } from '@/app/api/auth/session/route';
import { POST as login } from '@/app/api/auth/connexion/route';
import { GET as confirmation } from '@/app/api/auth/confirmation/route';
import { POST as logout } from '@/app/api/auth/deconnexion/route';
import { getZentraUser } from '@/app/zentra-auth';
import { registerAccessIdentity } from './founder-access';
import { attachAutomationAccess } from './automation/founder-access';
import { writeSupabasePkceCookie } from './supabase-auth-cookies';
import {
  SUPABASE_ACCESS_COOKIE, SUPABASE_REFRESH_COOKIE, SUPABASE_SESSION_OWNER_COOKIE,
  SUPABASE_SIGNED_OUT_COOKIE, SESSION_OWNER_COOKIE_MAX_AGE,
} from './supabase-auth-cookie-policy';

const now = 1_800_000_000;
let db: DatabaseSync;
let browser: Map<string, string>;
let expires: Map<string, number>;
let issued: Map<string, { id: string; email: string }>;
let refreshOwners: Map<string, string>;
let sequence: number;
let calls: { operation: string; account?: string }[];
let holdNextRefresh: boolean;
let rejectNextRefresh: boolean;
let refreshStarted: Promise<void>;
let signalRefreshStarted: () => void;
let releaseRefresh: () => void;

function prepare(query: string) {
  let args: SQLInputValue[] = [];
  return { bind(...values: SQLInputValue[]) { args = values; return this; },
    async first() { return db.prepare(query).get(...args) ?? null; },
    async run() { const result = db.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
  };
}
function payload(account: string) {
  const access = `synthetic.${Buffer.from(JSON.stringify({ sub: account, iat: Math.floor(Date.now() / 1000), session_id: `session-${++sequence}` })).toString('base64url')}.fixture`;
  const refresh = `synthetic-refresh-${++sequence}`;
  issued.set(access, { id: account, email: `${account}@example.test` }); refreshOwners.set(refresh, account);
  return { access_token: access, refresh_token: refresh, expires_in: 3600,
    user: { id: account, email: `${account}@example.test`, email_confirmed_at: '2026-01-01T00:00:00Z' } };
}
async function syntheticFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://synthetic-auth.invalid') throw new Error('Non-synthetic network forbidden');
  const rawBody = init?.body;
  if (rawBody && typeof rawBody !== 'string') throw new Error('Synthetic request body must be JSON text');
  const body = typeof rawBody === 'string' && rawBody ? JSON.parse(rawBody) : {};
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  const user = issued.get(token);
  if (url.pathname === '/auth/v1/user') {
    calls.push({ operation: 'verify', account: user?.id });
    return user ? Response.json({ ...user, email_confirmed_at: '2026-01-01T00:00:00Z' }) : Response.json({ code: 'invalid_credentials' }, { status: 401 });
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const account = String(body.email).split('@')[0]; calls.push({ operation: 'password', account }); return Response.json(payload(account));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
    calls.push({ operation: 'pkce', account: 'account-b' }); return Response.json(payload('account-b'));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const account = refreshOwners.get(body.refresh_token); calls.push({ operation: 'refresh', account });
    const rejected = rejectNextRefresh; rejectNextRefresh = false;
    // Determine the result from this refresh token BEFORE another request signs in.
    const response = account && !rejected ? Response.json(payload(account)) : Response.json({ code: 'invalid_credentials' }, { status: 401 });
    if (holdNextRefresh) { holdNextRefresh = false; signalRefreshStarted(); await new Promise<void>(resolve => { releaseRefresh = resolve; }); }
    return response;
  }
  if (url.pathname === '/auth/v1/logout') { calls.push({ operation: 'logout', account: user?.id }); return Response.json({}); }
  throw new Error('Unimplemented synthetic request');
}
function request(path: string, body?: unknown) {
  return new Request('https://zentra.example' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'https://zentra.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function purgeExpiredCookies() {
  for (const [name, time] of expires) if (time <= Date.now()) { browser.delete(name); expires.delete(name); }
}
function newContext(): Context { purgeExpiredCookies(); return { jar: new Map(browser), updates: new Map(), writes: [] }; }
async function call(handler: (request: Request) => Promise<Response>, req: Request) {
  const context = newContext();
  const response = await state.context.run(context, () => handler(req));
  // Request snapshots stay independent; the browser applies response cookies in arrival order.
  for (const [name, cookie] of context.updates) {
    if (cookie.options.maxAge === 0) { browser.delete(name); expires.delete(name); }
    else { browser.set(name, cookie.value); expires.set(name, Date.now() + Number(cookie.options.maxAge) * 1000); }
  }
  return { response, context };
}
async function protectedRead(refreshSession = true) {
  const context = newContext();
  const user = await state.context.run(context, () => getZentraUser({ refreshSession }));
  return { user, context };
}
const loginRequest = (account = 'account-a') => request('/api/auth/connexion', { email: `${account}@example.test`, password: 'fictional-password-123' });
const sessionRequest = () => request('/api/auth/session');
function expectNoOwnerWrite(context: Context) { expect(context.writes.some(write => write.name === SUPABASE_SESSION_OWNER_COOKIE)).toBe(false); }
function expectNoOfferedAccess() { expect(registerAccessIdentity).not.toHaveBeenCalled(); expect(attachAutomationAccess).not.toHaveBeenCalled(); }
function resetOfferedAccess() { vi.mocked(registerAccessIdentity).mockClear(); vi.mocked(attachAutomationAccess).mockClear(); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now * 1000);
  vi.stubGlobal('fetch', () => { throw new Error('Actual network forbidden'); });
  state.context = new AsyncLocalStorage<Context>(); browser = new Map(); expires = new Map(); issued = new Map(); refreshOwners = new Map(); sequence = 0; calls = [];
  holdNextRefresh = false; rejectNextRefresh = false; refreshStarted = new Promise(resolve => { signalRefreshStarted = resolve; }); releaseRefresh = () => {};
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  state.db = { prepare, async batch(statements) {
    db.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  state.client = createClient({ url: 'https://synthetic-auth.invalid', publishableKey: `sb_publishable_${'fictional'.repeat(4)}` }, syntheticFetch);
  resetOfferedAccess();
});
afterEach(() => { releaseRefresh(); db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Session owner binding with real auth routes, provider client and migrated SQLite', () => {
  it.each([false, true])('verifies a read-only identity without offered grants, with expired access=%s', async expired => {
    await call(login, loginRequest());
    if (expired) issued.delete(browser.get(SUPABASE_ACCESS_COOKIE)!);
    resetOfferedAccess(); calls = [];
    const context = newContext();
    const identity = await state.context.run(context, () => getZentraUser({ refreshSession: true, offerAccess: false }));
    expect(identity?.userId).toBe('account-a');
    expect(calls.some(call => call.operation === 'verify')).toBe(true);
    expect(calls.some(call => call.operation === 'refresh')).toBe(expired);
    expectNoOfferedAccess(); expectNoOwnerWrite(context);
    if (!expired) expect(context.writes).toEqual([]);
  });

  it('preserves offered access on existing default authentication callers', async () => {
    await call(login, loginRequest()); resetOfferedAccess();
    expect((await protectedRead()).user?.userId).toBe('account-a');
    expect(registerAccessIdentity).toHaveBeenCalledOnce(); expect(attachAutomationAccess).toHaveBeenCalledOnce();
  });

  it('creates a fixed secure owner only for an explicit password authentication', async () => {
    const { response, context } = await call(login, loginRequest());
    expect(response.status).toBe(200); expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-a');
    expect(context.updates.get(SUPABASE_SESSION_OWNER_COOKIE)?.options).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
    expect(SESSION_OWNER_COOKIE_MAX_AGE).toBe(30 * 24 * 60 * 60);
    expect((await protectedRead()).user?.userId).toBe('account-a');
  });

  it('creates the owner for the provider-verified PKCE callback', async () => {
    const context = newContext(); await state.context.run(context, () => writeSupabasePkceCookie('v'.repeat(64), '/compte'));
    for (const [name, cookie] of context.updates) browser.set(name, cookie.value);
    const result = await call(confirmation, request('/api/auth/confirmation?code=valid-code-for-testing-12345'));
    expect(result.response.status).toBe(303); expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-b');
    expect((await protectedRead()).user?.userId).toBe('account-b');
  });

  it('rejects tokens-only legacy cookies without silent refresh or offered access', async () => {
    const old = payload('account-a'); browser.set(SUPABASE_ACCESS_COOKIE, old.access_token); browser.set(SUPABASE_REFRESH_COOKIE, old.refresh_token);
    expect((await protectedRead()).user).toBeNull();
    const result = await call(session, sessionRequest()); expect(await result.response.json()).toEqual({ authenticated: false });
    expect(result.context.writes).toEqual([]); expect(calls).toEqual([]); expectNoOfferedAccess();
  });

  it('never treats an owner-only cookie as authorization', async () => {
    await call(login, loginRequest()); browser.delete(SUPABASE_ACCESS_COOKIE); browser.delete(SUPABASE_REFRESH_COOKIE); calls = [];
    expect((await protectedRead()).user).toBeNull(); expect(await (await call(session, sessionRequest())).response.json()).toEqual({ authenticated: false });
    expect(calls).toEqual([]); expectNoOfferedAccess();
  });

  it.each(['missing', 'bad owner', 'x'.repeat(129)])('requires explicit login for a missing/malformed binding (%s)', async owner => {
    await call(login, loginRequest());
    if (owner === 'missing') browser.delete(SUPABASE_SESSION_OWNER_COOKIE); else browser.set(SUPABASE_SESSION_OWNER_COOKIE, owner);
    calls = []; expect((await protectedRead()).user).toBeNull();
    expect(await (await call(session, sessionRequest())).response.json()).toEqual({ authenticated: false });
    expect(calls).toEqual([]); expectNoOfferedAccess();
  });

  it('does not renew the fixed 30-day owner even while access and refresh tokens roll', async () => {
    await call(login, loginRequest()); const deadline = expires.get(SUPABASE_SESSION_OWNER_COOKIE)!;
    vi.setSystemTime(deadline - 1000); const refreshed = await call(session, sessionRequest());
    expect(refreshed.response.status).toBe(200); expectNoOwnerWrite(refreshed.context); expect(expires.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe(deadline);
    vi.setSystemTime(deadline + 1); resetOfferedAccess(); calls = [];
    expect(browser.has(SUPABASE_ACCESS_COOKIE)).toBe(true); expect(browser.has(SUPABASE_REFRESH_COOKIE)).toBe(true);
    expect((await protectedRead()).user).toBeNull(); expect(await (await call(session, sessionRequest())).response.json()).toEqual({ authenticated: false });
    expect(calls).toEqual([]); expectNoOfferedAccess();
    expect((await call(login, loginRequest())).response.status).toBe(200);
    expect((await protectedRead()).user?.userId).toBe('account-a'); expect(expires.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe(Date.now() + SESSION_OWNER_COOKIE_MAX_AGE * 1000);
  });

  it.each(['protected', 'session'])('refuses a different verified access identity before offered access (%s)', async route => {
    await call(login, loginRequest()); const aToken = browser.get(SUPABASE_ACCESS_COOKIE)!;
    await call(login, loginRequest('account-b')); browser.set(SUPABASE_ACCESS_COOKIE, aToken); resetOfferedAccess();
    if (route === 'protected') expect((await protectedRead()).user).toBeNull();
    else { const result = await call(session, sessionRequest()); expect(await result.response.json()).toEqual({ authenticated: false }); expectNoOwnerWrite(result.context); }
    expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-b'); expectNoOfferedAccess();
  });

  it.each(['protected', 'session'])('refuses a different refresh identity before publishing cookies (%s)', async route => {
    await call(login, loginRequest()); const aRefresh = browser.get(SUPABASE_REFRESH_COOKIE)!;
    await call(login, loginRequest('account-b')); browser.delete(SUPABASE_ACCESS_COOKIE); browser.set(SUPABASE_REFRESH_COOKIE, aRefresh); resetOfferedAccess();
    let context: Context;
    if (route === 'protected') { const result = await protectedRead(); expect(result.user).toBeNull(); context = result.context; }
    else { const result = await call(session, sessionRequest()); expect(await result.response.json()).toEqual({ authenticated: false }); context = result.context; }
    expect(context.writes.filter(write => write.name === SUPABASE_ACCESS_COOKIE && Number(write.cookie.options.maxAge) > 0)).toEqual([]);
    expectNoOwnerWrite(context); expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-b'); expectNoOfferedAccess();
  });

  it.each(['revoked', 'deleted'])('keeps strict session policy authoritative despite a coherent owner (%s)', async policy => {
    await call(login, loginRequest());
    db.prepare('INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)').run('account-a', now, policy === 'deleted' ? now : null);
    resetOfferedAccess(); expect((await protectedRead()).user).toBeNull();
    const result = await call(session, sessionRequest()); expect(await result.response.json()).toEqual({ authenticated: false }); expectNoOwnerWrite(result.context); expectNoOfferedAccess();
  });

  it.each(['protected', 'session'])('checks strict policy before any refresh-cookie write (%s)', async route => {
    await call(login, loginRequest()); issued.delete(browser.get(SUPABASE_ACCESS_COOKIE)!);
    db.prepare('INSERT INTO account_session_policy(user_id,revoked_before) VALUES(?,?)').run('account-a', now);
    const result = route === 'protected' ? await protectedRead() : await call(session, sessionRequest());
    if ('user' in result) expect(result.user).toBeNull(); else expect(await result.response.json()).toEqual({ authenticated: false });
    expect(result.context.writes.filter(write => write.name === SUPABASE_ACCESS_COOKIE && Number(write.cookie.options.maxAge) > 0)).toEqual([]);
    expectNoOwnerWrite(result.context); expectNoOfferedAccess();
  });

  it.each(['password', 'callback'])('never admits A after an explicit B %s and a late A refresh', async action => {
    await call(login, loginRequest()); issued.delete(browser.get(SUPABASE_ACCESS_COOKIE)!); holdNextRefresh = true;
    const pendingA = call(session, sessionRequest()); await refreshStarted;
    if (action === 'password') expect((await call(login, loginRequest('account-b'))).response.status).toBe(200);
    else {
      const context = newContext(); await state.context.run(context, () => writeSupabasePkceCookie('v'.repeat(64), '/compte'));
      for (const [name, cookie] of context.updates) browser.set(name, cookie.value);
      expect((await call(confirmation, request('/api/auth/confirmation?code=valid-code-for-testing-12345'))).response.status).toBe(303);
    }
    const bOwnerDeadline = expires.get(SUPABASE_SESSION_OWNER_COOKIE)!; expect((await protectedRead()).user?.userId).toBe('account-b');
    releaseRefresh(); const late = await pendingA; expectNoOwnerWrite(late.context);
    expect(issued.get(browser.get(SUPABASE_ACCESS_COOKIE)!)?.id).toBe('account-a'); // Preserve the actual stale-cookie reproduction.
    resetOfferedAccess(); expect((await protectedRead()).user).toBeNull();
    const refused = await call(session, sessionRequest()); expect(await refused.response.json()).toEqual({ authenticated: false }); expectNoOwnerWrite(refused.context);
    expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-b'); expect(expires.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe(bOwnerDeadline); expectNoOfferedAccess();
    expect((await call(login, loginRequest('account-b'))).response.status).toBe(200); expect((await protectedRead()).user?.userId).toBe('account-b');
  });

  it('never lets a late automatic clear erase the B barrier', async () => {
    await call(login, loginRequest()); issued.delete(browser.get(SUPABASE_ACCESS_COOKIE)!); holdNextRefresh = true; rejectNextRefresh = true;
    const pendingA = call(session, sessionRequest()); await refreshStarted;
    await call(login, loginRequest('account-b')); const deadline = expires.get(SUPABASE_SESSION_OWNER_COOKIE);
    releaseRefresh(); const cleared = await pendingA; expectNoOwnerWrite(cleared.context);
    expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-b'); expect(expires.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe(deadline);
    expect((await protectedRead()).user).toBeNull(); expectNoOfferedAccess();
  });

  it('keeps signed-out refusal ahead of an owner and a late refresh', async () => {
    await call(login, loginRequest()); issued.delete(browser.get(SUPABASE_ACCESS_COOKIE)!); holdNextRefresh = true;
    const pending = call(session, sessionRequest()); await refreshStarted;
    const signedOut = await call(logout, request('/api/auth/deconnexion', {})); expectNoOwnerWrite(signedOut.context);
    releaseRefresh(); const late = await pending; expectNoOwnerWrite(late.context);
    expect(browser.get(SUPABASE_SIGNED_OUT_COOKIE)).toBe('1'); expect(browser.get(SUPABASE_SESSION_OWNER_COOKIE)).toBe('account-a');
    resetOfferedAccess(); expect((await protectedRead()).user).toBeNull(); expect(await (await call(session, sessionRequest())).response.json()).toEqual({ authenticated: false }); expectNoOfferedAccess();
  });
});
