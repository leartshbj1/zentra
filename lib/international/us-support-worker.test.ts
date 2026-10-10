import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../support/crypto';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import {
  usSupportExecutionMailboxEncryptionContext,
  type UsSupportWorkerContext,
} from './us-support-execution-contract';
import {
  UsMailboxError,
  type UsMailboxState,
} from './us-support-mailbox-contract';
import {
  US_SUPPORT_TRIAGE_MODEL,
  US_SUPPORT_TRIAGE_RECIPE_VERSION,
  UsSupportTriageError,
  type UsSupportTriageRequest,
  type UsSupportTriageResult,
} from './us-support-triage-contract';
import {
  createUsSupportTriageGrant,
  type UsSupportTriagePolicy,
} from './us-support-triage-policy';
import {
  UsSupportWorkerError,
  type UsSupportWorkerDiscovered,
  type UsSupportWorkerLease,
  type UsSupportWorkerStage,
  type UsSupportWorkerStore,
} from './us-support-worker-contract';
import {
  createUsSupportWorker,
  type UsSupportWorkerDependencies,
} from './us-support-worker';

/** Synthetic durable ports isolate the scheduler's order and bounds. The
 * composition suite exercises the actual SQLite transaction chain. */
async function fixture() {
  let at = 1791620000,
    enabled = true,
    refused = false;
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    userId = randomUUID(),
    connectionId = randomUUID(),
    delegationId = randomUUID();
  const sinceAt = at,
    key = btoa('w'.repeat(32)),
    token = 'synthetic-worker-mail-token';
  const lease = (
    patch: Partial<UsSupportWorkerLease> = {},
  ): UsSupportWorkerLease => ({
    runId: randomUUID(),
    organizationId,
    workspaceId,
    delegationId,
    delegationRevision: 1,
    workerId: 'us-support-intake-v1',
    acquiredAt: at,
    expiresAt: at + 120,
    scanOffset: 0,
    sinceAt,
    ...patch,
  });
  const queue: UsSupportWorkerLease[] = [lease()];
  const context = (
    runId = queue[0]?.runId ?? randomUUID(),
  ): UsSupportWorkerContext => ({
    schemaVersion: 1,
    workspaceId,
    authority: {
      schemaVersion: 1,
      organizationId,
      userId,
      ownerUserId: userId,
      role: 'owner',
      subscriptionId: 'sub_Test',
      environment: 'TEST',
      catalogVersion: 'fixture-test-v1',
      priceId: 'price_Test',
      authorityReference: 'in_Test',
      validStartsAt: sinceAt - 100,
      validEndsAt: sinceAt + 10000,
      seatLimit: 3,
      checkedAt: at,
      credential: {
        kind: 'worker',
        workerId: 'us-support-intake-v1',
        delegationId,
        delegationRevision: 1,
        runId,
      },
    },
  });
  const policy: UsSupportTriagePolicy = {
    schemaVersion: 1,
    cadence: 'utc_calendar_month',
    budgetPolicyVersion: 'budget-test-v1',
    processingPolicyVersion: 'processing-test-v1',
    recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION,
    threshold: 0.9,
    entries: [
      { catalogVersion: 'fixture-test-v1', priceId: 'price_Test', limit: 10 },
    ],
  };
  let head: UsMailboxState = {
    schemaVersion: 1,
    organizationId,
    workspaceId,
    revision: 1,
    currentConnection: {
      id: connectionId,
      provider: 'infomaniak',
      email: 'synthetic@example.test',
      mailboxId: 'synthetic-box',
      folderId: 'synthetic-folder',
      tokenSha256: await sha256Hex(token),
      credentialsCiphertext: await encryptSecret(
        key,
        token,
        usSupportExecutionMailboxEncryptionContext(context(), connectionId, 1),
      ),
      verifiedAt: at,
      connectedBy: userId,
      revision: 1,
    },
  };
  const records = new Map<string, UsSupportWorkerDiscovered>(),
    terminal = new Set<string>(),
    events: UsSupportWorkerStage[] = [],
    jobs = new Map<string, UsSupportTriageResult>();
  const item = (
    uid = '123',
    prepared = false,
    patch: Partial<UsSupportWorkerDiscovered> = {},
  ) => {
    const requestId = randomUUID(),
      request: UsSupportTriageRequest = {
        schemaVersion: 1,
        requestId,
        connectionId,
        expectedMailboxRevision: 1,
        uid,
        expectedMessageVersion: String(sinceAt),
        processingPolicyVersion: policy.processingPolicyVersion,
        consent: true,
      };
    const result: UsSupportWorkerDiscovered = {
      id: randomUUID(),
      uid,
      version: String(sinceAt),
      receivedAt: sinceAt,
      connectionId,
      mailboxRevision: 1,
      requestId,
      request: prepared ? request : null,
      state: 'discovered',
      jobId: null,
      ...patch,
    };
    records.set(result.id, result);
    return result;
  };
  const store: UsSupportWorkerStore = {
    read: vi.fn(async () => {
      throw Error('No human projection in scheduler');
    }),
    manage: vi.fn(async () => {
      throw Error('No delegation mutation in scheduler');
    }),
    acquire: vi.fn(async () => queue.shift() ?? null),
    revalidate: vi.fn(async (input) => {
      if (refused) throw new UsMailboxError('forbidden', 403);
      return context(
        'runId' in input ? input.runId : input.authority.credential.runId,
      );
    }),
    discover: vi.fn(async (_c, page, check) => {
      await check();
      for (const ref of page.references)
        if (![...records.values()].some((r) => r.uid === ref.uid))
          item(ref.uid, false, {
            version: ref.version,
            receivedAt: ref.receivedAt,
          });
      return [...records.values()];
    }),
    pending: vi.fn(async (_c, limit = 50) =>
      [...records.values()]
        .filter((r) => !terminal.has(r.id))
        .sort((a, b) => Number(!!b.request) - Number(!!a.request))
        .slice(0, limit),
    ),
    prepare: vi.fn(async (_c, input, check) => {
      await check();
      const old = records.get(input.discoveryId)!;
      if (
        old.request &&
        canonicalErpJson(old.request) !== canonicalErpJson(input.request)
      )
        throw new UsSupportWorkerError('worker_source_conflict', 409);
      const next = { ...old, request: structuredClone(input.request) };
      records.set(next.id, next);
      return next;
    }),
    stage: vi.fn(async (_c, event, check) => {
      await check();
      events.push(event);
      if (['ticketed', 'uncertain', 'rejected'].includes(event.stage))
        terminal.add(event.discoveryId);
    }),
    defer: vi.fn(async (_c, _event, check) => {
      await check();
    }),
    finish: vi.fn(async () => {}),
  };
  const triage = vi.fn(
    async (
      c: UsSupportWorkerContext,
      q: UsSupportTriageRequest,
      check: () => Promise<UsSupportWorkerContext>,
    ): Promise<UsSupportTriageResult> => {
      await check();
      const previous = jobs.get(q.requestId);
      if (previous) return { ...previous, replayed: true };
      const result: UsSupportTriageResult = {
        requestId: q.requestId,
        requestHash: 'a'.repeat(64),
        replayed: false,
        job: {
          schemaVersion: 1,
          id: randomUUID(),
          organizationId,
          workspaceId,
          actorUserId: userId,
          requestId: q.requestId,
          source: {
            provider: 'infomaniak',
            mailboxId: 'synthetic-box',
            folderId: 'synthetic-folder',
            uid: q.uid,
            messageVersion: q.expectedMessageVersion,
            receivedAt: sinceAt,
            messageSha256: 'b'.repeat(64),
            attachmentCount: 0,
            bodyComplete: true,
          },
          sourceHash: 'c'.repeat(64),
          grant: createUsSupportTriageGrant(c, policy),
          createdAt: at,
          state: 'completed',
          dispatchId: randomUUID(),
          completedAt: at,
          result: {
            schemaVersion: 1,
            category: 'product',
            priority: 'normal',
            categoryConfidence: 0.96,
            priorityConfidence: 0.95,
            confidence: 0.95,
            language: 'en',
            languageConfidence: 0.97,
            humanRequested: 0,
            reviewReasons: [],
            needsReview: false,
            model: US_SUPPORT_TRIAGE_MODEL,
            recipeVersion: US_SUPPORT_TRIAGE_RECIPE_VERSION,
          },
        },
      };
      jobs.set(q.requestId, result);
      return result;
    },
  );
  const dependencies: UsSupportWorkerDependencies = {
    enabled: vi.fn(async () => enabled),
    now: () => at,
    store: vi.fn(async () => store),
    mailbox: vi.fn(async () => head),
    encryptionKey: vi.fn(async () => key),
    discover: vi.fn(async (_connection, secret, scan, check) => {
      await check();
      expect(secret).toBe(token);
      return {
        offset: scan.offset,
        threadCount: 1,
        nextOffset: null,
        references: [
          { uid: '123', versionHint: String(sinceAt), receivedAt: sinceAt },
        ],
        issues: [],
      };
    }),
    resolveVersion: vi.fn(async (_connection, _token, _uid, check) => {
      await check();
      return { messageVersion: String(sinceAt), receivedAt: sinceAt };
    }),
    triage,
    processingPolicyVersion: vi.fn(async () => policy.processingPolicyVersion),
    diagnostic: vi.fn(),
  };
  return {
    dependencies,
    store,
    records,
    events,
    jobs,
    queue,
    item,
    lease,
    context,
    sinceAt,
    triage,
    head: () => head,
    setHead: (value: UsMailboxState) => {
      head = value;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
    refuse: () => {
      refused = true;
    },
    setNow: (value: number) => {
      at = value;
    },
    next: () => {
      at += 61;
      queue.push(lease());
    },
    run: () => createUsSupportWorker(dependencies).tick(),
  };
}

describe('bounded US autonomous Support orchestration', () => {
  it('does not access runtime stores when the exact gate is closed', async () => {
    const f = await fixture();
    f.enable(false);
    expect(await f.run()).toEqual({ acquired: 0, ticketed: 0, outcomes: [] });
    expect(f.dependencies.store).not.toHaveBeenCalled();
  });
  it('requests one 120-second lease per invocation within the paid D1 budget', async () => {
    const f = await fixture();
    f.queue.push(f.lease(), f.lease(), f.lease());
    await f.run();
    expect(f.store.acquire).toHaveBeenCalledOnce();
    expect(f.queue).toHaveLength(3);
    for (const [input] of vi.mocked(f.store.acquire).mock.calls)
      expect(input).toMatchObject({ leaseSeconds: 120 });
  });
  it('receives before preparing, uses explicit worker authority and creates one ticket', async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({
      acquired: 1,
      ticketed: 1,
      outcomes: ['completed'],
    });
    expect(f.store.prepare).toHaveBeenCalledOnce();
    expect(f.triage).toHaveBeenCalledOnce();
    expect(f.events).toMatchObject([{ stage: 'ticketed', code: null }]);
    expect(
      vi.mocked(f.store.discover).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(f.store.prepare).mock.invocationCallOrder[0]);
    expect(f.triage.mock.calls[0][0].authority.credential.kind).toBe('worker');
    expect(f.triage.mock.calls[0][1].consent).toBe(true);
    expect(canonicalErpJson(f.events)).not.toMatch(
      /synthetic-worker-mail-token|ciphertext|subject|body/,
    );
  });
  it('recovers prepared results before private intake and preserves recovery when the key is absent', async () => {
    const f = await fixture();
    const saved = f.item('124', true);
    f.dependencies.encryptionKey = vi.fn(async () => {
      throw Error('Missing secret');
    });
    expect(await f.run()).toEqual({
      acquired: 1,
      ticketed: 1,
      outcomes: ['partial'],
    });
    expect(f.triage.mock.calls[0][1]).toEqual(saved.request);
    expect(f.triage.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.dependencies.mailbox).mock.invocationCallOrder[0],
    );
    expect(f.dependencies.discover).not.toHaveBeenCalled();
    expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it('still refreshes the head when a prepared request fails transiently with others queued', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) f.item(String(200 + i), true);
    f.dependencies.triage = vi.fn(async () => {
      throw Error('Temporary transport outage');
    });
    expect(await f.run()).toEqual({
      acquired: 1,
      ticketed: 0,
      outcomes: ['failed'],
    });
    expect(f.dependencies.triage).toHaveBeenCalledOnce();
    expect(f.dependencies.discover).toHaveBeenCalledOnce();
    expect(f.records.size).toBe(6);
    expect(f.events).toEqual([]);
  });
  it('bounds recovery and new processing to one message in total', async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) f.item(String(200 + i), true);
    for (let i = 0; i < 8; i++) f.item(String(300 + i));
    expect((await f.run()).ticketed).toBe(1);
    expect(f.triage).toHaveBeenCalledOnce();
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(1);
    expect(f.records.size - f.events.length).toBeGreaterThan(0);
  });
  it('refreshes offset zero without moving the durable backfill cursor', async () => {
    const f = await fixture();
    f.queue[0] = f.lease({ scanOffset: 60 });
    await f.run();
    expect(
      vi.mocked(f.dependencies.discover).mock.calls.map((call) => call[2]),
    ).toEqual([
      { offset: 0, sinceAt: f.sinceAt },
      { offset: 60, sinceAt: f.sinceAt },
    ]);
    expect(
      vi.mocked(f.store.discover).mock.calls.map((call) => call[1]),
    ).toMatchObject([{ offset: 0, headOnly: true }, { offset: 60 }]);
    expect(vi.mocked(f.store.discover).mock.calls[1][1]).not.toHaveProperty(
      'headOnly',
    );
  });
  it('keeps malformed upstream references as body-free durable issues alongside healthy messages', async () => {
    const f = await fixture();
    const discover = f.dependencies.discover;
    f.dependencies.discover = vi.fn<UsSupportWorkerDependencies['discover']>(
      async (...args) => ({
        ...(await discover(...args)),
        issues: [
          {
            code: 'invalid_reference',
            threadIndex: 0,
            messageIndex: 1,
            fingerprint: 'd'.repeat(64),
          },
        ],
      }),
    );
    expect((await f.run()).ticketed).toBe(1);
    expect(vi.mocked(f.store.discover).mock.calls[0][1].issues).toEqual([
      { code: 'invalid_reference', uid: null, fingerprint: 'd'.repeat(64) },
    ]);
  });
  it.each([true, false])(
    'rejects a pre-consent date without prepare or quota (version hint %s)',
    async (hinted) => {
      const f = await fixture();
      f.item('123', false, {
        version: hinted ? String(f.sinceAt - 1) : null,
        receivedAt: hinted ? f.sinceAt - 1 : null,
      });
      f.dependencies.resolveVersion = vi.fn(async () => ({
        messageVersion: String(f.sinceAt - 1),
        receivedAt: f.sinceAt - 1,
      }));
      expect((await f.run()).ticketed).toBe(0);
      expect(f.store.prepare).not.toHaveBeenCalled();
      expect(f.triage).not.toHaveBeenCalled();
      expect(f.events).toMatchObject([
        { stage: 'rejected', code: 'before_consent_date' },
      ]);
    },
  );
  it('resolves only missing version facts, then freezes the exact prepared request before triage', async () => {
    const f = await fixture();
    f.item('123', false, { version: null, receivedAt: null });
    await f.run();
    expect(f.dependencies.resolveVersion).toHaveBeenCalledOnce();
    expect(f.triage.mock.calls[0][1]).toEqual(
      [...f.records.values()][0].request,
    );
    expect(f.triage.mock.calls[0][1].expectedMessageVersion).toBe(
      String(f.sinceAt),
    );
  });
  it.each([
    'triage_source_conflict',
    'triage_source_unavailable',
    'intake_source_conflict',
    'intake_source_unavailable',
  ])('quarantines %s without blocking a healthy message', async (code) => {
    const f = await fixture();
    f.item('123');
    f.item('124');
    const triage = f.triage;
    f.dependencies.triage = vi.fn<UsSupportWorkerDependencies['triage']>(
      async (...args) => {
        if (args[1].uid === '123')
          throw new UsSupportTriageError(
            code,
            code.endsWith('conflict') ? 409 : 422,
          );
        return triage(...args);
      },
    );
    expect(await f.run()).toEqual({
      acquired: 1,
      ticketed: 0,
      outcomes: ['partial'],
    });
    f.next();
    expect(await f.run()).toMatchObject({
      ticketed: 1,
      outcomes: ['completed'],
    });
    expect(f.events).toMatchObject([
      { stage: 'rejected', code },
      { stage: 'ticketed' },
    ]);
  });
  it('keeps transient requests pending and replays their exact identifier under the next lease', async () => {
    const f = await fixture();
    f.item('123');
    f.item('124');
    const triage = f.triage;
    let fail = true;
    f.dependencies.triage = vi.fn<UsSupportWorkerDependencies['triage']>(
      async (...args) => {
        if (args[1].uid === '123' && fail) throw Error('Temporary unavailable');
        return triage(...args);
      },
    );
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['failed'] });
    const first = vi.mocked(f.dependencies.triage).mock.calls[0][1];
    fail = false;
    f.next();
    expect(await f.run()).toMatchObject({
      ticketed: 1,
      outcomes: ['completed'],
    });
    expect(vi.mocked(f.dependencies.triage).mock.calls[1][1]).toEqual(first);
    expect(
      vi.mocked(f.dependencies.triage).mock.calls[1][0].authority.credential
        .runId,
    ).not.toBe(
      vi.mocked(f.dependencies.triage).mock.calls[0][0].authority.credential
        .runId,
    );
    f.next();
    expect(await f.run()).toMatchObject({
      ticketed: 1,
      outcomes: ['completed'],
    });
    expect(f.store.prepare).toHaveBeenCalledTimes(2);
  });
  it('stages ambiguous durable results as uncertain and cannot invoke them again', async () => {
    const f = await fixture(),
      triage = f.triage;
    f.dependencies.triage = vi.fn<UsSupportWorkerDependencies['triage']>(
      async (...args) => {
        const r = await triage(...args);
        return {
          ...r,
          job: {
            ...r.job,
            state: 'uncertain',
            result: null,
            completedAt: null,
          },
        };
      },
    );
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['uncertain'],
    });
    f.next();
    await f.run();
    expect(f.dependencies.triage).toHaveBeenCalledOnce();
    expect(f.events).toMatchObject([
      { stage: 'uncertain', code: 'dispatch_uncertain' },
    ]);
  });
  it.each([
    ['triage_quota_exceeded', 'budget_blocked'],
    ['triage_capacity_exceeded', 'capacity_blocked'],
    ['ticket_capacity_exceeded', 'capacity_blocked'],
    ['worker_policy_changed', 'policy_changed'],
  ] as const)(
    'stops the lease on %s and retains the exact pending request',
    async (code, expected) => {
      const f = await fixture();
      f.item('123');
      f.item('124');
      f.dependencies.triage = vi.fn(async () => {
        throw new UsSupportTriageError(code, 409);
      });
      expect(await f.run()).toMatchObject({
        ticketed: 0,
        outcomes: [expected],
      });
      expect(f.dependencies.triage).toHaveBeenCalledOnce();
      expect(f.events).toEqual([]);
      expect(vi.mocked(f.store.finish).mock.calls[0][1]).toEqual({
        outcome: expected,
        nextDueAt: f.sinceAt + 300,
      });
      expect([...f.records.values()][0].request).not.toBeNull();
    },
  );
  it('does not advance work if atomic discovery fails at the visible intake cap', async () => {
    const f = await fixture();
    f.store.discover = vi.fn(async () => {
      throw new UsSupportWorkerError('worker_capacity_exceeded', 409);
    });
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['capacity_blocked'],
    });
    expect(f.triage).not.toHaveBeenCalled();
    expect(f.store.prepare).not.toHaveBeenCalled();
  });
  it('drains already received messages before a new page fails at capacity', async () => {
    const f = await fixture();
    f.item('124');
    f.store.discover = vi.fn(async () => {
      throw new UsSupportWorkerError('worker_capacity_exceeded', 409);
    });
    expect(await f.run()).toEqual({
      acquired: 1,
      ticketed: 1,
      outcomes: ['capacity_blocked'],
    });
    expect(f.triage).toHaveBeenCalledOnce();
    expect(f.events).toMatchObject([{ stage: 'ticketed' }]);
    expect(f.triage.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.store.discover).mock.invocationCallOrder[0],
    );
  });
  it('durably defers transient messages with a content-free code for fair later leases', async () => {
    const f = await fixture(),
      item = f.item('123', true);
    f.dependencies.triage = vi.fn(async () => {
      throw Error('Private diagnostic content');
    });
    await f.run();
    expect(f.store.defer).toHaveBeenCalledOnce();
    expect(vi.mocked(f.store.defer).mock.calls[0][1]).toEqual({
      discoveryId: item.id,
      code: 'intake_failed',
    });
    expect(f.events).toEqual([]);
  });
  it('suppresses a successful result when membership is revoked during triage', async () => {
    const f = await fixture(),
      triage = f.triage;
    f.dependencies.triage = vi.fn<UsSupportWorkerDependencies['triage']>(
      async (...args) => {
        const result = await triage(...args);
        f.refuse();
        return result;
      },
    );
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.events).toEqual([]);
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.jobs.size).toBe(1);
  });
  it('does not perform effects after the 120-second lease expires during provider I/O', async () => {
    const f = await fixture(),
      discover = f.dependencies.discover;
    f.dependencies.discover = vi.fn<UsSupportWorkerDependencies['discover']>(
      async (...args) => {
        const result = await discover(...args);
        f.setNow(f.sinceAt + 120);
        return result;
      },
    );
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.store.discover).not.toHaveBeenCalled();
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
  });
  it('binds the first authority snapshot to the acquired run and delegation', async () => {
    const f = await fixture();
    f.store.revalidate = vi.fn(async () => f.context(randomUUID()));
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.dependencies.mailbox).not.toHaveBeenCalled();
    expect(f.store.pending).not.toHaveBeenCalled();
  });
  it('refuses a changed mailbox before any durable prepare or classification', async () => {
    const f = await fixture(),
      discover = f.dependencies.discover;
    f.dependencies.discover = vi.fn<UsSupportWorkerDependencies['discover']>(
      async (...args) => {
        const result = await discover(...args);
        f.setHead({ ...f.head(), revision: 2, currentConnection: null });
        return result;
      },
    );
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['connection_changed'],
    });
    expect(f.store.discover).not.toHaveBeenCalled();
    expect(f.triage).not.toHaveBeenCalled();
  });
  it.each(['mailbox_revision_conflict', 'mailbox_connection_required'])(
    'rejects an old prepared request on %s only while the new lease remains admitted',
    async (code) => {
      const f = await fixture(),
        saved = f.item('123', true);
      f.dependencies.triage = vi.fn(async () => {
        throw new UsSupportTriageError(code, 409);
      });
      expect(await f.run()).toMatchObject({
        ticketed: 0,
        outcomes: ['partial'],
      });
      expect(f.events).toEqual([
        {
          discoveryId: saved.id,
          stage: 'rejected',
          jobId: null,
          code: 'connection_replaced',
        },
      ]);
      expect(f.dependencies.resolveVersion).not.toHaveBeenCalled();
      expect(f.store.defer).not.toHaveBeenCalled();
    },
  );
  it('rejects an old unprepared connection without resolving its private source', async () => {
    const f = await fixture(),
      saved = f.item('123', false, {
        connectionId: randomUUID(),
        version: null,
        receivedAt: null,
      });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['partial'] });
    expect(f.events).toEqual([
      {
        discoveryId: saved.id,
        stage: 'rejected',
        jobId: null,
        code: 'connection_replaced',
      },
    ]);
    expect(f.dependencies.resolveVersion).not.toHaveBeenCalled();
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.triage).not.toHaveBeenCalled();
  });
  it('never lets a throwing diagnostic hide a durable retry', async () => {
    const f = await fixture();
    f.dependencies.triage = vi.fn(async () => {
      throw Error('Synthetic private body');
    });
    f.dependencies.diagnostic = vi.fn(() => {
      throw Error('Diagnostic unavailable');
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['failed'] });
    expect(f.store.finish).toHaveBeenCalledOnce();
    expect(f.dependencies.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'intake',
        code: 'intake_failed',
        outcome: 'failed',
      }),
    );
    expect(
      JSON.stringify(vi.mocked(f.dependencies.diagnostic!).mock.calls),
    ).not.toContain('Synthetic private body');
  });
});
