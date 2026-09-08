import { AccountPublicError, sha256Hex } from './account-security';
import {
  activeBootstrapSql,
  type BootstrapValidationContext,
} from './business-sync-validation';
import { creditProjectionSql as sql } from './business-sync-credit-projection-sql';

export const CREDIT_SOURCE_PAGE = 256;
export const CREDIT_SOURCE_BYTES = 4 * 1024 * 1024;
export const CREDIT_LINE_PAGE = 1000;
// Bump the algorithm version whenever orchestration semantics change. SQL is
// also fingerprinted, so a receipt cannot silently acquire different rules.
export const creditProjectionContract = [
  2,
  CREDIT_SOURCE_PAGE,
  CREDIT_SOURCE_BYTES,
  CREDIT_LINE_PAGE,
  sql,
];
type Context = BootstrapValidationContext & { integrityValidator: string };
type Phase =
  | 'documents'
  | 'seed_lines'
  | 'seed_payments'
  | 'seed_settlements'
  | 'movement'
  | 'gross'
  | 'rank'
  | 'tax'
  | 'verify'
  | 'valid'
  | 'invalid';
type Order = { id: string; date: string; created_at: string; sequence: string };
type Movement = Order & {
  kind: 'payment' | 'settlement';
  amount: string;
  reverses: string | null;
};
type State = {
  phase: Phase;
  lastDocument: string | null;
  document: { id: string; credit: number; total: string } | null;
  cursor: string | null;
  lastMovement: Order | null;
  movement: Movement | null;
  remainingTotal: string | null;
  signedWeights: boolean;
  documents: number;
  movements: number;
  failedRule: string | null;
};
type Stored = {
  manifest_sha256: string;
  generation: string;
  revision: number;
  state_json: string;
};
type Receipt = Stored & { state: State };
type Key = keyof typeof sql;
type Overrides = {
  cursor?: string | null;
  pageSize?: number;
  extraCents?: number;
};
const initial = (): State => ({
  phase: 'documents',
  lastDocument: null,
  document: null,
  cursor: null,
  lastMovement: null,
  movement: null,
  remainingTotal: null,
  signedWeights: false,
  documents: 0,
  movements: 0,
  failedRule: null,
});
const phases: Phase[] = [
  'documents',
  'seed_lines',
  'seed_payments',
  'seed_settlements',
  'movement',
  'gross',
  'rank',
  'tax',
  'verify',
  'valid',
  'invalid',
];
const integer = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|-?[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) >= BigInt('-9223372036854775807') &&
  BigInt(value) <= BigInt('9223372036854775807');
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024;
const optionalId = (v: unknown) => v === null || identifier(v);
const count = (v: unknown, max: number) =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const order = (v: Order) =>
  v &&
  identifier(v.id) &&
  typeof v.date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v.date) &&
  typeof v.created_at === 'string' &&
  v.created_at.length <= 128 &&
  integer(v.sequence) &&
  BigInt(v.sequence) >= BigInt(0);
const movement = (v: Movement) =>
  order(v) &&
  ['payment', 'settlement'].includes(v.kind) &&
  integer(v.amount) &&
  BigInt(v.amount) > BigInt(0) &&
  optionalId(v.reverses) &&
  (v.kind === 'settlement' || v.reverses === null);
function corrupt(): never {
  throw new AccountPublicError(
    'Le reçu de calcul des avoirs est incohérent.',
    503,
  );
}
function cancelled(): never {
  throw new AccountPublicError(
    'La préparation a été annulée ou remplacée pendant son contrôle.',
    409,
  );
}

