import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGACY_COUNTRY_GUARD_CODE, requireLegacyCountryTransport } from './legacy-country-guard';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { validateCompanyConfiguration } from './country-config';
import { canonicalCreationJson, createOrResumeUsWorkspace, validateWorkspaceCreationRequest, type WorkspaceCreationIntent, type WorkspaceCreationPorts, type WorkspaceCreationReceipt } from './workspace-creation';

const folder = new URL('../../drizzle/', import.meta.url);
const guardName = '0086_international_legacy_country_guards.sql';
const intentionName = '0085_international_workspace_creation_intents.sql';
const migrations = readdirSync(folder).filter(name => name.endsWith('.sql')).sort();
const read = (name: string) => readFileSync(new URL(name, folder), 'utf8');
const guardSql = read(guardName);
const states = ['reserved', 'postgres_confirmed', 'ready'] as const;
const isTarget = (name: string) => name.startsWith('business_sync_') || ['company_copies', 'document_number_reservations', 'workspace_backups', 'workspace_backup_chunks'].includes(name);
const quote = (name: string) => '"' + name + '"';
type Row = Record<string, SQLInputValue>;
type Column = { name: string; type: string; pk: number };
const identityColumns = ['organization_id', 'transfer_id', 'transaction_id', 'source_transfer_id', 'bootstrap_transfer_id', 'backup_id'];

function baseDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF');
  for (const name of migrations.filter(name => name < intentionName)) db.exec(read(name));
  return db;
}
function columns(db: DatabaseSync, table: string) {
  return db.prepare('PRAGMA table_info(' + quote(table) + ')').all() as Column[];
}
function targets(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name).filter(isTarget).sort();
}
function rowFor(db: DatabaseSync, table: string, prefix: string): Row {
  const row: Row = {};
  for (const column of columns(db, table)) {
    if (column.pk && column.type.toLowerCase() === 'integer') continue;
    row[column.name] = column.name === 'organization_id' ? prefix + '-company'
      : ['transfer_id', 'transaction_id', 'bootstrap_transfer_id'].includes(column.name) ? prefix + '-transfer'
      : column.name === 'source_transfer_id' ? prefix + '-source'
      : column.name === 'backup_id' ? prefix + '-backup'
      : column.type.toLowerCase() === 'integer' ? 1
      : column.name.endsWith('_json') ? '{}'
      : prefix + '-fixture';
  }
  return row;
}
function insert(table: string, row: Row, verb = 'INSERT') {
  return { sql: `${verb} INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, values: Object.values(row) };
}
function write(db: DatabaseSync, table: string, row: Row, verb = 'INSERT') {
  const statement = insert(table, row, verb);
  db.prepare(statement.sql).run(...statement.values);
}
function seedCompany(db: DatabaseSync, prefix: string) {
  db.prepare("INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES(?,?,?,'active',2000000000,0,1)").run(prefix + '-subscription', prefix + '-customer', 'legacy-test-price');
  db.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(prefix + '-company', prefix + '-name', prefix + '-subscription', prefix + '-owner');
  write(db, 'business_sync_transfers', rowFor(db, 'business_sync_transfers', prefix));
  write(db, 'business_sync_transfers', { ...rowFor(db, 'business_sync_transfers', prefix), transfer_id: prefix + '-source', revision: 2 });
  write(db, 'workspace_backups', rowFor(db, 'workspace_backups', prefix));
  for (const table of targets(db).filter(table => !['business_sync_transfers', 'workspace_backups'].includes(table))) write(db, table, rowFor(db, table, prefix));
}
function intentionRow(state: typeof states[number]): Row {
  const receipt = state === 'reserved' ? null : JSON.stringify({ creationId: 'us-creation', organizationId: 'us-company', actorUserId: 'us-owner', requestId: 'us-request', configurationFingerprint: 'a'.repeat(64), revision: 1 });
  return { creation_id: 'us-creation', organization_id: 'us-company', actor_user_id: 'us-owner', request_id: 'us-request', country_code: 'US', confirmation_version: 1, company_name: 'Synthetic US company', configuration_fingerprint: 'a'.repeat(64), configuration_json: '{"country":"US","currency":"USD","organizationId":"us-company","taxConfiguration":{"status":"unconfigured"}}', state, pg_receipt_json: receipt, own_subscription_id: state === 'ready' ? 'us-subscription' : null, created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' };
}

/** Test only the fence in all states; workflow admission has its own tests.
 * Use the actual 0085 table DDL but intentionally omit its transition triggers
 * when creating synthetic pre-existing legacy rows. This is not a valid US
 * creation path and is never presented as a receipt/finalization proof. */
function fenceFixture(state: typeof states[number]) {
  const db = baseDatabase();
  const actualTable = read(intentionName).split('--> statement-breakpoint').find(statement => /CREATE TABLE\s+[`"]?international_workspace_creation_intents\b/.test(statement));
  if (!actualTable) throw new Error('0085 actual intention table DDL missing');
  db.exec(actualTable);
  write(db, 'international_workspace_creation_intents', intentionRow(state));
  seedCompany(db, 'us');
  seedCompany(db, 'ch');
  return db;
}
function blocked(db: DatabaseSync, sql: string, ...values: SQLInputValue[]) {
  expect(() => db.prepare(sql).run(...values), sql).toThrow(LEGACY_COUNTRY_GUARD_CODE);
}
function snapshot(db: DatabaseSync, table: string) {
  return db.prepare('SELECT rowid AS qa_rowid,* FROM ' + quote(table) + ' ORDER BY rowid').all();
}
function uniqueKeys(db: DatabaseSync, table: string) {
  const primary = columns(db, table).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
  const indexes = db.prepare('PRAGMA index_list(' + quote(table) + ')').all() as { name: string; unique: number }[];
  const keys = indexes.filter(index => index.unique).map(index => (db.prepare('PRAGMA index_info(' + quote(index.name) + ')').all() as { name: string }[]).map(column => column.name));
  if (primary.length) keys.push(primary);
  return keys;
}

describe('0086 actual SQLite legacy country fences', () => {
  it.each(states)('blocks every direct/indirect INSERT, UPDATE and DELETE while %s without touching CH', state => {
    const db = fenceFixture(state);
    try {
      const before = Object.fromEntries(targets(db).map(table => [table, snapshot(db, table)]));
      db.exec(guardSql);
      expect(targets(db)).toHaveLength(38);
      for (const table of targets(db)) {
        const row = rowFor(db, table, 'us');
        const creation = insert(table, row);
        blocked(db, creation.sql, ...creation.values);
        const duplicate = insert(table, row, 'INSERT OR IGNORE');
        blocked(db, duplicate.sql, ...duplicate.values);
        const column = Object.keys(row)[0];
        blocked(db, `UPDATE ${quote(table)} SET ${quote(column)}=${quote(column)} WHERE rowid=1`);
        blocked(db, `DELETE FROM ${quote(table)} WHERE rowid=1`);
        expect(snapshot(db, table), table).toEqual(before[table]);
      }
      // New CH data still supports every real table's insert/update/delete.
      seedCompany(db, 'other-ch');
      for (const table of targets(db)) {
        const row = rowFor(db, table, 'other-ch');
        const key = Object.keys(row)[0];
        expect(() => db.prepare(`UPDATE ${quote(table)} SET ${quote(key)}=${quote(key)} WHERE ${quote(key)}=?`).run(row[key]), table).not.toThrow();
      }
      // Delete children before their transfer/backup/organization parents.
      for (const table of targets(db).filter(table => !['business_sync_transfers', 'workspace_backups'].includes(table))) {
        const row = rowFor(db, table, 'other-ch');
        const key = Object.keys(row)[0];
        expect(() => db.prepare(`DELETE FROM ${quote(table)} WHERE ${quote(key)}=?`).run(row[key]), table).not.toThrow();
      }
      expect(() => db.prepare("DELETE FROM business_sync_transfers WHERE organization_id='other-ch-company'").run()).not.toThrow();
      expect(() => db.prepare("DELETE FROM workspace_backups WHERE organization_id='other-ch-company'").run()).not.toThrow();
    } finally { db.close(); }
  });

  it('rejects forged CH labels pointing at US parent/source identities and refuses OLD identity detachment', () => {
    const db = fenceFixture('reserved');
    try {
      db.exec(guardSql);
      for (const table of targets(db)) {
        const us = rowFor(db, table, 'us');
        const ch = rowFor(db, table, 'ch');
        const oldRow = db.prepare(`SELECT rowid AS qa_rowid,* FROM ${quote(table)} WHERE rowid=1`).get()!;
        const chKey = Object.keys(ch)[0];
        for (const column of identityColumns.filter(column => column in us)) {
          const forged = insert(table, { ...ch, [column]: us[column] });
          blocked(db, forged.sql, ...forged.values);
          blocked(db, `UPDATE ${quote(table)} SET ${quote(column)}=? WHERE ${quote(chKey)}=?`, us[column], ch[chKey]);
        }
        const changed = identityColumns.filter(column => column in us);
        blocked(db, `UPDATE ${quote(table)} SET ${changed.map(column => quote(column) + '=?').join(',')} WHERE rowid=?`, ...changed.map(column => ch[column]), oldRow.qa_rowid);
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get()!.n).toBe(table === 'business_sync_transfers' ? 4 : 2);
      }
    } finally { db.close(); }
  });

  it('fences implicit REPLACE deletions on every real PK/unique identity with recursive triggers disabled', () => {
    const db = fenceFixture('reserved');
    try {
      db.exec(guardSql);
      expect(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers).toBe(0);
      for (const table of targets(db)) {
        const stored = db.prepare('SELECT * FROM ' + quote(table) + ' WHERE rowid=1').get() as Row;
        const ch = { ...stored, ...rowFor(db, table, 'ch') };
        const keys = uniqueKeys(db, table);
        expect(keys.length, table).toBeGreaterThan(0);
        const before = snapshot(db, table);
        for (const key of keys) {
          const collision = { ...ch, ...Object.fromEntries(key.map(column => [column, stored[column]])) };
          const statement = insert(table, collision, 'INSERT OR REPLACE');
          blocked(db, statement.sql, ...statement.values);
        }
        expect(snapshot(db, table), table).toEqual(before);
      }
    } finally { db.close(); }
  });

  it('preserves exact US object namespaces even with a forged CH parent and distinguishes nearby names', () => {
    const db = fenceFixture('reserved');
    try {
      const tables = targets(db).filter(table => columns(db, table).some(column => column.name === 'object_key'));
      expect(tables).toHaveLength(4);
      for (const table of tables) {
        const ch = rowFor(db, table, 'ch');
        const key = Object.keys(ch)[0];
        db.prepare(`UPDATE ${quote(table)} SET object_key=? WHERE ${quote(key)}=?`).run('business-sync/us-company/orphan/prepared-object', ch[key]);
      }
      db.exec(guardSql);
      for (const table of tables) {
        const ch = rowFor(db, table, 'ch');
        const key = Object.keys(ch)[0];
        blocked(db, `UPDATE ${quote(table)} SET object_key='business-sync/ch-company/relabel' WHERE ${quote(key)}=?`, ch[key]);
        blocked(db, `DELETE FROM ${quote(table)} WHERE ${quote(key)}=?`, ch[key]);
        const nearby: Row = { ...rowFor(db, table, 'other-ch'), object_key: 'business-sync/us-company-other/not-the-US-identity', transfer_id: 'ch-transfer', transaction_id: 'ch-transfer' };
        for (const column of Object.keys(nearby).filter(column => !columns(db, table).some(actual => actual.name === column))) delete nearby[column];
        if ('chunk_index' in nearby) nearby.chunk_index = 2;
        if ('part_index' in nearby) nearby.part_index = 2;
        expect(() => write(db, table, nearby), table).not.toThrow();
        const creation = insert(table, { ...nearby, object_key: 'business-sync/us-company/new-object' });
        blocked(db, creation.sql, ...creation.values);
      }
    } finally { db.close(); }
  });

  it('loads the complete migration chain with exactly three fences per actual table and no account fences', () => {
    const db = baseDatabase();
    try {
      for (const name of migrations.filter(name => name >= intentionName)) db.exec(read(name));
      const rows = db.prepare("SELECT tbl_name AS target,name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'international_legacy_%'").all() as { target: string; name: string }[];
      expect(rows).toHaveLength(114);
      expect([...new Set(rows.map(row => row.target))].sort()).toEqual(targets(db));
      for (const table of targets(db)) for (const operation of ['insert', 'update', 'delete']) expect(rows.some(row => row.name === 'international_legacy_' + table + '_' + operation), table + ':' + operation).toBe(true);
      expect(rows.some(row => ['organizations', 'organization_members', 'subscriptions'].includes(row.target))).toBe(false);
    } finally { db.close(); }
  });

  it.each(states)('the API preflight queries the actual SQL identity while %s and admits a separate CH company', async state => {
    const db = fenceFixture(state);
    try {
      const adapter = { prepare: (sql: string) => ({ bind: (organizationId: string) => ({ first: async <T>() => (db.prepare(sql).get(organizationId) ?? null) as T | null }) }) };
      await expect(requireLegacyCountryTransport('us-company', adapter)).rejects.toMatchObject({ status: 409, code: LEGACY_COUNTRY_GUARD_CODE });
      await expect(requireLegacyCountryTransport('ch-company', adapter)).resolves.toBeUndefined();
    } finally { db.close(); }
  });
});

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');

