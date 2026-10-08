import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalCreationJson } from './workspace-creation';

// Every actual D1 migration 0000..0087, in disposable Node SQLite, with FK ON.
// PG receipts and paid evidence are explicitly synthetic trusted-sink fixtures.
// This is SQL admission/rollback evidence, not Stripe verification, Cloudflare
// workerd/D1 concurrency, hosted PostgreSQL or production/physical-client proof.
const folder = new URL('../../drizzle/', import.meta.url);
const migrationFiles = readdirSync(folder).filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 87).sort();
const sources = migrationFiles.map(name => readFileSync(new URL(name, folder), 'utf8'));
const actor = '11111111-1111-4111-8111-111111111111';
const other = '99999999-9999-4999-8999-999999999999';
const org = '33333333-3333-4333-8333-333333333333';
const creation = '44444444-4444-4444-8444-444444444444';
const request = '22222222-2222-4222-8222-222222222222';
type Row = Record<string, SQLInputValue>;
type Json = Record<string, unknown>;
let db: DatabaseSync;
let now: number;
let chBefore: Record<string, unknown[]>;

function configuration(organizationId = org) {
  return { organizationId, schemaVersion: 1, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '10 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
}
function nationalReceipt(organizationId = org, creationId = creation, requestId = request): Json {
  return { creationId, organizationId, actorUserId: actor, requestId, configurationFingerprint: 'a'.repeat(64), configuration: configuration(organizationId), revision: 1, updatedBy: actor, updatedAt: new Date(now * 1000).toISOString(), replayed: false };
}
function reserve(organizationId = org, creationId = creation, requestId = request) {
  const timestamp = new Date(now * 1000).toISOString();
  db.prepare(`INSERT INTO international_workspace_creation_intents(creation_id,organization_id,actor_user_id,request_id,country_code,confirmation_version,company_name,configuration_fingerprint,configuration_json,state,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?,?,'reserved',?,?)`).run(creationId, organizationId, actor, requestId, 'US', 'Fictitious US company', 'a'.repeat(64), canonicalCreationJson(configuration(organizationId)), timestamp, timestamp);
}
function confirm(receipt: Json = nationalReceipt(), organizationId = org) {
  db.prepare("UPDATE international_workspace_creation_intents SET state='postgres_confirmed',pg_receipt_json=? WHERE organization_id=?").run(canonicalCreationJson(receipt), organizationId);
}
function offer(): Json {
  return { kind: 'saas_subscription', catalogVersion: 'synthetic-us-test-v1', country: 'US', currency: 'USD', module: 'gestion', plan: 'synthetic-us-test-plan', priceId: 'price_synthetic_us', productId: 'prod_synthetic_us', environment: 'TEST', unitAmountMinor: '123', interval: 'month', intervalCount: 1, taxBehavior: 'exclusive' };
}
function authority(organizationId = org, subscriptionId = 'sub_synthetic_us'): Json {
  return { kind: 'saas_subscription_authority', organizationId, subscriptionId, offer: offer(), status: 'active', evidence: { kind: 'verified_payment', referenceId: 'in_synthetic_us', organizationId, subscriptionId, environment: 'TEST', catalogVersion: 'synthetic-us-test-v1', priceId: 'price_synthetic_us', currency: 'USD', startsAt: now - 60, endsAt: now + 3600, revoked: false } };
}
function candidate(patch: Row = {}): Row {
  return { organization_id: org, creation_id: creation, owner_user_id: actor, subscription_id: 'sub_synthetic_us', environment: 'TEST', catalog_version: 'synthetic-us-test-v1', country: 'US', currency: 'USD', offer_json: canonicalCreationJson(offer()), authority_json: canonicalCreationJson(authority()), seat_limit: 2, revision: 1, updated_at: now, revoked_at: null, ...patch };
}
function write(table: string, row: Row, replace = false) {
  const names = Object.keys(row);
  return db.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...Object.values(row));
}
function member(patch: Row = {}): Row {
  return { membership_id: 'us-owner-membership', organization_id: org, user_id: actor, role: 'owner', display_name: 'Fictitious owner', joined_at: now, revoked_at: null, ...patch };
}
function textColumn(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError('Expected a SQL text fixture column');
  return value;
}
function ready(subscriptionId = 'sub_synthetic_us', organizationId = org) {
  return db.prepare("UPDATE international_workspace_creation_intents SET state='ready',own_subscription_id=? WHERE organization_id=? AND state='postgres_confirmed'").run(subscriptionId, organizationId);
}
function atomic(task: () => void) {
  db.exec('BEGIN');
  try { task(); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function admit(row = candidate(), owner = member()) {
  atomic(() => { write('international_saas_authorities', row); write('international_workspace_members', owner); ready(textColumn(row, 'subscription_id'), textColumn(row, 'organization_id')); });
}
function snapshotLegacy() {
  return Object.fromEntries(['subscriptions', 'organizations', 'organization_members', 'license_activations', 'device_sessions', 'account_trials'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function changeJson(row: Row, target: 'offer_json' | 'authority_json', change: (json: Json) => void): Row {
  const json = JSON.parse(textColumn(row, target)) as Json;
  change(json);
  return { ...row, [target]: canonicalCreationJson(json) };
}
beforeEach(() => {
  now = Math.floor(Date.now() / 1000);
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF');
  for (const sql of sources) db.exec(sql);
  db.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('sub_ch','cus_ch','price_ch','active',?,?,0,?)").run(now + 86400, now + 86400, now);
  db.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES('ch-company','Existing CH','sub_ch',?,?,?)").run(actor, now, now);
  db.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('ch-owner','ch-company',?,'synthetic@example.invalid','owner',?)").run(actor, now);
  db.prepare("INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at) VALUES('ch-license','sub_ch','same-installation',?,?)").run(now, now);
  db.prepare("INSERT INTO device_sessions(session_id,token_hash,organization_id,user_id,installation_id,created_at,last_seen_at,expires_at) VALUES('ch-session',?,'ch-company',?,'same-installation',?,?,?)").run(createHash('sha256').update('synthetic-token').digest('hex'), actor, now, now, now + 86400);
  chBefore = snapshotLegacy();
  reserve();
  confirm();
});
afterEach(() => {
  expect(snapshotLegacy()).toEqual(chBefore);
  db.close();
});

describe('0087 full-SQL US own-authority admission', () => {
  it('loads exactly 88 real migrations and atomically admits US owner/authority/ready without a legacy company or licence', () => {
    expect(migrationFiles.map(name => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 88 }, (_, i) => i));
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    admit();
    expect(db.prepare('SELECT state,own_subscription_id FROM international_workspace_creation_intents WHERE organization_id=?').get(org)).toEqual({ state: 'ready', own_subscription_id: 'sub_synthetic_us' });
    expect(db.prepare('SELECT owner_user_id,seat_limit FROM international_saas_authorities').get()).toEqual({ owner_user_id: actor, seat_limit: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM organizations WHERE organization_id=?').get(org)).toEqual({ n: 0 });
  });
  it.each(['authority-only', 'authority-and-owner', 'zero-row-ready'] as const)('rejects an incomplete %s commit through actual deferred foreign keys', mode => {
    expect(() => atomic(() => {
      write('international_saas_authorities', candidate());
      if (mode !== 'authority-only') write('international_workspace_members', member());
      if (mode === 'zero-row-ready') expect(ready('sub_synthetic_us', 'not-the-intention').changes).toBe(0);
    })).toThrow('FOREIGN KEY constraint failed');
    expect(db.prepare('SELECT count(*) n FROM international_saas_authorities').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM international_workspace_members').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT state FROM international_workspace_creation_intents').get()).toEqual({ state: 'postgres_confirmed' });
  });
  it('rolls all admission writes back when the final own-subscription differs, then safely recovers', () => {
    expect(() => atomic(() => { write('international_saas_authorities', candidate()); write('international_workspace_members', member()); ready('sub_wrong'); })).toThrow('international_us_ready_not_admitted');
    expect(db.prepare('SELECT count(*) n FROM international_saas_authorities').get()).toEqual({ n: 0 });
    admit();
    const before = db.prepare('SELECT * FROM international_saas_authorities').get();
    expect(() => admit()).toThrow('international_saas_authority_exists');
    expect(db.prepare('SELECT * FROM international_saas_authorities').get()).toEqual(before);
  });
  it.each(['reserved', 'legacy-subscription', 'wrong-owner', 'wrong-creation', 'initially-revoked', 'future-timestamp', 'future-revision'] as const)('refuses %s admission', scenario => {
    let row = candidate();
    if (scenario === 'reserved') { const o = randomUUID(), c = randomUUID(), r = randomUUID(); reserve(o, c, r); row = candidate({ organization_id: o, creation_id: c }); }
    if (scenario === 'legacy-subscription') row.subscription_id = 'sub_ch';
    if (scenario === 'wrong-owner') row.owner_user_id = other;
    if (scenario === 'wrong-creation') row.creation_id = randomUUID();
    if (scenario === 'initially-revoked') row.revoked_at = now;
    if (scenario === 'future-timestamp') row.updated_at = now + 3600;
    if (scenario === 'future-revision') row.revision = 2;
    expect(() => admit(row)).toThrow();
  });
  it.each(['updatedBy', 'updatedAt', 'replayed', 'configuration', 'extra', 'duplicate'] as const)('rejects an incomplete or altered national receipt: %s', field => {
    const o = randomUUID(), c = randomUUID(), r = randomUUID(); reserve(o, c, r);
    const receipt = nationalReceipt(o, c, r);
    if (field === 'extra') receipt.unexpected = true;
    else if (field === 'duplicate') receipt.extra = 'marker';
    else if (field === 'configuration') receipt.configuration = { ...configuration(o), invoiceNumberPrefix: 'DIFFERENT' };
    else if (field === 'updatedBy') receipt.updatedBy = other;
    else if (field === 'updatedAt') receipt.updatedAt = 'not-a-date';
    else delete receipt[field];
    const encoded = field === 'duplicate' ? canonicalCreationJson(receipt).replace('"extra":"marker",', '"updatedBy":"' + actor + '",') : canonicalCreationJson(receipt);
    db.prepare("UPDATE international_workspace_creation_intents SET state='postgres_confirmed',pg_receipt_json=? WHERE organization_id=?").run(encoded, o);
    expect(() => admit(candidate({ organization_id: o, creation_id: c, authority_json: canonicalCreationJson(authority(o)) }), member({ organization_id: o }))).toThrow('international_saas_authority_scope');
  });
  it.each(['country', 'currency', 'environment', 'catalogVersion', 'module', 'plan', 'priceId', 'productId', 'unitAmountMinor', 'interval', 'intervalCount', 'taxBehavior'] as const)('rejects invalid offer field %s in real SQL', field => {
    const row = candidate();
    const invalid: Record<string, unknown> = { country: 'CH', currency: 'CHF', environment: 'PRODUCTION', catalogVersion: 'other', module: 'support', plan: '', priceId: 'price_', productId: 'prod_', unitAmountMinor: '9007199254740992', interval: 'week', intervalCount: 1.5, taxBehavior: 'unspecified' };
    const json = { ...offer(), [field]: invalid[field] };
    row.offer_json = canonicalCreationJson(json);
    row.authority_json = canonicalCreationJson({ ...authority(), offer: json });
    expect(() => admit(row)).toThrow();
  });
  it.each(['organizationId', 'subscriptionId', 'environment', 'catalogVersion', 'priceId', 'currency', 'startsAt', 'endsAt', 'revoked', 'kind', 'referenceId'] as const)('rejects unbound or inactive payment evidence %s', field => {
    const invalid: Record<string, unknown> = { organizationId: other, subscriptionId: 'sub_other', environment: 'PRODUCTION', catalogVersion: 'other', priceId: 'price_other', currency: 'CHF', startsAt: now + 1, endsAt: now, revoked: true, kind: 'authorized_trial', referenceId: '' };
    const row = changeJson(candidate(), 'authority_json', json => { (json.evidence as Json)[field] = invalid[field]; });
    expect(() => admit(row)).toThrow();
  });
  it.each(['offer-missing', 'evidence-null', 'revoked-string', 'date-string', 'unknown-key', 'duplicate-key', 'array', 'nested-offer-drift'] as const)('refuses JSON shape bypass %s', scenario => {
    let row = candidate();
    if (scenario === 'offer-missing') row = changeJson(row, 'offer_json', json => { delete json.country; });
    if (scenario === 'evidence-null') row = changeJson(row, 'authority_json', json => { json.evidence = null; });
    if (scenario === 'revoked-string') row = changeJson(row, 'authority_json', json => { (json.evidence as Json).revoked = 'false'; });
    if (scenario === 'date-string') row = changeJson(row, 'authority_json', json => { (json.evidence as Json).startsAt = String(now); });
    if (scenario === 'unknown-key') row = changeJson(row, 'authority_json', json => { json.ownerUserId = actor; });
    if (scenario === 'duplicate-key') row.authority_json = textColumn(row, 'authority_json').replace('"kind":"saas_subscription_authority"', '"kind":"saas_subscription_authority","kind":"saas_subscription_authority"');
    if (scenario === 'array') row.offer_json = '[]';
    if (scenario === 'nested-offer-drift') row = changeJson(row, 'authority_json', json => { (json.offer as Json).unitAmountMinor = '124'; });
    expect(() => admit(row)).toThrow();
  });
  it.each([0, -1, 1.5, 1001, null])('rejects invalid seat limit %s', limit => expect(() => admit(candidate({ seat_limit: limit }))).toThrow());
  it.each([
    ['revision', 0], ['updated_at', 0], ['updated_at', 1.5], ['updated_at', 253402300800],
    ['catalog_version', ''], ['subscription_id', ''], ['currency', null], ['offer_json', '{}'], ['authority_json', '{}'],
  ] as [string, SQLInputValue][])('rejects invalid durable column %s=%s', (field, value) => expect(() => admit(candidate({ [field]: value }))).toThrow());
  it.each(['owner-user', 'owner-role', 'revoked-owner'] as const)('rolls back mismatched initial %s membership', scenario => {
    const row = member();
    if (scenario === 'owner-user') row.user_id = other;
    if (scenario === 'owner-role') row.role = 'admin';
    if (scenario === 'revoked-owner') row.revoked_at = now;
    expect(() => admit(candidate(), row)).toThrow('international_us_membership_scope');
  });
  it('counts the owner and active members, and does not reactivate or replace a revoked member', () => {
    admit();
    write('international_workspace_members', member({ membership_id: 'second', user_id: other, role: 'accountant' }));
    expect(() => write('international_workspace_members', member({ membership_id: 'third', user_id: randomUUID(), role: 'member' }))).toThrow('international_us_seat_limit');
    db.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE membership_id=?').run(now, 'second');
    write('international_workspace_members', member({ membership_id: 'third', user_id: randomUUID(), role: 'member' }));
    expect(() => db.exec("UPDATE international_workspace_members SET revoked_at=NULL WHERE membership_id='second'")).toThrow('international_us_membership_immutable');
    expect(() => write('international_workspace_members', member({ membership_id: 'replacement', user_id: other, role: 'member' }), true)).toThrow('international_us_membership_exists');
  });
  it.each(['', 'not-an-auth-id', '99999999-9999-4999-7999-999999999999'])('refuses invalid additional Auth identity %s', userId => {
    admit();
    expect(() => write('international_workspace_members', member({ membership_id: 'second', user_id: userId, role: 'member' }))).toThrow('CHECK constraint failed');
  });
  it.each(['membership_id', 'joined_at', 'display_name'] as const)('refuses invalid additional member column %s', field => {
    admit();
    const invalid: Row = { membership_id: '', joined_at: -1, display_name: 'x'.repeat(161) };
    expect(() => write('international_workspace_members', member({ membership_id: 'second', user_id: other, role: 'member', [field]: invalid[field] }))).toThrow('CHECK constraint failed');
  });
  it.each(['organization_id', 'creation_id', 'owner_user_id', 'subscription_id', 'environment', 'catalog_version', 'country', 'currency', 'offer_json', 'authority_json', 'seat_limit', 'revision', 'updated_at'] as const)('never rewrites admitted authority %s', field => {
    admit();
    expect(() => db.prepare(`UPDATE international_saas_authorities SET ${field}=?`).run(typeof candidate()[field] === 'number' ? 42 : 'modified')).toThrow('international_saas_authority_immutable');
  });
  it.each(['membership_id', 'organization_id', 'user_id', 'role', 'joined_at'] as const)('never changes membership identity/role %s', field => {
    admit();
    expect(() => db.prepare(`UPDATE international_workspace_members SET ${field}=?`).run(field === 'joined_at' ? 1 : 'modified')).toThrow('international_us_membership_immutable');
  });
  it('revokes once without rewriting receipt or authority JSON and preserves the durable history', () => {
    admit();
    const proof = db.prepare('SELECT authority_json,offer_json FROM international_saas_authorities').get();
    const intent = db.prepare('SELECT * FROM international_workspace_creation_intents').get();
    db.prepare('UPDATE international_saas_authorities SET revoked_at=?').run(now);
    db.prepare('UPDATE international_workspace_members SET revoked_at=?').run(now);
    expect(db.prepare('SELECT authority_json,offer_json FROM international_saas_authorities').get()).toEqual(proof);
    expect(db.prepare('SELECT * FROM international_workspace_creation_intents').get()).toEqual(intent);
    expect(() => db.exec('UPDATE international_saas_authorities SET revoked_at=NULL')).toThrow('international_saas_authority_immutable');
    expect(() => db.prepare('UPDATE international_saas_authorities SET revoked_at=?').run(now + 1)).toThrow('international_saas_authority_immutable');
    expect(() => db.exec('DELETE FROM international_saas_authorities')).toThrow('international_saas_authority_immutable');
    expect(() => db.exec('DELETE FROM international_workspace_members')).toThrow('international_us_membership_immutable');
    expect(() => write('international_saas_authorities', candidate(), true)).toThrow('international_saas_authority_exists');
    expect(() => write('international_workspace_members', member(), true)).toThrow('international_us_membership_exists');
  });
  it.each(['creation_id', 'subscription_id'] as const)('does not let OR REPLACE move an admitted %s into another US namespace', field => {
    admit();
    const o = randomUUID(), c = randomUUID(), r = randomUUID(); reserve(o, c, r); confirm(nationalReceipt(o, c, r), o);
    const row = candidate({ organization_id: o, creation_id: c, subscription_id: 'sub_second', authority_json: canonicalCreationJson(authority(o, 'sub_second')), [field]: field === 'creation_id' ? creation : 'sub_synthetic_us' });
    expect(() => write('international_saas_authorities', row, true)).toThrow('international_saas_authority_exists');
    expect(db.prepare('SELECT organization_id,subscription_id FROM international_saas_authorities').all()).toEqual([{ organization_id: org, subscription_id: 'sub_synthetic_us' }]);
  });
  it.each(['owner', 'authority'] as const)('does not allow fresh members after the %s was revoked', source => {
    admit();
    db.prepare(`UPDATE ${source === 'owner' ? 'international_workspace_members' : 'international_saas_authorities'} SET revoked_at=?`).run(now);
    expect(() => write('international_workspace_members', member({ membership_id: 'second', user_id: other, role: 'member' }))).toThrow('international_us_membership_scope');
  });
  it.each(['organization', 'subscription'] as const)('refuses reverse legacy %s collision after US admission', target => {
    admit();
    if (target === 'subscription') expect(() => db.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,'cus_other','price_ch','active',?,?)").run('sub_synthetic_us', now + 60, now)).toThrow('international_us_legacy_identity_conflict');
    else expect(() => db.prepare("INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,'Wrong CH','sub_ch',?,?,?)").run(org, actor, now, now)).toThrow('international_us_legacy_identity_conflict');
  });
  it.each(['organization', 'subscription'] as const)('refuses reassigning existing CH %s identity to US', target => {
    admit();
    if (target === 'organization') expect(() => db.prepare("UPDATE organizations SET organization_id=? WHERE organization_id='ch-company'").run(org)).toThrow('international_us_legacy_identity_conflict');
    else expect(() => db.prepare("UPDATE subscriptions SET subscription_id=? WHERE subscription_id='sub_ch'").run('sub_synthetic_us')).toThrow('international_us_legacy_identity_conflict');
  });
  it('keeps the permanent legacy business fence after admission and revocation', () => {
    admit();
    db.prepare('UPDATE international_saas_authorities SET revoked_at=?').run(now);
    expect(() => db.prepare("INSERT INTO document_number_reservations(organization_id,installation_id,request_id,created_by,prefix,year,minimum,count,start_value,end_value,created_at) VALUES(?,'fixture','fixture',?,'INV',2026,1,1,1,1,?)").run(org, actor, new Date(now * 1000).toISOString())).toThrow('international_legacy_transport_forbidden');
    expect(db.prepare('SELECT country_code,state FROM international_workspace_creation_intents').get()).toEqual({ country_code: 'US', state: 'ready' });
  });
});
