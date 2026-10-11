import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionInput, ProviderResult } from '@/lib/automation/types';
import type {
  ActionActor,
  ActionAdmission,
  QuotePlan,
  QuotePlanningContext,
  QuotePreparationPorts,
  StoredQuoteProposal,
} from './types';
import type { DeviceQuoteAuthority } from './production-admission';

// Unit composition only: authentication, repositories, context/provenance,
// engine and provider transport are deliberately mocked boundaries here. These
// tests prove neither production admission nor an actual JEV/network decision.
const state = vi.hoisted(() => ({
  enabled: true,
  allowed: 1 as number | null,
  admissionRevision: 'admission-one',
  rejectAdmission: false,
  keyHook: null as null | (() => Promise<void>),
  providerHook: null as null | (() => void),
  providerGuard: null as null | (() => Promise<void>),
  authority: vi.fn(),
  recover: vi.fn(),
  preflight: vi.fn(),
  preflightCas: vi.fn(),
  load: vi.fn(),
  fences: vi.fn(),
  progression: vi.fn(),
  ledgerFactory: vi.fn(),
  intakeFactory: vi.fn(),
  providerFactory: vi.fn(),
  key: vi.fn(),
  prepareEngine: vi.fn(),
  prepareSql: vi.fn(),
  bindSql: vi.fn(),
  firstSql: vi.fn(),
  decide: vi.fn(),
  externalCall: vi.fn(),
}));

vi.mock('@/lib/automation/config', () => ({ decisionApiKey: state.key }));
vi.mock('@/lib/runtime', () => ({
  database: () => ({ prepare: state.prepareSql }),
}));
vi.mock('./production-admission', () => ({
  createDeviceQuoteAuthority: state.authority,
}));
vi.mock('./device-proposal-recovery', () => ({
  readPreparedDeviceQuote: state.recover,
}));
vi.mock('./published-context', () => ({
  loadDeviceQuotePlanningContext: state.load,
}));
vi.mock('./published-fences', () => ({
  createPublishedQuoteFences: state.fences,
}));
vi.mock('./publication-gateway', () => ({
  publicationCoordinationEnabled: () => state.enabled,
}));
vi.mock('./ledger', () => ({ createD1QuoteLedger: state.ledgerFactory }));
vi.mock('./intake', () => ({ createD1QuoteIntake: state.intakeFactory }));
vi.mock('./provider', () => ({
  createQuoteDecisionProvider: state.providerFactory,
}));
vi.mock('./engine', () => ({ prepareQuoteProposal: state.prepareEngine }));

import { prepareDeviceSupportQuote } from './device-preparation';
import { ActionEngineError } from './types';

