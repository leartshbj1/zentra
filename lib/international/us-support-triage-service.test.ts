import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../support/crypto';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import { UsMailboxError, type UsMailboxState } from './us-support-mailbox-contract';
import { US_SUPPORT_WORKER_ID, usSupportExecutionMailboxEncryptionContext, type UsSupportExecutionContext, type UsSupportWorkerContext } from './us-support-execution-contract';
import { US_SUPPORT_TRIAGE_MODEL, US_SUPPORT_TRIAGE_RECIPE_VERSION, UsSupportTriageError, hashUsSupportTriageExecutionRequest, hashUsSupportTriageSource,
  type UsSupportTriageRequest, type UsSupportTriageResult, type UsSupportTriageStore, type UsSupportTriageDecision } from './us-support-triage-contract';
import { type UsSupportTriagePolicy } from './us-support-triage-policy';
import { createUsSupportTriageService, type UsSupportTriageServiceDependencies, type UsSupportTriageMessage } from './us-support-triage-service';

/** Synthetic stores isolate the common service's transport/authority order.
 * Real SQLite H3a and H4 suites separately verify atomic SQL admission. */
async function fixture() {
  const organizationId = randomUUID(), workspaceId = randomUUID(), userId = randomUUID(), now = 1791620000;
  const initial: UsSupportWorkerContext = { schemaVersion: 1, workspaceId, authority: { schemaVersion: 1, organizationId, userId, ownerUserId: userId, role: 'owner', subscriptionId: 'sub_Test',
    environment: 'TEST', catalogVersion: 'fixture-test-v1', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: now - 100, validEndsAt: now + 1000, seatLimit: 3, checkedAt: now,
    credential: { kind: 'worker', workerId: US_SUPPORT_WORKER_ID, delegationId: randomUUID(), delegationRevision: 1, runId: randomUUID() } } };
  let context: UsSupportExecutionContext = initial, refused = false;
  const current = vi.fn(async () => { if (refused) throw new UsMailboxError('forbidden', 403); return context; });
  const policy: UsSupportTriagePolicy = { schemaVersion: 1, cadence: 'utc_calendar_month', budgetPolicyVersion: 'budget-test-v1', processingPolicyVersion: 'processing-test-v1', recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION,
    threshold: 0.9, entries: [{ catalogVersion: 'fixture-test-v1', priceId: 'price_Test', limit: 10 }] };
  const key = btoa('s'.repeat(32)), token = 'private-provider-key', connectionId = randomUUID();
  const connection = { id: connectionId, provider: 'infomaniak' as const, email: 'private@example.test', mailboxId: 'private-box', folderId: 'private-folder', tokenSha256: await sha256Hex(token),
    credentialsCiphertext: await encryptSecret(key, token, usSupportExecutionMailboxEncryptionContext(initial, connectionId, 1)), verifiedAt: now, connectedBy: userId, revision: 1 };
  let head: UsMailboxState = { schemaVersion: 1, organizationId, workspaceId, revision: 1, currentConnection: connection };
  const message: UsSupportTriageMessage = { source: { provider: 'infomaniak', mailboxId: connection.mailboxId, folderId: connection.folderId, uid: '42', messageVersion: String(now), receivedAt: now,
    messageSha256: 'a'.repeat(64), attachmentCount: 0, bodyComplete: true }, subject: 'Private subject', body: 'My product cannot connect.' };
  const decision: UsSupportTriageDecision = { schemaVersion: 1, category: 'bug', priority: 'normal', categoryConfidence: 0.96, priorityConfidence: 0.95, confidence: 0.95,
    language: 'en', languageConfidence: 0.98, humanRequested: 0, reviewReasons: [], needsReview: false, model: US_SUPPORT_TRIAGE_MODEL, recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION };
  const jobs = new Map<string, UsSupportTriageResult>();
  const store: UsSupportTriageStore = {
    find: vi.fn(async (_c, id, hash): Promise<UsSupportTriageResult | null> => { const saved = jobs.get(id); if (!saved) return null; if (saved.requestHash !== hash) throw new UsSupportTriageError('triage_idempotency_conflict', 409);
      return { ...saved, replayed: true, job: { ...saved.job, state: saved.job.result ? 'completed' : saved.job.dispatchId ? 'uncertain' : 'reserved' } }; }),
    claim: vi.fn(async (c, command, check) => { await check(); const hash = await hashUsSupportTriageExecutionRequest(c, command.request), prior = await store.find(c, command.request.requestId, hash); if (prior) return prior;
      const result: UsSupportTriageResult = { requestId: command.request.requestId, requestHash: hash, replayed: false, job: { schemaVersion: 1, id: randomUUID(), organizationId, workspaceId, actorUserId: c.authority.userId,
        requestId: command.request.requestId, source: command.source, sourceHash: await hashUsSupportTriageSource(organizationId, workspaceId, command.source), grant: command.grant, createdAt: now,
        state: 'reserved', dispatchId: null, result: null, completedAt: null } }; jobs.set(command.request.requestId, result); return result; }),
    dispatch: vi.fn(async (c, command, check) => { await check(); const prior = await store.find(c, command.requestId, command.requestHash); if (!prior) throw Error('Missing fixture reservation');
      if (prior.job.dispatchId) return { result: prior, mayDispatch: false }; const result = { ...prior, replayed: false, job: { ...prior.job, state: 'dispatched' as const, dispatchId: command.dispatchId } };
      jobs.set(command.requestId, result); return { result, mayDispatch: true }; }),
    complete: vi.fn(async (c, command, check) => { await check(); const prior = await store.find(c, command.requestId, command.requestHash); if (!prior) throw Error('Missing fixture dispatch');
      const result = { ...prior, replayed: false, job: { ...prior.job, state: 'completed' as const, result: command.decision, completedAt: now } }; jobs.set(command.requestId, result); return result; }),
    uncertain: vi.fn(async (c, command, check) => { await check(); const prior = await store.find(c, command.requestId, command.requestHash); if (!prior) throw Error('Missing fixture dispatch'); return prior; }),
    usage: vi.fn(async (_c, grant) => ({ limit: grant.limit, used: jobs.size, remaining: Math.max(0, grant.limit - jobs.size) })),
  };
  const dependencies: UsSupportTriageServiceDependencies = { now: () => now, store: vi.fn(async () => store), mailbox: vi.fn(async () => head), policy: vi.fn(async () => policy), providerReady: vi.fn(async () => true),
    encryptionKey: vi.fn(async () => key), message: vi.fn(async (_c, secret, _q, check) => { await check(); expect(secret).toBe(token); return message; }), classify: vi.fn(async (_m, _g, check) => { await check(); return decision; }) };
  const request: UsSupportTriageRequest = { schemaVersion: 1, requestId: randomUUID(), connectionId, expectedMailboxRevision: 1, uid: '42', expectedMessageVersion: String(now), processingPolicyVersion: policy.processingPolicyVersion, consent: true };
  const service = createUsSupportTriageService(dependencies), run = (q = request) => service.triage(context, q, current);
  return { initial, context: () => context, setContext: (value: UsSupportExecutionContext) => { context = value; }, refuse: (value = true) => { refused = value; }, head: () => head,
    setHead: (value: UsMailboxState) => { head = value; }, dependencies, store, jobs, message, decision, policy, request, current, service, run };
}

