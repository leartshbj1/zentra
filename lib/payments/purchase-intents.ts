export type PurchaseEnvironment = 'TEST' | 'PRODUCTION';
export type PurchaseProvider = 'stripe' | 'postfinance';
export type PurchaseProduct = 'gestion' | 'support' | 'automation' | 'complete';
export type PurchaseState =
  | 'reserved'
  | 'dispatched'
  | 'uncertain'
  | 'settled'
  | 'canceled'
  | 'expired'
  | 'released';
export type PurchaseTerms = Readonly<{
  version: string;
  consentVersion: string | null;
  origin: string;
}>;
export type PurchaseInput = Readonly<{
  ownerId: string;
  environment: PurchaseEnvironment;
  provider: PurchaseProvider;
  providerScope: string;
  product: PurchaseProduct;
  organizationId: string | null;
  workspaceId: string | null;
  planId: string | null;
  parameters: Record<string, unknown>;
  terms: PurchaseTerms;
  reservationSeconds?: number;
}>;
export type PurchaseBinding = Readonly<{
  intentId: string;
  fingerprint: string;
  ownerId: string;
  environment: PurchaseEnvironment;
  provider: PurchaseProvider;
  providerScope: string;
}>;
export type PurchaseIntent = PurchaseBinding &
  Readonly<{
    product: PurchaseProduct;
    organizationId: string | null;
    workspaceId: string | null;
    planId: string | null;
    parameters: Record<string, unknown>;
    terms: PurchaseTerms & { acceptedAt: number };
    createdAt: number;
    expiresAt: number;
    dispatchedAt: number | null;
    providerReference: string | null;
    state: PurchaseState;
    evidenceFingerprint: string | null;
  }>;
export class PurchaseIntentError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'binding' | 'state') {
    super(`purchase_intent_${code}`);
  }
}
type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Row = {
  intent_id: string;
  fingerprint: string;
  owner_id: string;
  environment: PurchaseEnvironment;
  provider: PurchaseProvider;
  provider_scope: string;
  product: PurchaseProduct;
  organization_id: string | null;
  workspace_id: string | null;
  plan_id: string | null;
  parameters: string;
  terms_version: string;
  consent_version: string | null;
  origin: string;
  accepted_at: number;
  state: PurchaseState;
  created_at: number;
  expires_at: number;
  dispatched_at: number | null;
  provider_reference: string | null;
  evidence_fingerprint: string | null;
};
type Footprint = readonly [
  'organization' | 'workspace',
  string,
  'gestion' | 'support' | 'automation',
];
const hashPattern = /^[a-f0-9]{64}$/;
function text(value: unknown, maximum = 180): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return point < 32 || point === 127;
    })
  );
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 12) throw new PurchaseIntentError('invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return (
      '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']'
    );
  if (
    typeof value === 'object' &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  }
  throw new PurchaseIntentError('invalid');
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function fromRow(row: Row): PurchaseIntent {
  return {
    intentId: row.intent_id,
    fingerprint: row.fingerprint,
    ownerId: row.owner_id,
    environment: row.environment,
    provider: row.provider,
    providerScope: row.provider_scope,
    product: row.product,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    parameters: JSON.parse(row.parameters),
    terms: {
      version: row.terms_version,
      consentVersion: row.consent_version,
      origin: row.origin,
      acceptedAt: row.accepted_at,
    },
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    dispatchedAt: row.dispatched_at,
    providerReference: row.provider_reference,
    evidenceFingerprint: row.evidence_fingerprint,
  };
}
const terminal = new Set<PurchaseState>([
  'settled',
  'canceled',
  'expired',
  'released',
]);

/** Internal reservation/sink, NOT authentication, a provider verifier or a rights
 * issuer. The controller must authorise this context and independently verify
 * final provider facts before calling finalize. Never accept these objects from
 * a public route unchanged. Dispatched/uncertain operations have no TTL release. */
export class D1PurchaseIntents {
  constructor(
    private readonly db: Database,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}