it('applies the complete actual migration chain in workerd D1 and serializes a fresh reservation before legacy bootstrap', async () => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local D1 migration test"); } }', d1Databases: ['DB'], compatibilityDate: '2026-05-15' });
  const reference = baseDatabase();
  try {
    const db: D1Database = await runtime.getD1Database('DB');
    for (const name of migrations) for (const statement of read(name).split('--> statement-breakpoint').filter(statement => statement.trim())) await db.prepare(statement).run();
    for (const table of targets(reference)) {
      const actual = (await db.prepare('PRAGMA table_info(' + quote(table) + ')').all()).results.map(row => row.name);
      expect(actual, table).toEqual(columns(reference, table).map(column => column.name));
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'international_legacy_%'").first()).toEqual({ n: 114 });
    const intention = insert('international_workspace_creation_intents', intentionRow('reserved'));
    const bootstrap = insert('business_sync_spaces', rowFor(reference, 'business_sync_spaces', 'us'));
    await expect(db.batch([
      db.prepare(intention.sql).bind(...intention.values),
      db.prepare(bootstrap.sql).bind(...bootstrap.values),
    ])).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM international_workspace_creation_intents WHERE organization_id='us-company'").first()).toEqual({ n: 0 });
    await db.prepare(intention.sql).bind(...intention.values).run();
    await expect(db.prepare(bootstrap.sql).bind(...bootstrap.values).run()).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
    await expect(requireLegacyCountryTransport('us-company', db)).rejects.toMatchObject({ status: 409 });
    // Phase admission is still closed even with a fabricated matching receipt.
    const ready = intentionRow('ready');
    await expect(db.prepare("UPDATE international_workspace_creation_intents SET state='ready',pg_receipt_json=?,own_subscription_id=? WHERE organization_id='us-company'").bind(ready.pg_receipt_json, ready.own_subscription_id).run()).rejects.toThrow('international_us_ready_not_admitted');

    const actor = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const stamp = '2026-10-08T12:00:00.000Z';
    const request = validateWorkspaceCreationRequest({ requestId, confirmationVersion: 1, companyName: 'Synthetic US Company', configuration: { schemaVersion: 1, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '10 Example St', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } } });
    const fingerprint = createHash('sha256').update(canonicalCreationJson({ confirmationVersion: request.confirmationVersion, companyName: request.companyName, configuration: request.configuration })).digest('hex');
    let serial = 0;
    const allocateId = () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(++serial).padStart(12, '0');
    const store = d1WorkspaceCreationStore(db);
    const candidates: WorkspaceCreationIntent[] = Array.from({ length: 8 }, () => {
      const organizationId = allocateId();
      return { creationId: allocateId(), organizationId, actorUserId: actor, requestId, confirmationVersion: 1, companyName: request.companyName, fingerprint, configuration: validateCompanyConfiguration({ ...request.configuration, organizationId }), state: 'reserved', receipt: null, createdAt: stamp, updatedAt: stamp };
    });
    const reservations = await Promise.all(candidates.map(candidate => store.reserve(candidate)));
    const winner = reservations[0];
    expect(new Set(candidates.map(candidate => candidate.organizationId)).size).toBe(8);
    expect(reservations.every(saved => canonicalCreationJson(saved) === canonicalCreationJson(winner))).toBe(true);
    expect(await store.find(actor, requestId)).toEqual(winner);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM international_workspace_creation_intents WHERE actor_user_id=? AND request_id=?').bind(actor, requestId).first()).toEqual({ n: 1 });
    expect(await store.find('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', requestId)).toBeNull();
    // This port is explicitly synthetic: it is NOT the PostgreSQL RPC and
    // demonstrates only D1 confirmation, exact binding and durable retries.
    const simulatedReceipt = (intent: WorkspaceCreationIntent, replayed = false): WorkspaceCreationReceipt => ({ creationId: intent.creationId, organizationId: intent.organizationId, actorUserId: intent.actorUserId, requestId: intent.requestId, configurationFingerprint: intent.fingerprint, configuration: intent.configuration, revision: 1, updatedBy: intent.actorUserId, updatedAt: stamp, replayed });
    const confirmed = await store.confirm(winner, simulatedReceipt(winner), stamp);
    expect(await store.confirm(winner, simulatedReceipt(winner, true), '2026-10-08T12:01:00.000Z')).toEqual(confirmed);
    expect(confirmed.receipt?.replayed).toBe(false);
    expect(await store.find(actor, requestId)).toEqual(confirmed);

    const serviceRequest = { ...request, requestId: '33333333-3333-4333-8333-333333333333' };
    const simulatedReceipts = new Map<string, WorkspaceCreationReceipt>();
    let admissions = 0, authorityChecks = 0;
    const ports: WorkspaceCreationPorts = {
      store, allocateId, now: () => stamp,
      fingerprint: async value => createHash('sha256').update(value).digest('hex'),
      admit: async intent => {
        admissions++;
        const old = simulatedReceipts.get(intent.creationId);
        if (old) return { ...old, replayed: true };
        const receipt = simulatedReceipt(intent);
        simulatedReceipts.set(intent.creationId, receipt);
        return receipt;
      },
      revalidate: async () => { authorityChecks++; },
    };
    const completed = await Promise.all(Array.from({ length: 8 }, () => createOrResumeUsWorkspace(actor, serviceRequest, ports)));
    const serviceWinner = completed[0];
    expect(completed.every(saved => canonicalCreationJson(saved) === canonicalCreationJson(serviceWinner))).toBe(true);
    expect(serviceWinner.state).toBe('postgres_confirmed');
    expect(simulatedReceipts.size).toBe(1);
    expect(authorityChecks).toBeGreaterThan(8);
    const allocated = serial, calls = admissions;
    expect(await createOrResumeUsWorkspace(actor, serviceRequest, ports)).toEqual(serviceWinner);
    expect(serial).toBe(allocated);
    expect(admissions).toBe(calls);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM international_workspace_creation_intents WHERE actor_user_id=? AND request_id=?').bind(actor, serviceRequest.requestId).first()).toEqual({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM organizations').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM organization_members').first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM international_workspace_creation_intents WHERE state='ready' OR own_subscription_id IS NOT NULL").first()).toEqual({ n: 0 });
  } finally { reference.close(); await runtime.dispose(); }
}, 90_000);

