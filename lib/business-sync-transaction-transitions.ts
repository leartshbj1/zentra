import { AccountPublicError, sha256Hex } from './account-security';
import { readBusinessTransactionChunk } from './business-sync-transaction-chunk';
import type { TransactionManifest } from './business-sync-transaction-format';
import { issuedInvoiceFields } from './business-sync-transaction-immutability';
import { database } from './runtime';
import {
  transitionField as field,
  transitionDifferent as different,
  transitionParentLocked,
  transitionParentPredicates,
  transitionDraftParents,
} from './business-sync-transition-state';
import { accountingTransitionConditions } from './business-sync-accounting-transitions';
import {
  transitionRowColumns,
  transitionRowRecordSql,
} from './business-sync-transition-rows';
import { supplierPostingConditions } from './business-sync-supplier-posting-transitions';
import { payrollTransitionConditions } from './business-sync-payroll-transitions';
import {
  nativeGuardContract,
  receiverNativeGuards,
} from './business-sync-native-guard-contract';
import { nativeGuardQueries } from './business-sync-native-guards';
import { nativeGuardDigests } from './business-sync-native-guard-digests';

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
export const TRANSITION_PAGE = 16;
const parentIssued = (table: string, foreignKey: string) =>
  transitionParentLocked(
    table,
    `json_array(json_extract(COALESCE(?22,?23),'$.${foreignKey}'))`,
  );
const conditions = [
  ...supplierPostingConditions,
  ...payrollTransitionConditions,
  ...accountingTransitionConditions,
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
    invalid: transitionDraftParents('invoices', 'invoice_id'),
  },
  {
    table: 'quote_items',
    id: 'transition:issued-quote-items',
    invalid: transitionDraftParents('quotes', 'quote_id'),
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
  rowColumns: transitionRowColumns,
  nativeGuards: nativeGuardContract,
  receiverNativeGuards,
};
export function transactionTransitionQueries(active: string) {
  const gate = `EXISTS(${active}) AND EXISTS(SELECT 1 FROM business_sync_transaction_validations WHERE transfer_id=?1 AND phase='transitions' AND checked_changes=?16)`;
  // Declaring all per-change parameters keeps D1 statement bindings uniform.
  const args =
    'WITH args AS (SELECT ?16 checked,?17 source,?18 stamp,?19 position,?20 table_name,?21 row_key,?22 before_json,?23 after_json,?24 part_index,?25 change_index)';
  return {
    native: nativeGuardQueries(gate, args),
    reject: Object.fromEntries(
      [...new Set(conditions.map((rule) => rule.table))].map((table) => {
        const rules = conditions.filter((rule) => rule.table === table);
        if (rules.length === 1)
          return [
            table,
            `${args} UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule='${rules[0].id}',failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND ${gate} AND (${rules[0].invalid})`,
          ];
        return [
          table,
          `${args}, failed AS MATERIALIZED (SELECT CASE ${rules
            .map((rule) => `WHEN (${rule.invalid}) THEN '${rule.id}'`)
            .join(' ')} END rule)
        UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule=(SELECT rule FROM failed),failed_change=?19,updated_at=?18 WHERE transfer_id=?1 AND ${gate} AND (SELECT rule FROM failed) IS NOT NULL`,
        ];
      }),
    ),
    document: `${args} INSERT INTO business_sync_transaction_document_states(transfer_id,validator_sha256,table_name,row_key_json,issued)
      SELECT ?1,?15,?20,?21,CASE WHEN ?23 IS NULL THEN -2 ELSE CASE ?20 ${Object.entries(
        transitionParentPredicates,
      )
        .map(
          ([table, predicate]) =>
            `WHEN '${table}' THEN CASE WHEN ${predicate('?23')} THEN 1 ELSE 0 END`,
        )
        .join(' ')} END END WHERE ${gate}
      ON CONFLICT(transfer_id,validator_sha256,table_name,row_key_json) DO UPDATE SET issued=excluded.issued`,
    advance: `UPDATE business_sync_transaction_validations SET checked_changes=?18,next_change_chunk=?17,updated_at=?19,phase=CASE WHEN ?18=?20 THEN 'projecting' ELSE 'transitions' END WHERE transfer_id=?1 AND ${gate}`,
    accountingRow: `${args} ${transitionRowRecordSql.replace('__ACTIVE__', gate)}`,
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
  const digests = await nativeGuardDigests(
    ctx.id,
    String(ctx.validationBindings[1]),
    String(ctx.validationBindings[14]),
    ctx.sourceTransferId,
    changes,
  );
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
    const native = ctx.queries.native[c.table];
    if (native)
      statements.push(db.prepare(native).bind(...bindings, digests[i]));
    if (Object.hasOwn(transitionParentPredicates, c.table))
      statements.push(db.prepare(ctx.queries.document).bind(...bindings));
    if (Object.hasOwn(transitionRowColumns, c.table))
      statements.push(db.prepare(ctx.queries.accountingRow).bind(...bindings));
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
