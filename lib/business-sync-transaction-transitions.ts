import { AccountPublicError, sha256Hex } from './account-security';
import { readBusinessTransactionChunk } from './business-sync-transaction-chunk';
import type { TransactionManifest } from './business-sync-transaction-format';
import { issuedInvoiceFields } from './business-sync-transaction-immutability';
import { database } from './runtime';

export const issuedQuoteFields = [
  'number',
  'client_id',
  'project_id',
  'title',
  'issue_date',
  'valid_until',
  'currency',
  'subtotal_cents',
  'discount_cents',
  'vat_cents',
  'total_cents',
  'notes',
  'terms',
  'snapshot_json',
] as const;
export const TRANSITION_PAGE = 32;
const field = (image: number, name: string) =>
  `json_extract(?${image},'$.${name}')`;
const different = (fields: readonly string[]) =>
  fields
    .map((name) => `${field(22, name)} IS NOT ${field(23, name)}`)
    .join(' OR ');
// Only whether a document is issued is retained. Full original images stay in
// immutable chunks; monetary comparisons happen in SQLite, never JS numbers.
// A missing state for an earlier parent change must not fall back to an old
// draft image and authorize rewriting a now-issued document.
const parentIssued = (table: string, foreignKey: string) => `COALESCE(
 (SELECT issued FROM business_sync_transaction_document_states WHERE transfer_id=?1 AND validator_sha256=?15 AND table_name='${table}' AND row_key_json=json_array(json_extract(COALESCE(?22,?23),'$.${foreignKey}'))),
 CASE WHEN EXISTS(SELECT 1 FROM business_sync_transaction_changes WHERE transaction_id=?1 AND organization_id=?2 AND table_name='${table}' AND row_key_json=json_array(json_extract(COALESCE(?22,?23),'$.${foreignKey}')) AND (part_index,change_index)<(?24,?25)) THEN -1 ELSE COALESCE((SELECT json_extract(row_json,'$.number') IS NOT NULL FROM business_sync_versions WHERE transfer_id=?17 AND organization_id=?2 AND table_name='${table}' AND row_key_json=json_array(json_extract(COALESCE(?22,?23),'$.${foreignKey}'))),0) END)`;
