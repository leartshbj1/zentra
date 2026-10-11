import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRequest,
  encodeConfirmation,
  encodeReservation,
  type DeviceExecutionConfirmRequest,
} from './device-execution-contract';
import type { QuoteConfirmationInput } from './device-confirmation';
import type { DeviceQuoteReservationResult } from './device-reservation';
import { QuoteLedgerError } from './ledger-types';
import type { DraftQuoteReceipt, QuotePlanningContext } from './types';
import {
  captureQuotePlan,
  validatePlanAgainstContext,
  validatePlanningContext,
} from './validation';

type Reserved = Extract<DeviceQuoteReservationResult, { state: 'reserved' }>;
const sha = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const reservationId = 'efc98ca7-0913-4a53-85c6-d3d38737d9db',
  installationId = '788659d9-f20e-4eae-9c0f-146057b0bfb0',
  customerId = '960e994b-bbf2-4538-b58c-588112da7849',
  quoteId = '02c11008-6c2d-49b3-8d0f-50cfb6b218eb',
  snapshotId = '68c9d889-ecfb-4fcb-a4aa-3bed171a68aa';

// Pure wire tests use the actual A8/A7 types and the core's captured/validated
// plan; no fake authority, provider, DB, native executable or route is invoked.
function fixture(kind: 'new' | 'existing' = 'new'): Reserved {
  const actor = {
    organizationId: 'synthetic-company',
    userId: 'synthetic-user',
  };
  const rawContext: QuotePlanningContext = {
    organizationId: actor.organizationId,
    revision: 'context-v1',
    currency: 'CHF',
    source: {
      id: 'synthetic-source',
      revision: 'source-v1',
      organizationId: actor.organizationId,
      senderEmail: 'synthetic@example.test',
      senderName: 'Atelier Été 👩‍🔧',
      subject: 'Installation — étage 2\u2028"\\',
      body: 'Installer 3 radiateurs\nMerci',
    },
    customers:
      kind === 'existing'
        ? [
            {
              id: 'existing-client-a',
              revision: 'customer-v1',
              organizationId: actor.organizationId,
              name: 'Atelier Été 👩‍🔧',
              email: 'synthetic@example.test',
              archived: false,
            },
          ]
        : [],
    articles: [
      {
        id: 'radiator-a',
        revision: 'article-v1',
        organizationId: actor.organizationId,
        name: 'Radiateur',
        description: 'radiateurs',
        sku: 'RAD-A',
        unit: 'pièce',
        currency: 'CHF',
        unitPriceCents: 19901,
        taxRateBp: 810,
        archived: false,
      },
    ],
  };
  const context = validatePlanningContext(rawContext),
    plan = captureQuotePlan({
      schemaVersion: 1,
      engineVersion: 'action-engine-quote-v1',
      kind: 'prepare_quote_draft',
      organizationId: actor.organizationId,
      contextRevision: context.revision,
      sourceId: context.source.id,
      sourceRevision: context.source.revision,
      status: 'ready',
      reasons: [],
      customer:
        kind === 'new'
          ? {
              kind: 'new',
              name: context.source.senderName,
              email: context.source.senderEmail,
            }
          : {
              kind: 'existing',
              id: context.customers[0].id,
              revision: context.customers[0].revision,
              name: context.customers[0].name,
            },
      title: context.source.subject,
      currency: context.currency,
      lines: [
        {
          articleId: context.articles[0].id,
          articleRevision: context.articles[0].revision,
          description: 'Radiateur',
          unit: 'pièce',
          quantityMilli: 3000,
          unitPriceCents: 19901,
          taxRateBp: 810,
          netCents: 59703,
          evidence: 'Installer 3 radiateurs',
        },
      ],
      netCents: 59703,
      confidence: 0.99,
      requiresHumanValidation: true,
    });
  validatePlanAgainstContext(plan, context);
  const canonicalPlanJson = JSON.stringify(plan),
    fingerprint = sha(canonicalPlanJson),
    proposal = {
      id: 'synthetic-proposal',
      organizationId: actor.organizationId,
      fingerprint,
      plan,
    };
  return {
    state: 'reserved',
    actor,
    installationId,
    authorizationRevision: sha('synthetic-authority-v1'),
    proposal,
    canonicalPlanJson,
    reservation: {
      id: reservationId,
      organizationId: actor.organizationId,
      proposalId: proposal.id,
      fingerprint,
      userId: actor.userId,
      installationId,
      customerId: kind === 'new' ? customerId : 'existing-client-a',
      quoteId,
      createdAt: 1791720000,
      receipt: null,
    },
    binding: {
      resourcesSha256: 'b'.repeat(64),
      sourceCanonicalSha256: sha(JSON.stringify(context.source)),
      planningPublication: {
        organizationId: actor.organizationId,
        snapshotId,
        baseRevision: 3,
        revision: 4,
        archiveSha256: 'c'.repeat(64),
        manifestSha256: 'd'.repeat(64),
      },
    },
    source: context.source,
  };
}
function receipt(f = fixture()): DraftQuoteReceipt {
  return {
    organizationId: f.actor.organizationId,
    proposalId: f.proposal.id,
    fingerprint: f.proposal.fingerprint,
    customerId: f.reservation.customerId,
    quoteId: f.reservation.quoteId,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  };
}
const confirmation = (): QuoteConfirmationInput => ({
  sourceId: 'synthetic-source',
  proposalId: 'synthetic-proposal',
  reservationId,
  publicationSnapshotId: snapshotId,
});
const reservationRequest = () => ({
  schemaVersion: 1,
  operation: 'reserve',
  sourceId: 'synthetic-source',
  proposalId: 'synthetic-proposal',
});
const confirmationRequest = (): DeviceExecutionConfirmRequest => ({
  schemaVersion: 1,
  operation: 'confirm',
  ...confirmation(),
});
function encode(raw: unknown) {
  return encodeReservation(raw as DeviceQuoteReservationResult);
}
function invalid(operation: () => unknown) {
  expect(operation).toThrow(QuoteLedgerError);
  expect(operation).toThrow('invalid_record');
}
function withPlan(f: Reserved, patch: Record<string, unknown>) {
  const plan = { ...f.proposal.plan, ...patch },
    canonicalPlanJson = JSON.stringify(plan),
    fingerprint = sha(canonicalPlanJson);
  return {
    ...f,
    canonicalPlanJson,
    proposal: { ...f.proposal, plan, fingerprint },
    reservation: { ...f.reservation, fingerprint },
  };
}
function withSource(f: Reserved, patch: Record<string, unknown>) {
  const source = { ...f.source, ...patch };
  return {
    ...f,
    source,
    binding: {
      ...f.binding,
      sourceCanonicalSha256: sha(JSON.stringify(source)),
    },
  };
}