it('executes the actual 114 fences in the pinned workerd D1 runtime, with all states and atomic rollback', async () => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local D1 guard test"); } }', d1Databases: ['DB'], compatibilityDate: '2026-05-15' });
  const source = fenceFixture('reserved');
  try {
    const db: D1Database = await runtime.getD1Database('DB');
    // The final table/index SQL comes from executing the real production
    // migrations in SQLite; apply the unmodified 0086 migration in workerd.
    const names = [...targets(source), 'subscriptions', 'organizations', 'international_workspace_creation_intents'];
    const objects = source.prepare("SELECT type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN('table','index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all() as { type: string; tbl_name: string; sql: string }[];
    for (const object of objects.filter(object => names.includes(object.tbl_name))) await db.prepare(object.sql).run();
    for (const table of ['subscriptions', 'organizations', 'international_workspace_creation_intents', 'business_sync_transfers', 'workspace_backups', ...targets(source).filter(table => !['business_sync_transfers', 'workspace_backups'].includes(table))]) {
      for (const row of source.prepare('SELECT * FROM ' + quote(table)).all() as Row[]) {
        const statement = insert(table, row);
        await db.prepare(statement.sql).bind(...statement.values).run();
      }
    }
    for (const statement of guardSql.split('--> statement-breakpoint')) await db.prepare(statement).run();
    for (const state of states) {
      // Synthetic state selection isolates the fence, not admission/finalization.
      const intention = intentionRow(state);
      await db.prepare('UPDATE international_workspace_creation_intents SET state=?,pg_receipt_json=?,own_subscription_id=? WHERE organization_id=?').bind(state, intention.pg_receipt_json, intention.own_subscription_id, 'us-company').run();
      for (const table of targets(source)) {
        const row = rowFor(source, table, 'us');
        const statement = insert(table, row);
        await expect(db.prepare(statement.sql).bind(...statement.values).run(), table + ':insert:' + state).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
        const key = Object.keys(row)[0];
        await expect(db.prepare(`UPDATE ${quote(table)} SET ${quote(key)}=${quote(key)} WHERE rowid=1`).run(), table + ':update:' + state).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
        await expect(db.prepare(`DELETE FROM ${quote(table)} WHERE rowid=1`).run(), table + ':delete:' + state).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
        await expect(db.prepare(`UPDATE ${quote(table)} SET ${quote(key)}=${quote(key)} WHERE ${quote(key)}=?`).bind(rowFor(source, table, 'ch')[key]).run(), table + ':legacy-ch').resolves.toMatchObject({ success: true });
      }
      await expect(requireLegacyCountryTransport('us-company', db)).rejects.toMatchObject({ code: LEGACY_COUNTRY_GUARD_CODE });
      await expect(requireLegacyCountryTransport('ch-company', db)).resolves.toBeUndefined();
    }
    for (const table of targets(source)) {
      const us = rowFor(source, table, 'us');
      const ch = rowFor(source, table, 'ch');
      const chKey = Object.keys(ch)[0];
      for (const column of identityColumns.filter(column => column in us)) {
        const forged = insert(table, { ...ch, [column]: us[column] });
        await expect(db.prepare(forged.sql).bind(...forged.values).run(), table + ':forged:' + column).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
        await expect(db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE ${quote(chKey)}=?`).bind(us[column], ch[chKey]).run(), table + ':new:' + column).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
      }
      if ('object_key' in ch) {
        const forged = insert(table, { ...ch, object_key: 'business-sync/us-company/forged-ch-parent' });
        await expect(db.prepare(forged.sql).bind(...forged.values).run(), table + ':namespace-insert').rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
        await expect(db.prepare(`UPDATE ${quote(table)} SET object_key=? WHERE ${quote(chKey)}=?`).bind('business-sync/us-company/forged-ch-parent', ch[chKey]).run(), table + ':namespace-update').rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
      }
      const changed = identityColumns.filter(column => column in us);
      await expect(db.prepare(`UPDATE ${quote(table)} SET ${changed.map(column => quote(column) + '=?').join(',')} WHERE rowid=1`).bind(...changed.map(column => ch[column])).run(), table + ':old-detachment').rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
      const stored = source.prepare('SELECT * FROM ' + quote(table) + ' WHERE rowid=1').get() as Row;
      for (const key of uniqueKeys(source, table)) {
        const collision = { ...stored, ...ch, ...Object.fromEntries(key.map(column => [column, stored[column]])) };
        const statement = insert(table, collision, 'INSERT OR REPLACE');
        await expect(db.prepare(statement.sql).bind(...statement.values).run(), table + ':replace').rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
      }
      expect((await db.prepare('SELECT * FROM ' + quote(table) + ' ORDER BY rowid').all()).results, table + ':unchanged').toEqual(source.prepare('SELECT * FROM ' + quote(table) + ' ORDER BY rowid').all());
    }
    const head = await db.prepare("SELECT head_revision FROM business_sync_spaces WHERE organization_id='ch-company'").first();
    await expect(db.batch([
      db.prepare("UPDATE business_sync_spaces SET head_revision=99 WHERE organization_id='ch-company'"),
      db.prepare("UPDATE business_sync_spaces SET head_revision=99 WHERE organization_id='us-company'"),
    ])).rejects.toThrow(LEGACY_COUNTRY_GUARD_CODE);
    expect(await db.prepare("SELECT head_revision FROM business_sync_spaces WHERE organization_id='ch-company'").first()).toEqual(head);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'international_legacy_%'").first()).toEqual({ n: 114 });
  } finally { source.close(); await runtime.dispose(); }
}, 90_000);
