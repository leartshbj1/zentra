import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accountingRules } from './business-sync-accounting';
import { financialRules } from './business-sync-financial';
import { postingRules } from './business-sync-postings';
import { cashVatRules } from './business-sync-cash-vat';
import { creditSettlementRules } from './business-sync-credit-settlements';
import { creditRecoveryRules } from './business-sync-credit-recovery';
import { supplierRules } from './business-sync-supplier';
import { roundedProportionCtes } from './business-sync-money';

// Exercise the workerd SQLite limits used by D1, which differ from node:sqlite.
// Use the exact simulator shipped with this repository's pinned Wrangler.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
let runtime: {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
let db: D1Database;
const rules = [
  ...accountingRules,
  ...financialRules,
  ...postingRules,
  ...cashVatRules,
  ...creditSettlementRules,
  ...creditRecoveryRules,
  ...supplierRules,
];
for (const name of ['ZENTRA_RECOVERY_QA', 'ZENTRA_SUPPLIER_QA'])
  it.skipIf(!process.env[name])(
    `validates every financial rule against native ${name} rows inside D1`,
    async () => {
      const folder = process.env[name]!;
      const prepared = JSON.parse(
        readFileSync(join(folder, 'prepared.json'), 'utf8'),
      );
      expect(prepared.manifest.tables.customer_credit_recovery_postings).toBe(
        4,
      );
      if (name === 'ZENTRA_SUPPLIER_QA') {
        expect(prepared.manifest.tables.supplier_credit_allocations).toBe(3);
        expect(prepared.manifest.tables.supplier_credit_refunds).toBe(3);
      }
      await db.exec('DELETE FROM business_sync_versions');
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
              .map(
                (row: { table: string; key_json: string; row_json: string }) =>
                  db
                    .prepare(
                      'INSERT INTO business_sync_versions VALUES(?,?,?,?,?)',
                    )
                    .bind(
                      'transfer',
                      'first',
                      row.table,
                      row.key_json,
                      row.row_json,
                    ),
              ),
          );
      }
      for (const rule of rules)
        expect(
          await db.prepare(rule.sql).bind('transfer', 'first').first(),
          rule.id,
        ).toBeNull();
    },
  );
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("Local D1 test"); } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  db = await runtime.getD1Database('DB');
  await db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT)',
  );
}, 15000);
afterAll(async () => {
  if (runtime) await runtime.dispose();
});

it('executes every bootstrap financial query within the D1 SQL limits', async () => {
  for (const rule of rules) {
    await expect(
      db.prepare(rule.sql).bind('transfer', 'first').all(),
      rule.id,
    ).resolves.toMatchObject({ success: true, results: [] });
  }
});

it('keeps 200000 extreme-value VAT proportions exact within the D1 runtime', async () => {
  const result = await db
    .prepare(`WITH RECURSIVE ids(id) AS (VALUES(0) UNION ALL SELECT id+1 FROM ids WHERE id<199999),
    inputs AS MATERIALIZED (SELECT id,9223372036854775807-id amount,9223372036854775807-id numerator,9223372036854775807 denominator FROM ids),
    ${roundedProportionCtes('inputs', 'proportions')}
    SELECT COUNT(*) count,SUM(amount IS NULL OR amount<>9223372036854775807-2*id) wrong FROM proportions`)
    .first();
  expect(result).toEqual({ count: 200000, wrong: 0 });
}, 25000);

