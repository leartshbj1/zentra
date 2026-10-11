import { quotePlanFingerprint } from './fingerprint';
import {
  captureActor,
  captureQuotePlan,
  validatePlanningContext,
} from './validation';
import type { ActionActor, QuotePlan, QuotePlanningContext } from './types';
import type { QuoteLedgerPredicate } from './ledger-types';
import {
  QuotePreparationError,
  type QuotePreparationInput,
  type QuotePreparationClaim,
  type QuotePreparationResult,
  type QuotePreparationClaimResult,
  type QuotePreparationFence,
  type QuotePreparationFenceRequest,
  type QuotePreparationIntake,
} from './intake-types';

export const QUOTE_PREPARATION_LEASE_SECONDS = 180;
const invalid = (): never => {
  throw new QuotePreparationError('invalid_record');
};
function object(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw),
    result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') return invalid();
    const field = descriptors[key];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    result[key] = field.value;
  }
  return result;
}
function exact(raw: unknown, keys: readonly string[]) {
  const value = object(raw);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value;
}
function id(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(raw)
  )
    return invalid();
  return raw;
}
function uuid(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw,
    )
  )
    return invalid();
  return raw;
}
function hash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return invalid();
  return raw;
}
function time(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > 253402300799
  )
    return invalid();
  return raw;
}
function actorCapture(raw: unknown): ActionActor {
  try {
    return captureActor(raw);
  } catch {
    return invalid();
  }
}
function databaseError(error: unknown): never {
  if (error instanceof QuotePreparationError) throw error;
  // Read only an ordinary own message, never arbitrary getters/coercion.
  try {
    const field =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'message')
        : undefined;
    if (
      field &&
      'value' in field &&
      typeof field.value === 'string' &&
      field.value.includes('action_engine_denied')
    )
      throw new QuotePreparationError('forbidden');
  } catch (safe) {
    if (safe instanceof QuotePreparationError) throw safe;
  }
  throw new QuotePreparationError('service_unavailable');
}

export function captureQuotePreparationInput(
  raw: unknown,
): QuotePreparationInput {
  const value = exact(raw, [
    'organizationId',
    'sourceId',
    'kind',
    'engineVersion',
    'sourceRevision',
    'contextRevision',
    'contextHash',
  ]);
  if (
    value.kind !== 'prepare_quote_draft' ||
    value.engineVersion !== 'action-engine-quote-v1'
  )
    return invalid();
  return Object.freeze({
    organizationId: id(value.organizationId),
    sourceId: id(value.sourceId),
    kind: 'prepare_quote_draft',
    engineVersion: 'action-engine-quote-v1',
    sourceRevision: id(value.sourceRevision),
    contextRevision: id(value.contextRevision),
    contextHash: hash(value.contextHash),
  });
}
async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    throw new QuotePreparationError('service_unavailable');
  }
}
async function planFingerprint(plan: QuotePlan): Promise<string> {
  try {
    return await quotePlanFingerprint(plan);
  } catch {
    throw new QuotePreparationError('service_unavailable');
  }
}
export async function quotePreparationInputFingerprint(
  raw: QuotePreparationInput,
): Promise<string> {
  const input = captureQuotePreparationInput(raw);
  return digest(JSON.stringify(input));
}
/** Full trusted context, not only mail/revision labels. Sorting is codepoint based. */
export async function quotePreparationInput(
  raw: QuotePlanningContext,
): Promise<QuotePreparationInput> {
  const context = validatePlanningContext(raw);
  const order = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const canonical = JSON.stringify({
    ...context,
    customers: [...context.customers].sort(order),
    articles: [...context.articles].sort(order),
  });
  const contextHash = await digest(canonical);
  return captureQuotePreparationInput({
    organizationId: context.organizationId,
    sourceId: context.source.id,
    kind: 'prepare_quote_draft',
    engineVersion: 'action-engine-quote-v1',
    sourceRevision: context.source.revision,
    contextRevision: context.revision,
    contextHash,
  });
}

