import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  session: vi.fn(),
  rate: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({ database: mocks.db }));
vi.mock('@/lib/account', async (original) => ({
  ...(await original<typeof import('./account')>()),
  requireDeviceSession: mocks.session,
  enforceAccountRateLimit: mocks.rate,
}));
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncContractHash } from './business-sync-bootstrap';
import { structuralRules, structuralSchema } from './business-sync-structure';
import {
  structuralValidatorHash,
  validateBootstrapStructure,
} from './business-sync-validation';
import {
  bootstrapIntegrityStatus,
  validateBootstrapIntegrity,
  AUDIT_ROWS_PER_PASS,
  ACCOUNTING_RULES_PER_PASS,
  bootstrapAccountingRules,
} from './business-sync-integrity';
import { GET, POST } from '../app/api/sync/bootstrap/integrity/route';

let db: DatabaseSync;
let beforeQuery: ((sql: string) => void) | undefined;
let afterRead: ((sql: string) => Promise<void>) | undefined;
let beforeBatch: ((statements: Statement[]) => void) | undefined;
type Scalar = string | number | null;
type Statement = ReturnType<typeof prepare>;
function prepare(sql: string) {
  let values: Scalar[] = [];
  const start = () => {
    beforeQuery?.(sql);
    return db.prepare(sql);
  };
  const statement = {
    sql,
    bind: (...args: Scalar[]) => {
      expect(args.length).toBeLessThanOrEqual(100);
      values = args;
      return statement;
    },
    execute: () => ({
      meta: { changes: Number(start().run(...values).changes) },
    }),
    run: async () => statement.execute(),
    first: async () => {
      const row = start().get(...values) ?? null;
      await afterRead?.(sql);
      return row;
    },
    all: async () => ({ results: start().all(...values) }),
  };
  return statement;
}
const id = '11111111-1111-4111-8111-111111111111';
const owner: DeviceSessionContext = {
  organizationId: 'org_first',
  organizationName: 'First',
  installationId: 'pc',
  userId: 'owner',
  role: 'owner',
  sessionId: 'session',
  subscriptionId: 'sub',
  entitlementValidUntil: 2000000000,
};
beforeEach(async () => {
  vi.clearAllMocks();
  beforeQuery = undefined;
  afterRead = undefined;
  beforeBatch = undefined;
  db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1);
    INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1);
    INSERT INTO business_sync_spaces VALUES('org_first','generation','${id}','initializing',0,'owner','2026-09-08');`);
  db.prepare(
    "INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at) VALUES(?,'org_first','pc','owner','generation','bootstrap','uploaded',0,'{}','hash','2026-09-08')",
  ).run(id);
  const native = new DatabaseSync(':memory:');
  try {
    native.exec(structuralSchema.tables.settings.sql);
    native.exec(
      "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise fictive','2026-09-08','2026-09-08')",
    );
    const fields = protocol.tables.settings.columns;
    const value = native
      .prepare(
        `SELECT json_object(${fields.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) json FROM settings`,
      )
      .get()!.json as string;
    db.prepare(
      "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','settings','[1]',?,?)",
    ).run(id, value, await sha256Hex(value));
  } finally {
    native.close();
  }
  mocks.db.mockReturnValue({
    prepare,
    batch: async (statements: Statement[]) => {
      beforeBatch?.(statements);
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  mocks.session.mockResolvedValue(owner);
  await manifest();
});
afterEach(() => db.close());
async function manifest() {
  const counts = Object.fromEntries(
    Object.keys(protocol.tables).map((name) => [
      name,
      Number(
        db
          .prepare(
            'SELECT COUNT(*) n FROM business_sync_versions WHERE table_name=?',
          )
          .get(name)!.n,
      ),
    ]),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chunks = Array.from({ length: Math.ceil(total / 200) }, (_, i) => ({
    sha256: 'a'.repeat(64),
    size_bytes: 1,
    row_count: Math.min(200, total - i * 200),
  }));
  const text = JSON.stringify({
    format: 'zentra-business-bootstrap',
    version: 1,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    tables: counts,
    chunks,
    row_count: total,
    size_bytes: chunks.length,
  });
  db.prepare(
    'UPDATE business_sync_transfers SET manifest_json=?,manifest_sha256=?',
  ).run(text, await sha256Hex(text));
}
type Audit = Record<string, string | null>;
async function audit(
  count: number,
  previous: string | null = null,
  payload = '{"texte":"Écriture fictive\\nMontant"}',
): Promise<Audit[]> {
  const data: Audit[] = [];
  for (let at = 0; at < count; at++) {
    const item: Audit = {
      id: `audit-${String(count - at).padStart(6, '0')}-${String(previous).slice(0, 6)}`,
      occurred_at: '2026-09-08',
      actor: 'local_user',
      action: 'test',
      entity_type: 'fixture',
      entity_id: 'fiction',
      payload_json: payload,
      previous_hash: previous,
    };
    item.entry_hash = await sha256Hex(
      [
        previous ?? '',
        item.id,
        item.occurred_at,
        item.actor,
        item.action,
        item.entity_type,
        item.entity_id,
        item.payload_json,
      ].join('\n'),
    );
    const json = JSON.stringify(item);
    db.prepare(
      "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','audit_log',?,?,?)",
    ).run(id, JSON.stringify([item.id]), json, await sha256Hex(json));
    data.push(item);
    previous = item.entry_hash;
  }
  await manifest();
  return data;
}
async function structure() {
  let status = await validateBootstrapStructure(owner, id);
  for (let i = 0; i < 100 && status.state === 'checking'; i++)
    status = await validateBootstrapStructure(owner, id);
  expect(status).toMatchObject({
    state: 'valid',
    checked_rules: structuralRules.length,
  });
}
async function finish() {
  let status = await bootstrapIntegrityStatus(owner, id);
  for (let i = 0; i < 200 && !['valid', 'invalid'].includes(status.state); i++)
    status = await validateBootstrapIntegrity(owner, id);
  return status;
}
async function accounting() {
  let status = await validateBootstrapIntegrity(owner, id);
  for (
    let at = 0;
    at < bootstrapAccountingRules.length + 10 &&
    ['accounting', 'projecting'].includes(status.state);
    at++
  )
    status = await validateBootstrapIntegrity(owner, id);
  expect(status.state).toBe('indexing');
  return status;
}
it('resumes bounded accounting rules after a lost response and does not advance on an interrupted pass', async () => {
  await structure();
  const first = await validateBootstrapIntegrity(owner, id);
  expect(first).toMatchObject({
    state: 'accounting',
    checked_accounting_rules: ACCOUNTING_RULES_PER_PASS,
    indexed_audit_entries: 0,
  });
  expect(await bootstrapIntegrityStatus(owner, id)).toEqual(first);
  let checked = 0;
  beforeQuery = (sql) => {
    if (
      bootstrapAccountingRules.some((rule) => rule.sql === sql) &&
      ++checked === 2
    )
      throw new Error('Accounting connection interrupted');
  };
  await expect(validateBootstrapIntegrity(owner, id)).rejects.toThrow(
    'Accounting connection interrupted',
  );
  expect(await bootstrapIntegrityStatus(owner, id)).toEqual(first);
  beforeQuery = undefined;
  const next = await validateBootstrapIntegrity(owner, id);
  expect(next.checked_accounting_rules).toBe(2 * ACCOUNTING_RULES_PER_PASS);
  expect(await finish()).toMatchObject({
    state: 'valid',
    checked_accounting_rules: bootstrapAccountingRules.length,
  });
});
it('does not skip accounting rules when two callers start from the same receipt', async () => {
  await structure();
  await validateBootstrapIntegrity(owner, id);
  let release!: () => void,
    readers = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  afterRead = async (sql) => {
    if (
      sql.startsWith('SELECT * FROM business_sync_integrity_checks') &&
      readers < 2
    ) {
      if (++readers === 2) release();
      await barrier;
    }
  };
  const results = await Promise.all([
    validateBootstrapIntegrity(owner, id),
    validateBootstrapIntegrity(owner, id),
  ]);
  expect(results.map((r) => r.checked_accounting_rules)).toEqual([8, 8]);
  expect(await finish()).toMatchObject({
    state: 'valid',
    checked_accounting_rules: bootstrapAccountingRules.length,
  });
});
it('rejects an inconsistent completed accounting cursor before accepting an audit receipt', async () => {
  await structure();
  await finish();
  db.exec('UPDATE business_sync_integrity_checks SET next_accounting_rule=0');
  await expect(bootstrapIntegrityStatus(owner, id)).rejects.toMatchObject({
    status: 503,
  });
});
it('rejects an empty accounting entry before accepting its otherwise valid audit chain', async () => {
  const value = JSON.stringify({
    id: 'entry',
    number: 'J-001',
    entry_date: '2026-09-08',
    description: 'Écriture fictive incomplète',
    source_type: 'manual',
    source_id: 'entry',
    source_event: 'post',
    status: 'posted',
    reversal_of: null,
    created_at: '2026-09-08',
  });
  db.prepare(
    "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','journal_entries','[\"entry\"]',?,?)",
  ).run(id, value, await sha256Hex(value));
  await audit(2);
  await structure();
  expect(await finish()).toMatchObject({
    state: 'invalid',
    failed_rule: 'journal:lines',
    verified_audit_entries: 0,
  });
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(0);
});

it('requires the exact current structural receipt and never activates the shared history', async () => {
  await expect(validateBootstrapIntegrity(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  await structure();
  const result = await finish();
  expect(result).toMatchObject({
    state: 'valid',
    total_audit_entries: 0,
    last_audit_hash: null,
    replication_active: false,
  });
  expect(await validateBootstrapIntegrity(owner, id)).toEqual(result);
  expect(
    db.prepare('SELECT state,head_revision FROM business_sync_spaces').get(),
  ).toMatchObject({ state: 'initializing', head_revision: 0 });
  db.exec(
    "UPDATE business_sync_structural_checks SET validator_sha256='obsolete'",
  );
  await expect(bootstrapIntegrityStatus(owner, id)).rejects.toMatchObject({
    status: 409,
  });
});
it('validates the hash-linked history independently of UUID and upload order and resumes its index', async () => {
  const data = await audit(205);
  await structure();
  await accounting();
  const first = await validateBootstrapIntegrity(owner, id);
  expect(first).toMatchObject({
    indexed_audit_entries: AUDIT_ROWS_PER_PASS,
    state: 'indexing',
  });
  expect(await bootstrapIntegrityStatus(owner, id)).toEqual(first);
  const result = await finish();
  expect(result).toMatchObject({
    state: 'valid',
    indexed_audit_entries: 205,
    verified_audit_entries: 205,
    last_audit_hash: data.at(-1)!.entry_hash,
  });
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(205);
});
it('rejects a modified audit payload without normalizing its original JSON text', async () => {
  await audit(3);
  await structure();
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.payload_json','changed') WHERE table_name='audit_log'",
  );
  expect(await finish()).toMatchObject({
    state: 'invalid',
    failed_rule: 'audit:hash',
  });
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(0);
});
it.each(['missing_parent', 'fork', 'two_roots'] as const)(
  'rejects the %s shape even when every entry has a valid content hash',
  async (kind) => {
    const root = await audit(1);
    if (kind === 'missing_parent') await audit(2, 'a'.repeat(64));
    if (kind === 'fork') {
      await audit(1, root[0].entry_hash);
      await audit(2, root[0].entry_hash);
    }
    if (kind === 'two_roots') await audit(2);
    await structure();
    const result = await finish();
    expect(result.state).toBe('invalid');
    expect(result.failed_rule).toBe(
      kind === 'missing_parent'
        ? 'audit:parent'
        : kind === 'fork'
          ? 'audit:fork'
          : 'audit:root',
    );
  },
);
it('rolls back indexed nodes and its cursor together after a database failure', async () => {
  await audit(120);
  await structure();
  await accounting();
  let inserts = 0;
  beforeQuery = (sql) => {
    if (sql.startsWith('WITH incoming') && ++inserts === 3)
      throw new Error('Database interrupted');
  };
  await expect(validateBootstrapIntegrity(owner, id)).rejects.toThrow(
    'Database interrupted',
  );
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(0);
  expect(
    (await bootstrapIntegrityStatus(owner, id)).indexed_audit_entries,
  ).toBe(0);
  beforeQuery = undefined;
  expect((await finish()).state).toBe('valid');
});
it('does not recreate audit nodes if cancellation races the atomic index commit', async () => {
  await audit(5);
  await structure();
  await accounting();
  beforeBatch = () => {
    db.exec(
      "UPDATE business_sync_transfers SET state='abandoning'; DELETE FROM business_sync_audit_nodes; DELETE FROM business_sync_integrity_checks",
    );
  };
  await expect(validateBootstrapIntegrity(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(0);
});
it('merges concurrent index receipts without duplicate entries or a skipped page', async () => {
  await audit(205);
  await structure();
  await accounting();
  let release!: () => void,
    readers = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  afterRead = async (sql) => {
    if (
      sql.startsWith('SELECT * FROM business_sync_integrity_checks') &&
      readers < 2
    ) {
      if (++readers === 2) release();
      await barrier;
    }
  };
  const results = await Promise.all([
    validateBootstrapIntegrity(owner, id),
    validateBootstrapIntegrity(owner, id),
  ]);
  expect(results.map((r) => r.indexed_audit_entries)).toEqual([100, 100]);
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_audit_nodes').get()!.n,
  ).toBe(100);
  expect((await finish()).state).toBe('valid');
});
it('bounds the decoded audit page by bytes as well as rows', async () => {
  await audit(8, null, 'x'.repeat(800_000));
  await structure();
  await accounting();
  const status = await validateBootstrapIntegrity(owner, id);
  expect(status.indexed_audit_entries).toBe(5);
  expect((await finish()).state).toBe('valid');
});
it('protects HTTP access and ignores a client-supplied approval state', async () => {
  mocks.session.mockRejectedValueOnce(
    new AccountPublicError('Connexion nécessaire.', 401),
  );
  expect(
    (
      await GET(
        new Request(
          `https://zentra.test/api/sync/bootstrap/integrity?transfer_id=${id}`,
        ),
      )
    ).status,
  ).toBe(401);
  await structure();
  const response = await POST(
    new Request('https://zentra.test/api/sync/bootstrap/integrity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transfer_id: id,
        state: 'valid',
        indexed_audit_entries: 999,
      }),
    }),
  );
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toMatchObject({
    state: 'accounting',
    checked_accounting_rules: ACCOUNTING_RULES_PER_PASS,
    indexed_audit_entries: 0,
  });
  for (const role of ['member', 'accountant', 'read_only'] as const)
    await expect(
      validateBootstrapIntegrity({ ...owner, role }, id),
    ).rejects.toMatchObject({ status: 403 });
  await expect(
    validateBootstrapIntegrity({ ...owner, organizationId: 'other' }, id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    validateBootstrapIntegrity({ ...owner, installationId: 'other' }, id),
  ).rejects.toMatchObject({ status: 409 });
  expect(await structuralValidatorHash()).toHaveLength(64);
});
it('resumes a long audit walk and compares its exact final native-style hash', async () => {
  const data = await audit(2005);
  await structure();
  let status = await validateBootstrapIntegrity(owner, id);
  for (let i = 0; i < 50 && status.state !== 'walking'; i++)
    status = await validateBootstrapIntegrity(owner, id);
  expect(status.state).toBe('walking');
  status = await validateBootstrapIntegrity(owner, id);
  expect(status).toMatchObject({
    state: 'walking',
    verified_audit_entries: 1000,
    last_audit_hash: data[999].entry_hash,
  });
  expect(await bootstrapIntegrityStatus(owner, id)).toEqual(status);
  expect(await finish()).toMatchObject({
    state: 'valid',
    verified_audit_entries: 2005,
    last_audit_hash: data.at(-1)!.entry_hash,
  });
});
it('rejects a disconnected audit cycle without looping indefinitely', async () => {
  const data = await audit(3);
  await structure();
  await accounting();
  expect((await validateBootstrapIntegrity(owner, id)).state).toBe('linking');
  db.prepare(
    'UPDATE business_sync_audit_nodes SET previous_hash=? WHERE entry_hash=?',
  ).run(data[2].entry_hash, data[1].entry_hash);
  expect(await finish()).toMatchObject({
    state: 'invalid',
    failed_rule: 'audit:chain',
  });
});
it.skipIf(!process.env.ZENTRA_CREDIT_QA)(
  'requires exact credit projection before accepting the complete native history',
  async () => {
    const folder = process.env.ZENTRA_CREDIT_QA!;
    const fixture = JSON.parse(readFileSync(`${folder}/prepared.json`, 'utf8'));
    db.exec('DELETE FROM business_sync_versions');
    for (let index = 0; index < fixture.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          `${folder}/rows/${String(index).padStart(4, '0')}.json`,
          'utf8',
        ),
      );
      for (const row of chunk.rows)
        db.prepare(
          "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first',?,?,?,?)",
        ).run(
          id,
          row.table,
          row.key_json,
          row.row_json,
          await sha256Hex(row.row_json),
        );
    }
    await manifest();
    await structure();
    const result = await finish();
    expect(result).toMatchObject({
      state: 'valid',
      credit_projection: {
        phase: 'valid',
        verified_documents: 2,
        verified_movements: 8,
      },
    });
    expect(await bootstrapIntegrityStatus(owner, id)).toEqual(result);
    db.exec('DELETE FROM business_sync_credit_projection');
    await expect(bootstrapIntegrityStatus(owner, id)).rejects.toMatchObject({
      status: 503,
    });
  },
);
it.skipIf(!process.env.ZENTRA_RECOVERY_QA)(
  'accepts the complete native adoption with checked recovery tokens and exact line VAT',
  async () => {
    const folder = process.env.ZENTRA_RECOVERY_QA!;
    const fixture = JSON.parse(readFileSync(`${folder}/prepared.json`, 'utf8'));
    db.exec('DELETE FROM business_sync_versions');
    for (let index = 0; index < fixture.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          `${folder}/rows/${String(index).padStart(4, '0')}.json`,
          'utf8',
        ),
      );
      for (const row of chunk.rows)
        db.prepare(
          "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first',?,?,?,?)",
        ).run(
          id,
          row.table,
          row.key_json,
          row.row_json,
          await sha256Hex(row.row_json),
        );
    }
    await manifest();
    await structure();
    expect(await finish()).toMatchObject({
      state: 'valid',
      credit_projection: {
        phase: 'valid',
        verified_documents: 6,
        verified_movements: 14,
      },
    });
  },
);
