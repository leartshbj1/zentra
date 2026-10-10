import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountWorkspacesForUser, accountWorkspaceDiscoveryEnabled, type AccountWorkspaceReadDatabase } from './account-workspaces';
import { createOrResumeUsWorkspace } from './international/workspace-creation';
import { d1WorkspaceCreationStore } from './international/workspace-creation-d1';
import { d1UsAuthorityStore as currentUsAuthorityStore } from './international/saas-authority-d1';
// Historical discovery fixture deliberately stops before recurring rights.
// Actual0092/lifecycle integration is tested by the full-chain lifecycle suite.
const d1UsAuthorityStore = (db: Parameters<typeof currentUsAuthorityStore>[0]) => currentUsAuthorityStore(db, { authoritySource: 'initial_admission' });
import { prepareUsAuthorityAdmission, type UsSaasPolicy } from './international/saas-authority';
import type { SaasSubscriptionAuthority, SaasSubscriptionOffer, ServerStripePrice } from './international/subscriptions';

const flags = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('cloudflare:workers', () => ({ env: flags.env }));

const actor = '11111111-1111-4111-8111-111111111111';
const collaborator = '55555555-5555-4555-8555-555555555555';
const foreign = '99999999-9999-4999-8999-999999999999';
const org = '33333333-3333-4333-8333-333333333333';
const creation = '44444444-4444-4444-8444-444444444444';
const requestId = '22222222-2222-4222-8222-222222222222';
const offer: SaasSubscriptionOffer = { kind:'saas_subscription',catalogVersion:'discovery_fixture_US',country:'US',currency:'USD',module:'gestion',plan:'fixture_US',priceId:'price_discovery_fixture',productId:'prod_discovery_fixture',environment:'TEST',unitAmountMinor:'1000',interval:'month',intervalCount:1,taxBehavior:'exclusive' };
const price: ServerStripePrice = { id:offer.priceId,active:true,livemode:false,currency:'usd',unit_amount:1000,type:'recurring',tax_behavior:'exclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:{id:offer.productId,active:true} };
const files = readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0,4)) <= 87).sort();
const migrations = files.map(name => readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
let db: DatabaseSync, now: number, sql: string[], policy: UsSaasPolicy;

// Actual 88 D1 migrations in disposable Node SQLite. Provider/PG proofs are
// synthetic setup fixtures, not Stripe, hosted D1 or native-client evidence.
function adapter(database: DatabaseSync) {
  function prepare(query: string) {
    function bound(args: SQLInputValue[]) {
      return { sql:query, args,
        async all<T>() { sql.push(query); return { success:true, results:database.prepare(query).all(...args) as T[] }; },
        async first<T>() { return (database.prepare(query).get(...args) ?? null) as T | null; },
        async run() { const result = database.prepare(query).run(...args); return { success:true, meta:{changes:Number(result.changes)} }; },
      };
    }
    return { ...bound([]), bind(...args: unknown[]) { return bound(args as SQLInputValue[]); } };
  }
  return { prepare, async batch(statements: {sql:string;args:SQLInputValue[]}[]) {
    database.exec('BEGIN');
    try { const result = statements.map(statement => database.prepare(statement.sql).run(...statement.args)); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
}
function readOptions(usEnabled = true) { return { database:adapter(db), usEnabled }; }
function snapshot() { return ['subscriptions','organizations','organization_members','device_sessions','license_activations'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
async function confirmed() {
  let allocation = 0;
  const stamp = new Date(now * 1000).toISOString();
  const store = d1WorkspaceCreationStore(adapter(db) as unknown as Pick<D1Database,'prepare'|'batch'>);
  return createOrResumeUsWorkspace(actor, { requestId,confirmationVersion:1,companyName:'Same business name',configuration:{schemaVersion:1,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'10 Example St',city:'New York',subdivision:'NY',postalCode:'10001'},ein:'12-3456789',accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}} }, {
    store, allocateId:() => [org,creation][allocation++],now:() => stamp,fingerprint:async value => createHash('sha256').update(value).digest('hex'),
    admit:async intent => ({creationId:intent.creationId,organizationId:intent.organizationId,actorUserId:actor,requestId,configurationFingerprint:intent.fingerprint,configuration:intent.configuration,revision:1,updatedBy:actor,updatedAt:stamp,replayed:false}),revalidate:async () => {},
  });
}
async function ready() {
  const intent = await confirmed();
  const subscriptionId = 'sub_discovery_fixture_US';
  const authority: SaasSubscriptionAuthority = {kind:'saas_subscription_authority',organizationId:org,subscriptionId,offer,status:'active',evidence:{kind:'verified_payment',referenceId:'in_discovery_fixture',organizationId:org,subscriptionId,environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:now-60,endsAt:now+3600,revoked:false}};
  const candidate = prepareUsAuthorityAdmission(intent,{authority,seatLimit:10},policy,price);
  return d1UsAuthorityStore(adapter(db) as unknown as Pick<D1Database,'prepare'|'batch'>).admit(intent,candidate,async () => {});
}
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); for (const migration of migrations) db.exec(migration);
  now = Math.floor(Date.now()/1000); sql = []; for (const key of Object.keys(flags.env)) delete flags.env[key];
  policy = {catalog:[{offer,seatLimit:10}],environment:'TEST',now};
  for (const [id,joined] of [['ch-b',2],['ch-a',1]] as const) {
    db.prepare('INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,?,?,?,?)').run('sub-'+id,'cus-'+id,'price-'+id,'active',now+3600,now);
    db.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'Same business name','sub-'+id,actor,now,now);
    db.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,'fixture@example.invalid','owner',?)").run('member-'+id,id,actor,joined);
  }
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

describe('account metadata discovery, separate from licences and US product access', () => {
  it('uses all 88 migrations and returns CH then ready US with exactly four public fields', async () => {
    expect(files).toHaveLength(88); await ready(); const before = snapshot();
    const changes = db.prepare('SELECT total_changes() AS count').get();
    const workspaces = await accountWorkspacesForUser(actor,readOptions());
    expect(workspaces).toEqual([{organizationId:'ch-a',name:'Same business name',edition:'ch_legacy',role:'owner'},{organizationId:'ch-b',name:'Same business name',edition:'ch_legacy',role:'owner'},{organizationId:org,name:'Same business name',edition:'us_experimental',role:'owner'}]);
    for (const workspace of workspaces) expect(Object.keys(workspace).sort()).toEqual(['edition','name','organizationId','role']);
    expect(snapshot()).toEqual(before); expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(sql).toHaveLength(2); expect(sql.join(' ')).not.toMatch(/\b(?:SELECT\s+\*|offer_json|authority_json|pg_receipt_json|configuration_json|catalog_version|endsAt|startsAt)\b/i);
    expect(JSON.stringify(workspaces)).not.toMatch(/sub_|price_|evidence|receipt|123456789|12-3456789/);
  });
  it.each(['admin','accountant','member','read_only'] as const)('lists active US %s separately from the owner', async role => {
    await ready(); db.prepare('INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,joined_at) VALUES(?,?,?,?,?)').run('fixture-collaborator',org,collaborator,role,now);
    expect(await accountWorkspacesForUser(collaborator,readOptions())).toEqual([{organizationId:org,name:'Same business name',edition:'us_experimental',role}]);
  });
  it('never discovers another account or a postgres_confirmed intention', async () => {
    await confirmed(); expect(await accountWorkspacesForUser(actor,readOptions())).toHaveLength(2);
    expect(await accountWorkspacesForUser(foreign,readOptions())).toEqual([]);
    await ready(); expect(await accountWorkspacesForUser(foreign,readOptions())).toEqual([]);
  });
  it('excludes reserved intentions', async () => {
    const saved = await confirmed();
    const pendingOrg = '66666666-6666-4666-8666-666666666666';
    await d1WorkspaceCreationStore(adapter(db) as unknown as Pick<D1Database,'prepare'|'batch'>).reserve({ ...saved, organizationId:pendingOrg, creationId:'77777777-7777-4777-8777-777777777777', requestId:'88888888-8888-4888-8888-888888888888', configuration:{...saved.configuration,organizationId:pendingOrg}, state:'reserved', receipt:null });
    expect(await accountWorkspacesForUser(actor,readOptions())).toHaveLength(2);
  });
  it.each(['caller','owner'] as const)('excludes a workspace after %s revocation', async target => {
    await ready(); db.prepare("INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,joined_at) VALUES(?,?,?,'member',?)").run('fixture-collaborator',org,collaborator,now);
    db.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE organization_id=? AND user_id=?').run(now,org,target==='owner'?actor:collaborator);
    expect(await accountWorkspacesForUser(collaborator,readOptions())).toEqual([]);
  });
  it('keeps expired/revoked authority discoverable while the independent access reader denies it', async () => {
    await ready(); const store = d1UsAuthorityStore(adapter(db) as unknown as Pick<D1Database,'prepare'|'batch'>);
    await expect(store.access(org,actor,{...policy,now:now+3600})).rejects.toMatchObject({code:'subscription_required'});
    expect((await accountWorkspacesForUser(actor,readOptions())).at(-1)?.organizationId).toBe(org);
    db.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(now,org);
    await expect(store.access(org,actor,policy)).rejects.toMatchObject({code:'subscription_required'});
    expect((await accountWorkspacesForUser(actor,readOptions())).at(-1)?.organizationId).toBe(org);
  });
  it('uses fresh metadata on every call rather than caching revoked membership', async () => {
    await ready(); expect(await accountWorkspacesForUser(actor,readOptions())).toHaveLength(3);
    db.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE organization_id=? AND user_id=?').run(now,org,actor);
    expect(await accountWorkspacesForUser(actor,readOptions())).toHaveLength(2);
  });
  it('can project a fresh CH membership list without reading its private subscriptionId or SQL', async () => {
    const database: AccountWorkspaceReadDatabase = {prepare(){throw new Error('Unexpected database access');}};
    expect(await accountWorkspacesForUser(actor,{database,usEnabled:false,legacyMemberships:[{organizationId:'legacy-any-id',organizationName:'Unchanged name',role:'accountant',subscriptionId:'private_CH'}]})).toEqual([{organizationId:'legacy-any-id',name:'Unchanged name',edition:'ch_legacy',role:'accountant'}]);
  });
  it('keeps CH usable without the US schema when flags are closed and fails closed when open', async () => {
    const old = new DatabaseSync(':memory:');
    try {
      old.exec("CREATE TABLE organizations(organization_id TEXT,name TEXT); CREATE TABLE organization_members(organization_id TEXT,user_id TEXT,role TEXT,joined_at INTEGER,revoked_at INTEGER); INSERT INTO organizations VALUES('old-CH','Old CH');");
      old.prepare("INSERT INTO organization_members VALUES('old-CH',?,'owner',1,NULL)").run(actor);
      const database = adapter(old);
      expect(await accountWorkspacesForUser(actor,{database,usEnabled:false})).toEqual([{organizationId:'old-CH',name:'Old CH',edition:'ch_legacy',role:'owner'}]);
      expect(sql.every(query => !query.includes('international_'))).toBe(true);
      await expect(accountWorkspacesForUser(actor,{database,usEnabled:true})).rejects.toMatchObject({code:'service_unavailable',status:503});
    } finally { old.close(); }
  });
  it.each([{}, {INTERNATIONAL_CORE_ENABLED:'true'}, {INTERNATIONAL_US_ERP_ENABLED:'true'}, {INTERNATIONAL_CORE_ENABLED:'true',INTERNATIONAL_US_ERP_ENABLED:'TRUE'}])('defaults closed for %j without querying US', async configured => {
    Object.assign(flags.env,configured); expect(await accountWorkspaceDiscoveryEnabled()).toBe(false);
    expect(await accountWorkspacesForUser(actor,{database:adapter(db)})).toHaveLength(2); expect(sql).toHaveLength(1); expect(sql[0]).not.toContain('international_');
  });
  it('requires both flags and rechecks them before returning US descriptors', async () => {
    await ready(); Object.assign(flags.env,{INTERNATIONAL_CORE_ENABLED:'true',INTERNATIONAL_US_ERP_ENABLED:'true'});
    expect(await accountWorkspaceDiscoveryEnabled()).toBe(true); expect(await accountWorkspacesForUser(actor,{database:adapter(db)})).toHaveLength(3);
    const base = adapter(db); const changing: AccountWorkspaceReadDatabase = {prepare(query){const statement=base.prepare(query);return {bind(...args){const bound=statement.bind(...args);return {async all<T>(){const result=await bound.all<T>();if(query.includes('FROM international_workspace_members caller'))flags.env.INTERNATIONAL_US_ERP_ENABLED='false';return result;}};}};}};
    expect(await accountWorkspacesForUser(actor,{database:changing})).toHaveLength(2);
  });
  it('refuses invalid Auth identifiers and database failures with only a generic typed error', async () => {
    const database: AccountWorkspaceReadDatabase = {prepare(){throw new Error('private database details');}};
    await expect(accountWorkspacesForUser('unverified-user',{database,usEnabled:true})).rejects.toMatchObject({message:'service_unavailable',status:503});
    await expect(accountWorkspacesForUser(actor,{database,usEnabled:true})).rejects.toMatchObject({message:'service_unavailable',status:503});
  });
});
