import type { DeviceSessionContext } from './account';
import {
  AccountPublicError,
  roleCanManageMembers,
  sha256Hex,
} from './account-security';
import {
  bootstrapManifest,
  businessSyncContractHash,
  businessSyncTransferId,
} from './business-sync-bootstrap';
import { structuralRules, structuralSchema } from './business-sync-structure';
import { database } from './runtime';

export const STRUCTURAL_RULES_PER_REQUEST = 16;
type Transfer = {
  transfer_id: string;
  installation_id: string;
  generation: string;
  state: string;
  manifest_json: string;
  manifest_sha256: string;
};
type Progress = {
  manifest_sha256: string;
  generation: string;
  next_rule: number;
  state: string;
  failed_rule: string | null;
};
let validatorHash: Promise<string> | undefined;
export function structuralValidatorHash() {
  return (validatorHash ??= sha256Hex(
    JSON.stringify([
      'zentra-structural-validator',
      1,
      structuralSchema.protocol_sha256,
      structuralRules,
    ]),
  ));
}
const activeTransfer = `SELECT 1 FROM business_sync_transfers t JOIN business_sync_spaces s
  ON s.organization_id=t.organization_id AND s.bootstrap_transfer_id=t.transfer_id AND s.generation=t.generation
  WHERE t.transfer_id=? AND t.organization_id=? AND t.installation_id=? AND t.generation=? AND t.manifest_sha256=?
    AND t.kind='bootstrap' AND t.state='uploaded' AND s.state='initializing' AND s.head_revision=0`;
function invalid(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}

async function context(session: DeviceSessionContext, rawId: unknown) {
  if (!roleCanManageMembers(session.role))
    invalid(
      'Seuls le titulaire et les administrateurs peuvent vérifier la base de référence.',
      403,
    );
  const id = businessSyncTransferId(rawId);
  const db = database();
  const transfer = await db
    .prepare(
      "SELECT * FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND kind='bootstrap'",
    )
    .bind(id, session.organizationId)
    .first<Transfer>();
  if (!transfer) invalid('Préparation de synchronisation introuvable.', 404);
  if (transfer.installation_id !== session.installationId)
    invalid('Cette préparation appartient à un autre appareil.');
  const binding = [
    id,
    session.organizationId,
    session.installationId,
    transfer.generation,
    transfer.manifest_sha256,
  ];
  if (
    !(await db
      .prepare(activeTransfer)
      .bind(...binding)
      .first())
  )
    invalid('Cette préparation n’est pas disponible pour vérification.');
  if (structuralSchema.protocol_sha256 !== (await businessSyncContractHash()))
    invalid('Le vérificateur doit être mis à jour avant de continuer.', 503);
  if ((await sha256Hex(transfer.manifest_json)) !== transfer.manifest_sha256)
    invalid('Le manifeste enregistré est incohérent.', 503);
  const manifest = await bootstrapManifest(JSON.parse(transfer.manifest_json));
  const validator = await structuralValidatorHash();
  return { db, id, transfer, binding, manifest, validator };
}
type Context = Awaited<ReturnType<typeof context>>;
async function progress(ctx: Context) {
  const row = await ctx.db
    .prepare(
      'SELECT * FROM business_sync_structural_checks WHERE transfer_id=? AND validator_sha256=?',
    )
    .bind(ctx.id, ctx.validator)
    .first<Progress>();
  if (
    row &&
    (row.manifest_sha256 !== ctx.transfer.manifest_sha256 ||
      row.generation !== ctx.transfer.generation ||
      !Number.isSafeInteger(row.next_rule) ||
      row.next_rule < 0 ||
      row.next_rule > structuralRules.length ||
      !['checking', 'valid', 'invalid'].includes(row.state) ||
      (row.state === 'valid') !== (row.next_rule === structuralRules.length) ||
      (row.state === 'invalid'
        ? row.failed_rule !== structuralRules[row.next_rule]?.id
        : row.failed_rule !== null))
  )
    invalid(
      'Le reçu de vérification est incohérent. La préparation ne peut pas être publiée.',
      503,
    );
  return row;
}
function response(ctx: Context, row: Progress | null) {
  return {
    transfer_id: ctx.id,
    manifest_sha256: ctx.transfer.manifest_sha256,
    validator_sha256: ctx.validator,
    generation: ctx.transfer.generation,
    state: row?.state ?? 'pending',
    checked_rules: row?.next_rule ?? 0,
    total_rules: structuralRules.length,
    failed_rule: row?.failed_rule ?? null,
    replication_active: false,
  };
}

export async function structuralValidationStatus(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  const ctx = await context(session, rawId);
  return response(ctx, await progress(ctx));
}

export async function validateBootstrapStructure(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  const ctx = await context(session, rawId);
  await ctx.db
    .prepare(`INSERT OR IGNORE INTO business_sync_structural_checks
    (transfer_id,validator_sha256,manifest_sha256,generation,next_rule,state,updated_at)
    SELECT ?,?,?,?,0,'checking',? WHERE EXISTS(${activeTransfer})`)
    .bind(
      ctx.id,
      ctx.validator,
      ctx.transfer.manifest_sha256,
      ctx.transfer.generation,
      new Date().toISOString(),
      ...ctx.binding,
    )
    .run();
  const row = await progress(ctx);
  if (!row) invalid('La préparation a changé pendant sa vérification.');
  if (row.state !== 'checking') return response(ctx, row);
  let next = row.next_rule;
  let failed: string | null = null;
  const stop = Math.min(
    next + STRUCTURAL_RULES_PER_REQUEST,
    structuralRules.length,
  );
  for (; next < stop; next++) {
    const rule = structuralRules[next];
    const params: (string | number)[] = [ctx.id, session.organizationId];
    if (rule.kind === 'count') params.push(ctx.manifest.tables[rule.table]);
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
  // Uploaded rows are immutable. Cancellation or competing requests can only
  // advance this cursor through this compare-and-swap; a retry never skips work.
  await ctx.db
    .prepare(`UPDATE business_sync_structural_checks SET next_rule=?,state=?,failed_rule=?,updated_at=?
    WHERE transfer_id=? AND validator_sha256=? AND manifest_sha256=? AND generation=? AND next_rule=? AND state='checking'
      AND EXISTS(${activeTransfer})`)
    .bind(
      next,
      failed
        ? 'invalid'
        : next === structuralRules.length
          ? 'valid'
          : 'checking',
      failed,
      new Date().toISOString(),
      ctx.id,
      ctx.validator,
      ctx.transfer.manifest_sha256,
      ctx.transfer.generation,
      row.next_rule,
      ...ctx.binding,
    )
    .run();
  if (
    !(await ctx.db
      .prepare(activeTransfer)
      .bind(...ctx.binding)
      .first())
  )
    invalid(
      'La préparation a été annulée ou remplacée pendant sa vérification.',
    );
  return response(ctx, await progress(ctx));
}
