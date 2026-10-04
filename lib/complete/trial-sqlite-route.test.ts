import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  db: null as unknown,
  user: vi.fn(),
  actor: vi.fn(),
  journey: vi.fn(),
  skip: vi.fn(),
  quote: vi.fn(),
  change: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (name: string) => name === 'PUBLIC_SITE_URL' ? 'https://zentraapp.ch' : '',
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: state.user }));
vi.mock('@/lib/automation/access', () => ({ automationActor: state.actor }));
vi.mock('@/lib/complete/journey', () => ({ subscriptionJourney: state.journey, skipJourneyStep: state.skip }));
vi.mock('@/lib/complete/change', () => ({ quotePlanChange: state.quote, changePlan: state.change }));

import { POST as completeTrial } from '@/app/api/complete/trial/route';
import { POST as gestionTrial } from '@/app/api/account/trial/route';
import { POST as subscriptionChange } from '@/app/api/account/subscription/route';
import { startAccountTrial } from '@/lib/account-trial';
import { COMPLETE_TERMS_VERSION } from './plans';
import { COMPLETE_TRIAL_ANALYSES } from './trial';
import { LEGAL_VERSION } from '@/lib/legal';

const user = {
  userId: 'sqlite-trial-owner',
  email: 'sqlite-owner@example.test',
  displayName: 'Synthetic owner',
  emailConfirmed: true,
  provider: 'supabase',
};
const actor = { userId: user.userId, organizationId: 'synthetic-company', role: 'owner' };
let db: DatabaseSync;
let sqlFailures: string[];
const request = (path = '/api/complete/trial', changes: Record<string, unknown> = {}) =>
  new Request(`https://zentraapp.ch${path}`, {
    method: 'POST',
    headers: { origin: 'https://zentraapp.ch', 'content-type': 'application/json' },
    body: JSON.stringify({ companyName: 'Synthetic SME', acceptTerms: true, legalVersion: COMPLETE_TERMS_VERSION, ...changes }),
  });
