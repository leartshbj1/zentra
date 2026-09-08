import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import {
  auditHashFields as hashFields,
  verifiedAuditNode,
} from './business-sync-audit';
import { accountingRules } from './business-sync-accounting';
import { financialRules } from './business-sync-financial';
import { postingRules } from './business-sync-postings';
import { cashVatRules } from './business-sync-cash-vat';
import { creditSettlementRules } from './business-sync-credit-settlements';
import { creditRecoveryRules } from './business-sync-credit-recovery';
import { supplierRules } from './business-sync-supplier';
import {
  creditProjectionContract,
  creditProjectionStatus,
  validateCreditProjection,
} from './business-sync-credit-projection';
import {
  activeBootstrapSql,
  bootstrapValidationContext,
  requireStructuralValidation,
  structuralValidatorHash,
  type BootstrapValidationContext,
} from './business-sync-validation';

export const AUDIT_ROWS_PER_PASS = 100;
export const ACCOUNTING_RULES_PER_PASS = 4;
export const bootstrapAccountingRules = [
  ...accountingRules,
  ...financialRules,
  ...postingRules,
  ...cashVatRules,
  ...creditSettlementRules,
  ...creditRecoveryRules,
  ...supplierRules,
];
export const AUDIT_BYTES_PER_PASS = 4 * 1024 * 1024;
export const AUDIT_WALK_PER_PASS = 1000;
const nodesScope = 'transfer_id=?1 AND validator_sha256=?2';
const graphRules = [
  {
    id: 'audit:count',
    sql: `SELECT 1 AS invalid WHERE (SELECT COUNT(*) FROM business_sync_audit_nodes WHERE ${nodesScope})<>?3`,
  },
  {
    id: 'audit:root',
    sql: `SELECT 1 AS invalid WHERE (SELECT COUNT(*) FROM business_sync_audit_nodes WHERE ${nodesScope} AND previous_hash IS NULL)<>CASE WHEN ?3=0 THEN 0 ELSE 1 END`,
  },
  {
    id: 'audit:fork',
    sql: `SELECT 1 AS invalid FROM business_sync_audit_nodes WHERE ${nodesScope} AND previous_hash IS NOT NULL GROUP BY previous_hash HAVING COUNT(*)>1 LIMIT 1`,
  },
  {
    id: 'audit:parent',
    sql: `SELECT 1 AS invalid FROM business_sync_audit_nodes n LEFT JOIN business_sync_audit_nodes p
    ON p.transfer_id=n.transfer_id AND p.validator_sha256=n.validator_sha256 AND p.entry_hash=n.previous_hash
    WHERE n.transfer_id=?1 AND n.validator_sha256=?2 AND n.previous_hash IS NOT NULL AND p.entry_hash IS NULL LIMIT 1`,
  },
];
const walkSql = `WITH RECURSIVE chain(entry_hash,depth) AS (
  SELECT entry_hash,1 FROM business_sync_audit_nodes WHERE ${nodesScope} AND previous_hash IS ?3
  UNION ALL SELECT n.entry_hash,c.depth+1 FROM business_sync_audit_nodes n JOIN chain c ON n.previous_hash=c.entry_hash
    WHERE n.transfer_id=?1 AND n.validator_sha256=?2 AND c.depth<?4)
  SELECT entry_hash,depth FROM chain ORDER BY depth`;