const families = [
  [
    'invoice',
    'invoices',
    'issue',
    {
      number: 'F-1',
      type: 'facture',
      status: 'envoyee',
      issue_date: '2026-09-08',
      total_cents: 100,
      vat_cents: 0,
      subtotal_cents: 100,
      discount_cents: 0,
    },
  ],
  [
    'payment',
    'payments',
    'invoice:original',
    { date: '2026-09-08', invoice_id: 'original' },
  ],
  [
    'expense',
    'expenses',
    'create',
    { date: '2026-09-08', payment_status: 'paid' },
  ],
  [
    'supplier_invoice',
    'supplier_invoices',
    'validate',
    { document_date: '2026-09-08', status: 'validated' },
  ],
  [
    'supplier_payment',
    'supplier_payments',
    'invoice:original',
    { date: '2026-09-08', supplier_invoice_id: 'original' },
  ],
  [
    'payslip',
    'payslips',
    'post',
    { period: '2026-09', status: 'comptabilise' },
  ],
  [
    'payslip',
    'payslips',
    'payment',
    { period: '2026-09', status: 'paye', payment_date: '2026-09-08' },
  ],
] as const;

it.each(families)(
  'checks %s sources (%s / %s) within D1',
  async (kind, table, event, row) => {
    const sourceRule = postingRules.find((r) => r.id === 'posting:source')!;
    const requiredRule = postingRules.find((r) => r.id === 'posting:required')!;
    const insert = async (
      table: string,
      id: string,
      row: Record<string, unknown>,
      organization = 'first',
    ) => {
      await db
        .prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)')
        .bind(
          'transfer',
          organization,
          table,
          JSON.stringify([id]),
          JSON.stringify({ id, ...row }),
        )
        .run();
    };
    await db.exec('DELETE FROM business_sync_versions');
    await insert('accounting_settings', 'settings', { enabled: 1 });
    await insert(table, 'piece', row);
    expect(
      await db.prepare(requiredRule.sql).bind('transfer', 'first').first(),
      `${kind}/${event} missing entry`,
    ).not.toBeNull();
    const entry = {
      number: 'J-1',
      entry_date: '2026-09-08',
      source_type: kind,
      source_id: 'piece',
      source_event: event,
      reversal_of: null,
    };
    await insert('journal_entries', 'entry', entry);
    // A paid payslip needs both its accrual and its payment entry.
    if (event === 'payment')
      await insert('journal_entries', 'accrual', {
        ...entry,
        source_event: 'post',
      });
    expect(
      await db.prepare(requiredRule.sql).bind('transfer', 'first').first(),
      `${kind}/${event} complete`,
    ).toBeNull();
    expect(
      await db.prepare(sourceRule.sql).bind('transfer', 'first').first(),
    ).toBeNull();
    await db
      .prepare('DELETE FROM business_sync_versions WHERE table_name=?')
      .bind(table)
      .run();
    await insert(table, 'piece', row, 'another-organization');
    expect(
      await db.prepare(sourceRule.sql).bind('transfer', 'first').first(),
      `${kind}/${event} foreign source`,
    ).not.toBeNull();
  },
);

it.skipIf(!process.env.ZENTRA_CREDIT_QA)(
  'accepts the native credit application, reversal, refund and replay history and protects its proof',
  async () => {
    const folder = process.env.ZENTRA_CREDIT_QA!;
    const prepared = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    expect(prepared.manifest.tables.invoices).toBe(4);
    expect(prepared.manifest.tables.customer_credit_settlements).toBe(4);
    expect(prepared.manifest.tables.customer_credit_settlement_postings).toBe(
      4,
    );
    expect(prepared.manifest.tables.journal_entries).toBe(18);
    expect(prepared.manifest.tables.journal_lines).toBe(53);
    await db.exec('DELETE FROM business_sync_versions');
    for (let index = 0; index < prepared.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          join(folder, 'rows', `${String(index).padStart(4, '0')}.json`),
          'utf8',
        ),
      );
      for (let at = 0; at < chunk.rows.length; at += 20) {
        const part = chunk.rows.slice(at, at + 20) as {
          table: string;
          key_json: string;
          row_json: string;
        }[];
        await db
          .prepare(
            `INSERT INTO business_sync_versions VALUES ${part.map(() => '(?,?,?,?,?)').join(',')}`,
          )
          .bind(
            ...part.flatMap((row) => [
              'transfer',
              'first',
              row.table,
              row.key_json,
              row.row_json,
            ]),
          )
          .run();
      }
    }
    for (const rule of rules)
      expect(
        await db.prepare(rule.sql).bind('transfer', 'first').first(),
        rule.id,
      ).toBeNull();
    const saved = await db
      .prepare(
        "SELECT row_key_json key,row_json FROM business_sync_versions WHERE table_name='customer_credit_settlement_postings' LIMIT 1",
      )
      .first<{ key: string; row_json: string }>();
    expect(saved).not.toBeNull();
    await db
      .prepare(
        "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.snapshot_json',json_set(json_extract(row_json,'$.snapshot_json'),'$.entry.description','Corrupted after transfer')) WHERE table_name='customer_credit_settlement_postings' AND row_key_json=?",
      )
      .bind(saved!.key)
      .run();
    const proofRule = rules.find(
      (r) => r.id === 'credit_settlements:proof_snapshot',
    )!;
    expect(
      await db.prepare(proofRule.sql).bind('transfer', 'first').first(),
    ).not.toBeNull();
    await db
      .prepare(
        "UPDATE business_sync_versions SET row_json=? WHERE table_name='customer_credit_settlement_postings' AND row_key_json=?",
      )
      .bind(saved!.row_json, saved!.key)
      .run();
    expect(
      await db.prepare(proofRule.sql).bind('transfer', 'first').first(),
    ).toBeNull();
  },
  20000,
);

