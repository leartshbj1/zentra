import { describe, expect, it, vi } from 'vitest';
import { JEV_MODEL } from '../automation/provider';
import { DecisionFailure } from '../automation/types';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { createUsSupplierAnalysis, US_SUPPLIER_RECIPE, type UsSupplierAnalysisDependencies } from './us-supplier-analysis';
import type { UsAutomationCompletion, UsAutomationGrant, UsAutomationJob, UsAutomationSettings, UsAutomationStore } from './us-automation-contract';
import type { UsSupplierProposal, UsSupplierSource, UsSupplierStore } from './us-supplier-contract';
import { validateUsSupplierProposal } from './us-supplier-proposal';

const org = '54b7ee3b-5753-4af1-98f6-b2a568fb3890', user = '53e1704e-9cc6-431b-ac4d-2186c5fe5f6d';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const text = 'Supplier: Harbor Supplies LLC\nInvoice Number US-1043\nInvoice Date: 04/05/2026\nDue Date: May 5, 2026\nCurrency: USD\nSubtotal 1,000.00\nSales Tax 82.50\nTotal USD 1,082.50';
const grant: UsAutomationGrant = { schemaVersion: 1, organizationId: org, environment: 'TEST', bucket: 'supplier_invoice_extract', periodId: '2026-10', periodStart: Date.UTC(2026, 9, 1) / 1000, periodEnd: Date.UTC(2026, 10, 1) / 1000, limit: 10, subscriptionId: 'sub_fictitious', authorityReference: 'test-fictitious-authority', catalogVersion: 'catalog-test', priceId: 'price_fictitious', budgetPolicyVersion: 'budget-test', processingPolicyVersion: 'processing-test', checkedAt: Date.parse(actor.timestamp) / 1000 };
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The actual orchestrator/extractor/HTTP adapter run here. Stores, admission,
 * clock and provider response are in-memory TEST fixtures, not PG/API proof. */