function statement(query: string) {
  let args: SQLInputValue[] = [];
  const execute = () => {
    try {
      const meta = db.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(meta.changes) } };
    } catch (error) {
      sqlFailures.push((error as Error).message);
      throw error;
    }
  };
  return {
    bind(...values: SQLInputValue[]) { args = values; return this; },
    async first() { return db.prepare(query).get(...args) ?? null; },
    async all() { return { results: db.prepare(query).all(...args) }; },
    async run() { return execute(); },
    execute,
  };
}
function count(table: string) {
  const allowed = new Set(['account_trials', 'complete_trials', 'subscriptions', 'organizations', 'organization_members', 'support_workspaces', 'support_gestion_links', 'legal_acceptances']);
  if (!allowed.has(table)) throw new Error('Unexpected synthetic table');
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
beforeEach(() => {
  vi.resetAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = process.env.ZENTRA_TEST_MIGRATIONS || fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrations, file), 'utf8'));
  }
  sqlFailures = [];
  state.db = {
    prepare: statement,
    async batch(statements: ReturnType<typeof statement>[]) {
      db.exec('BEGIN');
      try {
        const result = statements.map(item => item.execute());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  state.user.mockResolvedValue(user);
  state.actor.mockResolvedValue(actor);
  state.change.mockResolvedValue({ state: 'scheduled', operationId: 'synthetic-operation' });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe('Complete trial routes with exact real SQLite migrations', () => {
  it('starts a confirmed ordinary account trial and records complete terms in the real schema', async () => {
    const response = await completeTrial(request());
    expect(response.status, JSON.stringify(sqlFailures)).toBe(200);
    const body = await response.json() as { created: boolean; organizationId: string; endsAt: number };
    expect(body.created).toBe(true);
    for (const table of ['account_trials', 'complete_trials', 'subscriptions', 'organizations', 'organization_members', 'support_workspaces', 'support_gestion_links', 'legal_acceptances']) expect(count(table), table).toBe(1);
    const trial = db.prepare('SELECT * FROM account_trials').get()!;
    expect(Number(trial.ends_at) - Number(trial.started_at)).toBe(14 * 86400);
    expect(body.organizationId).toBe(trial.organization_id);
    expect(body.endsAt).toBe(trial.ends_at);
    expect(db.prepare('SELECT seat_limit,status FROM subscriptions').get()).toMatchObject({ seat_limit: 3, status: 'trialing' });
    expect(db.prepare('SELECT analyses FROM complete_trials').get()).toMatchObject({ analyses: COMPLETE_TRIAL_ANALYSES });
    expect(db.prepare('SELECT * FROM legal_acceptances').get()).toMatchObject({
      user_id: user.userId, document_version: COMPLETE_TERMS_VERSION, context: 'complete_trial', plan_id: 'team', origin: 'https://zentraapp.ch',
      checkout_session_id: `complete_trial_${trial.subscription_id}`,
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('retries without restarting the end, replacing the company or duplicating the acceptance', async () => {
    const initial = await completeTrial(request());
    expect(initial.status, JSON.stringify(sqlFailures)).toBe(200);
    const before = db.prepare('SELECT * FROM account_trials').get();
    const receipt = db.prepare('SELECT * FROM legal_acceptances').get();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600 * 1000);
    const repeated = await completeTrial(request(undefined, { companyName: 'Do not rename existing company' }));
    expect(repeated.status, JSON.stringify(sqlFailures)).toBe(200);
    expect(db.prepare('SELECT * FROM account_trials').get()).toEqual(before);
    expect(db.prepare('SELECT * FROM legal_acceptances').get()).toEqual(receipt);
    expect(db.prepare('SELECT name FROM organizations').get()).toMatchObject({ name: 'Synthetic SME' });
    for (const table of ['organizations', 'subscriptions', 'support_workspaces', 'support_gestion_links', 'legal_acceptances']) expect(count(table), table).toBe(1);
  });

  it('recovers a company already created by the previous failed request without extending its trial', async () => {
    const existing = await startAccountTrial(user, 'Existing synthetic SME', true);
    const before = db.prepare('SELECT * FROM account_trials').get();
    expect(count('legal_acceptances')).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1800 * 1000);
    const response = await completeTrial(request(undefined, { companyName: '' }));
    expect(response.status, JSON.stringify(sqlFailures)).toBe(200);
    expect(await response.json()).toMatchObject({ organizationId: existing.organization_id, endsAt: existing.ends_at });
    expect(db.prepare('SELECT * FROM account_trials').get()).toEqual(before);
    expect(count('legal_acceptances')).toBe(1);
    expect(count('organizations')).toBe(1);
    expect(db.prepare('SELECT name FROM organizations').get()).toMatchObject({ name: 'Existing synthetic SME' });
    expect((await completeTrial(request())).status).toBe(200);
    expect(count('legal_acceptances')).toBe(1);
  });

  it('keeps Gestion acceptance when upgrading the same 14-day trial to complete terms', async () => {
    const original = await gestionTrial(request('/api/account/trial', { legalVersion: LEGAL_VERSION }));
    expect(original.status, JSON.stringify(sqlFailures)).toBe(200);
    const existing = db.prepare('SELECT * FROM account_trials').get();
    const gestionReceipt = db.prepare("SELECT * FROM legal_acceptances WHERE context='gestion_trial'").get();
    expect(count('complete_trials')).toBe(0);
    const upgraded = await completeTrial(request());
    expect(upgraded.status, JSON.stringify(sqlFailures)).toBe(200);
    expect(db.prepare('SELECT * FROM account_trials').get()).toEqual(existing);
    expect(db.prepare("SELECT * FROM legal_acceptances WHERE context='gestion_trial'").get()).toEqual(gestionReceipt);
    expect(count('legal_acceptances')).toBe(2);
    expect(count('organizations')).toBe(1);
    expect(count('complete_trials')).toBe(1);
    expect(db.prepare('SELECT seat_limit FROM subscriptions').get()).toMatchObject({ seat_limit: 3 });
    expect((await completeTrial(request())).status).toBe(200);
    expect(count('legal_acceptances')).toBe(2);
  });

  it('rejects missing current complete terms before creating any entitlement', async () => {
    const response = await completeTrial(request(undefined, { acceptTerms: false }));
    expect(response.status).toBe(400);
    expect(count('account_trials')).toBe(0);
    expect(count('organizations')).toBe(0);
    expect(count('legal_acceptances')).toBe(0);
  });

  it('retains authentication and rate boundaries around trial creation', async () => {
    state.user.mockResolvedValue({ ...user, emailConfirmed: false });
    expect((await completeTrial(request())).status).toBe(401);
    expect(count('organizations')).toBe(0);
    state.user.mockResolvedValue(user);
    for (let attempt = 0; attempt < 5; attempt++) await completeTrial(request());
    expect((await completeTrial(request())).status).toBe(429);
    expect(count('account_trials')).toBe(1);
    expect(count('organizations')).toBe(1);
  });
});

describe('Complete plan change acceptance with exact real SQLite migrations', () => {
  const changeRequest = () => request('/api/account/subscription', { action: 'change', organizationId: actor.organizationId, plan: 'team', fingerprint: 'synthetic-fingerprint' });

  it('records a complete change receipt without a missing required checkout field', async () => {
    const response = await subscriptionChange(changeRequest());
    expect(response.status, JSON.stringify(sqlFailures)).toBe(200);
    expect(state.change).toHaveBeenCalledWith(user.userId, actor.organizationId, 'team', 'synthetic-fingerprint');
    const receipt = db.prepare('SELECT * FROM legal_acceptances').get()!;
    expect(receipt).toMatchObject({ user_id: user.userId, document_version: COMPLETE_TERMS_VERSION, context: 'complete_change', plan_id: 'team' });
    expect(receipt.checkout_session_id).toBe(`complete_change_${receipt.acceptance_id}`);
  });

  it('keeps separate acceptance records for distinct explicit change requests', async () => {
    expect((await subscriptionChange(changeRequest())).status, JSON.stringify(sqlFailures)).toBe(200);
    expect((await subscriptionChange(changeRequest())).status, JSON.stringify(sqlFailures)).toBe(200);
    expect(count('legal_acceptances')).toBe(2);
    const rows = db.prepare('SELECT acceptance_id,checkout_session_id FROM legal_acceptances').all();
    expect(new Set(rows.map(row => row.checkout_session_id)).size).toBe(2);
  });

  it.each([{ ...actor, device: true }, { ...actor, role: 'member' }])('refuses a native or non-owner actor before billing receipt (%j)', async deniedActor => {
    state.actor.mockResolvedValue(deniedActor);
    expect((await subscriptionChange(changeRequest())).status).toBe(403);
    expect(count('legal_acceptances')).toBe(0);
    expect(state.change).not.toHaveBeenCalled();
  });
});