describe('shared US triage execution without a fabricated HTTP session', () => {
  it('uses explicit worker delegation for every store/mailbox call and emits once', async () => {
    const f = await fixture(), result = await f.run(); expect(result.job).toMatchObject({ state: 'completed', actorUserId: f.initial.authority.userId, result: { category: 'bug' } });
    expect(f.dependencies.classify).toHaveBeenCalledOnce(); expect(f.store.dispatch).toHaveBeenCalledOnce();
    for (const port of [f.store.find, f.store.claim, f.store.dispatch, f.store.complete, f.dependencies.mailbox!]) for (const call of vi.mocked(port).mock.calls)
      expect(call[0].authority.credential).toEqual(f.initial.authority.credential);
    expect(canonicalErpJson([...f.jobs.values()])).not.toMatch(/My product|Private subject|private-provider-key|credentialsCiphertext/);
  });
  it('supports the original human authority directly with the same service', async () => {
    const f = await fixture(); f.setContext({ ...f.initial, authority: { ...f.initial.authority, credential: { kind: 'browser' } } });
    expect((await f.run()).job.state).toBe('completed'); expect(f.dependencies.classify).toHaveBeenCalledOnce();
  });
  it('reads only the shared quota for delegated budget readiness', async () => {
    const f = await fixture(), budget = await f.service.readBudget(f.context(), f.current);
    expect(budget).toEqual({ processingPolicyVersion: f.policy.processingPolicyVersion, recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION, usage: { limit: 10, used: 0, remaining: 10 } });
    expect(f.dependencies.mailbox).not.toHaveBeenCalled(); expect(f.dependencies.message).not.toHaveBeenCalled(); expect(f.dependencies.classify).not.toHaveBeenCalled(); expect(f.dependencies.encryptionKey).not.toHaveBeenCalled();
  });
  it('replays completed work under a new lease without policy, provider, mailbox or secret access', async () => {
    const f = await fixture(), first = await f.run();
    f.setContext({ ...f.initial, authority: { ...f.initial.authority, credential: { ...f.initial.authority.credential, runId: randomUUID() } } });
    for (const key of ['policy', 'providerReady', 'mailbox', 'encryptionKey', 'message'] as const) f.dependencies[key] = vi.fn(async () => { throw Error('Unexpected private access'); }) as never;
    expect(await f.run()).toMatchObject({ replayed: true, job: { id: first.job.id, state: 'completed' } }); expect(f.dependencies.classify).toHaveBeenCalledOnce();
    for (const key of ['policy', 'providerReady', 'mailbox', 'encryptionKey', 'message'] as const) expect(f.dependencies[key]).not.toHaveBeenCalled();
  });
  it('retains an ambiguous dispatch through a new lease and cannot emit again', async () => {
    const f = await fixture(); f.dependencies.classify = vi.fn(async () => { throw new UsSupportTriageError('triage_provider_unavailable', 503); });
    await expect(f.run()).rejects.toMatchObject({ code: 'triage_provider_unavailable' });
    f.setContext({ ...f.initial, authority: { ...f.initial.authority, credential: { ...f.initial.authority.credential, runId: randomUUID() } } });
    f.dependencies.policy = vi.fn(async () => { throw Error('No new provider admission'); });
    expect(await f.run()).toMatchObject({ replayed: true, job: { state: 'uncertain', result: null } }); expect(f.dependencies.classify).toHaveBeenCalledOnce(); expect(f.dependencies.policy).not.toHaveBeenCalled();
  });
  it.each(['dispatch', 'complete'] as const)('recovers a lost %s acknowledgement without another model emission', async phase => {
    const f = await fixture();
    if (phase === 'dispatch') { const original = f.store.dispatch; f.store.dispatch = async (...args) => { await original(...args); throw Error('Lost dispatch acknowledgement'); }; }
    else { const original = f.store.complete; f.store.complete = async (...args) => { await original(...args); throw Error('Lost completion acknowledgement'); }; }
    await expect(f.run()).rejects.toThrow(); expect((await f.run()).job.state).toBe(phase === 'dispatch' ? 'uncertain' : 'completed');
    expect(f.dependencies.classify).toHaveBeenCalledTimes(phase === 'dispatch' ? 0 : 1);
  });
  it('does not let a worker fall back to the human-only mailbox reader', async () => {
    const f = await fixture(); delete f.dependencies.mailbox;
    const read = vi.fn(async () => f.head()); f.dependencies.mailboxStore = vi.fn(async () => ({ read, receipt: async () => null, commit: async () => { throw Error('Unexpected mailbox mutation'); } }));
    await expect(f.run()).rejects.toMatchObject({ code: 'service_unavailable' }); expect(f.dependencies.mailboxStore).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(f.dependencies.classify).not.toHaveBeenCalled();
  });
  it.each(['delegation', 'run', 'kind', 'user'] as const)('rejects a changed %s execution before private I/O', async kind => {
    const f = await fixture(); const changed: UsSupportExecutionContext = kind === 'kind' ? { ...f.initial, authority: { ...f.initial.authority, credential: { kind: 'browser' } } }
      : { ...f.initial, authority: { ...f.initial.authority, ...(kind === 'user' ? { userId: randomUUID(), role: 'admin' as const } : {}), credential: { ...f.initial.authority.credential,
        ...(kind === 'delegation' ? { delegationRevision: 2 } : kind === 'run' ? { runId: randomUUID() } : {}) } } };
    f.current.mockResolvedValue(changed); await expect(f.run()).rejects.toMatchObject({ code: 'configuration_changed', status: 409 }); expect(f.dependencies.store).not.toHaveBeenCalled(); expect(f.dependencies.message).not.toHaveBeenCalled();
  });
  it('will not start a model after revocation at the durable dispatch boundary', async () => {
    const f = await fixture(), dispatch = f.store.dispatch; f.store.dispatch = async (...args) => { const result = await dispatch(...args); f.refuse(); return result; };
    await expect(f.run()).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect(f.dependencies.classify).not.toHaveBeenCalled(); expect(f.store.complete).not.toHaveBeenCalled();
    f.refuse(false); expect((await f.run()).job.state).toBe('uncertain'); expect(f.dependencies.classify).not.toHaveBeenCalled();
  });
  it('fresh revocation outranks an upstream error and cannot complete the dispatch', async () => {
    const f = await fixture(); f.dependencies.classify = vi.fn(async () => { f.refuse(); throw Error('Private upstream body'); });
    await expect(f.run()).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect(f.store.complete).not.toHaveBeenCalled(); expect(f.jobs.size).toBe(1);
    f.refuse(false); expect((await f.run()).job.state).toBe('uncertain'); expect(f.dependencies.classify).toHaveBeenCalledOnce();
  });
  it('stale connection after inference prevents completion and remains fenced', async () => {
    const f = await fixture(); f.dependencies.classify = vi.fn(async () => { f.setHead({ ...f.head(), revision: 2, currentConnection: null }); return f.decision; });
    await expect(f.run()).rejects.toMatchObject({ code: 'mailbox_revision_conflict', status: 409 }); expect(f.store.complete).not.toHaveBeenCalled();
    expect((await f.run()).job.state).toBe('uncertain'); expect(f.dependencies.classify).toHaveBeenCalledOnce();
  });
  it('requires fresh policy before a source reservation and shares the existing quota error', async () => {
    const f = await fixture(); f.store.claim = vi.fn(async () => { throw new UsSupportTriageError('triage_quota_exceeded', 409); });
    await expect(f.run()).rejects.toMatchObject({ code: 'triage_quota_exceeded', status: 409 }); expect(f.dependencies.classify).not.toHaveBeenCalled(); expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.jobs.size).toBe(0);
  });
  it('preserves the existing lifetime capacity error without dispatching', async () => {
    const f = await fixture(); f.store.claim = vi.fn(async () => { throw new UsSupportTriageError('triage_capacity_exceeded', 409); });
    await expect(f.run()).rejects.toMatchObject({ code: 'triage_capacity_exceeded', status: 409 }); expect(f.dependencies.classify).not.toHaveBeenCalled(); expect(f.store.dispatch).not.toHaveBeenCalled();
  });
  it('does not reserve a contradictory physical source', async () => {
    const f = await fixture(); f.dependencies.message = vi.fn(async () => ({ ...f.message, source: { ...f.message.source, mailboxId: 'another-box' } }));
    await expect(f.run()).rejects.toMatchObject({ code: 'triage_source_conflict', status: 409 }); expect(f.jobs.size).toBe(0); expect(f.dependencies.classify).not.toHaveBeenCalled();
  });
  it('freezes the exact request before asynchronous revalidation', async () => {
    const f = await fixture(), request = { ...f.request }; f.current.mockImplementation(async () => { request.uid = '43'; return f.context(); });
    expect((await f.run(request)).job.source.uid).toBe('42'); expect(request.uid).toBe('43');
  });
  it('recovers the optional ticket sink from durable completion without another model call', async () => {
    const f = await fixture(); let fail = true; f.dependencies.recordTicket = vi.fn(async (context, _job, check) => { expect(context.authority.credential.kind).toBe('worker'); await check(); if (fail) throw Error('Lost ticket acknowledgement'); });
    await expect(f.run()).rejects.toThrow('Lost ticket acknowledgement'); expect([...f.jobs.values()][0].job.state).toBe('completed'); fail = false;
    expect((await f.run()).job.state).toBe('completed'); expect(f.dependencies.classify).toHaveBeenCalledOnce(); expect(f.dependencies.recordTicket).toHaveBeenCalledTimes(2);
  });
  it('does not return a completed result after authority changes in the ticket sink', async () => {
    const f = await fixture(); f.dependencies.recordTicket = vi.fn(async () => { f.refuse(); });
    await expect(f.run()).rejects.toMatchObject({ code: 'forbidden', status: 403 }); expect([...f.jobs.values()][0].job.state).toBe('completed');
    f.refuse(false); f.dependencies.recordTicket = vi.fn(async () => {}); expect((await f.run()).job.state).toBe('completed'); expect(f.dependencies.classify).toHaveBeenCalledOnce();
  });
});