let hash: Promise<string> | undefined;
export function integrityValidatorHash() {
  return (hash ??= structuralValidatorHash().then((structure) =>
    sha256Hex(
      JSON.stringify([
        'zentra-bootstrap-integrity',
        1,
        structure,
        bootstrapAccountingRules,
        creditProjectionContract,
        hashFields,
        'sha256-fields-separated-by-lf-v1',
        graphRules,
        walkSql,
      ]),
    ),
  ));
}
type Progress = {
  manifest_sha256: string;
  generation: string;
  state: string;
  next_accounting_rule: number;
  last_row_key: string | null;
  indexed_entries: number;
  walked_entries: number;
  last_hash: string | null;
  failed_rule: string | null;
};
type Context = BootstrapValidationContext & { integrityValidator: string };
type AuditNode = {
  row_key: string;
  entry_hash: string;
  previous_hash: string | null;
};
const isHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function invalid(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
async function context(
  session: DeviceSessionContext,
  id: unknown,
): Promise<Context> {
  const ctx = await bootstrapValidationContext(session, id);
  await requireStructuralValidation(ctx);
  return { ...ctx, integrityValidator: await integrityValidatorHash() };
}
async function progress(ctx: Context) {
  const row = await ctx.db
    .prepare(
      'SELECT * FROM business_sync_integrity_checks WHERE transfer_id=? AND validator_sha256=?',
    )
    .bind(ctx.id, ctx.integrityValidator)
    .first<Progress>();
  const count = ctx.manifest.tables.audit_log;
  if (
    row &&
    (row.manifest_sha256 !== ctx.transfer.manifest_sha256 ||
      row.generation !== ctx.transfer.generation ||
      !Number.isSafeInteger(row.next_accounting_rule) ||
      row.next_accounting_rule < 0 ||
      row.next_accounting_rule > bootstrapAccountingRules.length ||
      (!['accounting', 'invalid'].includes(row.state) &&
        row.next_accounting_rule !== bootstrapAccountingRules.length) ||
      ![
        'accounting',
        'projecting',
        'indexing',
        'linking',
        'walking',
        'valid',
        'invalid',
      ].includes(row.state) ||
      !Number.isSafeInteger(row.indexed_entries) ||
      row.indexed_entries < 0 ||
      row.indexed_entries > count ||
      !Number.isSafeInteger(row.walked_entries) ||
      row.walked_entries < 0 ||
      row.walked_entries > row.indexed_entries ||
      (row.indexed_entries === 0) !== (row.last_row_key === null) ||
      (row.walked_entries === 0) !== (row.last_hash === null) ||
      (row.last_hash !== null && !isHash(row.last_hash)) ||
      (row.state === 'invalid'
        ? typeof row.failed_rule !== 'string'
        : row.failed_rule !== null) ||
      (row.state === 'valid' &&
        (row.indexed_entries !== count || row.walked_entries !== count)) ||
      (['linking', 'walking'].includes(row.state) &&
        row.indexed_entries !== count))
  )
    invalid('Le reçu de contrôle comptable est incohérent.', 503);
  if (
    row &&
    ['indexing', 'linking', 'walking', 'valid'].includes(row.state) &&
    (await creditProjectionStatus(ctx)).phase !== 'valid'
  )
    invalid('Le reçu de calcul des avoirs est absent ou incomplet.', 503);
  return row;
}
const progressGuard = `SELECT 1 FROM business_sync_integrity_checks c WHERE c.transfer_id=? AND c.validator_sha256=?
  AND c.manifest_sha256=? AND c.generation=? AND c.state=? AND c.last_row_key IS ? AND c.indexed_entries=?
  AND c.walked_entries=? AND c.last_hash IS ? AND c.next_accounting_rule=? AND EXISTS(${activeBootstrapSql})`;
function guardValues(ctx: Context, row: Progress) {
  return [
    ctx.id,
    ctx.integrityValidator,
    row.manifest_sha256,
    row.generation,
    row.state,
    row.last_row_key,
    row.indexed_entries,
    row.walked_entries,
    row.last_hash,
    row.next_accounting_rule,
    ...ctx.binding,
  ];
}
async function save(
  ctx: Context,
  old: Progress,
  next: Progress,
  nodes: AuditNode[] = [],
) {
  const statements: D1PreparedStatement[] = [];
  // 25*3 input values + 2 identities + 15 guard bindings stay below D1's 100.
  for (let at = 0; at < nodes.length; at += 25) {
    const part = nodes.slice(at, at + 25);
    statements.push(
      ctx.db
        .prepare(`WITH incoming(row_key,entry_hash,previous_hash) AS (VALUES ${part.map(() => '(?,?,?)').join(',')})
      INSERT INTO business_sync_audit_nodes(transfer_id,validator_sha256,row_key,entry_hash,previous_hash)
      SELECT ?,?,row_key,entry_hash,previous_hash FROM incoming WHERE EXISTS(${progressGuard})
      ON CONFLICT(transfer_id,validator_sha256,row_key) DO UPDATE SET entry_hash=CASE
        WHEN business_sync_audit_nodes.entry_hash=excluded.entry_hash AND business_sync_audit_nodes.previous_hash IS excluded.previous_hash
        THEN business_sync_audit_nodes.entry_hash ELSE NULL END`)
        .bind(
          ...part.flatMap((n) => [n.row_key, n.entry_hash, n.previous_hash]),
          ctx.id,
          ctx.integrityValidator,
          ...guardValues(ctx, old),
        ),
    );
  }
  statements.push(
    ctx.db
      .prepare(`UPDATE business_sync_integrity_checks SET state=?,last_row_key=?,indexed_entries=?,walked_entries=?,last_hash=?,failed_rule=?,next_accounting_rule=?,updated_at=?
    WHERE transfer_id=? AND validator_sha256=? AND EXISTS(${progressGuard})`)
      .bind(
        next.state,
        next.last_row_key,
        next.indexed_entries,
        next.walked_entries,
        next.last_hash,
        next.failed_rule,
        next.next_accounting_rule,
        new Date().toISOString(),
        ctx.id,
        ctx.integrityValidator,
        ...guardValues(ctx, old),
      ),
  );
  await ctx.db.batch(statements);
  if (
    !(await ctx.db
      .prepare(activeBootstrapSql)
      .bind(...ctx.binding)
      .first())
  )
    invalid('La préparation a été annulée ou remplacée pendant son contrôle.');
  const stored = await progress(ctx);
  if (!stored) invalid('Le contrôle a été annulé.');
  return stored;
}
async function response(ctx: Context, row: Progress | null) {
  return {
    transfer_id: ctx.id,
    generation: ctx.transfer.generation,
    manifest_sha256: ctx.transfer.manifest_sha256,
    validator_sha256: ctx.integrityValidator,
    structural_validator_sha256: ctx.validator,
    state: row?.state ?? 'pending',
    checked_accounting_rules: row?.next_accounting_rule ?? 0,
    total_accounting_rules: bootstrapAccountingRules.length,
    indexed_audit_entries: row?.indexed_entries ?? 0,
    verified_audit_entries: row?.walked_entries ?? 0,
    total_audit_entries: ctx.manifest.tables.audit_log,
    last_audit_hash: row?.last_hash ?? null,
    failed_rule: row?.failed_rule ?? null,
    credit_projection: await creditProjectionStatus(ctx),
    replication_active: false,
  };
}
async function indexAudit(ctx: Context, row: Progress) {
  const where =
    "transfer_id=? AND organization_id=? AND table_name='audit_log' AND row_key_json>COALESCE(?,'')";
  const args = [ctx.id, ctx.binding[1], row.last_row_key];
  const meta = await ctx.db
    .prepare(
      `SELECT row_key_json,length(CAST(row_json AS BLOB)) AS bytes FROM business_sync_versions WHERE ${where} ORDER BY row_key_json LIMIT ?`,
    )
    .bind(...args, AUDIT_ROWS_PER_PASS)
    .all<{ row_key_json: string; bytes: number }>();
  let size = 0,
    limit = 0;
  for (const item of meta.results ?? []) {
    if (
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > 1024 * 1024
    )
      invalid('Une entrée d’audit a une taille incohérente.', 503);
    if (size + item.bytes > AUDIT_BYTES_PER_PASS) break;
    size += item.bytes;
    limit++;
  }
  if (!limit)
    return save(ctx, row, {
      ...row,
      state:
        row.indexed_entries === ctx.manifest.tables.audit_log
          ? 'linking'
          : 'invalid',
      failed_rule:
        row.indexed_entries === ctx.manifest.tables.audit_log
          ? null
          : 'audit:count',
    });
  const result = await ctx.db
    .prepare(
      `SELECT row_key_json,row_json FROM business_sync_versions WHERE ${where} ORDER BY row_key_json LIMIT ?`,
    )
    .bind(...args, limit)
    .all<{ row_key_json: string; row_json: string }>();
  const nodes: AuditNode[] = [];
  for (const item of result.results ?? []) {
    const data = JSON.parse(item.row_json) as Record<string, unknown>;
    const node = await verifiedAuditNode(data);
    if (!node)
      return save(ctx, row, {
        ...row,
        state: 'invalid',
        failed_rule: 'audit:hash',
      });
    nodes.push({
      row_key: item.row_key_json,
      ...node,
    });
  }
  if (nodes.length !== limit)
    invalid('Les lignes d’audit ont changé pendant le contrôle.');
  const indexed = row.indexed_entries + nodes.length;
  if (indexed > ctx.manifest.tables.audit_log)
    return save(ctx, row, {
      ...row,
      state: 'invalid',
      failed_rule: 'audit:count',
    });
  return save(
    ctx,
    row,
    {
      ...row,
      indexed_entries: indexed,
      last_row_key: nodes.at(-1)!.row_key,
      state: indexed === ctx.manifest.tables.audit_log ? 'linking' : 'indexing',
    },
    nodes,
  );
}
async function linkAudit(ctx: Context, row: Progress) {
  for (const rule of graphRules) {
    const values: (string | number)[] = [ctx.id, ctx.integrityValidator];
    if (['audit:count', 'audit:root'].includes(rule.id))
      values.push(ctx.manifest.tables.audit_log);
    if (
      await ctx.db
        .prepare(rule.sql)
        .bind(...values)
        .first()
    )
      return save(ctx, row, { ...row, state: 'invalid', failed_rule: rule.id });
  }
  return save(ctx, row, {
    ...row,
    state: ctx.manifest.tables.audit_log === 0 ? 'valid' : 'walking',
  });
}
async function walkAudit(ctx: Context, row: Progress) {
  const result = await ctx.db
    .prepare(walkSql)
    .bind(ctx.id, ctx.integrityValidator, row.last_hash, AUDIT_WALK_PER_PASS)
    .all<{ entry_hash: string; depth: number }>();
  const nodes = result.results ?? [];
  const total = row.walked_entries + nodes.length;
  if (
    !nodes.length ||
    total > ctx.manifest.tables.audit_log ||
    nodes.some((n, i) => n.depth !== i + 1 || !isHash(n.entry_hash))
  )
    return save(ctx, row, {
      ...row,
      state: 'invalid',
      failed_rule: 'audit:chain',
    });
  const next = {
    ...row,
    walked_entries: total,
    last_hash: nodes.at(-1)!.entry_hash,
    state: total === ctx.manifest.tables.audit_log ? 'valid' : 'walking',
  };
  if (
    nodes.length < AUDIT_WALK_PER_PASS &&
    total !== ctx.manifest.tables.audit_log
  ) {
    next.state = 'invalid';
    next.failed_rule = 'audit:chain';
  }
  return save(ctx, row, next);
}
export async function bootstrapIntegrityStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await context(session, id);
  return response(ctx, await progress(ctx));
}
export async function validateBootstrapIntegrity(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await context(session, id);
  await ctx.db
    .prepare(`INSERT OR IGNORE INTO business_sync_integrity_checks(transfer_id,validator_sha256,manifest_sha256,generation,state,updated_at)
    SELECT ?,?,?,?,'accounting',? WHERE EXISTS(${activeBootstrapSql})`)
    .bind(
      ctx.id,
      ctx.integrityValidator,
      ctx.transfer.manifest_sha256,
      ctx.transfer.generation,
      new Date().toISOString(),
      ...ctx.binding,
    )
    .run();
  let row = await progress(ctx);
  if (!row) invalid('La préparation a changé pendant son contrôle.');
  if (row.state === 'accounting') {
    let failed: string | null = null;
    let next = row.next_accounting_rule;
    const stop = Math.min(
      next + ACCOUNTING_RULES_PER_PASS,
      bootstrapAccountingRules.length,
    );
    for (; next < stop; next++) {
      const rule = bootstrapAccountingRules[next];
      if (
        await ctx.db
          .prepare(rule.sql)
          .bind(ctx.id, session.organizationId)
          .first()
      ) {
        failed = rule.id;
        break;
      }
    }
    row = await save(ctx, row, {
      ...row,
      state: failed
        ? 'invalid'
        : next === bootstrapAccountingRules.length
          ? 'projecting'
          : 'accounting',
      next_accounting_rule: next,
      failed_rule: failed,
    });
  } else if (row.state === 'projecting') {
    const projection = await validateCreditProjection(ctx);
    if (projection.phase === 'valid' || projection.phase === 'invalid')
      row = await save(ctx, row, {
        ...row,
        state: projection.phase === 'valid' ? 'indexing' : 'invalid',
        failed_rule: projection.failed_rule,
      });
  } else if (row.state === 'indexing') row = await indexAudit(ctx, row);
  else if (row.state === 'linking') row = await linkAudit(ctx, row);
  else if (row.state === 'walking') row = await walkAudit(ctx, row);
  return response(ctx, row);
}
