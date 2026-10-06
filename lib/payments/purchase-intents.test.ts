import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  D1PurchaseIntents,
  type PurchaseInput,
  type PurchaseIntent,
} from './purchase-intents';
import { D1PrepaidPeriods } from './prepaid-periods';

let sql: DatabaseSync, clock: number;
let beforeBatch: (() => void) | null;
type Prepared = { query: string; values: SQLInputValue[] };
function d1() {
  return {
    prepare(query: string) {
      const state: Prepared = { query, values: [] };
      const statement = Object.assign(state, {
        bind(...values: SQLInputValue[]) {
          state.values = values;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...state.values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...state.values) };
        },
        async run() {
          return {
            success: true,
            meta: sql.prepare(query).run(...state.values),
          };
        },
      });
      return statement;
    },
    async batch(statements: Prepared[]) {
      beforeBatch?.();
      beforeBatch = null;
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => ({
          success: true,
          meta: sql.prepare(statement.query).run(...statement.values),
        }));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
const store = () => new D1PurchaseIntents(d1(), () => clock);
const owner = 'synthetic-owner';
function company(id = 'company-a', user = owner) {
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit)
    VALUES(?,?,'fixture-only','incomplete',0,1,?,3)`)
    .run('trial_' + id, 'trial_' + id, clock);
  sql
    .prepare(`INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at)
    VALUES(?,'Synthetic company',?,?,?,?)`)
    .run(id, 'trial_' + id, user, clock, clock);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES(?,?,?,'synthetic@example.test','owner',?)`)
    .run('member-' + id, id, user, clock);
}
function workspace(id = 'workspace-a', user = owner) {
  sql
    .prepare(
      `INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,'Synthetic support',?,?)`,
    )
    .run(id, user, clock, clock);
}
function link(companyId = 'company-a', workspaceId = 'workspace-a') {
  sql
    .prepare(
      `INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?)`,
    )
    .run(workspaceId, companyId, owner, clock);
}
const input = (patch: Partial<PurchaseInput> = {}): PurchaseInput => ({
  ownerId: owner,
  environment: 'PRODUCTION',
  provider: 'stripe',
  providerScope: 'acct_synthetic',
  product: 'gestion',
  organizationId: 'company-a',
  workspaceId: null,
  planId: 'start',
  parameters: {
    priceChfMinor: 6900,
    currency: 'CHF',
    seats: 3,
    requestKey: 'synthetic-request-1',
  },
  terms: {
    version: '2026-09-14',
    consentVersion: null,
    origin: 'https://zentraapp.ch',
  },
  ...patch,
});
function count(table = 'purchase_intents') {
  return sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}