describe('private device execution request codec', () => {
  it('captures selectors only, detached and frozen before any wait', () => {
    const raw = reservationRequest(),
      captured = captureRequest(raw);
    raw.sourceId = 'changed-source';
    expect(captured).toStrictEqual(reservationRequest());
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captureRequest(confirmationRequest())).toStrictEqual(
      confirmationRequest(),
    );
  });

  it.each([
    'actor',
    'organizationId',
    'installationId',
    'plan',
    'permission',
    'authorizationRevision',
    'expectedResourcesHash',
    'expectedWorkspaceScope',
    'expectedMemberContextNonce',
  ])('refuses caller-controlled %s', (key) => {
    invalid(() => captureRequest({ ...reservationRequest(), [key]: 'forged' }));
    invalid(() =>
      captureRequest({ ...confirmationRequest(), [key]: 'forged' }),
    );
  });

  it.each([
    null,
    [],
    {},
    { ...reservationRequest(), schemaVersion: 2 },
    { ...reservationRequest(), schemaVersion: '1' },
    { ...reservationRequest(), operation: 'execute' },
    { ...reservationRequest(), sourceId: ' source ' },
    { ...reservationRequest(), sourceId: 'x'.repeat(161) },
    { ...reservationRequest(), proposalId: 123 },
    { ...reservationRequest(), reservationId },
    { ...confirmationRequest(), reservationId: reservationId.toUpperCase() },
    { ...confirmationRequest(), publicationSnapshotId: 'not-a-uuid' },
  ])('rejects malformed/versioned/extra selector input %#', (raw) => {
    invalid(() => captureRequest(raw));
  });

  it('rejects descriptors and prototypes without evaluating a getter', () => {
    const getter = vi.fn(() => 'secret'),
      accessor = Object.defineProperty(reservationRequest(), 'sourceId', {
        enumerable: true,
        get: getter,
      });
    invalid(() => captureRequest(accessor));
    expect(getter).not.toHaveBeenCalled();
    invalid(() =>
      captureRequest(Object.create(reservationRequest()) as unknown),
    );
    invalid(() =>
      captureRequest(
        Object.defineProperty(reservationRequest(), 'hidden', { value: true }),
      ),
    );
    invalid(() =>
      captureRequest({ ...reservationRequest(), [Symbol('hidden')]: true }),
    );
    expect(
      captureRequest(Object.assign(Object.create(null), reservationRequest())),
    ).toStrictEqual(reservationRequest());
  });

  it('maps hostile Proxy failures to a bounded code without source/secrets', () => {
    const raw = new Proxy(reservationRequest(), {
      ownKeys() {
        throw Error('secret-token synthetic-private-source');
      },
    });
    expect(() => captureRequest(raw)).toThrow('invalid_record');
    try {
      captureRequest(raw);
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-token|private-source/);
    }
  });
});