async function read(ctx: Context): Promise<Receipt | null> {
  const row = await ctx.db
    .prepare(
      'SELECT manifest_sha256,generation,revision,state_json FROM business_sync_credit_projection WHERE transfer_id=? AND validator_sha256=?',
    )
    .bind(ctx.id, ctx.integrityValidator)
    .first<Stored>();
  if (!row) return null;
  if (
    row.manifest_sha256 !== ctx.transfer.manifest_sha256 ||
    row.generation !== ctx.transfer.generation ||
    !count(row.revision, Number.MAX_SAFE_INTEGER) ||
    typeof row.state_json !== 'string' ||
    row.state_json.length > 16384
  )
    corrupt();
  let state: State;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    corrupt();
  }
  const max = ctx.manifest.row_count * 2;
  if (
    !state ||
    !phases.includes(state.phase) ||
    !optionalId(state.lastDocument) ||
    !(
      state.cursor === null ||
      (typeof state.cursor === 'string' && state.cursor.length <= 8192)
    ) ||
    typeof state.signedWeights !== 'boolean' ||
    !count(state.documents, max) ||
    !count(state.movements, max) ||
    !(state.lastMovement === null || order(state.lastMovement)) ||
    !(state.movement === null || movement(state.movement)) ||
    !(state.remainingTotal === null || integer(state.remainingTotal)) ||
    !(
      state.document === null ||
      (identifier(state.document.id) &&
        [0, 1].includes(state.document.credit) &&
        integer(state.document.total) &&
        BigInt(state.document.total) > BigInt(0))
    ) ||
    (state.phase === 'invalid'
      ? !identifier(state.failedRule)
      : state.failedRule !== null)
  )
    corrupt();
  if (
    !['documents', 'valid', 'invalid'].includes(state.phase) &&
    !state.document
  )
    corrupt();
  if (
    ['gross', 'rank', 'tax', 'verify'].includes(state.phase) &&
    (!state.movement || state.remainingTotal === null)
  )
    corrupt();
  return { ...row, state };
}
function bindings(
  ctx: Context,
  old: Receipt,
  state = old.state,
  overrides: Overrides = {},
) {
  return [
    ctx.id,
    ctx.binding[1],
    ctx.integrityValidator,
    state.document?.id ?? null,
    overrides.cursor === undefined ? state.cursor : overrides.cursor,
    overrides.pageSize ?? CREDIT_LINE_PAGE,
    state.movement?.id ?? null,
    state.movement?.amount ?? '0',
    state.remainingTotal ?? '0',
    state.document?.credit ?? 0,
    Number(state.signedWeights),
    overrides.extraCents ?? 0,
    state.lastMovement?.date ?? null,
    state.lastMovement?.created_at ?? null,
    state.lastMovement?.sequence ?? '0',
    state.lastMovement?.id ?? null,
    state.movement?.reverses ?? null,
    old.revision,
    old.state_json,
    ctx.transfer.manifest_sha256,
    ctx.transfer.generation,
    ctx.transfer.installation_id,
  ];
}
function statement(
  ctx: Context,
  old: Receipt,
  key: Key,
  state = old.state,
  overrides: Overrides = {},
) {
  return ctx.db.prepare(sql[key]).bind(...bindings(ctx, old, state, overrides));
}
async function save(
  ctx: Context,
  old: Receipt,
  next: State,
  mutations: Key[] = [],
  work = old.state,
  overrides: Overrides = {},
) {
  const values = bindings(ctx, old, work, overrides);
  await ctx.db.batch([
    ...mutations.map((key) => ctx.db.prepare(sql[key]).bind(...values)),
    ctx.db
      .prepare(sql.save)
      .bind(...values, JSON.stringify(next), new Date().toISOString()),
  ]);
  if (
    !(await ctx.db
      .prepare(activeBootstrapSql)
      .bind(...ctx.binding)
      .first())
  )
    cancelled();
  const stored = await read(ctx);
  if (!stored) cancelled();
  // A concurrent caller may have won the compare-and-swap; return its receipt.
  return status(stored);
}
function status(row: Receipt | null) {
  return {
    phase: row?.state.phase ?? 'pending',
    verified_documents: row?.state.documents ?? 0,
    verified_movements: row?.state.movements ?? 0,
    revision: row?.revision ?? 0,
    failed_rule: row?.state.failedRule ?? null,
  };
}
export async function creditProjectionStatus(ctx: Context) {
  return status(await read(ctx));
}