async function fixture() {
  const source: UsSupplierSource = { kind: 'document_import', sha256: await sha256Hex(text), fileName: 'fixture.txt', mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText: text };
  let settings: UsAutomationSettings = { schemaVersion: 1, organizationId: org, revision: 1, enabled: true, consent: { processingPolicyVersion: grant.processingPolicyVersion, acceptedBy: user, acceptedAt: actor.timestamp } };
  let current: UsAutomationJob | null = null, proposal: UsSupplierProposal | null = null, next = 1;
  const store: UsAutomationStore = { supportedSchemaVersion: 4,
    readSettings: vi.fn(async () => structuredClone(settings)), saveSettings: vi.fn(async () => { throw new Error('No settings mutation in analysis'); }),
    findSource: vi.fn(async () => structuredClone(current)), read: vi.fn(async () => structuredClone(current)),
    claim: vi.fn(async value => {
      // Synchronous reservation is only a unit-test simulation of the SQL fence.
      if (current && current.state !== 'released') return { job: structuredClone(current), claimed: false };
      current = { schemaVersion: 1, organizationId: org, id: id(next++), environment: value.grant.environment, bucket: grant.bucket, source: value.source, recipeVersion: value.recipeVersion, requestId: value.requestId, createdBy: value.actor.userId, createdAt: value.actor.timestamp, grant: value.grant, consentRevision: settings.revision, state: 'held', leaseToken: value.leaseToken, leaseUntil: '2026-10-08T12:02:00.000Z', leaseGeneration: 1, dispatchId: null, dispatchedAt: null, resultBody: null, resultSha256: null, proposalId: null };
      return { job: structuredClone(current), claimed: true };
    }),
    dispatch: vi.fn(async value => {
      if (!current || current.state !== 'held' || current.leaseToken !== value.leaseToken) return { job: structuredClone(current!), mayDispatch: false };
      current = { ...current, state: 'dispatched', dispatchId: id(next++), dispatchedAt: value.actor.timestamp }; return { job: structuredClone(current), mayDispatch: true };
    }),
    complete: vi.fn(async (value: UsAutomationCompletion) => {
      if (!current || current.state !== 'dispatched') throw new ErpError('invalid_automation_record', 503);
      proposal = validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: id(next++), revision: 0, state: 'review', source: current.source, extraction: JSON.parse(value.resultBody), createdBy: current.createdBy, createdAt: current.createdAt }, org);
      current = { ...current, state: 'completed', resultBody: value.resultBody, resultSha256: value.resultSha256, proposalId: proposal.id };
      return { job: structuredClone(current), proposal: structuredClone(proposal) };
    }),
    markUncertain: vi.fn(async () => { if (current && current.state !== 'completed') current = { ...current, state: 'uncertain' }; return structuredClone(current!); }),
    usage: vi.fn<UsAutomationStore['usage']>(async (_actor, value) => ({ schemaVersion: 1, organizationId: org, environment: value.environment, bucket: grant.bucket, periodId: value.periodId, limit: value.limit, held: 0, consumed: 0, remaining: value.limit })), expireHeld: vi.fn(async () => 0),
  };
  const suppliers: UsSupplierStore = { supportedSchemaVersion: 4, read: vi.fn(async () => structuredClone(proposal)), list: vi.fn(async () => proposal ? [structuredClone(proposal)] : []), findSource: vi.fn(async () => structuredClone(proposal)), create: vi.fn(async () => { throw new Error('Only automation completion may create'); }), approve: vi.fn(async () => { throw new Error('Human financial approval absent'); }) };
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const request = JSON.parse(String(options?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      const keys = Object.keys(question.criteria), choice = name === 'kind' ? 'vendor_invoice' : keys.includes('v0') ? 'v0' : 'absent';
      return [name, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    })); return Response.json({ model: JEV_MODEL, answers });
  });
  const dependencies: UsSupplierAnalysisDependencies = { store, suppliers, grant: vi.fn(async () => structuredClone(grant)), providerKey: vi.fn(async () => 'local-test-key'), providerEnabled: vi.fn(async () => true), fetcher, newId: () => id(next++) };
  const revalidate = vi.fn(async () => ({ ...actor }));
  return { source, store, suppliers, dependencies, fetcher, revalidate, run: () => createUsSupplierAnalysis(dependencies)({ actor, source, revalidate }), job: () => current, proposal: () => proposal,
    setJob: (value: UsAutomationJob | null) => { current = value; }, setProposal: (value: UsSupplierProposal) => { proposal = value; },
    pause: () => { settings = { ...settings, enabled: false, revision: settings.revision + 1 }; },
    consentChange: () => { settings = { ...settings, revision: settings.revision + 1, consent: { ...settings.consent!, processingPolicyVersion: 'new-processing' } }; },
  };
}