export function captureQuotePreparationClaim(
  raw: unknown,
  actor: ActionActor,
  expectedInput: QuotePreparationInput,
): QuotePreparationClaim {
  const identity = actorCapture(actor);
  const value = exact(raw, [
    'id',
    'input',
    'inputHash',
    'userId',
    'ownerToken',
    'leaseUntil',
  ]);
  const input = captureQuotePreparationInput(value.input),
    expected = captureQuotePreparationInput(expectedInput);
  if (
    input.organizationId !== identity.organizationId ||
    value.userId !== identity.userId
  )
    throw new QuotePreparationError('forbidden');
  if (JSON.stringify(input) !== JSON.stringify(expected))
    throw new QuotePreparationError('conflict');
  return Object.freeze({
    id: uuid(value.id),
    input,
    inputHash: hash(value.inputHash),
    userId: id(value.userId),
    ownerToken: uuid(value.ownerToken),
    leaseUntil: time(value.leaseUntil),
  });
}
export function captureQuotePreparationResult(
  raw: unknown,
  expectedInput: QuotePreparationInput,
): QuotePreparationResult {
  const value = exact(raw, ['inputHash', 'plan', 'fingerprint']),
    input = captureQuotePreparationInput(expectedInput);
  let plan: QuotePlan;
  try {
    plan = captureQuotePlan(value.plan);
  } catch {
    return invalid();
  }
  if (
    plan.organizationId !== input.organizationId ||
    plan.sourceId !== input.sourceId ||
    plan.sourceRevision !== input.sourceRevision ||
    plan.contextRevision !== input.contextRevision ||
    plan.kind !== input.kind ||
    plan.engineVersion !== input.engineVersion ||
    plan.reasons.includes('provider_unavailable')
  )
    return invalid();
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 65536)
    return invalid();
  return Object.freeze({
    inputHash: hash(value.inputHash),
    plan,
    fingerprint: hash(value.fingerprint),
  });
}
function claimCapture(raw: unknown, actor: ActionActor) {
  const fields = object(raw),
    input = captureQuotePreparationInput(fields.input);
  return captureQuotePreparationClaim(fields, actor, input);
}
function predicate(raw: QuoteLedgerPredicate): QuoteLedgerPredicate {
  const fields = exact(raw, ['sql', 'bindings']);
  if (
    typeof fields.sql !== 'string' ||
    !fields.sql.trim() ||
    fields.sql.length > 16000 ||
    fields.sql.includes(';') ||
    fields.sql.includes(String.fromCharCode(0)) ||
    !Array.isArray(fields.bindings) ||
    Object.getPrototypeOf(fields.bindings) !== Array.prototype
  )
    return invalid();
  const values = fields.bindings,
    descriptors = Object.getOwnPropertyDescriptors(values as object),
    length: unknown = descriptors.length?.value;
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 64 ||
    Reflect.ownKeys(values).length !== length + 1
  )
    return invalid();
  const bindings: (string | number | null)[] = [];
  for (let at = 0; at < length; at++) {
    const field = descriptors[String(at)];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    const value: unknown = field.value;
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= 65536) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    bindings.push(value as string | number | null);
  }
  return Object.freeze({ sql: fields.sql, bindings: Object.freeze(bindings) });
}

