import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { structuralRules, structuralSchema } from './business-sync-structure';
import {
  bootstrapAccountingRules,
  integrityValidatorHash,
} from './business-sync-integrity';
import { creditProjectionQueries } from './business-sync-credit-projection-sql';
import {
  creditProjectionContract,
  creditProjectionStatus,
  validateCreditProjection,
  type CreditProjectionContext,
} from './business-sync-credit-projection';
import {
  transactionReviewContext,
  transactionReviewGateSql,
} from './business-sync-transaction-review';
import { database } from './runtime';
import { transactionImmutabilityRules } from './business-sync-transaction-immutability';
import { transactionClosureRules } from './business-sync-transaction-closure';
import {
  transactionTransitionContract,
  transactionTransitionOffset,
  transactionTransitionQueries,
  validateTransactionTransitions,
} from './business-sync-transaction-transitions';
export const transactionStateRules = [
  ...transactionImmutabilityRules,
  ...transactionClosureRules,
  ...bootstrapAccountingRules.map((rule) => ({ ...rule, source: false })),
];

const STRUCTURE_PAGE = 16,
  ACCOUNTING_PAGE = 4;
// Increment on every validation semantic change. Upgrade only forwards: an
// older running deployment must never replace a newer validation attempt.
export const TRANSACTION_VALIDATION_VERSION = 5;
const countAt = new Map(
  structuralRules.flatMap((r, i) =>
    r.kind === 'count' ? [[r.table, i] as const] : [],
  ),
);
const countsSql = `WITH totals AS (
 SELECT table_name,COUNT(*) n FROM business_sync_versions WHERE transfer_id=?16 AND organization_id=?2 GROUP BY table_name
 UNION ALL SELECT table_name,SUM(CASE operation WHEN 'insert' THEN 1 WHEN 'delete' THEN -1 ELSE 0 END) n FROM business_sync_transaction_changes WHERE transaction_id=?1 AND organization_id=?2 GROUP BY table_name
), grouped AS (SELECT table_name,SUM(n) n FROM totals GROUP BY table_name)
SELECT json_group_object(table_name,n) FROM grouped`;
const active = `SELECT 1 FROM business_sync_transaction_validations v
 WHERE v.transfer_id=?1 AND v.attempt=?6 AND v.validator_sha256=?15 AND v.algorithm_version=${TRANSACTION_VALIDATION_VERSION} AND ${transactionReviewGateSql}`;
const upgradeGuard = `EXISTS(SELECT 1 FROM business_sync_transaction_validations v WHERE v.transfer_id=?1 AND v.attempt=?6
 AND v.validator_sha256=?19 AND v.algorithm_version=?20 AND v.algorithm_version<${TRANSACTION_VALIDATION_VERSION}) AND ${transactionReviewGateSql}`;
const transitionQueries = transactionTransitionQueries(active);
export const transactionTransitionSql = transitionQueries;
const projectionActive = `SELECT 1 FROM business_sync_transaction_validations v
 JOIN business_sync_transaction_reviews r ON r.transfer_id=v.transfer_id AND r.attempt=v.attempt
 JOIN business_sync_transfers t ON t.transfer_id=r.transfer_id
 JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
 JOIN business_sync_transfers u ON u.transfer_id=r.source_transfer_id AND u.organization_id=t.organization_id AND u.generation=t.generation
 JOIN args a WHERE t.transfer_id=a.transfer AND t.organization_id=a.organization AND t.installation_id=a.installation_id
 AND t.manifest_sha256=a.manifest_sha256 AND t.generation=a.generation AND t.kind='transaction' AND t.state='received'
 AND r.manifest_sha256=t.manifest_sha256 AND r.generation=t.generation AND r.state='projected'
 AND r.applied_changes=json_extract(t.manifest_json,'$.change_count') AND r.next_chunk=json_array_length(t.manifest_json,'$.chunks')
 AND u.state='committed' AND u.revision=r.source_revision AND (u.kind='transaction' OR (u.kind='bootstrap' AND u.transfer_id=s.bootstrap_transfer_id))
 AND s.state='ready' AND s.head_revision=r.source_revision AND v.validator_sha256=a.validator AND v.algorithm_version=${TRANSACTION_VALIDATION_VERSION} AND v.phase='projecting'
 AND v.next_structural_rule=${structuralRules.length} AND v.next_accounting_rule=${transactionStateRules.length} AND v.failed_rule IS NULL AND v.checked_changes=json_extract(t.manifest_json,'$.change_count') AND v.next_change_chunk=json_array_length(t.manifest_json,'$.chunks')`;