describe('US supplier analysis orchestration: no real provider or PG', () => {
  it('dispatches once and produces only a review proposal, with exact result bytes and no financial approval', async () => {
    const t = await fixture(), result = await t.run();
    expect(result).toMatchObject({ replayed: false, proposal: { state: 'review', revision: 0, extraction: { kind: 'vendor_invoice' } } });
    expect(result.proposal.extraction.issues).toContain('human_approval_required'); expect(result.proposal).not.toHaveProperty('recording');
    expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.claim).toHaveBeenCalledTimes(1); expect(t.store.dispatch).toHaveBeenCalledTimes(1);
    expect(t.job()?.recipeVersion).toBe(US_SUPPLIER_RECIPE); expect(t.job()?.resultBody).toBe(canonicalErpJson(result.proposal.extraction)); expect(t.job()?.resultSha256).toBe(await sha256Hex(t.job()!.resultBody!));
    expect(t.suppliers.approve).not.toHaveBeenCalled(); expect(t.suppliers.create).not.toHaveBeenCalled();
  });
  it('returns a completed exact source without reserving or calling the provider again', async () => {
    const t = await fixture(), first = await t.run(), second = await t.run();
    expect(second).toEqual({ ...first, replayed: true }); expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.claim).toHaveBeenCalledTimes(1); expect(t.store.complete).toHaveBeenCalledTimes(1);
  });
  it.each(['paused', 'provider-off', 'key-unset', 'all-off'] as const)('recovers the completed exact source while %s without another provider admission or reservation', async condition => {
    const t = await fixture(), first = await t.run();
    const authCalls = t.revalidate.mock.calls.length;
    if (condition === 'paused' || condition === 'all-off') t.pause();
    if (condition === 'provider-off' || condition === 'all-off') t.dependencies.providerEnabled = vi.fn(async () => false);
    if (condition === 'key-unset' || condition === 'all-off') t.dependencies.providerKey = vi.fn(async () => null);
    const keyCalls = vi.mocked(t.dependencies.providerKey).mock.calls.length, providerCalls = vi.mocked(t.dependencies.providerEnabled).mock.calls.length;
    expect(await t.run()).toEqual({ ...first, replayed: true });
    expect(t.revalidate.mock.calls.length).toBeGreaterThan(authCalls);
    expect(t.dependencies.providerKey).toHaveBeenCalledTimes(keyCalls); expect(t.dependencies.providerEnabled).toHaveBeenCalledTimes(providerCalls);
    expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.claim).toHaveBeenCalledTimes(1); expect(t.store.dispatch).toHaveBeenCalledTimes(1); expect(t.store.complete).toHaveBeenCalledTimes(1);
    expect(t.suppliers.approve).not.toHaveBeenCalled();
  });
  it.each(['x'.repeat(39), 'é'.repeat(39), ` ${'x'.repeat(39)} `, `\n${'x'.repeat(37)}\n`])('rejects an unreadable trimmed source before claim or provider access (%j)', async documentText => {
    const t = await fixture(), source = { ...t.source, documentText, sha256: await sha256Hex(documentText) };
    await expect(createUsSupplierAnalysis(t.dependencies)({ actor, source, revalidate: t.revalidate })).rejects.toMatchObject({ code: 'supplier_source_unreadable', status: 422 });
    expect(t.store.claim).not.toHaveBeenCalled(); expect(t.store.dispatch).not.toHaveBeenCalled(); expect(t.store.complete).not.toHaveBeenCalled(); expect(t.fetcher).not.toHaveBeenCalled();
    expect(t.dependencies.providerKey).not.toHaveBeenCalled(); expect(t.dependencies.providerEnabled).not.toHaveBeenCalled();
  });
  it('has at most one simulated atomic claim and external emission for concurrent collaborators', async () => {
    const t = await fixture(), result = await Promise.allSettled([t.run(), t.run()]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.complete).toHaveBeenCalledTimes(1);
  });
  it.each(['claim', 'dispatch', 'complete'] as const)('does not emit twice after a lost %s acknowledgement', async stage => {
    const t = await fixture(); let once = true;
    if (stage === 'claim') { const original = t.store.claim; t.store.claim = vi.fn(async value => { const answer = await original(value); if (once) { once = false; throw new Error('Lost claim ACK'); } return answer; }); }
    if (stage === 'dispatch') { const original = t.store.dispatch; t.store.dispatch = vi.fn(async value => { const answer = await original(value); if (once) { once = false; throw new Error('Lost dispatch ACK'); } return answer; }); }
    if (stage === 'complete') { const original = t.store.complete; t.store.complete = vi.fn(async value => { const answer = await original(value); if (once) { once = false; throw new Error('Lost complete ACK'); } return answer; }); }
    await expect(t.run()).rejects.toBeDefined();
    if (stage === 'complete') expect(await t.run()).toMatchObject({ replayed: true });
    else await expect(t.run()).rejects.toMatchObject({ code: stage === 'claim' ? 'automation_busy' : 'automation_dispatch_uncertain', status: 409 });
    expect(t.fetcher).toHaveBeenCalledTimes(stage === 'dispatch' || stage === 'claim' ? 0 : 1);
  });
  it('marks an emitted ambiguous network result uncertain and refuses automatic retry', async () => {
    const t = await fixture(); t.fetcher.mockRejectedValue(new Error('Unknown outcome private upstream error'));
    await expect(t.run()).rejects.toMatchObject({ code: 'network' }); expect(t.job()?.state).toBe('uncertain');
    await expect(t.run()).rejects.toMatchObject({ code: 'automation_dispatch_uncertain', status: 409 }); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not repeat the provider after an unknown completion that did not persist a proposal', async () => {
    const t = await fixture(); t.store.complete = vi.fn(async () => { throw new Error('Completion outcome unknown'); });
    await expect(t.run()).rejects.toBeDefined(); expect(t.job()?.state).toBe('uncertain'); expect(t.proposal()).toBeNull();
    await expect(t.run()).rejects.toMatchObject({ code: 'automation_dispatch_uncertain', status: 409 }); expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.complete).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503])('consumes the dispatch and never automatically retries HTTP %s', async status => {
    const t = await fixture(); t.fetcher.mockImplementation(async () => new Response('', { status }));
    await expect(t.run()).rejects.toBeInstanceOf(DecisionFailure); await expect(t.run()).rejects.toMatchObject({ code: 'automation_dispatch_uncertain' }); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves a quota refusal at the last durable dispatch fence without emitting HTTP', async () => {
    const t = await fixture(); t.store.dispatch = vi.fn(async () => { throw new ErpError('automation_quota_exceeded', 402); });
    await expect(t.run()).rejects.toMatchObject({ code: 'automation_quota_exceeded', status: 402 });
    expect(t.fetcher).not.toHaveBeenCalled(); expect(t.store.complete).not.toHaveBeenCalled();
  });
  it('preserves consent revocation between claim and authorization without disguising it as provider failure', async () => {
    const t = await fixture(), original = t.store.claim;
    t.store.claim = vi.fn(async value => { const answer = await original(value); t.pause(); return answer; });
    await expect(t.run()).rejects.toMatchObject({ code: 'automation_consent_required', status: 409 });
    expect(t.fetcher).not.toHaveBeenCalled(); expect(t.store.dispatch).not.toHaveBeenCalled();
  });
  it.each(['pause', 'policy', 'flag', 'revocation'] as const)('withholds external emission when %s changes after durable dispatch', async change => {
    const t = await fixture(), original = t.store.dispatch;
    t.store.dispatch = vi.fn(async value => { const answer = await original(value);
      if (change === 'pause') t.pause(); if (change === 'policy') t.consentChange();
      if (change === 'flag') t.dependencies.providerEnabled = async () => false;
      if (change === 'revocation') t.revalidate.mockRejectedValue(new ErpError('automation_entitlement_required', 402)); return answer;
    });
    await expect(t.run()).rejects.toBeDefined(); expect(t.fetcher).not.toHaveBeenCalled(); expect(t.store.complete).not.toHaveBeenCalled(); expect(t.job()?.state).not.toBe('completed');
  });
  it('rechecks authority after model work and cannot persist a result for a revoked actor', async () => {
    const t = await fixture(), original = t.fetcher.getMockImplementation()!;
    t.fetcher.mockImplementation(async (...args) => { const response = await original(...args); t.revalidate.mockRejectedValue(new ErpError('automation_entitlement_required', 402)); return response; });
    await expect(t.run()).rejects.toMatchObject({ code: 'automation_entitlement_required', status: 402 }); expect(t.fetcher).toHaveBeenCalledTimes(1); expect(t.store.complete).not.toHaveBeenCalled();
    t.revalidate.mockResolvedValue({ ...actor }); await expect(t.run()).rejects.toMatchObject({ code: 'automation_dispatch_uncertain', status: 409 }); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an identity change while a quota grant is being obtained', async () => {
    const t = await fixture(); t.dependencies.grant = async () => { t.revalidate.mockResolvedValue({ ...actor, userId: 'different-user' }); return grant; };
    await expect(t.run()).rejects.toMatchObject({ code: 'session_changed', status: 401 }); expect(t.store.claim).not.toHaveBeenCalled(); expect(t.fetcher).not.toHaveBeenCalled();
  });
  it.each(['hash', 'pdf', 'grant-tenant', 'capability', 'key'] as const)('rejects %s before reservation or external work', async kind => {
    const t = await fixture();
    if (kind === 'hash') t.source = { ...t.source, sha256: 'a'.repeat(64) };
    if (kind === 'pdf') t.source = { ...t.source, mediaType: 'application/pdf' };
    if (kind === 'grant-tenant') t.dependencies.grant = async () => ({ ...grant, organizationId: id(999) });
    if (kind === 'capability') t.dependencies.store = { ...t.store, supportedSchemaVersion: 3 };
    if (kind === 'key') t.dependencies.providerKey = async () => null;
    await expect(createUsSupplierAnalysis(t.dependencies)({ actor, source: t.source, revalidate: t.revalidate })).rejects.toBeDefined(); expect(t.store.claim).not.toHaveBeenCalled(); expect(t.fetcher).not.toHaveBeenCalled();
  });
  it('rejects a malformed completed source even when the proposal is individually well formed', async () => {
    const t = await fixture(); await t.run(); t.setProposal(validateUsSupplierProposal({ ...t.proposal()!, source: { ...t.source, documentText: 'Other private document', sha256: await sha256Hex('Other private document') } }, org));
    await expect(t.run()).rejects.toMatchObject({ code: 'invalid_automation_record', status: 503 }); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['source', 'extraction', 'proposal-id', 'state'] as const)('rejects an uncorrelated complete %s acknowledgement', async kind => {
    const t = await fixture(), original = t.store.complete;
    t.store.complete = vi.fn(async value => { const result = await original(value);
      if (kind === 'source') return { ...result, proposal: { ...result.proposal, source: { ...result.proposal.source, documentText: 'Other document', sha256: await sha256Hex('Other document') } } };
      if (kind === 'extraction') return { ...result, proposal: validateUsSupplierProposal({ ...result.proposal, extraction: { ...result.proposal.extraction, fields: { ...result.proposal.extraction.fields, reference: 'OTHER' } } }, org) };
      if (kind === 'proposal-id') return { ...result, proposal: { ...result.proposal, id: id(999) } };
      return { ...result, job: { ...result.job, state: 'uncertain' as const } };
    });
    await expect(t.run()).rejects.toMatchObject({ code: 'invalid_automation_record', status: 503 }); expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it('captures source data before awaiting a grant; later caller mutation never changes dispatched text', async () => {
    const t = await fixture(), mutable = { ...t.source };
    t.dependencies.grant = async () => { mutable.documentText = 'New untrusted text'; mutable.sha256 = 'f'.repeat(64); return grant; };
    const result = await createUsSupplierAnalysis(t.dependencies)({ actor, source: mutable, revalidate: t.revalidate }); expect(result.proposal.source.documentText).toBe(text); expect(result.proposal.source.sha256).toBe(t.source.sha256);
  });
  it.each(['source', 'grant'] as const)('never invokes a hostile private %s getter', async kind => {
    const t = await fixture(), getter = vi.fn(() => 'PRIVATE DATA');
    if (kind === 'source') Object.defineProperty(t.source, 'documentText', { enumerable: true, get: getter });
    else { const hostile = { ...grant }; Object.defineProperty(hostile, 'limit', { enumerable: true, get: getter }); t.dependencies.grant = async () => hostile; }
    await expect(t.run()).rejects.toBeDefined(); expect(getter).not.toHaveBeenCalled(); expect(t.fetcher).not.toHaveBeenCalled(); expect(t.store.claim).not.toHaveBeenCalled();
  });
});
