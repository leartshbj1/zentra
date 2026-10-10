import {
  ActionEngineError,
  type ActionActor,
  type ActionAdmission,
  type QuotePlanningContext,
  type QuotePlan,
  type StoredQuoteProposal,
  type DraftQuoteReceipt,
  type ReviewReason,
} from './types';
import {
  boundedInteger,
  lineNetCents,
  sumNetCents,
  MAX_UNIT_PRICE_CENTS,
  MAX_AMOUNT_CENTS,
} from './money';
import {
  lexicalmatches,
  nonItemPhrase,
  parseQuoteQuantity,
  quotePhrases,
} from './quantity';

const fail = (): never => {
  throw new ActionEngineError('invalid_context');
};
const reasons: readonly ReviewReason[] = [
  'missing_customer_name',
  'ambiguous_customer',
  'archived_customer',
  'missing_quantity',
  'ambiguous_quantity',
  'unsupported_quantity',
  'missing_article',
  'too_many_candidates',
  'source_too_long',
  'low_confidence',
  'not_quote_request',
  'invalid_decision',
  'provider_unavailable',
];
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    captured: Record<string, unknown> = Object.create(null);
  // Only ordinary enumerable JSON data. Copy descriptors, never invoke getters.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return fail();
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return fail();
    captured[key] = descriptor.value;
  }
  return captured;
}
function exact(value: unknown, keys: readonly string[]) {
  const v = object(value);
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(v, key))
  )
    return fail();
  return v;
}
function text(value: unknown, max: number, required = true): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim()) ||
    [0, 11, 12, 127].some((code) => value.includes(String.fromCharCode(code)))
  )
    return fail();
  return value;
}
export function actionIdentifier(value: unknown): string {
  const id = text(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id)) return fail();
  return id;
}
function email(value: unknown) {
  const v = text(value, 254).trim().toLowerCase();
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      v,
    )
  )
    return fail();
  return v;
}
function boolean(value: unknown) {
  if (typeof value !== 'boolean') return fail();
  return value;
}
// This first lot represents two-decimal amounts only; other currencies need an explicit exponent adapter.
function currency(value: unknown) {
  const v = text(value, 3);
  if (v !== 'CHF' && v !== 'USD') return fail();
  return v;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value as object),
    length = descriptors.length?.value;
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return fail();
  const captured: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return fail();
    captured.push(descriptor.value);
  }
  return captured;
}
function uniqueIds<T extends { id: string }>(items: readonly T[]) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    return fail();
  return items;
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

export function captureActor(raw: unknown): ActionActor {
  const v = exact(raw, ['organizationId', 'userId']);
  return freeze({
    organizationId: actionIdentifier(v.organizationId),
    userId: actionIdentifier(v.userId),
  });
}
export function captureAdmission(
  raw: unknown,
  actor: ActionActor,
): ActionAdmission {
  const v = exact(raw, [
    'organizationId',
    'userId',
    'revision',
    'automationActive',
    'mayPrepareQuote',
  ]);
  if (
    v.organizationId !== actor.organizationId ||
    v.userId !== actor.userId ||
    v.automationActive !== true ||
    v.mayPrepareQuote !== true
  )
    throw new ActionEngineError('forbidden');
  return freeze({
    organizationId: actor.organizationId,
    userId: actor.userId,
    revision: actionIdentifier(v.revision),
    automationActive: true,
    mayPrepareQuote: true,
  });
}

/** Capture primitives into a fresh immutable projection before the first provider/network await. */
export function validatePlanningContext(raw: unknown): QuotePlanningContext {
  const v = exact(raw, [
    'organizationId',
    'revision',
    'currency',
    'source',
    'customers',
    'articles',
  ]);
  const organizationId = actionIdentifier(v.organizationId),
    contextCurrency = currency(v.currency);
  const s = exact(v.source, [
    'id',
    'revision',
    'organizationId',
    'senderEmail',
    'senderName',
    'subject',
    'body',
  ]);
  if (s.organizationId !== organizationId) return fail();
  const source = {
    id: actionIdentifier(s.id),
    revision: actionIdentifier(s.revision),
    organizationId,
    senderEmail: email(s.senderEmail),
    senderName: text(s.senderName, 200, false),
    subject: text(s.subject, 300, false),
    body: text(s.body, 16000, false),
  };
  const customers = uniqueIds(
    list(v.customers, 5000).map((rawCustomer) => {
      const c = exact(rawCustomer, [
        'id',
        'revision',
        'organizationId',
        'name',
        'email',
        'archived',
      ]);
      if (c.organizationId !== organizationId) return fail();
      // A contact can have no e-mail. It cannot be matched by invented/name-only identity.
      return {
        id: actionIdentifier(c.id),
        revision: actionIdentifier(c.revision),
        organizationId,
        name: text(c.name, 200),
        email: c.email === '' ? '' : email(c.email),
        archived: boolean(c.archived),
      };
    }),
  );
  const articles = uniqueIds(
    list(v.articles, 5000).map((rawArticle) => {
      const a = exact(rawArticle, [
        'id',
        'revision',
        'organizationId',
        'name',
        'description',
        'sku',
        'unit',
        'currency',
        'unitPriceCents',
        'taxRateBp',
        'archived',
      ]);
      if (a.organizationId !== organizationId || a.currency !== contextCurrency)
        return fail();
      return {
        id: actionIdentifier(a.id),
        revision: actionIdentifier(a.revision),
        organizationId,
        name: text(a.name, 200),
        description: text(a.description, 1000, false),
        sku: text(a.sku, 100, false),
        unit: text(a.unit, 40),
        currency: contextCurrency,
        unitPriceCents: boundedInteger(
          a.unitPriceCents,
          0,
          MAX_UNIT_PRICE_CENTS,
        ),
        taxRateBp: boundedInteger(a.taxRateBp, 0, 10000),
        archived: boolean(a.archived),
      };
    }),
  );
  return freeze({
    organizationId,
    revision: actionIdentifier(v.revision),
    currency: contextCurrency,
    source,
    customers,
    articles,
  });
}

