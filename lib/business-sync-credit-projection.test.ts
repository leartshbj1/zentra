import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({ database: vi.fn() }));
import { sha256Hex } from './account-security';
import { creditProjectionSql } from './business-sync-credit-projection-sql';
import {
  creditProjectionStatus,
  validateCreditProjection,
} from './business-sync-credit-projection';
import type { BootstrapValidationContext } from './business-sync-validation';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
let runtime: {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
let db: D1Database;
let ctx: BootstrapValidationContext & { integrityValidator: string };
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("Projection test"); } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  db = await runtime.getD1Database('DB');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (const query of readFileSync(
      new URL(`../drizzle/${file}`, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((q) => q.trim()))
      await db.prepare(query).run();
  }
  await db
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO organizations VALUES('org','First','sub','owner',1,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO business_sync_spaces VALUES('org','generation','transfer','initializing',0,'owner','2026-09-08')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at) VALUES('transfer','org','pc','owner','generation','bootstrap','uploaded',0,'{}','hash','2026-09-08')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO business_sync_integrity_checks(transfer_id,validator_sha256,manifest_sha256,generation,state,updated_at) VALUES('transfer','validator','hash','generation','projecting','2026-09-08')",
    )
    .run();
  ctx = {
    db,
    id: 'transfer',
    binding: ['transfer', 'org', 'pc', 'generation', 'hash'],
    transfer: {
      transfer_id: 'transfer',
      installation_id: 'pc',
      generation: 'generation',
      state: 'uploaded',
      manifest_json: '{}',
      manifest_sha256: 'hash',
    },
    manifest: { row_count: 200000 },
    validator: 'structure',
    integrityValidator: 'validator',
  } as typeof ctx;
}, 15000);
afterAll(async () => {
  await runtime?.dispose();
});
beforeEach(async () => {
  for (const table of [
    'business_sync_versions',
    'business_sync_credit_lines',
    'business_sync_credit_movements',
    'business_sync_credit_projection',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("UPDATE business_sync_transfers SET state='uploaded'").run();
});
async function insert(
  table: string,
  id: string,
  value: Record<string, unknown>,
) {
  // Tokens preserve adversarial integers above Number.MAX_SAFE_INTEGER.
  const text = JSON.stringify({ id, ...value }).replace(
    /"@i64:(-?[0-9]+)"/g,
    '$1',
  );
  await db
    .prepare(
      "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES('transfer','org',?,?,?,'test')",
    )
    .bind(table, JSON.stringify([id]), text)
    .run();
}
async function document(
  gross: (number | string)[],
  vat = gross.map(() => 0 as number | string),
  credit = false,
) {
  const total = gross.reduce<bigint>(
    (sum, item) => sum + BigInt(String(item).replace('@i64:', '')),
    BigInt(0),
  );
  await insert('invoices', 'doc', {
    type: credit ? 'avoir' : 'facture',
    total_cents: `@i64:${total * BigInt(credit ? -1 : 1)}`,
  });
  await insert(
    credit
      ? 'customer_credit_documents'
      : 'customer_credit_recovery_tax_models',
    'eligible',
    credit ? { credit_note_id: 'doc' } : { original_invoice_id: 'doc' },
  );
  for (let index = 0; index < gross.length; index++) {
    const signed = (value: string | number) =>
      `@i64:${BigInt(String(value).replace('@i64:', '')) * BigInt(credit ? -1 : 1)}`;
    await insert('invoice_items', `line-${String(index).padStart(4, '0')}`, {
      invoice_id: 'doc',
      position: index,
      line_total_cents: signed(gross[index]),
      line_vat_cents: signed(vat[index]),
    });
  }
}
async function payment(
  id: string,
  amount: number | string,
  date = '2026-09-08',
) {
  await insert('payments', id, {
    invoice_id: 'doc',
    amount_cents: amount,
    date,
    created_at: `${date}T12:00:00Z`,
  });
}
async function refund(
  id: string,
  amount: number,
  parts: [number, number][],
  sequence: number,
  reverses: string | null = null,
) {
  await insert('customer_credit_settlements', id, {
    credit_note_id: 'doc',
    invoice_id: null,
    amount_cents: amount,
    date: '2026-09-08',
    created_at: '2026-09-08T12:00:00Z',
    sequence,
    reverses_id: reverses,
  });
  for (let index = 0; index < parts.length; index++)
    await insert('customer_credit_settlement_lines', `${id}-${index}`, {
      settlement_id: id,
      side: 'credit',
      invoice_item_id: `line-${String(index).padStart(4, '0')}`,
      gross_cents: parts[index][0],
      vat_cents: parts[index][1],
    });
}
async function until(phase: string) {
  let result = await creditProjectionStatus(ctx);
  for (
    let i = 0;
    i < 150 &&
    result.phase !== phase &&
    !['valid', 'invalid'].includes(result.phase);
    i++
  )
    result = await validateCreditProjection(ctx);
  expect(result.phase, JSON.stringify(result)).toBe(phase);
  return result;
}
async function lines() {
  return (
    await db
      .prepare(
        'SELECT item_id,CAST(remaining AS TEXT) remaining,CAST(released AS TEXT) released FROM business_sync_credit_lines ORDER BY item_id',
      )
      .all()
  ).results;
}
it('compiles every bounded projection statement within actual D1 limits', async () => {
  const bindings = [
    'transfer',
    'org',
    'validator',
    'doc',
    null,
    1000,
    null,
    '0',
    '0',
    0,
    0,
    0,
    null,
    null,
    '0',
    null,
    null,
    0,
    '{}',
    'hash',
    'generation',
    'pc',
  ];
  for (const [key, query] of Object.entries(creditProjectionSql)) {
    const values = [
      ...bindings,
      ...(key === 'initialize'
        ? ['date']
        : key === 'save'
          ? ['{}', 'date']
          : []),
    ];
    await expect(
      db
        .prepare(`EXPLAIN ${query}`)
        .bind(...values)
        .all(),
      key,
    ).resolves.toMatchObject({ success: true });
  }
});
it('preserves mixed VAT rates and negative deposit lines over two partial payments', async () => {
  await document([100, 100, -50], [8, 3, -4]);
  await payment('a', 50);
  await payment('b', 100);
  await until('verify');
  expect(
    (
      await db
        .prepare(
          'SELECT proposed_gross gross,proposed_vat vat FROM business_sync_credit_lines ORDER BY item_id',
        )
        .all()
    ).results,
  ).toEqual([
    { gross: 34, vat: 3 },
    { gross: 33, vat: 1 },
    { gross: -17, vat: -1 },
  ]);
  const result = await until('valid');
  expect(result).toMatchObject({
    verified_documents: 1,
    verified_movements: 2,
  });
  expect(await lines()).toEqual([
    { item_id: 'line-0000', remaining: '0', released: '8' },
    { item_id: 'line-0001', remaining: '0', released: '3' },
    { item_id: 'line-0002', remaining: '0', released: '-4' },
  ]);
  expect(await validateCreditProjection(ctx)).toEqual(result);
});
it('orders same-date reversals by sequence, restores original cents, then pays the full credit', async () => {
  await document([1000], [80], true);
  await refund('z-first', 300, [[300, 24]], 1);
  await refund('a-reverse', 300, [[-300, -24]], 2, 'z-first');
  await refund('b-final', 1000, [[1000, 80]], 3);
  expect(await until('valid')).toMatchObject({ verified_movements: 3 });
  expect(await lines()).toEqual([
    { item_id: 'line-0000', remaining: '0', released: '80' },
  ]);
});
it('rejects a redistribution of VAT cents even when document totals are unchanged', async () => {
  await document([100, 100], [8, 8], true);
  await refund(
    'refund',
    100,
    [
      [50, 3],
      [50, 5],
    ],
    1,
  );
  expect(await until('invalid')).toMatchObject({
    failed_rule: 'credit_projection:settlement_parts',
    verified_movements: 0,
  });
  expect((await lines())!.map((line) => line.remaining)).toEqual([
    '100',
    '100',
  ]);
});
it.each(['9007199254740993', '9223372036854775807'])(
  'keeps integer cents exact at %s without converting money to JS numbers',
  async (amount) => {
    await document([`@i64:${amount}`], [1]);
    await payment('a', `@i64:${BigInt(amount) - BigInt(1)}`);
    await payment('b', 1);
    expect(await until('valid')).toMatchObject({ verified_movements: 2 });
    expect(await lines()).toEqual([
      { item_id: 'line-0000', remaining: '0', released: '1' },
    ]);
  },
);
it.each(['["text",null,17]', '[{}]', 'broken', 'null'])(
  'rejects malformed recovery parts %s with a stable validation receipt',
  async (parts) => {
    await document([100], [8]);
    await payment('paid', 50);
    await insert('customer_credit_recovery_postings', 'proof', {
      original_invoice_id: 'doc',
      source_type: 'payment',
      source_id: 'paid',
      parts_json: parts,
      expected_vat_cents: 4,
    });
    expect(await until('invalid')).toMatchObject({
      failed_rule: 'credit_projection:recovery_parts',
    });
  },
);
it('resumes more than one scalar line page and source page', async () => {
  await document(Array(1003).fill(1));
  await payment('full', 1003);
  await until('gross');
  const first = await validateCreditProjection(ctx);
  expect(await creditProjectionStatus(ctx)).toEqual(first);
  expect(
    (await db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_credit_lines WHERE proposed_gross IS NOT NULL',
      )
      .first())!.n,
  ).toBe(1000);
  await until('valid');
  expect(
    (await db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_credit_lines WHERE remaining<>0 OR released<>0',
      )
      .first())!.n,
  ).toBe(0);
}, 15000);
it('makes the projection and its checkpoint one transaction and safely retries after failure', async () => {
  await document([100], [8]);
  await payment('paid', 50);
  await until('verify');
  const before = await creditProjectionStatus(ctx);
  const actual = ctx.db;
  ctx.db = {
    prepare: actual.prepare.bind(actual),
    batch: async (statements: D1PreparedStatement[]) =>
      actual.batch([
        ...statements,
        actual.prepare(
          'INSERT INTO business_sync_credit_lines(transfer_id) VALUES(NULL)',
        ),
      ]),
  } as D1Database;
  await expect(validateCreditProjection(ctx)).rejects.toThrow();
  ctx.db = actual;
  expect(await creditProjectionStatus(ctx)).toEqual(before);
  expect((await lines())![0]).toMatchObject({
    remaining: '100',
    released: '0',
  });
  await until('valid');
  expect((await lines())![0]).toMatchObject({ remaining: '50', released: '4' });
});
it('does not apply a movement after transfer cancellation races its batch', async () => {
  await document([100], [8]);
  await payment('paid', 50);
  await until('verify');
  const actual = ctx.db;
  ctx.db = {
    prepare: actual.prepare.bind(actual),
    batch: async (statements: D1PreparedStatement[]) => {
      await actual
        .prepare("UPDATE business_sync_transfers SET state='abandoning'")
        .run();
      return actual.batch(statements);
    },
  } as D1Database;
  await expect(validateCreditProjection(ctx)).rejects.toMatchObject({
    status: 409,
  });
  ctx.db = actual;
  expect((await lines())![0]).toMatchObject({
    remaining: '100',
    released: '0',
  });
});
it('serializes simultaneous verification requests without applying a payment twice', async () => {
  await document([100], [8]);
  await payment('paid', 50);
  await until('verify');
  await Promise.all([
    validateCreditProjection(ctx),
    validateCreditProjection(ctx),
  ]);
  expect((await lines())![0]).toMatchObject({ remaining: '50', released: '4' });
  expect(await until('valid')).toMatchObject({ verified_movements: 1 });
});
it.skipIf(!process.env.ZENTRA_CREDIT_QA)(
  'replays the frozen native credit/payment/refund/reversal fixture in D1',
  async () => {
    const folder = process.env.ZENTRA_CREDIT_QA!;
    const prepared = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    for (let index = 0; index < prepared.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          join(folder, 'rows', `${String(index).padStart(4, '0')}.json`),
          'utf8',
        ),
      );
      for (let at = 0; at < chunk.rows.length; at += 20)
        await db.batch(
          chunk.rows
            .slice(at, at + 20)
            .map((row: { table: string; key_json: string; row_json: string }) =>
              db
                .prepare(
                  "INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES('transfer','org',?,?,?,'fixture')",
                )
                .bind(row.table, row.key_json, row.row_json),
            ),
        );
    }
    expect(await until('valid')).toMatchObject({
      verified_documents: 2,
      verified_movements: 8,
    });
  },
  20000,
);
it('caps each source page by raw JSON bytes as well as row count', async () => {
  await document(Array(6).fill(1));
  await db
    .prepare(
      "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.description',?) WHERE table_name='invoice_items'",
    )
    .bind('x'.repeat(900000))
    .run();
  await until('seed_lines');
  await validateCreditProjection(ctx);
  expect(
    (await db
      .prepare('SELECT COUNT(*) n FROM business_sync_credit_lines')
      .first())!.n,
  ).toBe(4);
  await until('valid');
  expect(
    (await db
      .prepare('SELECT COUNT(*) n FROM business_sync_credit_lines')
      .first())!.n,
  ).toBe(6);
});
it('ranks 200000 derived numeric lines without loading them into JavaScript', async () => {
  await document([200000]);
  await payment('half', 100000);
  await until('rank');
  await db.prepare('DELETE FROM business_sync_credit_lines').run();
  await db
    .prepare(`WITH RECURSIVE ids(id) AS (VALUES(0) UNION ALL SELECT id+1 FROM ids WHERE id<199999)
    INSERT INTO business_sync_credit_lines(transfer_id,validator_sha256,document_id,item_id,position,gross,vat,remaining,released,proposed_gross,remainder)
    SELECT 'transfer','validator','doc',printf('%06d',id),id,1,0,1,0,0,100000 FROM ids`)
    .run();
  expect((await validateCreditProjection(ctx)).phase).toBe('tax');
  expect(
    await db
      .prepare(
        'SELECT COUNT(*) count,SUM(proposed_gross) gross,SUM(proposed_gross<>(position<100000)) wrong FROM business_sync_credit_lines',
      )
      .first(),
  ).toEqual({ count: 200000, gross: 100000, wrong: 0 });
}, 15000);
it('binds the recovered source bytes to the original review token before seeding lines', async () => {
  await document([100], [8]);
  const original = '{"amount":9007199254740993}';
  await insert('customer_credit_recoveries', 'recovery', {
    original_invoice_id: 'doc',
    source_json: '{"amount":9007199254740992}',
    request_json: JSON.stringify({ source_token: await sha256Hex(original) }),
  });
  expect(await until('invalid')).toMatchObject({
    failed_rule: 'credit_projection:recovery_token',
  });
  expect(await lines()).toEqual([]);
});