  async reserve(input: PurchaseInput): Promise<PurchaseIntent> {
    if (
      !text(input.ownerId) ||
      !text(input.providerScope, 300) ||
      (input.planId === null
        ? input.product !== 'automation'
        : !text(input.planId)) ||
      !['TEST', 'PRODUCTION'].includes(input.environment) ||
      !['stripe', 'postfinance'].includes(input.provider) ||
      !['gestion', 'support', 'automation', 'complete'].includes(
        input.product,
      ) ||
      !text(input.terms?.version) ||
      (input.terms.consentVersion !== null &&
        !text(input.terms.consentVersion)) ||
      !text(input.terms.origin, 300)
    )
      throw new PurchaseIntentError('invalid');
    let origin: URL;
    try {
      origin = new URL(input.terms.origin);
    } catch {
      throw new PurchaseIntentError('invalid');
    }
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.origin !== input.terms.origin
    )
      throw new PurchaseIntentError('invalid');
    if (
      !input.parameters ||
      Array.isArray(input.parameters) ||
      Object.getPrototypeOf(input.parameters) !== Object.prototype
    )
      throw new PurchaseIntentError('invalid');
    const parameters = canonical(input.parameters);
    if (new TextEncoder().encode(parameters).byteLength > 32768)
      throw new PurchaseIntentError('invalid');
    const seconds = input.reservationSeconds ?? 3600;
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400)
      throw new PurchaseIntentError('invalid');
    if (
      (input.organizationId !== null && !text(input.organizationId)) ||
      (input.workspaceId !== null && !text(input.workspaceId))
    )
      throw new PurchaseIntentError('invalid');
    let organizationId = input.organizationId;
    if (input.product === 'support') {
      if (!input.workspaceId) throw new PurchaseIntentError('invalid');
      const link = await this.db
        .prepare(
          'SELECT organization_id FROM support_gestion_links WHERE workspace_id=?',
        )
        .bind(input.workspaceId)
        .first<{ organization_id: string }>();
      if (
        organizationId !== null &&
        organizationId !== (link?.organization_id ?? null)
      )
        throw new PurchaseIntentError('conflict');
      organizationId = link?.organization_id ?? null;
    } else if (
      !organizationId ||
      (input.product === 'complete'
        ? !input.workspaceId
        : input.workspaceId !== null)
    )
      throw new PurchaseIntentError('invalid');
    const footprints: Footprint[] =
      input.product === 'complete'
        ? [
            ['organization', organizationId!, 'gestion'],
            ['organization', organizationId!, 'automation'],
            ['organization', organizationId!, 'support'],
            ['workspace', input.workspaceId!, 'support'],
          ]
        : input.product === 'support'
          ? [
              ['workspace', input.workspaceId!, 'support'],
              ...(organizationId
                ? [['organization', organizationId, 'support'] as Footprint]
                : []),
            ]
          : [['organization', organizationId!, input.product]];
    const fingerprint = await digest(
      canonical({
        ownerId: input.ownerId,
        environment: input.environment,
        provider: input.provider,
        providerScope: input.providerScope,
        product: input.product,
        organizationId,
        workspaceId: input.workspaceId,
        planId: input.planId,
        parameters: JSON.parse(parameters),
        terms: input.terms,
      }),
    );
    const existing = await this.byFingerprint(fingerprint);
    if (existing) return existing;
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now <= 0)
      throw new PurchaseIntentError('invalid');
    const intentId = 'purchase_' + crypto.randomUUID();
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO purchase_intents(intent_id,fingerprint,owner_id,environment,provider,provider_scope,product,organization_id,workspace_id,plan_id,parameters,terms_version,consent_version,origin,accepted_at,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            intentId,
            fingerprint,
            input.ownerId,
            input.environment,
            input.provider,
            input.providerScope,
            input.product,
            organizationId,
            input.workspaceId,
            input.planId,
            parameters,
            input.terms.version,
            input.terms.consentVersion,
            input.terms.origin,
            now,
            now,
            now + seconds,
          ),
        ...footprints.map(([kind, id, entitlement]) =>
          this.db
            .prepare(
              'INSERT INTO purchase_intent_footprints(intent_id,environment,scope_kind,scope_id,entitlement) VALUES(?,?,?,?,?)',
            )
            .bind(intentId, input.environment, kind, id, entitlement),
        ),
      ]);
    } catch (error) {
      // The losing concurrent exact request resumes the winning history, even
      // after release. Financial/network/storage failures remain retriable.
      const winner = await this.byFingerprint(fingerprint);
      if (winner) return winner;
      if (
        /purchase_(?:target|rights|change|footprint)|UNIQUE constraint failed: purchase_intent_footprints/.test(
          String(error),
        )
      )
        throw new PurchaseIntentError('conflict');
      throw error;
    }
    return (await this.byFingerprint(fingerprint))!;
  }

  private async byFingerprint(fingerprint: string) {
    const row = await this.db
      .prepare('SELECT * FROM purchase_intents WHERE fingerprint=?')
      .bind(fingerprint)
      .first<Row>();
    return row ? fromRow(row) : null;
  }
  private async bound(binding: PurchaseBinding) {
    if (
      !/^purchase_[0-9a-f-]{36}$/.test(binding.intentId) ||
      !hashPattern.test(binding.fingerprint)
    )
      throw new PurchaseIntentError('binding');
    const row = await this.db
      .prepare(
        'SELECT * FROM purchase_intents WHERE intent_id=? AND fingerprint=? AND owner_id=? AND environment=? AND provider=? AND provider_scope=?',
      )
      .bind(
        binding.intentId,
        binding.fingerprint,
        binding.ownerId,
        binding.environment,
        binding.provider,
        binding.providerScope,
      )
      .first<Row>();
    if (!row) throw new PurchaseIntentError('binding');
    return fromRow(row);
  }
  async read(binding: PurchaseBinding) {
    return this.bound(binding);
  }
  async markDispatched(binding: PurchaseBinding) {
    const intent = await this.bound(binding);
    if (intent.state === 'reserved') {
      await this.db
        .prepare(
          "UPDATE purchase_intents SET state='dispatched',dispatched_at=? WHERE intent_id=? AND fingerprint=? AND state='reserved' AND expires_at>?",
        )
        .bind(this.clock(), binding.intentId, binding.fingerprint, this.clock())
        .run();
    } else if (['dispatched', 'uncertain'].includes(intent.state)) {
      // A safe provider-idempotency retry is still a financial dispatch. Touch
      // the state so database scope guards recheck the current owner, target
      // and reservation immediately before it, rather than trusting the first
      // dispatch's authorization indefinitely. Preserve uncertainty/history.
      await this.db
        .prepare(
          "UPDATE purchase_intents SET state=state WHERE intent_id=? AND fingerprint=? AND state IN ('dispatched','uncertain')",
        )
        .bind(binding.intentId, binding.fingerprint)
        .run();
    } else throw new PurchaseIntentError('state');
    const result = await this.bound(binding);
    if (!['dispatched', 'uncertain'].includes(result.state))
      throw new PurchaseIntentError('state');
    return result;
  }
  async markUncertain(binding: PurchaseBinding) {
    await this.bound(binding);
    await this.db
      .prepare(
        "UPDATE purchase_intents SET state='uncertain' WHERE intent_id=? AND fingerprint=? AND state='dispatched'",
      )
      .bind(binding.intentId, binding.fingerprint)
      .run();
    const result = await this.bound(binding);
    if (result.state !== 'uncertain') throw new PurchaseIntentError('state');
    return result;
  }
  async bindProviderReference(binding: PurchaseBinding, reference: string) {
    if (!text(reference, 240)) throw new PurchaseIntentError('invalid');
    const intent = await this.bound(binding);
    if (
      intent.providerReference !== null &&
      intent.providerReference !== reference
    )
      throw new PurchaseIntentError('binding');
    if (!['dispatched', 'uncertain'].includes(intent.state))
      throw new PurchaseIntentError('state');
    await this.db
      .prepare(
        "UPDATE purchase_intents SET provider_reference=? WHERE intent_id=? AND fingerprint=? AND state IN ('dispatched','uncertain') AND (provider_reference IS NULL OR provider_reference=?)",
      )
      .bind(reference, binding.intentId, binding.fingerprint, reference)
      .run();
    const result = await this.bound(binding);
    if (result.providerReference !== reference)
      throw new PurchaseIntentError('binding');
    return result;
  }
  async releaseUndispatched(binding: PurchaseBinding) {
    const intent = await this.bound(binding);
    if (intent.state === 'released') return intent;
    if (intent.state !== 'reserved') throw new PurchaseIntentError('state');
    await this.db
      .prepare(
        "UPDATE purchase_intents SET state='released',finalized_at=? WHERE intent_id=? AND fingerprint=? AND state='reserved' AND dispatched_at IS NULL",
      )
      .bind(this.clock(), binding.intentId, binding.fingerprint)
      .run();
    const result = await this.bound(binding);
    if (result.state !== 'released') throw new PurchaseIntentError('state');
    return result;
  }
  async finalize(
    binding: PurchaseBinding,
    fact: Readonly<{
      providerReference: string;
      outcome: 'expired' | 'canceled' | 'settled';
      evidenceFingerprint: string;
    }>,
  ) {
    if (
      !text(fact.providerReference, 240) ||
      !hashPattern.test(fact.evidenceFingerprint) ||
      !['expired', 'canceled', 'settled'].includes(fact.outcome)
    )
      throw new PurchaseIntentError('invalid');
    const intent = await this.bound(binding);
    if (intent.providerReference !== fact.providerReference)
      throw new PurchaseIntentError('binding');
    if (terminal.has(intent.state)) {
      if (
        intent.state !== fact.outcome ||
        intent.evidenceFingerprint !== fact.evidenceFingerprint
      )
        throw new PurchaseIntentError('state');
      return intent;
    }
    if (!['dispatched', 'uncertain'].includes(intent.state))
      throw new PurchaseIntentError('state');
    await this.db
      .prepare(
        "UPDATE purchase_intents SET state=?,evidence_fingerprint=?,finalized_at=? WHERE intent_id=? AND fingerprint=? AND provider_reference=? AND state IN ('dispatched','uncertain')",
      )
      .bind(
        fact.outcome,
        fact.evidenceFingerprint,
        this.clock(),
        binding.intentId,
        binding.fingerprint,
        fact.providerReference,
      )
      .run();
    const result = await this.bound(binding);
    if (
      result.state !== fact.outcome ||
      result.evidenceFingerprint !== fact.evidenceFingerprint
    )
      throw new PurchaseIntentError('state');
    return result;
  }
}