export function captureQuotePlan(raw: unknown): QuotePlan {
  const v = exact(raw, [
    'schemaVersion',
    'engineVersion',
    'kind',
    'organizationId',
    'contextRevision',
    'sourceId',
    'sourceRevision',
    'status',
    'reasons',
    'customer',
    'title',
    'currency',
    'lines',
    'netCents',
    'confidence',
    'requiresHumanValidation',
  ]);
  if (
    v.schemaVersion !== 1 ||
    v.engineVersion !== 'action-engine-quote-v1' ||
    v.kind !== 'prepare_quote_draft' ||
    (v.status !== 'ready' && v.status !== 'needs_review') ||
    v.requiresHumanValidation !== true
  )
    return fail();
  const review = list(v.reasons, reasons.length).map((r) => {
    if (!reasons.includes(r as ReviewReason)) return fail();
    return r as ReviewReason;
  });
  if (new Set(review).size !== review.length) return fail();
  let customer: QuotePlan['customer'] = null;
  if (v.customer !== null) {
    const c = object(v.customer);
    if (c.kind === 'existing') {
      exact(c, ['kind', 'id', 'revision', 'name']);
      customer = {
        kind: 'existing',
        id: actionIdentifier(c.id),
        revision: actionIdentifier(c.revision),
        name: text(c.name, 200),
      };
    } else if (c.kind === 'new') {
      exact(c, ['kind', 'name', 'email']);
      customer = {
        kind: 'new',
        name: text(c.name, 200),
        email: email(c.email),
      };
    } else return fail();
  }
  const lines = list(v.lines, 8).map((rawLine) => {
    const l = exact(rawLine, [
      'articleId',
      'articleRevision',
      'description',
      'unit',
      'quantityMilli',
      'unitPriceCents',
      'taxRateBp',
      'netCents',
      'evidence',
    ]);
    const quantityMilli = boundedInteger(l.quantityMilli, 1, 1_000_000),
      unitPriceCents = boundedInteger(
        l.unitPriceCents,
        0,
        MAX_UNIT_PRICE_CENTS,
      ),
      netCents = lineNetCents(quantityMilli, unitPriceCents);
    if (l.netCents !== netCents) return fail();
    return {
      articleId: actionIdentifier(l.articleId),
      articleRevision: actionIdentifier(l.articleRevision),
      description: text(l.description, 200),
      unit: text(l.unit, 40),
      quantityMilli,
      unitPriceCents,
      taxRateBp: boundedInteger(l.taxRateBp, 0, 10000),
      netCents,
      evidence: text(l.evidence, 16000),
    };
  });
  const netCents = sumNetCents(lines.map((l) => l.netCents));
  if (
    v.netCents !== netCents ||
    netCents > MAX_AMOUNT_CENTS ||
    (v.confidence !== null &&
      (typeof v.confidence !== 'number' ||
        !Number.isFinite(v.confidence) ||
        v.confidence < 0 ||
        v.confidence > 1))
  )
    return fail();
  if (
    v.status === 'ready' &&
    (review.length ||
      !customer ||
      !lines.length ||
      v.confidence === null ||
      (v.confidence as number) < 0.95)
  )
    return fail();
  if (v.status === 'needs_review' && !review.length) return fail();
  return freeze({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: actionIdentifier(v.organizationId),
    contextRevision: actionIdentifier(v.contextRevision),
    sourceId: actionIdentifier(v.sourceId),
    sourceRevision: actionIdentifier(v.sourceRevision),
    status: v.status as QuotePlan['status'],
    reasons: review,
    customer,
    title: text(v.title, 160),
    currency: currency(v.currency),
    lines,
    netCents,
    confidence: v.confidence as number | null,
    requiresHumanValidation: true,
  });
}