export async function validateCreditProjection(ctx: Context) {
  let old = await read(ctx);
  if (!old) {
    const state = initial();
    const candidate = {
      manifest_sha256: ctx.transfer.manifest_sha256,
      generation: ctx.transfer.generation,
      revision: 0,
      state_json: JSON.stringify(state),
      state,
    };
    await ctx.db
      .prepare(sql.initialize)
      .bind(...bindings(ctx, candidate), new Date().toISOString())
      .run();
    old = await read(ctx);
    if (!old) cancelled();
  }
  const s = old.state;
  const fail = (rule: string) =>
    save(ctx, old, {
      ...s,
      phase: 'invalid',
      failedRule: `credit_projection:${rule}`,
    });
  const first = <T>(key: Key, work = s, overrides: Overrides = {}) =>
    statement(ctx, old, key, work, overrides).first<T>();
  if (s.phase === 'valid' || s.phase === 'invalid') return status(old);
  if (s.phase === 'documents') {
    const doc = await first<NonNullable<State['document']>>('nextDocument', s, {
      cursor: s.lastDocument,
    });
    if (!doc) return save(ctx, old, { ...s, phase: 'valid' });
    if (
      !identifier(doc.id) ||
      !integer(doc.total) ||
      BigInt(doc.total) <= BigInt(0) ||
      ![0, 1].includes(doc.credit)
    )
      return fail('document');
    const source = await first<{ source_json: string; token: string }>(
      'recoveryToken',
      { ...s, document: doc },
    );
    if (
      source &&
      (typeof source.source_json !== 'string' ||
        source.source_json.length > 1024 * 1024 ||
        typeof source.token !== 'string' ||
        (await sha256Hex(source.source_json)) !== source.token)
    )
      return fail('recovery_token');
    return save(ctx, old, {
      ...s,
      phase: 'seed_lines',
      document: doc,
      cursor: null,
    });
  }
  if (['seed_lines', 'seed_payments', 'seed_settlements'].includes(s.phase)) {
    const keys: [Key, Key, Key] =
      s.phase === 'seed_lines'
        ? ['seedLinesMeta', 'seedLinesCheck', 'seedLines']
        : s.phase === 'seed_payments'
          ? ['seedPaymentsMeta', 'seedPaymentsCheck', 'seedPayments']
          : ['seedSettlementsMeta', 'seedSettlementsCheck', 'seedSettlements'];
    const meta =
      (
        await statement(ctx, old, keys[0], s, {
          pageSize: CREDIT_SOURCE_PAGE,
        }).all<{ row_key_json: string; bytes: number }>()
      ).results ?? [];
    let size = 0,
      limit = 0;
    for (const item of meta) {
      if (
        !count(item.bytes, 1024 * 1024) ||
        !item.bytes ||
        typeof item.row_key_json !== 'string' ||
        item.row_key_json.length > 8192
      )
        return fail('source_page');
      if (size + item.bytes > CREDIT_SOURCE_BYTES) break;
      size += item.bytes;
      limit++;
    }
    if (limit) {
      if (await first(keys[1], s, { pageSize: limit })) return fail(s.phase);
      return save(
        ctx,
        old,
        { ...s, cursor: meta[limit - 1].row_key_json },
        [keys[2]],
        s,
        { pageSize: limit },
      );
    }
    if (s.phase === 'seed_lines') {
      const totals = await first<{ count: number; gross: string | null }>(
        'totals',
      );
      if (!totals || !totals.count || totals.gross !== s.document!.total)
        return fail('line_total');
    }
    const phase =
      s.phase === 'seed_lines'
        ? s.document!.credit
          ? 'seed_settlements'
          : 'seed_payments'
        : s.phase === 'seed_payments'
          ? 'seed_settlements'
          : 'movement';
    return save(ctx, old, { ...s, phase, cursor: null });
  }
  if (s.phase === 'movement') {
    const event = await first<Movement>('nextMovement');
    if (!event) {
      if (await first('unfinished')) return fail('unfinished');
      return save(ctx, old, {
        ...initial(),
        documents: s.documents + 1,
        movements: s.movements,
        lastDocument: s.document!.id,
      });
    }
    if (!movement(event)) return fail('movement');
    const totals = await first<{ remaining: string | null; signed: number }>(
      'totals',
    );
    if (
      !totals ||
      !integer(totals.remaining) ||
      BigInt(totals.remaining) < BigInt(0)
    )
      return fail('remaining');
    const work = {
      ...s,
      movement: event,
      remainingTotal: totals.remaining,
      signedWeights: totals.signed === 1,
      cursor: null,
    };
    if (event.reverses) {
      if (await first('reversalSource', work)) return fail('reversal');
      return save(
        ctx,
        old,
        { ...work, phase: 'verify' },
        ['resetProposals', 'reverse'],
        work,
      );
    }
    if (BigInt(event.amount) > BigInt(totals.remaining))
      return fail('overpayment');
    return save(
      ctx,
      old,
      { ...work, phase: 'gross' },
      ['resetProposals'],
      work,
    );
  }
  if (s.phase === 'gross' || s.phase === 'tax') {
    if (s.phase === 'tax' && s.cursor === null && (await first('grossBounds')))
      return fail('gross_bounds');
    const page =
      (await statement(ctx, old, 'linePage').all<{ item_id: string }>())
        .results ?? [];
    if (!page.length)
      return save(ctx, old, {
        ...s,
        phase: s.phase === 'gross' ? 'rank' : 'verify',
        cursor: null,
      });
    if (page.some((item) => !identifier(item.item_id))) return fail('line_id');
    return save(ctx, old, { ...s, cursor: page[page.length - 1].item_id }, [
      s.phase,
    ]);
  }
  if (s.phase === 'rank') {
    const totals = await first<{
      count: number;
      amount: string | null;
      eligible: number;
      invalid: number;
    }>('grossTotals');
    if (
      !totals ||
      totals.invalid ||
      !integer(totals.amount) ||
      !count(totals.eligible, ctx.manifest.row_count)
    )
      return fail('gross_sum');
    const extra = BigInt(s.movement!.amount) - BigInt(totals.amount);
    if (extra < BigInt(0) || extra > BigInt(totals.eligible))
      return fail('remainder');
    return save(ctx, old, { ...s, phase: 'tax', cursor: null }, ['rank'], s, {
      extraCents: Number(extra),
    });
  }
  if (s.phase === 'verify') {
    if (await first('proposalBounds')) return fail('bounds');
    const totals = await first<{ gross: string | null; vat: string | null }>(
      'proposalTotals',
    );
    const expected =
      BigInt(s.movement!.amount) * BigInt(s.movement!.reverses ? -1 : 1);
    if (
      !totals ||
      !integer(totals.gross) ||
      !integer(totals.vat) ||
      BigInt(totals.gross) !== expected
    )
      return fail('proposal_total');
    if (s.movement!.kind === 'settlement') {
      if (await first('settlementParts')) return fail('settlement_parts');
    } else {
      const posting = await first<{
        received: number;
        released: string;
        due: string;
        valid: number;
      }>('paymentPosting');
      if (
        !posting ||
        !posting.valid ||
        (posting.received === 1 &&
          (posting.released !== totals.vat || posting.due !== totals.vat))
      )
        return fail('payment_posting');
      if (await first('recoveryParts')) return fail('recovery_parts');
    }
    const { id, date, created_at, sequence } = s.movement!;
    return save(
      ctx,
      old,
      {
        ...s,
        phase: 'movement',
        cursor: null,
        lastMovement: { id, date, created_at, sequence },
        movement: null,
        remainingTotal: null,
        movements: s.movements + 1,
      },
      ['apply', 'confirmMovement'],
    );
  }
  corrupt();
}