const queries = creditProjectionQueries(projectionActive);
export const transactionCreditProjectionSql = queries;
type Progress = {
  transfer_id: string;
  attempt: string;
  validator_sha256: string;
  algorithm_version: number;
  phase:
    | 'structure'
    | 'accounting'
    | 'transitions'
    | 'projecting'
    | 'valid'
    | 'invalid';
  checked_changes: number;
  next_change_chunk: number;
  failed_change: number | null;
  table_counts_json: string;
  next_structural_rule: number;
  next_accounting_rule: number;
  failed_rule: string | null;
};
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
let contractHash: Promise<string> | undefined;
export function transactionValidationContractHash() {
  return (contractHash ??= integrityValidatorHash().then((h) =>
    sha256Hex(
      JSON.stringify([
        'zentra-transaction-state-validation',
        TRANSACTION_VALIDATION_VERSION,
        h,
        creditProjectionContract,
        transactionStateRules,
        STRUCTURE_PAGE,
        ACCOUNTING_PAGE,
        countsSql,
        active,
        upgradeGuard,
        transactionTransitionContract,
        transitionQueries,
        queries,
      ]),
    ),
  ));
}
async function context(session: DeviceSessionContext, id: unknown) {
  const review = await transactionReviewContext(session, id);
  if (review.review.state !== 'projected')
    fail(
      'Les modifications doivent être projetées sans conflit avant leur contrôle métier.',
    );
  const db = database();
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${transactionReviewGateSql}`)
      .bind(...review.values)
      .first())
  )
    fail(
      'La révision partagée a changé. La copie de contrôle doit être recalée.',
    );
  const validator = await sha256Hex(
    JSON.stringify([
      await transactionValidationContractHash(),
      review.review.validator_sha256,
      review.review.attempt,
      review.review.source_transfer_id,
      review.review.source_revision,
      review.row.manifest_sha256,
    ]),
  );
  return {
    ...review,
    db,
    validator,
    validationBindings: [...review.values, validator],
  };
}
type Context = Awaited<ReturnType<typeof context>>;
function counts(row: Progress) {
  let value: Record<string, number>;
  try {
    value = JSON.parse(row.table_counts_json);
  } catch {
    fail('Le décompte de contrôle est altéré.', 503);
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.entries(value).some(
      ([name, n]) =>
        !Object.hasOwn(structuralSchema.tables, name) ||
        !Number.isSafeInteger(n) ||
        n < 0,
    )
  )
    fail('Le décompte de contrôle est incohérent.', 503);
  return value;
}
async function progress(ctx: Context) {
  const row = await ctx.db
    .prepare(
      'SELECT * FROM business_sync_transaction_validations WHERE transfer_id=?',
    )
    .bind(ctx.id)
    .first<Progress>();
  if (!row) return null;
  if (
    row.attempt !== ctx.review.attempt ||
    row.validator_sha256 !== ctx.validator ||
    row.algorithm_version !== TRANSACTION_VALIDATION_VERSION
  )
    fail('Cette tentative nécessite une nouvelle validation.');
  const integer = (n: number, max: number) =>
    Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (
    ![
      'structure',
      'accounting',
      'transitions',
      'projecting',
      'valid',
      'invalid',
    ].includes(row.phase) ||
    !integer(row.next_structural_rule, structuralRules.length) ||
    !integer(row.next_accounting_rule, transactionStateRules.length) ||
    (row.phase === 'structure' && row.next_accounting_rule !== 0) ||
    (['accounting', 'transitions', 'projecting', 'valid'].includes(row.phase) &&
      row.next_structural_rule !== structuralRules.length) ||
    (['transitions', 'projecting', 'valid'].includes(row.phase) &&
      row.next_accounting_rule !== transactionStateRules.length) ||
    (row.phase === 'invalid'
      ? typeof row.failed_rule !== 'string' || !row.failed_rule
      : row.failed_rule !== null)
  )
    fail('Le reçu de validation est incohérent.', 503);
  transactionTransitionOffset(
    ctx.manifest,
    row.checked_changes,
    row.next_change_chunk,
  );
  if (
    (['structure', 'accounting'].includes(row.phase) &&
      row.checked_changes !== 0) ||
    (['projecting', 'valid'].includes(row.phase) &&
      row.checked_changes !== ctx.manifest.change_count) ||
    (row.failed_change !== null &&
      (row.phase !== 'invalid' ||
        !Number.isSafeInteger(row.failed_change) ||
        row.failed_change < row.checked_changes ||
        row.failed_change >= ctx.manifest.change_count))
  )
    fail('Le reçu des modifications contrôlées est incohérent.', 503);
  counts(row);
  return row;
}
function projection(ctx: Context, row: Progress): CreditProjectionContext {
  return {
    db: ctx.db,
    id: ctx.id,
    transfer: ctx.row,
    binding: ctx.binding,
    manifest: {
      row_count: Object.values(counts(row)).reduce((a, b) => a + b, 0),
    },
    integrityValidator: ctx.validator,
    queries,
    active: { sql: active, bindings: ctx.validationBindings },
  };
}
async function response(ctx: Context, row: Progress | null) {
  const credit = row
    ? await creditProjectionStatus(projection(ctx, row))
    : null;
  if (row?.phase === 'valid' && credit?.phase !== 'valid')
    fail('Le calcul des avoirs est absent ou incomplet.', 503);
  const stillCurrent = await ctx.db
    .prepare(`SELECT 1 WHERE ${transactionReviewGateSql}`)
    .bind(...ctx.values)
    .first();
  return {
    transaction_id: ctx.id,
    organization_id: ctx.manifest.organization_id,
    installation_id: ctx.manifest.installation_id,
    generation: ctx.manifest.generation,
    manifest_sha256: ctx.row.manifest_sha256,
    attempt: ctx.review.attempt,
    source_revision: ctx.review.source_revision,
    validator_sha256: ctx.validator,
    algorithm_version: TRANSACTION_VALIDATION_VERSION,
    phase: stillCurrent ? (row?.phase ?? 'pending') : 'stale',
    checked_structural_rules: row?.next_structural_rule ?? 0,
    total_structural_rules: structuralRules.length,
    checked_accounting_rules: row?.next_accounting_rule ?? 0,
    total_accounting_rules: transactionStateRules.length,
    failed_rule: row?.failed_rule ?? null,
    checked_changes: row?.checked_changes ?? 0,
    total_changes: ctx.manifest.change_count,
    failed_change: row?.failed_change ?? null,
    credit_projection: credit,
    snapshot_validated: !!stillCurrent && row?.phase === 'valid',
    business_validated: false,
    canonical_committed: false,
    replication_active: false,
  };
}
export async function businessTransactionValidationStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await context(session, id);
  return response(ctx, await progress(ctx));
}
async function save(
  ctx: Context,
  old: Progress,
  phase: Progress['phase'],
  structural: number,
  accounting: number,
  failed: string | null,
) {
  await ctx.db
    .prepare(`UPDATE business_sync_transaction_validations SET phase=?16,next_structural_rule=?17,next_accounting_rule=?18,failed_rule=?19,updated_at=?20
    WHERE transfer_id=?1 AND phase=?21 AND next_structural_rule=?22 AND next_accounting_rule=?23 AND EXISTS(${active})`)
    .bind(
      ...ctx.validationBindings,
      phase,
      structural,
      accounting,
      failed,
      new Date().toISOString(),
      old.phase,
      old.next_structural_rule,
      old.next_accounting_rule,
    )
    .run();
  return response(ctx, await progress(ctx));
}
export async function validateBusinessTransaction(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await context(session, id);
  const old = await ctx.db
    .prepare(
      'SELECT * FROM business_sync_transaction_validations WHERE transfer_id=?',
    )
    .bind(ctx.id)
    .first<Progress>();
  if (old && old.algorithm_version !== TRANSACTION_VALIDATION_VERSION) {
    if (
      !Number.isSafeInteger(old.algorithm_version) ||
      old.algorithm_version < 1 ||
      old.algorithm_version > TRANSACTION_VALIDATION_VERSION ||
      old.attempt !== ctx.review.attempt
    )
      fail(
        'Cette validation nécessite une version plus récente ou une nouvelle tentative.',
      );
    const bindings = [
      ...ctx.validationBindings,
      ctx.review.source_transfer_id,
      new Date().toISOString(),
      TRANSACTION_VALIDATION_VERSION,
      old.validator_sha256,
      old.algorithm_version,
    ];
    // Only derived validation state is replaced. Original envelopes, source
    // rows, files, conflicts, candidate rows and audit evidence remain intact.
    await ctx.db.batch([
      ...[
        'business_sync_credit_lines',
        'business_sync_credit_movements',
        'business_sync_credit_projection',
        'business_sync_transaction_document_states',
        'business_sync_transaction_accounting_states',
      ].map((table) =>
        ctx.db
          .prepare(
            `DELETE FROM ${table} WHERE transfer_id=?1 AND validator_sha256=?19 AND ${upgradeGuard}`,
          )
          .bind(...bindings),
      ),
      ctx.db
        .prepare(
          `UPDATE business_sync_transaction_validations SET validator_sha256=?15,algorithm_version=?18,phase='structure',table_counts_json=(${countsSql}),next_structural_rule=0,next_accounting_rule=0,checked_changes=0,next_change_chunk=0,failed_change=NULL,failed_rule=NULL,updated_at=?17 WHERE transfer_id=?1 AND ${upgradeGuard}`,
        )
        .bind(...bindings),
    ]);
  }
  let row = await progress(ctx);
  if (!row) {
    await ctx.db
      .prepare(`INSERT OR IGNORE INTO business_sync_transaction_validations(transfer_id,attempt,validator_sha256,phase,table_counts_json,updated_at,algorithm_version)
    SELECT ?1,?6,?15,'structure',(${countsSql}),?17,?18 WHERE ${transactionReviewGateSql}`)
      .bind(
        ...ctx.validationBindings,
        ctx.review.source_transfer_id,
        new Date().toISOString(),
        TRANSACTION_VALIDATION_VERSION,
      )
      .run();
    row = await progress(ctx);
  }
  if (!row) fail('La tentative de contrôle a changé.');
  if (row.phase === 'valid' || row.phase === 'invalid')
    return response(ctx, row);
  if (row.phase === 'transitions') {
    await validateTransactionTransitions({
      id: ctx.id,
      manifest: ctx.manifest,
      sourceTransferId: ctx.review.source_transfer_id,
      validationBindings: ctx.validationBindings,
      checked: row.checked_changes,
      chunk: row.next_change_chunk,
      queries: transitionQueries,
    });
    return response(ctx, await progress(ctx));
  }
  if (row.phase === 'projecting') {
    const credit = await validateCreditProjection(projection(ctx, row));
    if (credit.phase === 'valid' || credit.phase === 'invalid')
      return save(
        ctx,
        row,
        credit.phase,
        row.next_structural_rule,
        row.next_accounting_rule,
        credit.failed_rule,
      );
    return response(ctx, row);
  }
  if (row.phase === 'structure') {
    const expected = counts(row);
    let next = row.next_structural_rule,
      executed = 0,
      failed: string | null = null;
    for (; next < structuralRules.length; next++) {
      const rule = structuralRules[next];
      if (
        rule.kind !== 'count' &&
        (countAt.get(rule.table) ?? Infinity) < next &&
        (expected[rule.table] ?? 0) === 0
      )
        continue;
      if (executed === STRUCTURE_PAGE) break;
      executed++;
      const params: (string | number)[] = [ctx.id, session.organizationId];
      if (rule.kind === 'count') params.push(expected[rule.table] ?? 0);
      if (
        await ctx.db
          .prepare(rule.sql)
          .bind(...params)
          .first()
      ) {
        failed = rule.id;
        break;
      }
    }
    return save(
      ctx,
      row,
      failed
        ? 'invalid'
        : next === structuralRules.length
          ? 'accounting'
          : 'structure',
      next,
      0,
      failed,
    );
  }
  let next = row.next_accounting_rule,
    failed: string | null = null;
  const end = Math.min(next + ACCOUNTING_PAGE, transactionStateRules.length);
  for (; next < end; next++) {
    const rule = transactionStateRules[next];
    if (
      await ctx.db
        .prepare(rule.sql)
        .bind(
          ctx.id,
          session.organizationId,
          ...(rule.source ? [ctx.review.source_transfer_id] : []),
        )
        .first()
    ) {
      failed = rule.id;
      break;
    }
  }
  return save(
    ctx,
    row,
    failed
      ? 'invalid'
      : next === transactionStateRules.length
        ? 'transitions'
        : 'accounting',
    row.next_structural_rule,
    next,
    failed,
  );
}