function footprints(intent: PurchaseIntent) {
  return sql
    .prepare(
      'SELECT * FROM purchase_intent_footprints WHERE intent_id=? ORDER BY scope_kind,scope_id,entitlement',
    )
    .all(intent.intentId);
}
function pendingChange(companyId = 'company-a', live = true) {
  sql
    .prepare(`INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at)
    VALUES(?,?,?,'sub_synthetic','team',?,'preparing',?,?,?)`)
    .run(
      companyId,
      'operation-' + companyId,
      owner,
      clock + 5000,
      JSON.stringify({ live }),
      clock,
      clock,
    );
}
function paidGestion(companyId = 'company-a', live = 1, complete = false) {
  const subscriptionId = 'sub_' + companyId;
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,entitlement_valid_until,last_paid_invoice_id)
    VALUES(?,'cus_synthetic','price_synthetic','active',?,?,?,?,'in_synthetic')`)
    .run(subscriptionId, clock + 5000, live, clock, clock + 5000);
  sql
    .prepare(
      'UPDATE organizations SET subscription_id=? WHERE organization_id=?',
    )
    .run(subscriptionId, companyId);
  if (complete)
    sql
      .prepare(`INSERT INTO complete_subscriptions(subscription_id,plan_id,paid_plan_id,paid_from,paid_until,last_paid_invoice_id)
    VALUES(?,'team','team',?,?,'in_synthetic')`)
      .run(subscriptionId, clock, clock + 5000);
}
function paidSupport(live = 1) {
  sql
    .prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,last_paid_invoice_id,livemode,updated_at)
    VALUES('workspace-a','sub_support','cus_synthetic','starter','active',?,?,'starter','in_synthetic',?,?)`)
    .run(clock, clock + 5000, live, clock);
}
function paidAutomation(live = 1) {
  sql
    .prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,livemode,updated_at)
    VALUES('company-a','sub_automation','cus_synthetic','active',?,?,'in_synthetic',?,?)`)
    .run(clock, clock + 5000, live, clock);
}
async function dispatched(patch: Partial<PurchaseInput> = {}) {
  let intent = await store().reserve(input(patch));
  intent = await store().markDispatched(intent);
  return store().bindProviderReference(
    intent,
    intent.provider === 'stripe' ? 'cs_synthetic' : 'transaction:71',
  );
}
beforeEach(() => {
  clock = Math.floor(Date.now() / 1000);
  beforeBatch = null;
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sql.exec(
      readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  }
  company();
  company('company-b');
  workspace();
});
afterEach(() => sql.close());

describe('Common purchase reservations using all real SQLite migrations', () => {
  it('resumes one stable UUID and immutable acceptance across 32 exact concurrent workers', async () => {
    const intents = await Promise.all(
      Array.from({ length: 32 }, () => store().reserve(input())),
    );
    expect(new Set(intents.map((intent) => intent.intentId)).size).toBe(1);
    expect(intents[0].intentId).toMatch(
      /^purchase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(count()).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(1);
    const original = intents[0];
    clock += 1000;
    expect(await store().reserve(input())).toEqual(original);
  });
  it('canonicalizes nested parameter ordering without changing the intent', async () => {
    const first = await store().reserve(
      input({ parameters: { a: 1, b: { x: 2, y: 3 } } }),
    );
    const second = await store().reserve(
      input({ parameters: { b: { y: 3, x: 2 }, a: 1 } }),
    );
    expect(second).toEqual(first);
  });
  it('atomically admits one winner for different plans and rolls back losing histories', async () => {
    const results = await Promise.allSettled(
      ['start', 'pro', 'solo'].map((planId) =>
        store().reserve(input({ planId })),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(count()).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(1);
  });
  it('excludes cross-provider and cross-merchant duplication of the same rights', async () => {
    await store().reserve(input());
    for (const patch of [
      {
        provider: 'postfinance' as const,
        providerScope: 'https://checkout.postfinance.ch|405',
      },
      { providerScope: 'acct_other' },
    ]) {
      await expect(store().reserve(input(patch))).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    expect(count()).toBe(1);
  });
  it('allows different enterprises, distinct products and independent environments', async () => {
    const first = await store().reserve(input());
    const second = await store().reserve(
      input({ organizationId: 'company-b' }),
    );
    const automation = await store().reserve(input({ product: 'automation' }));
    const support = await store().reserve(
      input({
        product: 'support',
        organizationId: null,
        workspaceId: 'workspace-a',
      }),
    );
    const test = await store().reserve(input({ environment: 'TEST' }));
    expect(
      new Set(
        [first, second, automation, support, test].map(
          (intent) => intent.intentId,
        ),
      ).size,
    ).toBe(5);
  });
  it('normalizes linked Support to the company and freezes both footprints', async () => {
    link();
    const support = await store().reserve(
      input({
        product: 'support',
        organizationId: null,
        workspaceId: 'workspace-a',
      }),
    );
    expect(support.organizationId).toBe('company-a');
    expect(footprints(support)).toHaveLength(2);
    await expect(
      store().reserve(
        input({ product: 'complete', workspaceId: 'workspace-a' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(count()).toBe(1);
  });
  it('reserves all four Complete slots atomically and blocks standalone overlaps', async () => {
    link();
    const complete = await store().reserve(
      input({ product: 'complete', workspaceId: 'workspace-a' }),
    );
    expect(footprints(complete)).toHaveLength(4);
    for (const patch of [
      { product: 'gestion' as const },
      { product: 'automation' as const },
      { product: 'support' as const, workspaceId: 'workspace-a' },
    ]) {
      await expect(store().reserve(input(patch))).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    await expect(
      store().reserve(input({ organizationId: 'company-b' })),
    ).resolves.toBeDefined();
  });
  it('does not leave a partial Complete reservation when its last workspace slot collides', async () => {
    await store().reserve(
      input({
        product: 'support',
        organizationId: null,
        workspaceId: 'workspace-a',
      }),
    );
    await expect(
      store().reserve(
        input({ product: 'complete', workspaceId: 'workspace-a' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(count()).toBe(1);
    expect(count('purchase_intent_footprints')).toBe(1);
  });
  it.each([
    { organizationId: null },
    { organizationId: 'missing' },
    { ownerId: 'foreign' },
    { workspaceId: 'workspace-a' },
    { product: 'complete' as const, workspaceId: null },
    { product: 'support' as const, workspaceId: null },
    { product: 'complete' as const, workspaceId: 'missing' },
  ])('requires explicit existing owned targets: %j', async (patch) => {
    await expect(store().reserve(input(patch))).rejects.toThrow();
    expect(count()).toBe(0);
  });
  it('refuses a Complete workspace already linked to another company', async () => {
    link('company-b');
    await expect(
      store().reserve(
        input({ product: 'complete', workspaceId: 'workspace-a' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['gestion', 'automation', 'support', 'complete'] as const)(
    'checks active Stripe %s occupancy at the INSERT',
    async (product) => {
      link();
      if (product === 'gestion') paidGestion();
      if (product === 'automation') paidAutomation();
      if (product === 'support') paidSupport();
      if (product === 'complete') paidGestion('company-a', 1, true);
      await expect(
        store().reserve(
          input({
            product,
            workspaceId: ['support', 'complete'].includes(product)
              ? 'workspace-a'
              : null,
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(count()).toBe(0);
    },
  );
  it('does not block an independent Automation option merely because Gestion is paid', async () => {
    paidGestion();
    await expect(
      store().reserve(input({ product: 'automation' })),
    ).resolves.toBeDefined();
  });
  it('separates existing TEST subscriptions from PRODUCTION occupancy', async () => {
    paidGestion('company-a', 0);
    await expect(store().reserve(input())).resolves.toBeDefined();
    await expect(
      store().reserve(input({ environment: 'TEST' })),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects a financially occupied target that changed after the pre-read', async () => {
    beforeBatch = () => paidGestion();
    await expect(store().reserve(input())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(count()).toBe(0);
    expect(count('purchase_intent_footprints')).toBe(0);
  });
  it('blocks pending Complete changes only on intersecting targets', async () => {
    pendingChange();
    await expect(store().reserve(input())).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store().reserve(input({ organizationId: 'company-b' })),
    ).resolves.toBeDefined();
  });
  it('closes the reverse-order plan-change race while preserving unrelated companies', async () => {
    await store().reserve(input());
    expect(() => pendingChange()).toThrow('purchase_change');
    expect(() => pendingChange('company-b')).not.toThrow();
  });
  it('separates pending TEST changes from PRODUCTION reservations in both insertion orders', async () => {
    pendingChange('company-a', false);
    await expect(store().reserve(input())).resolves.toBeDefined();
    await expect(
      store().reserve(input({ environment: 'TEST' })),
    ).rejects.toMatchObject({ code: 'conflict' });
    await store().reserve(input({ organizationId: 'company-b' }));
    expect(() => pendingChange('company-b', false)).not.toThrow();
  });
  it('checks a Complete change committed immediately before the atomic batch', async () => {
    beforeBatch = () => pendingChange();
    await expect(store().reserve(input())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(count()).toBe(0);
  });
  it('revalidates owner membership and Support link at dispatch', async () => {
    const intent = await store().reserve(
      input({
        product: 'support',
        organizationId: null,
        workspaceId: 'workspace-a',
      }),
    );
    link();
    await expect(store().markDispatched(intent)).rejects.toThrow(
      'purchase_target',
    );
    expect((await store().read(intent)).state).toBe('reserved');
    await store().releaseUndispatched(intent);
    const second = await store().reserve(
      input({ parameters: { requestKey: '2' } }),
    );
    sql
      .prepare(
        "UPDATE organization_members SET role='member' WHERE organization_id='company-a'",
      )
      .run();
    await expect(store().markDispatched(second)).rejects.toThrow(
      'purchase_target',
    );
  });
  it('cannot dispatch incomplete/corrupt footprint sets', async () => {
    const intent = await store().reserve(input());
    sql.exec('DROP TRIGGER purchase_footprint_no_delete');
    sql
      .prepare('DELETE FROM purchase_intent_footprints WHERE intent_id=?')
      .run(intent.intentId);
    await expect(store().markDispatched(intent)).rejects.toThrow(
      'purchase_footprint',
    );
  });
  it('checks newly occupied rights before dispatch too', async () => {
    const intent = await store().reserve(input());
    paidGestion();
    await expect(store().markDispatched(intent)).rejects.toThrow(
      'purchase_rights',
    );
  });
  it('allows only one outcome in a concurrent dispatch/release race', async () => {
    const intent = await store().reserve(input());
    const results = await Promise.allSettled([
      store().markDispatched(intent),
      store().releaseUndispatched(intent),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const actual = await store().read(intent);
    expect(['dispatched', 'released']).toContain(actual.state);
    expect(footprints(actual)[0].released_at === null).toBe(
      actual.state === 'dispatched',
    );
  });
  it('never TTL-releases a dispatched or uncertain purchase, including after reboot', async () => {
    const intent = await dispatched();
    clock += 90000;
    const uncertain = await store().markUncertain(intent);
    await expect(store().releaseUndispatched(uncertain)).rejects.toMatchObject({
      code: 'state',
    });
    await expect(
      store().reserve(input({ provider: 'postfinance', providerScope: '405' })),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await store().reserve(input())).state).toBe('uncertain');
    expect(footprints(uncertain)[0].released_at).toBeNull();
  });
  it('records a lost outcome after the owner is revoked but blocks another dispatch', async () => {
    const intent = await dispatched();
    sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
    const uncertain = await store().markUncertain(intent);
    expect(uncertain.state).toBe('uncertain');
    await expect(store().markDispatched(uncertain)).rejects.toThrow();
    expect((await store().read(intent)).state).toBe('uncertain');
    expect(footprints(intent)[0].released_at).toBeNull();
  });
  it('records a lost outcome for a deleted account without authorizing its retry', async () => {
    const intent = await dispatched();
    sql
      .prepare(
      'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
      )
      .run(owner, clock);
    const uncertain = await store().markUncertain(intent);
    expect(uncertain.state).toBe('uncertain');
    await expect(store().markDispatched(uncertain)).rejects.toThrow();
    expect((await store().read(intent)).state).toBe('uncertain');
    expect(footprints(intent)[0].released_at).toBeNull();
  });
  it('rechecks newly occupied rights before a provider idempotency retry', async () => {
    const intent = await dispatched();
    paidGestion();
    await expect(store().markDispatched(intent)).rejects.toThrow(
      'purchase_rights',
    );
    expect((await store().read(intent)).state).toBe('dispatched');
    expect(footprints(intent)[0].released_at).toBeNull();
  });
  it('releases an undispatched expired reservation explicitly and keeps its history/replay', async () => {
    const intent = await store().reserve(input());
    clock += 90000;
    await expect(store().markDispatched(intent)).rejects.toMatchObject({
      code: 'state',
    });
    const released = await store().releaseUndispatched(intent);
    expect(await store().reserve(input())).toEqual(released);
    expect(count()).toBe(1);
    expect(footprints(released)[0].released_at).toBe(clock);
    await expect(
      store().reserve(
        input({ parameters: { requestKey: 'explicit-new-request' } }),
      ),
    ).resolves.toBeDefined();
    expect(count()).toBe(2);
    expect(count('purchase_intent_footprints')).toBe(2);
  });
  it.each([
    'ownerId',
    'environment',
    'provider',
    'providerScope',
    'intentId',
    'fingerprint',
  ] as const)('rejects every mutation with a wrong %s binding', async (key) => {
    const intent = await dispatched();
    const wrong = {
      ...intent,
      [key]:
        key === 'fingerprint'
          ? 'f'.repeat(64)
          : key === 'environment'
            ? 'TEST'
            : key === 'provider'
              ? 'postfinance'
              : 'wrong',
    };
    for (const action of [
      () => store().read(wrong as PurchaseIntent),
      () => store().markDispatched(wrong as PurchaseIntent),
      () => store().markUncertain(wrong as PurchaseIntent),
      () => store().releaseUndispatched(wrong as PurchaseIntent),
      () => store().bindProviderReference(wrong as PurchaseIntent, 'cs_other'),
      () =>
        store().finalize(wrong as PurchaseIntent, {
          providerReference: 'cs_synthetic',
          outcome: 'expired',
          evidenceFingerprint: 'a'.repeat(64),
        }),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: 'binding' });
    }
    expect((await store().read(intent)).state).toBe('dispatched');
  });
  it.each(['expired', 'canceled'] as const)(
    'releases only exactly bound verified %s outcomes and preserves terminal replay',
    async (outcome) => {
      const intent = await dispatched();
      const fact = {
        providerReference: 'cs_synthetic',
        outcome,
        evidenceFingerprint: 'b'.repeat(64),
      };
      await expect(
        store().finalize(intent, { ...fact, providerReference: 'cs_other' }),
      ).rejects.toMatchObject({ code: 'binding' });
      const final = await store().finalize(intent, fact);
      expect(await store().finalize(intent, fact)).toEqual(final);
      expect((await store().reserve(input())).state).toBe(outcome);
      expect(footprints(final)[0].released_at).toBe(clock);
      await expect(
        store().finalize(intent, {
          ...fact,
          evidenceFingerprint: 'c'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'state' });
      await expect(
        store().finalize(intent, { ...fact, outcome: 'settled' }),
      ).rejects.toMatchObject({ code: 'state' });
    },
  );
  it('settlement alone never grants rights or releases the slot before projection', async () => {
    const intent = await dispatched();
    const final = await store().finalize(intent, {
      providerReference: 'cs_synthetic',
      outcome: 'settled',
      evidenceFingerprint: 'a'.repeat(64),
    });
    expect(final.state).toBe('settled');
    expect(footprints(final)[0].released_at).toBeNull();
    expect(count('prepaid_settlement_proofs')).toBe(0);
    expect(
      sql
        .prepare(
          "SELECT entitlement_valid_until FROM subscriptions WHERE subscription_id='trial_company-a'",
        )
        .get()!.entitlement_valid_until,
    ).toBe(0);
    await expect(store().releaseUndispatched(final)).rejects.toMatchObject({
      code: 'state',
    });
    await expect(
      store().finalize(final, {
        providerReference: 'cs_synthetic',
        outcome: 'canceled',
        evidenceFingerprint: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'state' });
  });
  it('serializes contradictory concurrent verified outcomes without losing the winning evidence', async () => {
    const intent = await dispatched();
    const results = await Promise.allSettled(
      ['expired', 'settled'].map((outcome) =>
        store().finalize(intent, {
          providerReference: 'cs_synthetic',
          outcome: outcome as 'expired' | 'settled',
          evidenceFingerprint: 'a'.repeat(64),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(['expired', 'settled']).toContain(
      (await store().read(intent)).state,
    );
  });
  it('never rebinds a provider transaction to another reference or intent', async () => {
    const intent = await dispatched();
    await expect(
      store().bindProviderReference(intent, 'cs_other'),
    ).rejects.toMatchObject({ code: 'binding' });
    const second = await store().markDispatched(
      await store().reserve(input({ organizationId: 'company-b' })),
    );
    await expect(
      store().bindProviderReference(second, 'cs_synthetic'),
    ).rejects.toThrow();
    expect((await store().read(second)).providerReference).toBeNull();
  });
  it.each([
    'parameters',
    'terms_version',
    'consent_version',
    'owner_id',
    'organization_id',
    'workspace_id',
    'provider_scope',
    'environment',
    'expires_at',
  ] as const)('SQL freezes %s despite direct UPDATE', async (column) => {
    const intent = await store().reserve(input());
    expect(() =>
      sql
        .prepare(`UPDATE purchase_intents SET ${column}=? WHERE intent_id=?`)
        .run(
          column === 'expires_at'
            ? clock + 9999
            : column === 'parameters'
              ? '{}'
              : 'other',
          intent.intentId,
        ),
    ).toThrow();
  });
  it('SQL preserves all history and forbids manual footprint release or terminal rollback', async () => {
    const intent = await dispatched();
    expect(() =>
      sql
        .prepare('DELETE FROM purchase_intents WHERE intent_id=?')
        .run(intent.intentId),
    ).toThrow('purchase_history');
    expect(() =>
      sql
        .prepare('DELETE FROM purchase_intent_footprints WHERE intent_id=?')
        .run(intent.intentId),
    ).toThrow('purchase_history');
    expect(() =>
      sql
        .prepare(
          'UPDATE purchase_intent_footprints SET released_at=? WHERE intent_id=?',
        )
        .run(clock, intent.intentId),
    ).toThrow('purchase_footprint_immutable');
    expect(() =>
      sql
        .prepare(
          "UPDATE purchase_intents SET state='released',finalized_at=? WHERE intent_id=?",
        )
        .run(clock, intent.intentId),
    ).toThrow('purchase_state');
  });
  it('considers pre-existing provider-neutral contract occupancy without requiring status-only rights', async () => {
    await new D1PrepaidPeriods(d1(), () => clock).createContract({
      contractId: 'pfp_11111111-1111-4111-8111-111111111111',
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: null,
      environment: 'PRODUCTION',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      productKey: 'gestion:start',
    });
    await expect(store().reserve(input())).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store().reserve(input({ product: 'automation' })),
    ).resolves.toBeDefined();
    await expect(
      store().reserve(input({ environment: 'TEST' })),
    ).resolves.toBeDefined();
  });
  it('permits preparing its own explicit frozen PFP contract before first dispatch', async () => {
    const intent = await store().reserve(
      input({
        provider: 'postfinance',
        providerScope: 'https://checkout.postfinance.ch|405',
      }),
    );
    await new D1PrepaidPeriods(d1(), () => clock).createContract({
      contractId: 'pfp_' + intent.intentId.slice('purchase_'.length),
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: null,
      environment: 'PRODUCTION',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      productKey: 'gestion:start',
    });
    await expect(store().markDispatched(intent)).resolves.toMatchObject({
      state: 'dispatched',
    });
  });
  it('recognizes the real unsuffixed Automation key and null planId in PFP occupancy', async () => {
    await new D1PrepaidPeriods(d1(), () => clock).createContract({
      contractId: 'pfp_11111111-1111-4111-8111-111111111111',
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: null,
      environment: 'PRODUCTION',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      productKey: 'automation',
    });
    await expect(
      store().reserve(input({ product: 'automation', planId: null })),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store().reserve(input())).resolves.toBeDefined();
    const test = await store().reserve(
      input({ product: 'automation', planId: null, environment: 'TEST' }),
    );
    expect(test.planId).toBeNull();
  });
  it.each(['owner', 'space', 'plan'] as const)(
    'cannot exempt its own PFP-shaped ID with wrong %s context',
    async (field) => {
      const intent = await store().reserve(
        input({
          provider: 'postfinance',
          providerScope: 'https://checkout.postfinance.ch|405',
        }),
      );
      await new D1PrepaidPeriods(d1(), () => clock).createContract({
        contractId: 'pfp_' + intent.intentId.slice('purchase_'.length),
        ownerId: field === 'owner' ? 'foreign' : owner,
        organizationId: 'company-a',
        workspaceId: null,
        environment: 'PRODUCTION',
        apiOrigin: 'https://checkout.postfinance.ch',
        spaceId: field === 'space' ? 999 : 405,
        productKey: field === 'plan' ? 'gestion:pro' : 'gestion:start',
      });
      await expect(store().markDispatched(intent)).rejects.toThrow(
        'purchase_binding',
      );
    },
  );
  it('never re-dispatches a PFP-shaped contract already containing a settled period', async () => {
    const intent = await store().reserve(
      input({
        provider: 'postfinance',
        providerScope: 'https://checkout.postfinance.ch|405',
      }),
    );
    const periods = new D1PrepaidPeriods(d1(), () => clock);
    const contractId = 'pfp_' + intent.intentId.slice('purchase_'.length);
    await periods.createContract({
      contractId,
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: null,
      environment: 'PRODUCTION',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      productKey: 'gestion:start',
    });
    const period = await periods.reservePeriod(contractId, 0);
    await periods.bindTransaction(period.periodId, 71);
    await periods.recordReconciledSettlement({
      periodId: period.periodId,
      transactionId: 71,
      invoiceId: 81,
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      environment: 'PRODUCTION',
      ownerId: owner,
      organizationId: 'company-a',
      workspaceId: null,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      currency: 'CHF',
      priceChfMinor: period.priceChfMinor,
      catalogVersion: period.catalogVersion,
      evidenceFingerprint: 'a'.repeat(64),
    });
    await expect(store().markDispatched(intent)).rejects.toThrow(
      'purchase_rights',
    );
    expect((await store().read(intent)).state).toBe('reserved');
  });
  it.each([
    { parameters: { bad: undefined } },
    { parameters: { bad: Infinity } },
    { parameters: { bad: 'x'.repeat(40000) } },
    { reservationSeconds: 0 },
    { reservationSeconds: 90000 },
    {
      terms: {
        version: '',
        consentVersion: null,
        origin: 'https://zentraapp.ch',
      },
    },
    {
      terms: {
        version: 'v1',
        consentVersion: null,
        origin: 'https://zentraapp.ch/path',
      },
    },
  ])(
    'rejects invalid or unbounded frozen request parameters: %j',
    async (patch) => {
      await expect(store().reserve(input(patch))).rejects.toMatchObject({
        code: 'invalid',
      });
      expect(count()).toBe(0);
    },
  );
});