const actor: ActionActor = {
  organizationId: 'unit-company',
  userId: 'unit-owner',
};
const platformKey = 'synthetic-platform-key-never-client';
const context: QuotePlanningContext = {
  organizationId: actor.organizationId,
  revision: 'context-one',
  currency: 'CHF',
  source: {
    id: 'unit-source',
    organizationId: actor.organizationId,
    revision: 'source-one',
    senderEmail: 'client@example.test',
    senderName: 'Synthetic Customer',
    subject: 'Quote',
    body: '3 radiators',
  },
  customers: [
    {
      id: 'customer-one',
      revision: 'customer-one-revision',
      organizationId: actor.organizationId,
      name: 'Synthetic Customer',
      email: 'client@example.test',
      archived: false,
    },
  ],
  articles: [
    {
      id: 'article-one',
      revision: 'article-one-revision',
      organizationId: actor.organizationId,
      name: 'Radiator',
      description: 'radiators',
      sku: 'RAD-A',
      unit: 'piece',
      currency: 'CHF',
      unitPriceCents: 19900,
      taxRateBp: 810,
      archived: false,
    },
  ],
};
const plan: QuotePlan = {
  schemaVersion: 1,
  engineVersion: 'action-engine-quote-v1',
  kind: 'prepare_quote_draft',
  organizationId: actor.organizationId,
  sourceId: context.source.id,
  sourceRevision: context.source.revision,
  contextRevision: context.revision,
  status: 'ready',
  reasons: [],
  title: 'Quote',
  currency: 'CHF',
  confidence: 0.99,
  customer: {
    kind: 'existing',
    id: 'customer-one',
    revision: 'customer-one-revision',
    name: 'Synthetic Customer',
  },
  lines: [
    {
      articleId: 'article-one',
      articleRevision: 'article-one-revision',
      description: 'Radiator',
      unit: 'piece',
      quantityMilli: 3000,
      unitPriceCents: 19900,
      taxRateBp: 810,
      netCents: 59700,
      evidence: '3 radiators',
    },
  ],
  netCents: 59700,
  requiresHumanValidation: true,
};
const proposal: StoredQuoteProposal = {
  id: 'unit-proposal',
  organizationId: actor.organizationId,
  fingerprint: 'a'.repeat(64),
  plan,
};
const decision: ProviderResult = {
  provider: 'unit-provider',
  model: 'unit-model',
  answers: {},
  latencyMs: 0,
  usage: { inputTokens: null, outputTokens: null, cost: null },
};
const input: DecisionInput = {
  state: { excerpt: context.source.body },
  questions: {},
};
const predicate = Object.freeze({
  sql: 'unit_authority_and_source_and_publication=?',
  bindings: Object.freeze(['unit-cas']),
});
const ledgerFence = async () => predicate;
const intakeFence = async () => predicate;
let authority: DeviceQuoteAuthority;
let admission: ActionAdmission;
let loaded: { context: QuotePlanningContext; admission: ActionAdmission };
let cas: { admission: ActionAdmission; predicate: () => typeof predicate };
let ledger: {
  findProposal: ReturnType<typeof vi.fn>;
  saveProposal: ReturnType<typeof vi.fn>;
};
let intake: {
  claim: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  uncertain: ReturnType<typeof vi.fn>;
};
let fences: {
  context: QuotePlanningContext;
  admission: ActionAdmission;
  ledgerFence: typeof ledgerFence;
  intakeFence: typeof intakeFence;
  progression: typeof state.progression;
};
const request = () =>
  new Request('https://unit.example.test/private-prepare', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer unit-device-token',
      Origin: 'tauri://localhost',
    },
  });

beforeEach(() => {
  vi.resetAllMocks();
  state.enabled = true;
  state.allowed = 1;
  state.rejectAdmission = false;
  state.admissionRevision = 'admission-one';
  state.keyHook = null;
  state.providerHook = null;
  state.providerGuard = null;
  admission = {
    ...actor,
    revision: 'admission-one',
    automationActive: true,
    mayPrepareQuote: true,
  };
  state.preflight.mockImplementation(async (): Promise<ActionAdmission> => {
    if (state.rejectAdmission) throw new ActionEngineError('forbidden');
    return { ...admission, revision: state.admissionRevision };
  });
  cas = { admission, predicate: () => predicate };
  state.preflightCas.mockResolvedValue(cas);
  authority = {
    actor,
    installationId: '00000000-0000-4000-8000-000000000001',
    preflight: state.preflight,
    preflightCas: state.preflightCas,
    authorizeRead: async () => undefined,
    predicate: () => predicate,
  };
  state.authority.mockResolvedValue(authority);
  state.recover.mockResolvedValue(null);
  loaded = { context, admission };
  state.load.mockResolvedValue(loaded);
  state.progression.mockReturnValue(predicate);
  fences = {
    context,
    admission,
    ledgerFence,
    intakeFence,
    progression: state.progression,
  };
  state.fences.mockResolvedValue(fences);
  ledger = {
    findProposal: vi.fn(async () => null),
    saveProposal: vi.fn(async () => proposal),
  };
  intake = {
    claim: vi.fn(),
    start: vi.fn(),
    finish: vi.fn(),
    uncertain: vi.fn(),
  };
  state.ledgerFactory.mockReturnValue(ledger);
  state.intakeFactory.mockReturnValue(intake);
  state.prepareSql.mockReturnValue({ bind: state.bindSql });
  state.bindSql.mockReturnValue({ first: state.firstSql });
  state.firstSql.mockImplementation(async () =>
    state.allowed === null ? null : { allowed: state.allowed },
  );
  state.key.mockImplementation(async () => {
    await state.keyHook?.();
    return platformKey;
  });
  state.externalCall.mockResolvedValue(decision);
  state.decide.mockImplementation(async () => {
    state.providerHook?.();
    if (state.providerGuard === null)
      throw Error('Missing unit provider guard');
    await state.providerGuard();
    return state.externalCall(input);
  });
  state.providerFactory.mockImplementation(
    (_key: string, guard: () => Promise<void>) => {
      state.providerGuard = guard;
      return Object.freeze({ decide: state.decide });
    },
  );
  // This is a wiring probe, not a substitute for the actual engine/intake tests.
  state.prepareEngine.mockImplementation(
    async (
      currentActor: ActionActor,
      _sourceId: string,
      ports: QuotePreparationPorts,
    ) => {
      await ports.authorize(currentActor);
      await ports.provider.decide(input);
      return proposal;
    },
  );
});

