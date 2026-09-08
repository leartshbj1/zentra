import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accountingRules } from './business-sync-accounting';
import { financialRules } from './business-sync-financial';
import { postingRules } from './business-sync-postings';

// Exercise the workerd SQLite limits used by D1, which differ from node:sqlite.
// Use the exact simulator shipped with this repository's pinned Wrangler.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
let runtime: {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
};
let db: D1Database;
const rules = [...accountingRules, ...financialRules, ...postingRules];
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

it('checks every source family and required posting with the D1 engine', async () => {
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
  for (const [kind, table, event, row] of families) {
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
  }
});