type Row = {
  id: string;
  organization_id: string;
  source_id: string;
  action_kind: string;
  engine_version: string;
  source_revision: string;
  context_revision: string;
  context_hash: string;
  input_hash: string;
  input_json: string;
  state: 'preparing' | 'started' | 'finished' | 'uncertain';
  owner_user_id: string;
  owner_token: string;
  lease_until: number;
  started_at: number | null;
  finished_at: number | null;
  result_json: string | null;
  result_fingerprint: string | null;
  created_at: number;
  updated_at: number;
};
type CapturedRow = {
  row: Row;
  input: QuotePreparationInput;
  result: QuotePreparationResult | null;
};
async function rowCapture(raw: unknown): Promise<CapturedRow> {
  const value = exact(raw, [
    'id',
    'organization_id',
    'source_id',
    'action_kind',
    'engine_version',
    'source_revision',
    'context_revision',
    'context_hash',
    'input_hash',
    'input_json',
    'state',
    'owner_user_id',
    'owner_token',
    'lease_until',
    'started_at',
    'finished_at',
    'result_json',
    'result_fingerprint',
    'created_at',
    'updated_at',
  ]);
  if (
    typeof value.input_json !== 'string' ||
    new TextEncoder().encode(value.input_json).byteLength > 4096 ||
    !['preparing', 'started', 'finished', 'uncertain'].includes(
      value.state as string,
    )
  )
    return invalid();
  let input: QuotePreparationInput;
  try {
    input = captureQuotePreparationInput(JSON.parse(value.input_json));
  } catch {
    return invalid();
  }
  if (
    input.organizationId !== value.organization_id ||
    input.sourceId !== value.source_id ||
    input.kind !== value.action_kind ||
    input.engineVersion !== value.engine_version ||
    input.sourceRevision !== value.source_revision ||
    input.contextRevision !== value.context_revision ||
    input.contextHash !== value.context_hash ||
    (await quotePreparationInputFingerprint(input)) !== hash(value.input_hash)
  )
    return invalid();
  uuid(value.id);
  uuid(value.owner_token);
  id(value.owner_user_id);
  const created = time(value.created_at),
    updated = time(value.updated_at),
    lease = time(value.lease_until);
  if (updated < created) return invalid();
  if (
    value.started_at !== null &&
    (time(value.started_at) < created || time(value.started_at) > updated)
  )
    return invalid();
  if (
    (value.state === 'started' || value.state === 'uncertain') &&
    value.started_at === null
  )
    return invalid();
  if (
    value.state === 'preparing' &&
    (value.started_at !== null || lease <= updated)
  )
    return invalid();
  let result: QuotePreparationResult | null = null;
  if (value.state === 'finished') {
    if (
      typeof value.result_json !== 'string' ||
      time(value.finished_at) < created ||
      time(value.finished_at) > updated
    )
      return invalid();
    try {
      result = captureQuotePreparationResult(
        {
          inputHash: value.input_hash,
          plan: JSON.parse(value.result_json),
          fingerprint: value.result_fingerprint,
        },
        input,
      );
    } catch {
      return invalid();
    }
    if ((await planFingerprint(result.plan)) !== result.fingerprint)
      return invalid();
  } else if (
    value.result_json !== null ||
    value.result_fingerprint !== null ||
    value.finished_at !== null
  )
    return invalid();
  return { row: Object.freeze(value) as unknown as Row, input, result };
}