const conditions = [
  {
    table: 'invoices',
    id: 'transition:issued-invoices',
    invalid: `?22 IS NOT NULL AND ${field(22, 'number')} IS NOT NULL AND (?23 IS NULL OR ${different(issuedInvoiceFields)})`,
  },
  {
    table: 'quotes',
    id: 'transition:issued-quotes',
    invalid: `?22 IS NOT NULL AND ${field(22, 'number')} IS NOT NULL AND (?23 IS NULL OR ${different(issuedQuoteFields)})`,
  },
  {
    table: 'invoice_items',
    id: 'transition:issued-invoice-items',
    invalid: `${parentIssued('invoices', 'invoice_id')}<>0`,
  },
  {
    table: 'quote_items',
    id: 'transition:issued-quote-items',
    invalid: `${parentIssued('quotes', 'quote_id')}<>0`,
  },
  {
    table: 'invoice_qr_bills',
    id: 'transition:frozen-qr-bills',
    invalid: `?22 IS NOT NULL AND (${field(22, 'frozen_at')} IS NOT NULL OR ${parentIssued('invoices', 'invoice_id')}<>0)`,
  },
];
export const transactionTransitionContract = {
  page: TRANSITION_PAGE,
  conditions,
};
export function transactionTransitionQueries(active: string) {
  const gate = `EXISTS(${active}) AND EXISTS(SELECT 1 FROM business_sync_transaction_validations WHERE transfer_id=?1 AND phase='transitions' AND checked_changes=?16)`;
  // Declaring all per-change parameters keeps D1 statement bindings uniform.
  const args =
    'WITH args AS (SELECT ?16 checked,?17 source,?18 stamp,?19 position,?20 table_name,?21 row_key,?22 before_json,?23 after_json,?24 part_index,?25 change_index)';
  return {
    reject: Object.fromEntries(
      conditions.map((rule) => [
        rule.table,
        `${args} UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule='${rule.id}',failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND ${gate} AND (${rule.invalid})`,
      ]),
    ),
    document: `${args} INSERT INTO business_sync_transaction_document_states(transfer_id,validator_sha256,table_name,row_key_json,issued)
      SELECT ?1,?15,?20,?21,${field(23, 'number')} IS NOT NULL WHERE ${gate}
      ON CONFLICT(transfer_id,validator_sha256,table_name,row_key_json) DO UPDATE SET issued=excluded.issued`,
    advance: `UPDATE business_sync_transaction_validations SET checked_changes=?18,next_change_chunk=?17,updated_at=?19,phase=CASE WHEN ?18=?20 THEN 'projecting' ELSE 'transitions' END WHERE transfer_id=?1 AND ${gate}`,
  };
}
export function transactionTransitionOffset(
  manifest: TransactionManifest,
  checked: number,
  chunk: number,
) {
  if (
    !Number.isSafeInteger(checked) ||
    checked < 0 ||
    checked > manifest.change_count ||
    !Number.isSafeInteger(chunk) ||
    chunk < 0 ||
    chunk > manifest.chunks.length
  )
    throw new AccountPublicError(
      'Le curseur de contrôle des modifications est incohérent.',
      503,
    );
  const offset =
    checked -
    manifest.chunks.slice(0, chunk).reduce((n, p) => n + p.change_count, 0);
  if (
    offset < 0 ||
    (chunk === manifest.chunks.length
      ? offset !== 0
      : offset >= manifest.chunks[chunk].change_count)
  )
    throw new AccountPublicError(
      'Le curseur de contrôle des modifications est incohérent.',
      503,
    );
  return offset;
}
type Context = {
  id: string;
  manifest: TransactionManifest;
  sourceTransferId: string;
  validationBindings: (string | number)[];
  checked: number;
  chunk: number;
  queries: ReturnType<typeof transactionTransitionQueries>;
};
export async function validateTransactionTransitions(ctx: Context) {
  const offset = transactionTransitionOffset(
    ctx.manifest,
    ctx.checked,
    ctx.chunk,
  );
  const all = await readBusinessTransactionChunk(
    ctx.id,
    ctx.manifest,
    ctx.chunk,
  );
  const changes = all.slice(offset, offset + TRANSITION_PAGE);
  const db = database();
  const metadata = (
    await db
      .prepare(
        'SELECT sequence,change_index,table_name,row_key_json,operation,before_sha256,after_sha256,source_rowid FROM business_sync_transaction_changes WHERE transaction_id=? AND part_index=? AND change_index>=? ORDER BY change_index LIMIT ?',
      )
      .bind(ctx.id, ctx.chunk, offset, changes.length)
      .all<{
        sequence: string;
        change_index: number;
        table_name: string;
        row_key_json: string;
        operation: string;
        before_sha256: string | null;
        after_sha256: string | null;
        source_rowid: string;
      }>()
  ).results;
  const matching =
    metadata.length === changes.length &&
    (
      await Promise.all(
        changes.map(async (c, i) => {
          const m = metadata[i];
          return (
            m.sequence === c.sequence &&
            m.change_index === offset + i &&
            m.table_name === c.table &&
            m.row_key_json === c.key_json &&
            m.operation === c.operation &&
            m.source_rowid === c.source_rowid &&
            m.before_sha256 ===
              (c.before_json === null
                ? null
                : await sha256Hex(c.before_json)) &&
            m.after_sha256 ===
              (c.after_json === null ? null : await sha256Hex(c.after_json))
          );
        }),
      )
    ).every(Boolean);
  if (!matching)
    throw new AccountPublicError(
      'Les preuves des modifications ne correspondent plus au fragment original.',
      503,
    );
  const stamp = new Date().toISOString();
  const statements = [];
  for (const [i, c] of changes.entries()) {
    const bindings = [
      ...ctx.validationBindings,
      ctx.checked,
      ctx.sourceTransferId,
      stamp,
      ctx.checked + i,
      c.table,
      c.key_json,
      c.before_json,
      c.after_json,
      ctx.chunk,
      offset + i,
    ];
    const reject = ctx.queries.reject[c.table];
    if (reject) statements.push(db.prepare(reject).bind(...bindings));
    if (c.table === 'invoices' || c.table === 'quotes')
      statements.push(db.prepare(ctx.queries.document).bind(...bindings));
  }
  statements.push(
    db
      .prepare(ctx.queries.advance)
      .bind(
        ...ctx.validationBindings,
        ctx.checked,
        ctx.chunk + (offset + changes.length === all.length ? 1 : 0),
        ctx.checked + changes.length,
        stamp,
        ctx.manifest.change_count,
      ),
  );
  await db.batch(statements);
}
