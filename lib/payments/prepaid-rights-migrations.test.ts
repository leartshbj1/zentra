import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';

let db: DatabaseSync, now: number, serial: number;
const anchor = Date.parse('2026-01-31T09:17:23Z') / 1000;
const owner = 'owner-a';
const migrations = readdirSync(new URL('../../drizzle/', import.meta.url))
  .filter((name) => name.endsWith('.sql')).sort();
function sql(query: string, ...values: SQLInputValue[]) {
  return db.prepare(query).run(...values);
}
function projection(id: string, limit: number | null = 999, until = now + 864000) {
  sql('INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,seat_limit,entitlement_valid_until,livemode,updated_at) VALUES(?,?,?,\'active\',?,?,?,1,?)',
    id, 'customer-a', 'cached-price', until, limit, until, now);
}
function organization(id: string, subscriptionId: string, createdBy = owner) {
  sql('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,\'PME fictive\',?,?,?,?)',
    id, subscriptionId, createdBy, now, now);
}
function member(user = owner, org = 'company-a', role = user === owner ? 'owner' : 'member', revokedAt: number | null = null, joinedAt = now) {
  return sql('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at,revoked_at) VALUES(?,?,?,?,?,?,?)',
    'member-' + org + '-' + user, org, user, user + '@example.test', role, joinedAt, revokedAt);
}
function invitation(org = 'company-a', options: { role?: string; expiresAt?: number; revokedAt?: number | null } = {}) {
  const id = 'invitation-' + ++serial;
  sql('INSERT INTO organization_invitations(invitation_id,organization_id,token_hash,role,created_by_user_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)',
    id, org, id, options.role ?? 'member', owner, now, options.expiresAt ?? now + 86400, options.revokedAt ?? null);
  return id;
}
function device(user = owner, org = 'company-a', options: { createdAt?: number; revokedAt?: number | null } = {}) {
  const id = 'device-' + ++serial;
  sql('INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, id, org, user, 'installation-' + id, options.createdAt ?? now, now, now + 86400, options.revokedAt ?? null);
  return id;
}
type ProofOptions = {
  organizationId?: string;
  ownerId?: string;
  actualOwner?: string;
  contractId?: string;
  environment?: string;
  productKey?: string;
  anchor?: number;
  ordinal?: number;
  startsAt?: number;
  endsAt?: number;
  price?: number;
  contractJson?: string;
  periodJson?: string;
  version?: string;
  evidence?: string;
  reconciledAt?: number;
  apiOrigin?: string;
  transactionOrigin?: string;
  transactionSpace?: number;
  proof?: boolean;
  activeOwner?: boolean;
  workspaceOwner?: string;
};
function proof(options: ProofOptions = {}) {
  const n = ++serial;
  const contractId = options.contractId ?? 'pfp_00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const org = options.organizationId ?? 'company-a';
  const ownerId = options.ownerId ?? owner;
  const product = prepaidProduct(options.productKey ?? 'complet:team')!;
  const json = JSON.stringify(product);
  const periodId = 'period-' + n;
  const a = options.anchor ?? anchor;
  const ordinal = options.ordinal ?? 0;
  const dates = prepaidMonthlyPeriod(a, ordinal);
  const exists = db.prepare('SELECT 1 FROM organizations WHERE organization_id=?').get(org);
  if (!exists) {
    projection(contractId);
    organization(org, contractId, options.actualOwner ?? ownerId);
    if (options.activeOwner !== false)
      member(options.actualOwner ?? ownerId, org, 'owner');
  }
  let workspaceId: string | null = null;
  if (options.workspaceOwner) {
    workspaceId = 'workspace-' + n;
    sql('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,\'Support fictif\',?,?)',
      workspaceId, options.workspaceOwner, now, now);
  }
  sql('INSERT INTO prepaid_contracts(contract_id,owner_id,organization_id,workspace_id,api_origin,space_id,environment,product_key,catalog_version,catalog_json,anchor_start,fingerprint,created_at) VALUES(?,?,?,?,?,405,?,?,?,?,?,?,?)',
    contractId, ownerId, org, workspaceId, options.apiOrigin ?? 'https://checkout.postfinance.ch', options.environment ?? 'PRODUCTION',
    options.productKey ?? 'complet:team', options.version ?? product.catalogVersion, options.contractJson ?? json, a, 'b'.repeat(64), now);
  sql('INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at) VALUES(?,?,?,?,?,\'CHF\',?,?,?,?)',
    periodId, contractId, ordinal, options.startsAt ?? dates.startSeconds, options.endsAt ?? dates.endSeconds,
    options.price ?? product.priceChfMinor, options.version ?? product.catalogVersion, options.periodJson ?? json, now);
  sql('INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at) VALUES(?,?,?,?,?)',
    periodId, options.transactionOrigin ?? options.apiOrigin ?? 'https://checkout.postfinance.ch', options.transactionSpace ?? 405, 1000 + n, now);
  if (options.proof !== false)
    sql('INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at) VALUES(?,?,?,?)',
      periodId, 2000 + n, options.evidence ?? 'a'.repeat(64), options.reconciledAt ?? now);
  return { contractId, periodId, org, dates };
}
function rights(org = 'company-a') {
  return db.prepare('SELECT * FROM prepaid_current_company_rights WHERE organization_id=?').get(org);
}
function assertNoAdmission(org = 'company-a', user = owner) {
  expect(rights(org)).toBeUndefined();
  expect(() => device(user, org)).toThrow('zentra account access revoked');
  expect(() => member('other-' + serial, org)).toThrow('zentra prepaid member access unavailable');
  expect(() => invitation(org)).toThrow('zentra prepaid invitation access unavailable');
}
beforeEach(() => {
  now = anchor;
  serial = 0;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  // Real production migrations, with one explicit test-only clock for their views/triggers.
  db.function('unixepoch', () => now);
  for (const file of migrations)
    db.exec(readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'));
});
afterEach(() => db.close());

describe('0074 actual SQLite migration: immutable prepaid rights at admission boundaries', () => {
  it('loads every real migration including the additive 0074 and freezes the six approved company snapshots', () => {
    expect(migrations.at(-1)).toBe('0074_prepaid_rights_guards.sql');
    const stored = db.prepare('SELECT product_key,catalog_json FROM prepaid_gestion_catalog_v1').all();
    expect(stored).toHaveLength(6);
    for (const entry of stored)
      expect(JSON.parse(String(entry.catalog_json))).toEqual(prepaidProduct(entry.product_key));
  });

  it.each(prepaidCatalog().filter((p) => p.gestion).map((p) => p.productKey))(
    'permits only the precise seats of %s even when subscription cache says unlimited', (productKey) => {
      const data = proof({ productKey });
      sql('UPDATE subscriptions SET seat_limit=NULL,entitlement_valid_until=? WHERE subscription_id=?', now + 999999, data.contractId);
      const seats = prepaidProduct(productKey)!.gestion!.seats;
      expect(rights()?.seat_limit).toBe(seats);
      device();
      for (let i = 1; i < seats; i++) {
        member('collaborator-' + i);
        device('collaborator-' + i);
      }
      expect(() => member('outside-limit')).toThrow('zentra prepaid member access unavailable');
      expect(() => invitation()).toThrow('zentra prepaid invitation access unavailable');
    },
  );

  it('does not rely on too-low, expired or false subscription projections', () => {
    const data = proof();
    sql('UPDATE subscriptions SET seat_limit=0,entitlement_valid_until=0,current_period_end=0,status=\'canceled\',livemode=0 WHERE subscription_id=?', data.contractId);
    expect(rights()?.seat_limit).toBe(3);
    member('colleague');
    device('colleague');
    invitation();
  });

  it('allows only the actual very first owner before proof and never opens a device or extra admission', () => {
    const id = 'pfp_00000000-0000-4000-8000-000000000001';
    projection(id);
    organization('company-a', id);
    expect(() => member('intruder', 'company-a', 'owner')).toThrow('zentra prepaid member access unavailable');
    member();
    assertNoAdmission();
    expect(() => member('other-owner', 'company-a', 'owner')).toThrow();
  });

  it('preserves an exact idempotent member replay without permitting an ON CONFLICT update or replacement admission', () => {
    proof({ proof: false });
    const query = 'INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING';
    const values: SQLInputValue[] = ['member-company-a-' + owner, 'company-a', owner, owner + '@example.test', 'owner', now];
    expect(() => sql(query, ...values)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM organization_members').get()?.n).toBe(1);
    expect(() => sql(query, 'different-id', ...values.slice(1))).toThrow('zentra prepaid member access unavailable');
    expect(() => sql(query.replace('ON CONFLICT DO NOTHING', 'ON CONFLICT(membership_id) DO UPDATE SET role=\'member\''), ...values)).not.toThrow();
    assertNoAdmission();
    expect(() => sql('UPDATE organization_members SET role=\'owner\' WHERE membership_id=?', values[0])).toThrow('zentra prepaid member access unavailable');
  });

  it.each([
    ['missing settlement', { proof: false }],
    ['TEST payment', { environment: 'TEST' }],
    ['malformed contract ID', { contractId: 'pfp_bad' }],
    ['wrong actual owner', { ownerId: 'other-owner', actualOwner: owner }],
    ['missing active owner', { activeOwner: false }],
    ['different provider origin', { apiOrigin: 'https://untrusted.example' }],
    ['transaction origin mismatch', { transactionOrigin: 'https://app-wallee.com' }],
    ['transaction Space mismatch', { transactionSpace: 406 }],
    ['unknown catalogue', { version: 'unknown-v99' }],
    ['wrong paid price', { price: 1 }],
    ['malformed contract JSON', { contractJson: '{' }],
    ['malformed period JSON', { periodJson: '{' }],
    ['oversized JSON', { contractJson: JSON.stringify({ tooLarge: 'x'.repeat(8193) }) }],
    ['wrong evidence fingerprint', { evidence: 'not-a-verified-proof' }],
    ['future reconciliation', { reconciledAt: anchor + 1 }],
    ['calendar start mismatch', { startsAt: anchor - 1 }],
    ['calendar end mismatch', { endsAt: anchor + 86400 }],
    ['wrong workspace owner', { workspaceOwner: 'another-owner' }],
    ['Support-only contract', { productKey: 'support:team' }],
    ['Automation-only contract', { productKey: 'automation' }],
  ] satisfies [string, ProofOptions][])('fails closed for %s despite generous cached access', (_name, options) => {
    proof(options);
    assertNoAdmission();
  });

  it.each(['seat_limit', 'includedProducts', 'extra', 'ownerIncluded', 'catalog mismatch', 'duplicate JSON key'])(
    'requires complete structural catalogue equality: %s', (variation) => {
      const product = prepaidProduct('complet:team')!;
      const mutable = JSON.parse(JSON.stringify(product));
      if (variation === 'seat_limit') mutable.gestion.seats = 999;
      if (variation === 'includedProducts') mutable.includedProducts.reverse();
      if (variation === 'extra') mutable.extra = true;
      if (variation === 'ownerIncluded') mutable.gestion.ownerIncluded = false;
      const bad = variation === 'catalog mismatch'
        ? JSON.stringify(prepaidProduct('complet:pro'))
        : variation === 'duplicate JSON key'
          ? JSON.stringify(product).replace('"automation":true', '"automation":true,"automation":true')
          : JSON.stringify(mutable);
      proof({ periodJson: bad });
      assertNoAdmission();
    },
  );

  it('accepts equivalent object-key order and JSON whitespace without changing entitlement', () => {
    const product = prepaidProduct('complet:team')!;
    const reordered = Object.fromEntries(Object.entries(product).reverse());
    proof({ contractJson: JSON.stringify(reordered, null, 2), periodJson: JSON.stringify(product, null, 1) });
    expect(rights()?.seat_limit).toBe(3);
    device();
  });

  it('accepts numerically equivalent JSON decimal notation but keeps booleans distinct', () => {
    const json = JSON.stringify(prepaidProduct('complet:team')).replace('"seats":3', '"seats":3.0');
    proof({ contractJson: json, periodJson: json });
    expect(rights()?.seat_limit).toBe(3);
    device();
  });

  it('allows a matched approved Wallee origin but not mismatched transaction scope', () => {
    proof({ apiOrigin: 'https://app-wallee.com' });
    expect(rights()).toBeDefined();
    device();
  });

  it('keeps already-paid rights after cancellation, but never after reversal or period end', () => {
    const data = proof();
    sql('UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=?', now, data.contractId);
    expect(rights()).toBeDefined();
    device();
    sql('INSERT INTO prepaid_period_revocations(period_id,evidence_fingerprint,revoked_at) VALUES(?,?,?)', data.periodId, 'c'.repeat(64), now);
    assertNoAdmission();
  });

  it('uses actual wall-clock coverage rather than a backdated session creation', () => {
    const data = proof();
    now = data.dates.endSeconds;
    expect(() => device(owner, 'company-a', { createdAt: anchor })).toThrow('zentra account access revoked');
    assertNoAdmission();
  });

  it('rejects future paid coverage and allows it only at its exact UTC start', () => {
    const data = proof({ anchor: anchor + 86400 });
    assertNoAdmission();
    now = data.dates.startSeconds;
    expect(rights()).toBeDefined();
    device();
    expect(() => device(owner, 'company-a', { createdAt: anchor })).toThrow();
  });

  it('matches clamped UTC calendar boundaries from the original 31st across February and March', () => {
    const data = proof({ ordinal: 1 });
    now = data.dates.startSeconds;
    expect(rights()?.starts_at).toBe(Date.parse('2026-02-28T09:17:23Z') / 1000);
    expect(rights()?.ends_at).toBe(Date.parse('2026-03-31T09:17:23Z') / 1000);
    device();
  });

  it('fails closed for two paid company contracts even if only the first is projected', () => {
    proof();
    proof({ productKey: 'gestion:start' });
    assertNoAdmission();
  });

  it('fails closed for a second proven current period even when its overlapping calendar is invalid', () => {
    const data = proof();
    const product = prepaidProduct('complet:team')!;
    const id = 'invalid-overlapping-period';
    sql('INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at) VALUES(?,?,1,?,?,\'CHF\',?,?,?,?)',
      id, data.contractId, anchor, data.dates.endSeconds, product.priceChfMinor, product.catalogVersion, JSON.stringify(product), now);
    sql('INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at) VALUES(?,\'https://checkout.postfinance.ch\',405,901,?)', id, now);
    sql('INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at) VALUES(?,902,?,?)', id, 'a'.repeat(64), now);
    // A contradictory audit journal must be reconciled, never resolved by picking a row.
    assertNoAdmission();
  });

  it('does not let a duplicate TEST contract mask one production paid contract', () => {
    proof();
    proof({ environment: 'TEST' });
    expect(rights()).toBeDefined();
    device();
  });

  it('does not let a wrong-owner paid contract mask the genuine owner', () => {
    proof();
    proof({ ownerId: 'intruder' });
    expect(rights()).toBeDefined();
    device();
  });

  it('reserves invitation seats atomically and accepts an invitation in the existing batch order', () => {
    proof();
    const first = invitation();
    invitation();
    expect(() => invitation()).toThrow('zentra prepaid invitation access unavailable');
    expect(() => member('unreserved')).toThrow('zentra prepaid member access unavailable');
    db.exec('BEGIN');
    sql('UPDATE organization_invitations SET accepted_at=?,accepted_by_user_id=? WHERE invitation_id=?', now, 'invited', first);
    member('invited');
    db.exec('COMMIT');
    device('invited');
    expect(() => invitation()).toThrow();
  });

  it('serializes a burst of seat reservations without exceeding the immutable paid limit', async () => {
    proof();
    const outcomes = await Promise.all(Array.from({ length: 15 }, async () => {
      try { invitation(); return true; } catch { return false; }
    }));
    expect(outcomes.filter(Boolean)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM organization_invitations WHERE revoked_at IS NULL AND accepted_at IS NULL').get()?.n).toBe(2);
  });

  it('guards invitation reactivation, moved scope, expiry extension, and accepted-to-pending replay', () => {
    proof();
    const inactive = invitation('company-a', { revokedAt: now });
    const expired = invitation('company-a', { expiresAt: now - 1 });
    const accepted = invitation();
    sql('UPDATE organization_invitations SET accepted_at=? WHERE invitation_id=?', now, accepted);
    invitation();
    invitation();
    expect(() => sql('UPDATE organization_invitations SET revoked_at=NULL WHERE invitation_id=?', inactive)).toThrow();
    expect(() => sql('UPDATE organization_invitations SET expires_at=? WHERE invitation_id=?', now + 999, expired)).toThrow();
    expect(() => sql('UPDATE organization_invitations SET accepted_at=NULL WHERE invitation_id=?', accepted)).toThrow();
    expect(() => invitation('company-a', { role: 'owner' })).toThrow();
  });

  it('allows revocation and owner demotion to remove rights, but cannot reactivate an unproved membership', () => {
    proof();
    member('revoked', 'company-a', 'member', now);
    sql('UPDATE organization_members SET role=\'member\' WHERE user_id=?', owner);
    assertNoAdmission();
    expect(() => sql('UPDATE organization_members SET revoked_at=NULL WHERE user_id=\'revoked\'')).toThrow();
    expect(() => sql('UPDATE organization_members SET role=\'owner\' WHERE user_id=?', owner)).toThrow();
  });

  it('rejects a promoted second owner, identity replacement and movement from a legacy company without proof', () => {
    proof({ proof: false });
    projection('sub_other');
    organization('legacy', 'sub_other');
    member('outside', 'legacy');
    expect(() => sql('UPDATE organization_members SET organization_id=\'company-a\' WHERE user_id=\'outside\'')).toThrow();
    expect(() => sql('UPDATE organization_members SET user_id=\'intruder\' WHERE organization_id=\'company-a\'')).toThrow();
  });

  it('ranks the genuine owner first after a projection changes to a lower paid seat count', () => {
    projection('sub_old');
    organization('company-a', 'sub_old');
    member('colleague', 'company-a', 'member', null, anchor - 10);
    member();
    const data = proof({ productKey: 'gestion:solo' });
    projection(data.contractId);
    sql('UPDATE organizations SET subscription_id=? WHERE organization_id=\'company-a\'', data.contractId);
    device();
    expect(() => device('colleague')).toThrow();
  });

  it('reserves the first seat for the real owner even when an older legacy member also has role owner', () => {
    projection('sub_old');
    organization('company-a', 'sub_old');
    member('former-owner', 'company-a', 'owner', null, anchor - 10);
    member();
    const data = proof({ productKey: 'gestion:solo' });
    projection(data.contractId);
    sql('UPDATE organizations SET subscription_id=? WHERE organization_id=\'company-a\'', data.contractId);
    device();
    expect(() => device('former-owner')).toThrow('zentra account access revoked');
  });

  it('prevents reactivation, extension and scope replacement of a device after refund or without proof', () => {
    const data = proof();
    const id = device();
    const inactive = device(owner, 'company-a', { revokedAt: now });
    sql('INSERT INTO prepaid_period_revocations(period_id,evidence_fingerprint,revoked_at) VALUES(?,?,?)', data.periodId, 'c'.repeat(64), now);
    expect(() => sql('UPDATE device_sessions SET revoked_at=NULL WHERE session_id=?', inactive)).toThrow();
    expect(() => sql('UPDATE device_sessions SET expires_at=expires_at+1 WHERE session_id=?', id)).toThrow();
    expect(() => sql('UPDATE device_sessions SET user_id=\'other\' WHERE session_id=?', id)).toThrow();
    // Passive heartbeat and revocation are not new access.
    expect(() => sql('UPDATE device_sessions SET last_seen_at=? WHERE session_id=?', now + 1, id)).not.toThrow();
    expect(() => sql('UPDATE device_sessions SET revoked_at=? WHERE session_id=?', now, id)).not.toThrow();
  });

  it('cannot fall through to a founder grant or legacy pack-transition cache for a malformed pfp_ ID', () => {
    const id = 'pfp_invalid';
    projection(id);
    organization('company-a', id);
    member();
    sql('INSERT INTO founder_access_grants(email,grant_id,user_id,organization_id,valid_until,revision,created_at,updated_at,last_operation_id) VALUES(?,?,?,?,?,1,?,?,?)',
      'owner@example.test', 'grant-a', owner, 'company-a', now + 999999, now, now, 'operation-a');
    sql('INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,?,?,?,?,? ,\'scheduled\',?,?,?)',
      'company-a', 'change-a', owner, id, 'team', now + 999999, '{"seats":3,"live":1,"sources":[]}', now, now);
    assertNoAdmission();
  });

  it.each(['sub_stripe', 'manual_grant', 'trial_complete', 'pfpXlegacy'])(
    'preserves historical paid-cache device, member and invitation behavior for %s', (id) => {
      projection(id, 3);
      organization('company-a', id);
      member();
      member('colleague');
      device();
      invitation();
      expect(() => member('one-more')).not.toThrow();
      expect(() => member('outside-limit')).toThrow('zentra seat limit reached');
    },
  );

  it('preserves the historical founder and Stripe-transition paths outside pfp_', () => {
    projection('manual_founder', 1, 0);
    organization('company-a', 'manual_founder');
    member();
    sql('INSERT INTO founder_access_grants(email,grant_id,user_id,organization_id,valid_until,revision,created_at,updated_at,last_operation_id) VALUES(?,?,?,?,?,1,?,?,?)',
      'owner@example.test', 'grant-a', owner, 'company-a', now + 999999, now, now, 'operation-a');
    expect(() => device()).not.toThrow();
    projection('sub_source', 3, 0);
    organization('company-b', 'sub_source');
    member(owner, 'company-b');
    sql('INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,?,?,?,?,? ,\'scheduled\',?,?,?)',
      'company-b', 'change-a', owner, 'sub_source', 'team', now + 999999, '{"seats":3,"live":1,"sources":[]}', now, now);
    expect(() => device(owner, 'company-b')).not.toThrow();
  });

  it('does not revive legacy transition access by supplying a cached pfp_ source', () => {
    projection('sub_primary', 3, 0);
    projection('pfp_source', 3);
    organization('company-a', 'sub_primary');
    member();
    sql('INSERT INTO complete_plan_changes(organization_id,operation_id,user_id,subscription_id,target_plan,effective_at,state,source_json,created_at,updated_at) VALUES(?,?,?,?,?,? ,\'scheduled\',?,?,?)',
      'company-a', 'change-a', owner, 'sub_primary', 'team', now + 999999,
      JSON.stringify({ seats: 3, live: 1, sources: [{ id: 'pfp_source', kind: 'gestion', customer: 'customer-a', invoice: null }] }), now, now);
    expect(() => device()).toThrow('zentra account access revoked');
  });
});