/** Durable preparation ownership, deliberately without an HTTP/provider adapter. */
export function createD1QuoteIntake(
  database: Pick<D1Database, 'prepare' | 'batch'>,
  rawFence: QuotePreparationFence,
  options: { nowSeconds?: () => number; newUuid?: () => string } = {},
): QuotePreparationIntake {
  if (typeof rawFence !== 'function')
    throw new QuotePreparationError('forbidden');
  const fence = rawFence.bind(undefined),
    prepare = database.prepare.bind(database),
    batch = database.batch.bind(database);
  const nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
    newUuid = options.newUuid ?? (() => crypto.randomUUID());
  const now = () => {
    try {
      return time(nowSeconds());
    } catch (error) {
      return databaseError(error);
    }
  };
  const nextId = () => {
    try {
      return uuid(newUuid());
    } catch (error) {
      return databaseError(error);
    }
  };
  async function atomic(
    request: QuotePreparationFenceRequest,
    build: D1PreparedStatement[] | (() => D1PreparedStatement[]),
    readIndex: number,
  ): Promise<unknown[]> {
    try {
      const gate = predicate(await fence(Object.freeze(request))),
        operationId = nextId();
      // Build clocks and lease predicates after the private fence's await. A
      // slow authority lookup must not keep an expired pre-HTTP lease valid.
      const statements = typeof build === 'function' ? build() : build;
      const results = await batch([
        prepare(
          `INSERT INTO action_engine_atomic_assertions(operation_id,allowed) SELECT ?,CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
        ).bind(operationId, ...gate.bindings),
        ...statements,
        prepare(
          'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
        ).bind(operationId),
      ]);
      if (
        results.some((result) => !result.success) ||
        !Array.isArray(results[readIndex + 1]?.results)
      )
        throw new QuotePreparationError('service_unavailable');
      return results[readIndex + 1].results;
    } catch (error) {
      return databaseError(error);
    }
  }
  const select = (input: QuotePreparationInput) =>
    prepare(
      'SELECT * FROM action_engine_quote_intake WHERE organization_id=? AND source_id=? AND action_kind=?',
    ).bind(input.organizationId, input.sourceId, input.kind);
  async function capturedRows(
    rows: unknown[],
    input: QuotePreparationInput,
    expectedHash: string,
  ) {
    if (rows.length > 1) return invalid();
    if (!rows.length) return null;
    const captured = await rowCapture(rows[0]);
    if (
      captured.row.input_hash !== expectedHash ||
      JSON.stringify(captured.input) !== JSON.stringify(input)
    )
      throw new QuotePreparationError('conflict');
    return captured;
  }
  async function load(
    actor: ActionActor,
    input: QuotePreparationInput,
    inputHash: string,
  ) {
    return capturedRows(
      await atomic({ operation: 'read', actor, input }, [select(input)], 0),
      input,
      inputHash,
    );
  }
  const event = (
    input: QuotePreparationInput,
    intakeId: string,
    owner: string,
    actor: ActionActor,
    kind: string,
    at: number,
  ) =>
    prepare(`INSERT INTO action_engine_quote_intake_events(id,intake_id,organization_id,input_hash,event_type,owner_token,actor_user_id,created_at)
    SELECT ?,i.id,i.organization_id,i.input_hash,?,i.owner_token,?,? FROM action_engine_quote_intake i
    WHERE i.id=? AND i.organization_id=? AND i.owner_token=? AND i.owner_user_id=?
    AND i.state=? AND NOT EXISTS(SELECT 1 FROM action_engine_quote_intake_events e WHERE e.intake_id=i.id AND e.owner_token=i.owner_token AND e.event_type=?)`).bind(
      nextId(),
      kind,
      actor.userId,
      at,
      intakeId,
      input.organizationId,
      owner,
      actor.userId,
      kind === 'claimed' ? 'preparing' : kind,
      kind,
    );
  const publicClaim = (captured: CapturedRow, actor: ActionActor) =>
    captureQuotePreparationClaim(
      {
        id: captured.row.id,
        input: captured.input,
        inputHash: captured.row.input_hash,
        userId: captured.row.owner_user_id,
        ownerToken: captured.row.owner_token,
        leaseUntil: captured.row.lease_until,
      },
      actor,
      captured.input,
    );
  function outcome(captured: CapturedRow): QuotePreparationClaimResult {
    if (captured.result)
      return Object.freeze({ state: 'finished', result: captured.result });
    if (
      captured.row.state === 'uncertain' ||
      (captured.row.state === 'started' && captured.row.lease_until <= now())
    )
      return Object.freeze({
        state: 'uncertain',
        sourceId: captured.input.sourceId,
      });
    return Object.freeze({ state: 'held', sourceId: captured.input.sourceId });
  }
  async function owned(
    actor: ActionActor,
    claim: QuotePreparationClaim,
  ): Promise<CapturedRow> {
    if (
      (await quotePreparationInputFingerprint(claim.input)) !== claim.inputHash
    )
      return invalid();
    const captured = await load(actor, claim.input, claim.inputHash);
    if (!captured) return invalid();
    if (
      captured.row.id !== claim.id ||
      captured.row.owner_token !== claim.ownerToken ||
      captured.row.owner_user_id !== actor.userId ||
      captured.row.lease_until !== claim.leaseUntil
    )
      throw new QuotePreparationError('held');
    return captured;
  }
  return {
    async read(rawActor, rawInput) {
      const actor = actorCapture(rawActor),
        input = captureQuotePreparationInput(rawInput);
      if (actor.organizationId !== input.organizationId)
        throw new QuotePreparationError('forbidden');
      const inputHash = await quotePreparationInputFingerprint(input),
        captured = await load(actor, input, inputHash);
      return captured
        ? Object.freeze({
            input: captured.input,
            inputHash: captured.row.input_hash,
            state: captured.row.state,
            result: captured.result,
          })
        : null;
    },
    async claim(rawActor, rawInput) {
      const actor = actorCapture(rawActor),
        input = captureQuotePreparationInput(rawInput);
      if (actor.organizationId !== input.organizationId)
        throw new QuotePreparationError('forbidden');
      const inputHash = await quotePreparationInputFingerprint(input),
        prior = await load(actor, input, inputHash);
      if (
        prior &&
        (prior.row.state !== 'preparing' || prior.row.lease_until > now())
      )
        return outcome(prior);
      const intakeId = prior?.row.id ?? nextId(),
        owner = nextId();
      const rows = await atomic(
        { operation: 'claim', actor, input },
        () => {
          const at = now(),
            lease = time(at + QUOTE_PREPARATION_LEASE_SECONDS);
          return [
            prepare(`INSERT INTO action_engine_quote_intake(id,organization_id,source_id,action_kind,engine_version,source_revision,context_revision,context_hash,input_hash,input_json,state,owner_user_id,owner_token,lease_until,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM action_engine_quote_intake WHERE organization_id=? AND source_id=? AND action_kind=?)`).bind(
              intakeId,
              input.organizationId,
              input.sourceId,
              input.kind,
              input.engineVersion,
              input.sourceRevision,
              input.contextRevision,
              input.contextHash,
              inputHash,
              JSON.stringify(input),
              actor.userId,
              owner,
              lease,
              at,
              at,
              input.organizationId,
              input.sourceId,
              input.kind,
            ),
            prepare(`UPDATE action_engine_quote_intake SET owner_user_id=?,owner_token=?,lease_until=?,updated_at=?
          WHERE organization_id=? AND source_id=? AND action_kind=? AND input_hash=? AND state='preparing' AND lease_until<=?`).bind(
              actor.userId,
              owner,
              lease,
              at,
              input.organizationId,
              input.sourceId,
              input.kind,
              inputHash,
              at,
            ),
            event(input, intakeId, owner, actor, 'claimed', at),
            select(input),
          ];
        },
        3,
      );
      const captured = await capturedRows(rows, input, inputHash);
      if (!captured) return invalid();
      return captured.row.state === 'preparing' &&
        captured.row.owner_token === owner &&
        captured.row.owner_user_id === actor.userId
        ? Object.freeze({ state: 'owned', claim: publicClaim(captured, actor) })
        : outcome(captured);
    },
    async start(rawActor, rawClaim) {
      const actor = actorCapture(rawActor),
        claim = claimCapture(rawClaim, actor),
        captured = await owned(actor, claim);
      if (captured.row.state !== 'preparing')
        throw new QuotePreparationError('uncertain');
      const rows = await atomic(
        { operation: 'start', actor, claim },
        () => {
          const at = now();
          if (captured.row.lease_until <= at)
            throw new QuotePreparationError('held');
          return [
            prepare(`UPDATE action_engine_quote_intake SET state='started',started_at=?,updated_at=?
          WHERE id=? AND organization_id=? AND input_hash=? AND owner_token=? AND owner_user_id=? AND state='preparing' AND lease_until>? RETURNING *`).bind(
              at,
              at,
              claim.id,
              actor.organizationId,
              claim.inputHash,
              claim.ownerToken,
              actor.userId,
              at,
            ),
            event(
              claim.input,
              claim.id,
              claim.ownerToken,
              actor,
              'started',
              at,
            ),
          ];
        },
        0,
      );
      if (rows.length !== 1) throw new QuotePreparationError('uncertain');
      const started = await capturedRows(rows, claim.input, claim.inputHash);
      if (!started || started.row.state !== 'started') return invalid();
    },
    async finish(rawActor, rawClaim, rawPlan, rawFingerprint) {
      const actor = actorCapture(rawActor),
        claim = claimCapture(rawClaim, actor);
      const result = captureQuotePreparationResult(
        {
          inputHash: claim.inputHash,
          plan: rawPlan,
          fingerprint: rawFingerprint,
        },
        claim.input,
      );
      if ((await planFingerprint(result.plan)) !== result.fingerprint)
        return invalid();
      const captured = await owned(actor, claim);
      if (captured.result) {
        if (JSON.stringify(captured.result) !== JSON.stringify(result))
          throw new QuotePreparationError('conflict');
        return captured.result;
      }
      if (captured.row.state === 'uncertain')
        throw new QuotePreparationError('uncertain');
      const rows = await atomic(
        { operation: 'finish', actor, claim, result },
        () => {
          const at = now();
          if (
            captured.row.state === 'preparing' &&
            captured.row.lease_until <= at
          )
            throw new QuotePreparationError('held');
          return [
            prepare(`UPDATE action_engine_quote_intake SET state='finished',finished_at=?,result_json=?,result_fingerprint=?,updated_at=?
          WHERE id=? AND organization_id=? AND input_hash=? AND owner_token=? AND owner_user_id=?
          AND (state='started' OR (state='preparing' AND lease_until>?))`).bind(
              at,
              JSON.stringify(result.plan),
              result.fingerprint,
              at,
              claim.id,
              actor.organizationId,
              claim.inputHash,
              claim.ownerToken,
              actor.userId,
              at,
            ),
            event(
              claim.input,
              claim.id,
              claim.ownerToken,
              actor,
              'finished',
              at,
            ),
            select(claim.input),
          ];
        },
        2,
      );
      const saved = await capturedRows(rows, claim.input, claim.inputHash);
      if (
        !saved?.result ||
        JSON.stringify(saved.result) !== JSON.stringify(result)
      )
        throw new QuotePreparationError('conflict');
      return saved.result;
    },
    async uncertain(rawActor, rawClaim) {
      const actor = actorCapture(rawActor),
        claim = claimCapture(rawClaim, actor),
        captured = await owned(actor, claim);
      if (
        captured.row.state === 'finished' ||
        captured.row.state === 'uncertain'
      )
        return;
      if (captured.row.state !== 'started') return invalid();
      const rows = await atomic(
        { operation: 'uncertain', actor, claim },
        () => {
          const at = now();
          return [
            prepare(`UPDATE action_engine_quote_intake SET state='uncertain',updated_at=?
          WHERE id=? AND organization_id=? AND input_hash=? AND owner_token=? AND owner_user_id=? AND state='started'`).bind(
              at,
              claim.id,
              actor.organizationId,
              claim.inputHash,
              claim.ownerToken,
              actor.userId,
            ),
            event(
              claim.input,
              claim.id,
              claim.ownerToken,
              actor,
              'uncertain',
              at,
            ),
            select(claim.input),
          ];
        },
        2,
      );
      const saved = await capturedRows(rows, claim.input, claim.inputHash);
      if (!saved || !['uncertain', 'finished'].includes(saved.row.state))
        return invalid();
    },
  };
}
