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
  structuralValidationStatus,
  structuralValidatorHash,
  validateBootstrapStructure,
  STRUCTURAL_RULES_PER_REQUEST,
} from './business-sync-validation';
import { GET, POST } from '../app/api/sync/bootstrap/structure/route';

let db: DatabaseSync;
let statements: string[];
let beforeQuery: ((sql: string) => void) | undefined;
let afterRead: ((sql: string) => Promise<void>) | undefined;
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
  statements = [];
  db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  const counts = Object.fromEntries(
    Object.keys(protocol.tables).map((name) => [
      name,
      name === 'settings' ? 1 : 0,
    ]),
  );
  const manifest = JSON.stringify({
    format: 'zentra-business-bootstrap',
    version: 1,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    tables: counts,
    chunks: [{ sha256: 'a'.repeat(64), size_bytes: 1, row_count: 1 }],
    size_bytes: 1,
    row_count: 1,
  });
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1);
    INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1);
    INSERT INTO business_sync_spaces VALUES('org_first','generation','${id}','initializing',0,'owner','2026-09-08');`);
  db.prepare(
    "INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at) VALUES(?,'org_first','pc','owner','generation','bootstrap','uploaded',0,?,?,'2026-09-08')",
  ).run(id, manifest, await sha256Hex(manifest));
  const native = new DatabaseSync(':memory:');
  try {
    native.exec(structuralSchema.tables.settings.sql);
    native.exec(
      "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise fictive','2026-09-08','2026-09-08')",
    );
    const columns = protocol.tables.settings.columns;
    const row = native
      .prepare(
        `SELECT json_object(${columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) json FROM settings`,
      )
      .get()!.json as string;
    db.prepare(
      "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','settings','[1]',?,?)",
    ).run(id, row, await sha256Hex(row));
  } finally {
    native.close();
  }
  mocks.db.mockReturnValue({
    prepare: (sql: string) => {
      let values: (string | number | null)[] = [];
      const execute = () => {
        statements.push(sql);
        beforeQuery?.(sql);
        return db.prepare(sql);
      };
      const statement = {
        bind: (...args: (string | number | null)[]) => {
          values = args;
          return statement;
        },
        first: async () => {
          const row = execute().get(...values) ?? null;
          await afterRead?.(sql);
          return row;
        },
        run: async () => ({
          meta: { changes: Number(execute().run(...values).changes) },
        }),
      };
      return statement;
    },
  });
  mocks.session.mockResolvedValue(owner);
});
afterEach(() => db.close());
async function finish() {
  let status = await structuralValidationStatus(owner, id);
  for (
    let attempt = 0;
    attempt < 100 && ['pending', 'checking'].includes(status.state);
    attempt++
  ) {
    statements = [];
    status = await validateBootstrapStructure(owner, id);
    expect(statements.length).toBeLessThanOrEqual(24);
  }
  return status;
}
it('resumes bounded checks from durable receipts and never publishes the history', async () => {
  expect(await structuralValidationStatus(owner, id)).toMatchObject({
    state: 'pending',
    checked_rules: 0,
    replication_active: false,
  });
  expect(
    db.prepare('SELECT COUNT(*) n FROM business_sync_structural_checks').get()!
      .n,
  ).toBe(0);
  const first = await validateBootstrapStructure(owner, id);
  expect(first).toMatchObject({
    state: 'checking',
    checked_rules: STRUCTURAL_RULES_PER_REQUEST,
  });
  expect(await structuralValidationStatus(owner, id)).toEqual(first);
  const status = await finish();
  expect(status).toMatchObject({
    state: 'valid',
    checked_rules: structuralRules.length,
    failed_rule: null,
    replication_active: false,
  });
  expect(
    db.prepare('SELECT state,head_revision FROM business_sync_spaces').get(),
  ).toMatchObject({ state: 'initializing', head_revision: 0 });
  statements = [];
  expect(await validateBootstrapStructure(owner, id)).toEqual(status);
  expect(statements.some((sql) => sql.includes('AS invalid'))).toBe(false);
});
it('rejects inconsistent data without running constraints against malformed parent JSON', async () => {
  db.exec("UPDATE business_sync_versions SET row_json='{broken'");
  const status = await finish();
  expect(status).toMatchObject({
    state: 'invalid',
    failed_rule: 'settings:fields',
  });
  expect(await validateBootstrapStructure(owner, id)).toEqual(status);
});
it('does not trust client cursor values and protects the endpoint and response cache', async () => {
  const request = new Request(
    'https://zentra.test/api/sync/bootstrap/structure',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transfer_id: id,
        next_rule: 9999,
        state: 'valid',
      }),
    },
  );
  const result = await POST(request);
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toContain('no-store');
  expect(await result.json()).toMatchObject({
    checked_rules: 16,
    state: 'checking',
  });
  mocks.session.mockRejectedValue(
    new AccountPublicError('Connexion nécessaire.', 401),
  );
  expect(
    (
      await GET(
        new Request(
          `https://zentra.test/api/sync/bootstrap/structure?transfer_id=${id}`,
        ),
      )
    ).status,
  ).toBe(401);
});
it('restricts the company, device, role and current initialization generation', async () => {
  for (const role of ['member', 'accountant', 'read_only'] as const)
    await expect(
      validateBootstrapStructure({ ...owner, role }, id),
    ).rejects.toMatchObject({ status: 403 });
  await expect(
    validateBootstrapStructure({ ...owner, organizationId: 'org_other' }, id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    validateBootstrapStructure({ ...owner, installationId: 'other' }, id),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await validateBootstrapStructure({ ...owner, role: 'admin' }, id))
      .checked_rules,
  ).toBe(16);
  db.exec("UPDATE business_sync_spaces SET generation='replacement'");
  await expect(validateBootstrapStructure(owner, id)).rejects.toMatchObject({
    status: 409,
  });
});
it('repeats unfinished checks after an interrupted query without advancing the receipt', async () => {
  let count = 0;
  beforeQuery = (sql) => {
    if (sql.includes('AS invalid') && ++count === 4)
      throw new Error('Temporary database failure');
  };
  await expect(validateBootstrapStructure(owner, id)).rejects.toThrow(
    'Temporary database failure',
  );
  expect((await structuralValidationStatus(owner, id)).checked_rules).toBe(0);
  beforeQuery = undefined;
  expect((await validateBootstrapStructure(owner, id)).checked_rules).toBe(16);
});
it('serializes concurrent cursor updates without skipping unchecked rules', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readers = 0;
  afterRead = async (sql) => {
    if (
      sql.startsWith('SELECT * FROM business_sync_structural_checks') &&
      readers < 2
    ) {
      if (++readers === 2) release();
      await barrier;
    }
  };
  const results = await Promise.all([
    validateBootstrapStructure(owner, id),
    validateBootstrapStructure(owner, id),
  ]);
  expect(results.map((result) => result.checked_rules)).toEqual([16, 16]);
  expect((await structuralValidationStatus(owner, id)).checked_rules).toBe(16);
});
it('does not persist success when cancellation races a structural query', async () => {
  let cancelled = false;
  beforeQuery = (sql) => {
    if (!cancelled && sql.includes('AS invalid')) {
      cancelled = true;
      db.exec(
        "UPDATE business_sync_transfers SET state='abandoning'; DELETE FROM business_sync_versions",
      );
    }
  };
  await expect(validateBootstrapStructure(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    db
      .prepare('SELECT next_rule,state FROM business_sync_structural_checks')
      .get(),
  ).toMatchObject({ next_rule: 0, state: 'checking' });
});
it('binds receipts to the manifest and exact validator and refuses inconsistent receipts', async () => {
  await validateBootstrapStructure(owner, id);
  const validator = await structuralValidatorHash();
  db.exec(
    "UPDATE business_sync_structural_checks SET validator_sha256='outdated'",
  );
  expect((await structuralValidationStatus(owner, id)).state).toBe('pending');
  await validateBootstrapStructure(owner, id);
  db.prepare(
    "UPDATE business_sync_structural_checks SET manifest_sha256='wrong' WHERE validator_sha256=?",
  ).run(validator);
  await expect(validateBootstrapStructure(owner, id)).rejects.toMatchObject({
    status: 503,
  });
});
it('refuses a changed manifest and an upload which has not been sealed', async () => {
  db.exec("UPDATE business_sync_transfers SET state='uploading'");
  await expect(validateBootstrapStructure(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  db.exec(
    "UPDATE business_sync_transfers SET state='uploaded',manifest_json='{}'",
  );
  await expect(validateBootstrapStructure(owner, id)).rejects.toMatchObject({
    status: 503,
  });
});

it('proves empty table counts then skips only their row constraints within the SQL budget', async () => {
  const executed: string[] = [];
  const expected = structuralRules.filter(
    (r) => r.kind === 'count' || r.table === 'settings',
  );
  const known = new Set(structuralRules.map((r) => r.sql));
  let status = await structuralValidationStatus(owner, id);
  let calls = 0;
  while (status.state !== 'valid' && calls < 100) {
    statements = [];
    status = await validateBootstrapStructure(owner, id);
    const queries = statements.filter((sql) => known.has(sql));
    expect(queries.length).toBeLessThanOrEqual(STRUCTURAL_RULES_PER_REQUEST);
    executed.push(...queries);
    expect(await structuralValidationStatus(owner, id)).toEqual(status);
    calls++;
  }
  expect(status.state).toBe('valid');
  expect(executed).toEqual(expected.map((r) => r.sql));
  expect(calls).toBe(Math.ceil(expected.length / STRUCTURAL_RULES_PER_REQUEST));
  expect(calls).toBeLessThan(
    Math.ceil(structuralRules.length / STRUCTURAL_RULES_PER_REQUEST),
  );
});

it('rejects a table declared empty before skipping any of its constraints', async () => {
  db.prepare(
    "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','invoices','[\"hidden\"]','{broken',?)",
  ).run(id, 'a'.repeat(64));
  const checks: string[] = [];
  beforeQuery = (sql) => {
    checks.push(sql);
  };
  expect(await finish()).toMatchObject({
    state: 'invalid',
    failed_rule: 'invoices:count',
  });
  const rowChecks = structuralRules.filter((r) => r.kind !== 'count');
  expect(checks.some((sql) => rowChecks.some((r) => r.sql === sql))).toBe(
    false,
  );
});

it('still rejects a nonempty child when its referenced parent table is proven empty', async () => {
  const row = JSON.stringify({
    ...Object.fromEntries(
      protocol.tables.payments.columns.map((c) => [c, null]),
    ),
    id: 'payment',
    invoice_id: 'missing-invoice',
    date: '2026-09-08',
    amount_cents: 100,
    created_at: '2026-09-08',
    updated_at: '2026-09-08',
  });
  db.prepare(
    "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,'org_first','payments','[\"payment\"]',?,?)",
  ).run(id, row, await sha256Hex(row));
  const manifest = JSON.parse(
    db
      .prepare(
        'SELECT manifest_json FROM business_sync_transfers WHERE transfer_id=?',
      )
      .get(id)!.manifest_json as string,
  );
  manifest.tables.payments = 1;
  manifest.row_count = 2;
  manifest.chunks[0].row_count = 2;
  const serialized = JSON.stringify(manifest);
  db.prepare(
    'UPDATE business_sync_transfers SET manifest_json=?,manifest_sha256=? WHERE transfer_id=?',
  ).run(serialized, await sha256Hex(serialized), id);
  const expected = structuralRules.find(
    (r) => r.table === 'payments' && r.kind === 'foreign_key',
  )!;
  expect(await finish()).toMatchObject({
    state: 'invalid',
    failed_rule: expected.id,
  });
});

it('retries the final count batch after an interruption beyond a span of empty constraints', async () => {
  const batches = Math.floor(
    structuralRules.filter((r) => r.kind === 'count').length /
      STRUCTURAL_RULES_PER_REQUEST,
  );
  for (let at = 0; at < batches; at++)
    await validateBootstrapStructure(owner, id);
  const previous = await structuralValidationStatus(owner, id);
  const fields = structuralRules.find(
    (r) => r.table === 'settings' && r.kind === 'fields',
  )!;
  beforeQuery = (sql) => {
    if (sql === fields.sql) throw new Error('Interrupted after empty tables');
  };
  await expect(validateBootstrapStructure(owner, id)).rejects.toThrow(
    'Interrupted after empty tables',
  );
  expect(await structuralValidationStatus(owner, id)).toEqual(previous);
  beforeQuery = undefined;
  expect(await finish()).toMatchObject({
    state: 'valid',
    checked_rules: structuralRules.length,
  });
});