describe('private device quote preparation composition (unit boundaries)', () => {
  it('allowlist absent denies before context, factories, platform key or provider', async () => {
    state.enabled = false;
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.preflightCas).not.toHaveBeenCalled();
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.fences).not.toHaveBeenCalled();
    expect(state.ledgerFactory).not.toHaveBeenCalled();
    expect(state.intakeFactory).not.toHaveBeenCalled();
    expect(state.key).not.toHaveBeenCalled();
    expect(state.providerFactory).not.toHaveBeenCalled();
    expect(state.prepareEngine).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it('wires captured request, source, current CAS, fences and the private factories into the engine', async () => {
    const original = request();
    const result = await prepareDeviceSupportQuote(original, context.source.id);
    expect(result).toBe(proposal);
    const captured: Request = state.authority.mock.calls[0][0];
    expect(captured).not.toBe(original);
    expect(captured.url).toBe(original.url);
    expect(captured.headers.get('Authorization')).toBe(
      'Bearer unit-device-token',
    );
    expect(state.load).toHaveBeenCalledWith(captured, context.source.id);
    expect(state.fences).toHaveBeenCalledWith(authority, cas, loaded);
    expect(state.recover).toHaveBeenCalledWith(authority, context.source.id);
    expect(state.ledgerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ prepare: state.prepareSql }),
      ledgerFence,
    );
    expect(state.intakeFactory).toHaveBeenCalledWith(
      expect.objectContaining({ prepare: state.prepareSql }),
      intakeFence,
    );
    expect(state.providerFactory).toHaveBeenCalledWith(
      platformKey,
      expect.any(Function),
    );
    expect(state.prepareEngine).toHaveBeenCalledWith(
      actor,
      context.source.id,
      expect.objectContaining({
        intake,
        provider: { decide: expect.any(Function) },
        findProposal: ledger.findProposal,
        saveProposal: ledger.saveProposal,
      }),
    );
    const ports: QuotePreparationPorts = state.prepareEngine.mock.calls[0][2];
    expect(await ports.loadContext(actor, context.source.id)).toBe(context);
    expect(state.prepareSql).toHaveBeenCalledWith(
      `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
    );
    expect(state.bindSql).toHaveBeenCalledWith(...predicate.bindings);
    expect(state.externalCall).toHaveBeenCalledTimes(1);
  });

  it('copies request headers before the first awaited authority call', async () => {
    const original = request();
    state.authority.mockImplementation(async () => {
      original.headers.set('Authorization', 'Bearer other-device-token');
      original.headers.set('Origin', 'https://hostile.example.test');
      return authority;
    });
    await prepareDeviceSupportQuote(original, context.source.id);
    const captured: Request = state.authority.mock.calls[0][0];
    expect(captured.headers.get('Authorization')).toBe(
      'Bearer unit-device-token',
    );
    expect(captured.headers.get('Origin')).toBe('tauri://localhost');
    expect(state.load.mock.calls[0][0]).toBe(captured);
  });

  it.each(['revoked', 'changed', 'gate-zero', 'gate-missing'] as const)(
    '%s at the last provider authorization prevents the mocked external call',
    async (change) => {
      state.providerHook = () => {
        if (change === 'revoked') state.rejectAdmission = true;
        if (change === 'changed') state.admissionRevision = 'admission-two';
        if (change === 'gate-zero') state.allowed = 0;
        if (change === 'gate-missing') state.allowed = null;
      };
      await expect(
        prepareDeviceSupportQuote(request(), context.source.id),
      ).rejects.toMatchObject({
        code: change === 'changed' ? 'stale_plan' : 'forbidden',
      });
      expect(state.decide).toHaveBeenCalledTimes(1);
      expect(state.externalCall).not.toHaveBeenCalled();
    },
  );

  it('withdrawal while the platform key is awaited prevents a new provider decision', async () => {
    // Binding values are request/deployment scoped; this probes a current gate
    // reread, not instantaneous cancellation of old workers. The durable stop
    // is action_settings.enabled=false in the real progression CAS.
    state.keyHook = async () => {
      state.enabled = false;
    };
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.key).toHaveBeenCalledTimes(1);
    expect(state.prepareEngine).toHaveBeenCalledTimes(1);
    expect(state.decide).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it('withdrawal immediately before the provider authorization also sends nothing', async () => {
    state.providerHook = () => {
      state.enabled = false;
    };
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'changed', 'gate-zero'] as const)(
    'initial %s refusal avoids factories and key lookup',
    async (change) => {
      if (change === 'revoked') state.rejectAdmission = true;
      if (change === 'changed') state.admissionRevision = 'admission-two';
      if (change === 'gate-zero') state.allowed = 0;
      await expect(
        prepareDeviceSupportQuote(request(), context.source.id),
      ).rejects.toMatchObject({
        code: change === 'changed' ? 'stale_plan' : 'forbidden',
      });
      expect(state.ledgerFactory).not.toHaveBeenCalled();
      expect(state.intakeFactory).not.toHaveBeenCalled();
      expect(state.key).not.toHaveBeenCalled();
      expect(state.providerFactory).not.toHaveBeenCalled();
      expect(state.prepareEngine).not.toHaveBeenCalled();
    },
  );

  it('keeps the platform key exclusively in the private provider constructor, never the proposal or engine ports', async () => {
    const result = await prepareDeviceSupportQuote(
      request(),
      context.source.id,
    );
    expect(state.providerFactory.mock.calls[0][0]).toBe(platformKey);
    expect(JSON.stringify(result)).not.toContain(platformKey);
    expect(Object.keys(result).sort()).toEqual([
      'fingerprint',
      'id',
      'organizationId',
      'plan',
    ]);
    const ports: QuotePreparationPorts = state.prepareEngine.mock.calls[0][2];
    expect(Object.keys(ports).sort()).toEqual([
      'authorize',
      'findProposal',
      'intake',
      'loadContext',
      'provider',
      'saveProposal',
    ]);
    expect(Object.keys(ports.provider)).toEqual(['decide']);
    expect(JSON.stringify(context)).not.toContain(platformKey);
  });

  it('rejects invalid source IDs before authentication or context lookup', async () => {
    await expect(
      prepareDeviceSupportQuote(request(), ''),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    expect(state.authority).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.providerFactory).not.toHaveBeenCalled();
  });

  it('returns the immutable recovered proposal without context, key or another engine decision', async () => {
    state.recover.mockResolvedValue(proposal);
    state.load.mockRejectedValue(Error('current archive unavailable'));
    state.key.mockRejectedValue(Error('platform key unavailable'));
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).resolves.toBe(proposal);
    expect(state.preflightCas).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.fences).not.toHaveBeenCalled();
    expect(state.prepareEngine).not.toHaveBeenCalled();
    expect(state.key).not.toHaveBeenCalled();
    expect(state.providerFactory).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it('does not interpret a failed recovery read as permission to prepare again', async () => {
    state.recover.mockRejectedValue(new ActionEngineError('forbidden'));
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.preflightCas).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.key).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it('rechecks the private deployment gate after historical recovery', async () => {
    state.recover.mockImplementation(async () => {
      state.enabled = false;
      return proposal;
    });
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.load).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });

  it('does not look up the platform key when the engine can reuse durable intake data', async () => {
    state.prepareEngine.mockResolvedValue(proposal);
    state.key.mockRejectedValue(Error('platform key unavailable'));
    await expect(
      prepareDeviceSupportQuote(request(), context.source.id),
    ).resolves.toBe(proposal);
    expect(state.key).not.toHaveBeenCalled();
    expect(state.providerFactory).not.toHaveBeenCalled();
    expect(state.externalCall).not.toHaveBeenCalled();
  });
});