it.skipIf(!process.env.ZENTRA_CASH_VAT_QA)(
  'accepts native cash-VAT rows in D1 and detects a balanced but incorrect release',
  async () => {
    const folder = process.env.ZENTRA_CASH_VAT_QA!;
    const prepared = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    expect(prepared.manifest.tables.invoices).toBe(2);
    expect(prepared.manifest.tables.payments).toBe(3);
    expect(prepared.manifest.tables.journal_entries).toBe(10);
    expect(prepared.manifest.tables.journal_lines).toBe(21);
    await db.exec('DELETE FROM business_sync_versions');
    for (let index = 0; index < prepared.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          join(folder, 'rows', `${String(index).padStart(4, '0')}.json`),
          'utf8',
        ),
      );
      for (let at = 0; at < chunk.rows.length; at += 20) {
        const part = chunk.rows.slice(at, at + 20) as {
          table: string;
          key_json: string;
          row_json: string;
        }[];
        await db
          .prepare(
            `INSERT INTO business_sync_versions VALUES ${part.map(() => '(?,?,?,?,?)').join(',')}`,
          )
          .bind(
            ...part.flatMap((row) => [
              'transfer',
              'first',
              row.table,
              row.key_json,
              row.row_json,
            ]),
          )
          .run();
      }
    }
    for (const rule of rules)
      expect(
        await db.prepare(rule.sql).bind('transfer', 'first').first(),
        rule.id,
      ).toBeNull();
    const posting = await db
      .prepare(
        "SELECT json_extract(row_json,'$.id') id FROM business_sync_versions WHERE table_name='journal_entries' AND json_extract(row_json,'$.source_type')='vat_cash_reclassification' ORDER BY json_extract(row_json,'$.entry_date'),id LIMIT 1",
      )
      .first<{ id: string }>();
    expect(posting).not.toBeNull();
    await db
      .prepare(
        "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.debit_cents',CASE WHEN json_extract(row_json,'$.debit_cents')>0 THEN json_extract(row_json,'$.debit_cents')+1 ELSE 0 END,'$.credit_cents',CASE WHEN json_extract(row_json,'$.credit_cents')>0 THEN json_extract(row_json,'$.credit_cents')+1 ELSE 0 END) WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')=?",
      )
      .bind(posting!.id)
      .run();
    const failures: string[] = [];
    for (const rule of rules)
      if (await db.prepare(rule.sql).bind('transfer', 'first').first())
        failures.push(rule.id);
    expect(failures).toEqual([
      'vat_cash:legacy_total',
      'vat_cash:payment_schedule',
    ]);
  },
  15000,
);