export function captureProposal(
  raw: unknown,
  actor: ActionActor,
): StoredQuoteProposal {
  const v = exact(raw, ['id', 'organizationId', 'fingerprint', 'plan']);
  if (
    v.organizationId !== actor.organizationId ||
    typeof v.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.fingerprint)
  )
    throw new ActionEngineError('invalid_proposal');
  const plan = captureQuotePlan(v.plan);
  if (plan.organizationId !== actor.organizationId)
    throw new ActionEngineError('invalid_proposal');
  return freeze({
    id: actionIdentifier(v.id),
    organizationId: actor.organizationId,
    fingerprint: v.fingerprint,
    plan,
  });
}

/** Reject stale/forged source facts and prices. Never repair a persisted plan silently. */
export function validatePlanAgainstContext(
  plan: QuotePlan,
  context: QuotePlanningContext,
): void {
  const stale = (): never => {
    throw new ActionEngineError('stale_plan');
  };
  if (
    plan.organizationId !== context.organizationId ||
    plan.contextRevision !== context.revision ||
    plan.sourceId !== context.source.id ||
    plan.sourceRevision !== context.source.revision ||
    plan.currency !== context.currency ||
    plan.title !== (context.source.subject.trim().slice(0, 160) || 'Quote')
  )
    return stale();
  const customer = plan.customer;
  const allMatches = context.customers.filter(
    (c) => c.email && c.email === context.source.senderEmail,
  );
  const matches = allMatches.filter((c) => !c.archived);
  if (customer?.kind === 'existing') {
    if (
      matches.length !== 1 ||
      matches[0].id !== customer.id ||
      matches[0].revision !== customer.revision ||
      matches[0].name !== customer.name
    )
      return stale();
  } else if (customer?.kind === 'new') {
    if (
      allMatches.length ||
      customer.email !== context.source.senderEmail ||
      customer.name !== context.source.senderName.trim()
    )
      return stale();
  }
  if (plan.status === 'ready') {
    if (
      context.source.body.length > 3000 ||
      new Set(plan.lines.map((l) => l.evidence)).size !== plan.lines.length
    )
      return stale();
    const expected = quotePhrases(context.source.body).filter(
      (evidence) =>
        context.articles.some((a) => lexicalmatches(evidence, a)) ||
        !nonItemPhrase(evidence, context.source.senderName),
    );
    if (
      expected.length !== plan.lines.length ||
      expected.some(
        (evidence, index) => evidence !== plan.lines[index].evidence,
      )
    )
      return stale();
  }
  for (const line of plan.lines) {
    const a = context.articles.find((a) => a.id === line.articleId);
    const candidates = context.articles.filter((a) =>
      lexicalmatches(line.evidence, a),
    );
    const quantity = parseQuoteQuantity(
      line.evidence,
      candidates.map((a) => a.sku),
    );
    if (
      !a ||
      !lexicalmatches(line.evidence, a) ||
      a.archived ||
      a.revision !== line.articleRevision ||
      a.name !== line.description ||
      a.unit !== line.unit ||
      a.unitPriceCents !== line.unitPriceCents ||
      a.taxRateBp !== line.taxRateBp ||
      !context.source.body.includes(line.evidence) ||
      line.evidence.length > 600 ||
      quantity.reason !== null ||
      quantity.quantityMilli !== line.quantityMilli
    )
      return stale();
  }
}

export function captureReceipt(
  raw: unknown,
  proposal: StoredQuoteProposal,
): DraftQuoteReceipt {
  try {
    const v = exact(raw, [
      'organizationId',
      'proposalId',
      'fingerprint',
      'customerId',
      'quoteId',
      'quoteNumber',
      'status',
      'requiresHumanValidation',
    ]);
    if (
      v.organizationId !== proposal.organizationId ||
      v.proposalId !== proposal.id ||
      v.fingerprint !== proposal.fingerprint ||
      v.quoteNumber !== null ||
      v.status !== 'draft' ||
      v.requiresHumanValidation !== true
    )
      throw new Error('receipt');
    if (
      proposal.plan.customer?.kind === 'existing' &&
      v.customerId !== proposal.plan.customer.id
    )
      throw new Error('receipt');
    return freeze({
      organizationId: proposal.organizationId,
      proposalId: proposal.id,
      fingerprint: proposal.fingerprint,
      customerId: actionIdentifier(v.customerId),
      quoteId: actionIdentifier(v.quoteId),
      quoteNumber: null,
      status: 'draft',
      requiresHumanValidation: true,
    });
  } catch {
    throw new ActionEngineError('invalid_receipt');
  }
}