describe('private A8 reservation wire projection', () => {
  it.each(['new', 'existing'] as const)(
    'preserves the validated %s customer draft and only writer fields',
    (kind) => {
      const f = fixture(kind),
        result = encodeReservation(f);
      expect(result).toStrictEqual({
        schemaVersion: 1,
        state: 'reserved',
        canonicalPlanJson: f.canonicalPlanJson,
        proposalId: f.proposal.id,
        fingerprint: f.proposal.fingerprint,
        reservationId,
        source: f.source,
        actor: f.actor,
        installationId,
        expectedResourcesHash: f.binding.resourcesSha256,
        expectedContextRevision: f.proposal.plan.contextRevision,
        customerId: f.reservation.customerId,
        quoteId,
        authorizationRevision: f.authorizationRevision,
      });
      expect(result).not.toBeInstanceOf(Promise);
      expect(Object.isFrozen(result)).toBe(true);
      if (result.state !== 'reserved') throw Error('expected reserved');
      expect(Object.isFrozen(result.actor)).toBe(true);
      expect(Object.isFrozen(result.source)).toBe(true);
      expect(result.source).not.toBe(f.source);
      expect(result.actor).not.toBe(f.actor);
      expect(result.source.subject).toContain('\u2028"\\');
      expect(result.source.body).toContain('\nMerci');
      expect(result.source.senderName).toContain('👩‍🔧');
      expect(sha(result.canonicalPlanJson)).toBe(result.fingerprint);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
      expect(result).not.toHaveProperty('expectedWorkspaceScope');
      expect(result).not.toHaveProperty('expectedMemberContextNonce');
      expect(result).not.toHaveProperty('binding');
      expect(result).not.toHaveProperty('reservation');
    },
  );

  it('does not mutate the upstream captured result or keep nested aliases', () => {
    const f = fixture(),
      before = JSON.stringify(f),
      encoded = encodeReservation(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(Object.isFrozen(f.actor)).toBe(false);
    expect(encoded).toStrictEqual(encodeReservation(f));
    (f.actor as { userId: string }).userId = 'changed-user';
    if (encoded.state !== 'reserved') throw Error('expected reserved');
    expect(encoded.actor.userId).toBe('synthetic-user');
  });

  const malformed: [string, (f: Reserved) => unknown][] = [
    ['extra root permission', (f) => ({ ...f, permission: true })],
    [
      'actor tenant',
      (f) => ({ ...f, actor: { ...f.actor, organizationId: 'other' } }),
    ],
    ['actor user', (f) => ({ ...f, actor: { ...f.actor, userId: 'other' } })],
    ['installation', (f) => ({ ...f, installationId: snapshotId })],
    [
      'reservation tenant',
      (f) => ({
        ...f,
        reservation: { ...f.reservation, organizationId: 'other' },
      }),
    ],
    [
      'reservation proposal',
      (f) => ({ ...f, reservation: { ...f.reservation, proposalId: 'other' } }),
    ],
    [
      'reservation fingerprint',
      (f) => ({
        ...f,
        reservation: { ...f.reservation, fingerprint: 'e'.repeat(64) },
      }),
    ],
    [
      'reservation user',
      (f) => ({ ...f, reservation: { ...f.reservation, userId: 'other' } }),
    ],
    [
      'reservation installation',
      (f) => ({
        ...f,
        reservation: { ...f.reservation, installationId: snapshotId },
      }),
    ],
    [
      'reservation receipt already present',
      (f) => ({ ...f, reservation: { ...f.reservation, receipt: receipt(f) } }),
    ],
    [
      'timestamp fraction',
      (f) => ({ ...f, reservation: { ...f.reservation, createdAt: 0.5 } }),
    ],
    [
      'timestamp unbounded',
      (f) => ({
        ...f,
        reservation: { ...f.reservation, createdAt: Number.MAX_SAFE_INTEGER },
      }),
    ],
    [
      'new customer not UUID',
      (f) => ({
        ...f,
        reservation: { ...f.reservation, customerId: 'new-customer' },
      }),
    ],
    [
      'quote not UUID',
      (f) => ({ ...f, reservation: { ...f.reservation, quoteId: 'draft' } }),
    ],
    ['source tenant', (f) => withSource(f, { organizationId: 'other' })],
    ['source ID', (f) => withSource(f, { id: 'other' })],
    ['source revision', (f) => withSource(f, { revision: 'other' })],
    [
      'source silently normalized email',
      (f) => withSource(f, { senderEmail: ' Synthetic@Example.Test ' }),
    ],
    [
      'source body over native bound',
      (f) =>
        withSource(f, { body: `Installer 3 radiateurs${'x'.repeat(3001)}` }),
    ],
    [
      'source hash',
      (f) => ({
        ...f,
        binding: { ...f.binding, sourceCanonicalSha256: 'e'.repeat(64) },
      }),
    ],
    [
      'resources hash type',
      (f) => ({ ...f, binding: { ...f.binding, resourcesSha256: 123 } }),
    ],
    [
      'resources hash uppercase',
      (f) => ({
        ...f,
        binding: { ...f.binding, resourcesSha256: 'B'.repeat(64) },
      }),
    ],
    [
      'publication tenant',
      (f) => ({
        ...f,
        binding: {
          ...f.binding,
          planningPublication: {
            ...f.binding.planningPublication,
            organizationId: 'other',
          },
        },
      }),
    ],
    [
      'publication revision',
      (f) => ({
        ...f,
        binding: {
          ...f.binding,
          planningPublication: {
            ...f.binding.planningPublication,
            revision: 9,
          },
        },
      }),
    ],
    [
      'publication extra resourcesHash',
      (f) => ({
        ...f,
        binding: {
          ...f.binding,
          planningPublication: {
            ...f.binding.planningPublication,
            resourcesSha256: f.binding.resourcesSha256,
          },
        },
      }),
    ],
    [
      'authorization revision absent',
      (f) => ({ ...f, authorizationRevision: '' }),
    ],
    ['USD not native CH writer', (f) => withPlan(f, { currency: 'USD' })],
    [
      'review plan not executable',
      (f) =>
        withPlan(f, { status: 'needs_review', reasons: ['low_confidence'] }),
    ],
    [
      'human validation false',
      (f) => withPlan(f, { requiresHumanValidation: false }),
    ],
    ['plan/source title', (f) => withPlan(f, { title: 'Forged title' })],
    [
      'forged customer name',
      (f) =>
        withPlan(f, {
          customer: { kind: 'new', name: 'Other', email: f.source.senderEmail },
        }),
    ],
    [
      'forged customer email',
      (f) =>
        withPlan(f, {
          customer: {
            kind: 'new',
            name: f.source.senderName,
            email: 'other@example.test',
          },
        }),
    ],
    [
      'plan over UTF8 size',
      (f) => ({ ...f, canonicalPlanJson: 'é'.repeat(32769) }),
    ],
    [
      'wrong canonical SHA',
      (f) => ({
        ...f,
        proposal: { ...f.proposal, fingerprint: 'e'.repeat(64) },
        reservation: { ...f.reservation, fingerprint: 'e'.repeat(64) },
      }),
    ],
    [
      'plan line amount',
      (f) =>
        withPlan(f, { lines: [{ ...f.proposal.plan.lines[0], netCents: 1 }] }),
    ],
    ['sparse lines', (f) => withPlan(f, { lines: Array(1) })],
    [
      'line evidence not in source',
      (f) =>
        withPlan(f, {
          lines: [
            { ...f.proposal.plan.lines[0], evidence: 'Invented 3 radiateurs' },
          ],
        }),
    ],
    [
      'line evidence over native bound',
      (f) =>
        withPlan(f, {
          lines: [{ ...f.proposal.plan.lines[0], evidence: 'x'.repeat(601) }],
        }),
    ],
    [
      'unpaired surrogate',
      (f) => withSource(f, { body: `${f.source.body}\ud800` }),
    ],
  ];
  it.each(malformed)('rejects %s instead of repairing it', (_name, mutate) => {
    invalid(() => encode(mutate(fixture())));
  });

  it('rejects duplicate/noncanonical plan JSON even with its matching hash', () => {
    const f = fixture();
    for (const canonicalPlanJson of [
      ` ${f.canonicalPlanJson}`,
      f.canonicalPlanJson.replace(
        '"currency":"CHF"',
        '"currency":"CHF","currency":"CHF"',
      ),
      f.canonicalPlanJson.replace('59703', '5.9703e4'),
    ]) {
      const fingerprint = sha(canonicalPlanJson);
      invalid(() =>
        encode({
          ...f,
          canonicalPlanJson,
          proposal: { ...f.proposal, fingerprint },
          reservation: { ...f.reservation, fingerprint },
        }),
      );
    }
  });

  it('rejects existing-customer rebinding and duplicate line evidence', () => {
    const f = fixture('existing');
    invalid(() =>
      encode({ ...f, reservation: { ...f.reservation, customerId } }),
    );
    invalid(() =>
      encode(
        withPlan(f, {
          lines: [f.proposal.plan.lines[0], f.proposal.plan.lines[0]],
          netCents: 119406,
        }),
      ),
    );
  });

  it('rejects nested extra keys/accessors without evaluating or leaking them', () => {
    const f = fixture(),
      getter = vi.fn(() => 'secret');
    for (const raw of [
      { ...f, actor: { ...f.actor, secret: 'private' } },
      { ...f, source: { ...f.source, rawMail: 'private' } },
      { ...f, binding: { ...f.binding, [Symbol('secret')]: true } },
      {
        ...f,
        source: Object.defineProperty({ ...f.source }, 'body', {
          enumerable: true,
          get: getter,
        }),
      },
      {
        ...f,
        proposal: {
          ...f.proposal,
          plan: {
            ...f.proposal.plan,
            lines: Object.defineProperty([...f.proposal.plan.lines], '0', {
              enumerable: true,
              get: getter,
            }),
          },
        },
      },
    ])
      invalid(() => encode(raw));
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps held/recovery replies small and never invents historical identifiers', () => {
    const f = fixture();
    expect(encode({ state: 'held', proposalId: f.proposal.id })).toStrictEqual({
      schemaVersion: 1,
      state: 'held',
      proposalId: f.proposal.id,
    });
    expect(
      encode({
        state: 'recovery_required',
        proposalId: f.proposal.id,
        reservationId,
        fingerprint: f.proposal.fingerprint,
      }),
    ).toStrictEqual({
      schemaVersion: 1,
      state: 'recovery_required',
      proposalId: f.proposal.id,
      reservationId,
      fingerprint: f.proposal.fingerprint,
    });
    const historical = encodeReservation({
      state: 'confirmed',
      receipt: receipt(f),
    });
    expect(historical).toStrictEqual({
      schemaVersion: 1,
      state: 'confirmed',
      receipt: receipt(f),
    });
    expect(historical).not.toHaveProperty('reservationId');
    expect(historical).not.toHaveProperty('publicationSnapshotId');
    expect(historical).not.toHaveProperty('source');
    invalid(() =>
      encode({ state: 'held', proposalId: f.proposal.id, actor: f.actor }),
    );
    invalid(() =>
      encode({
        state: 'recovery_required',
        proposalId: f.proposal.id,
        reservationId,
        fingerprint: f.proposal.fingerprint,
        source: f.source,
      }),
    );
    invalid(() =>
      encode({
        state: 'confirmed',
        receipt: receipt(f),
        publicationSnapshotId: snapshotId,
      }),
    );
    invalid(() => encode({ state: 'absent' }));
  });
});

describe('private A7 confirmation wire projection', () => {
  it('correlates exactly the captured four selectors and preserves null/human true', () => {
    const input = confirmation(),
      original = receipt(),
      result = encodeConfirmation(input, original);
    expect(result).toStrictEqual({
      schemaVersion: 1,
      state: 'confirmed',
      ...input,
      receipt: original,
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(result.receipt).not.toBe(original);
    expect(JSON.parse(JSON.stringify(result)).receipt.quoteNumber).toBe(null);
    expect(result.receipt.requiresHumanValidation).toBe(true);
    expect(result).not.toHaveProperty('baseRevision');
    expect(result).not.toHaveProperty('manifest');
    expect(result).not.toHaveProperty('revision');
  });

  it.each([
    [
      'missing explicit null',
      (r: DraftQuoteReceipt) => {
        const { quoteNumber: _omit, ...v } = r;
        return v;
      },
    ],
    [
      'undefined null',
      (r: DraftQuoteReceipt) => ({ ...r, quoteNumber: undefined }),
    ],
    [
      'numbered quote',
      (r: DraftQuoteReceipt) => ({ ...r, quoteNumber: 'Q-123' }),
    ],
    ['issued status', (r: DraftQuoteReceipt) => ({ ...r, status: 'issued' })],
    [
      'no human validation',
      (r: DraftQuoteReceipt) => ({ ...r, requiresHumanValidation: false }),
    ],
    [
      'nonboolean human validation',
      (r: DraftQuoteReceipt) => ({ ...r, requiresHumanValidation: 1 }),
    ],
    [
      'foreign proposal',
      (r: DraftQuoteReceipt) => ({ ...r, proposalId: 'other' }),
    ],
    [
      'bad SHA',
      (r: DraftQuoteReceipt) => ({ ...r, fingerprint: 'B'.repeat(64) }),
    ],
    ['bad quote ID', (r: DraftQuoteReceipt) => ({ ...r, quoteId: 'quote-a' })],
    [
      'extra sensitive field',
      (r: DraftQuoteReceipt) => ({ ...r, rawMail: 'private' }),
    ],
  ] as const)('rejects %s', (_name, change) => {
    const raw = change(receipt()) as DraftQuoteReceipt;
    invalid(() => encodeConfirmation(confirmation(), raw));
    if (_name !== 'foreign proposal')
      invalid(() => encode({ state: 'confirmed', receipt: raw }));
  });

  it('rejects forged selector context and a wire body supplied as confirmation input', () => {
    const r = receipt();
    invalid(() => encodeConfirmation({ ...confirmation(), sourceId: '' }, r));
    invalid(() =>
      encodeConfirmation({ ...confirmation(), reservationId: 'bad' }, r),
    );
    invalid(() =>
      encodeConfirmation(
        { ...confirmation(), publicationSnapshotId: 'bad' },
        r,
      ),
    );
    invalid(() => encodeConfirmation(confirmationRequest(), r));
    const getter = vi.fn(() => 'secret'),
      raw = Object.defineProperty({ ...r }, 'fingerprint', {
        enumerable: true,
        get: getter,
      });
    invalid(() => encodeConfirmation(confirmation(), raw));
    expect(getter).not.toHaveBeenCalled();
  });
});
