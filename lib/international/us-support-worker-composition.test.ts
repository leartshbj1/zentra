import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_ENDPOINT } from '../automation/transport';
import { encryptSecret } from '../support/crypto';
import { triageQuestions } from '../support/jev';
import { CATEGORIES, LANGUAGES, PRIORITIES } from '../support/types';
import { sha256Hex } from './canonical-hash';
import { readUsSupportExecutionMailbox } from './us-support-execution-d1';
import { usMailboxEncryptionContext } from './us-support-mailbox-contract';
import { US_SUPPORT_TRIAGE_MODEL } from './us-support-triage-contract';
import { createUsSupportIntakeProvider } from './us-support-intake-provider';
import {
  createUsSupportTriageClassifier,
  createUsSupportTriageMessageReader,
} from './us-support-triage-provider';
import {
  createUsSupportTriageService,
  type UsSupportTriageServiceDependencies,
} from './us-support-triage-service';
import { supportWorkerFixture } from './us-support-worker-test-fixture';
import {
  createUsSupportWorker,
  type UsSupportWorkerDependencies,
} from './us-support-worker';
import { d1UsTeamStore } from './us-team-store';
import {
  hashUsTeamCommand,
  hashUsTeamToken,
  newUsTeamToken,
} from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
import { createUsSupportTriageGrant } from './us-support-triage-policy';

// Real D1 authority checks are intentionally repeated around every effect.
// Parallel regression runs can make these SQLite chains slower than unit tests.
vi.setConfig({ testTimeout: 30_000 });

type Fixture = Awaited<ReturnType<typeof supportWorkerFixture>>;
const opened: Fixture[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) {
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    f.sql.close();
  }
});
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
function choice(options: object, selected: string) {
  return {
    type: 'choice',
    choice: selected,
    confidence: 0.97,
    probabilities: Object.fromEntries(
      Object.keys(options).map((key) => [
        key,
        key === selected ? 0.98 : 0.02 / (Object.keys(options).length - 1),
      ]),
    ),
  };
}
function typedResponse(language: 'en' | 'fr') {
  return {
    model: US_SUPPORT_TRIAGE_MODEL,
    answers: {
      category: choice(CATEGORIES, 'product'),
      priority: choice(PRIORITIES, 'normal'),
      language: choice(LANGUAGES, language),
      frustration: {
        type: 'score',
        score: 0,
        confidence: 1,
        probabilities: { '0': 1, '1': 0, '2': 0 },
        legend: Object.fromEntries(
          triageQuestions('', '').questions.frustration.criteria.map(
            (value, index) => [String(index), value],
          ),
        ),
      },
      human_requested: { type: 'noul', noul: 0 },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}
async function completionId(jobId: string) {
  const digest = await sha256Hex(
    'zentra:us-support-ticket:completed:v1:' + jobId,
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
async function adminMembership(f: Fixture) {
  const a = f.context().authority,
    userId = randomUUID(),
    email = userId + '@example.test',
    store = d1UsTeamStore(f.database, { now: f.now });
  const owner: UsTeamContext = {
    schemaVersion: 1,
    organizationId: a.organizationId,
    mode: 'member',
    role: a.role,
    user: { userId: a.userId, email: null, emailConfirmed: false },
    subscriptionId: a.subscriptionId,
    environment: a.environment,
    catalogVersion: a.catalogVersion,
    priceId: a.priceId,
    seatLimit: a.seatLimit,
    checkedAt: a.checkedAt,
    validStartsAt: a.validStartsAt,
    validEndsAt: a.validEndsAt,
    credential: a.credential,
  };
  const invitationId = randomUUID(),
    membershipId = randomUUID(),
    tokenHash = await hashUsTeamToken(newUsTeamToken());
  const invite: UsTeamPrivateCommand = {
    schemaVersion: 1,
    requestId: randomUUID(),
    expectedTeamRevision: await store.revision(owner),
    action: 'create_invitation',
    email,
    role: 'admin',
    invitationId,
    tokenHash,
    expiresAt: f.now() + 604800,
  };
  await store.commit({
    context: owner,
    command: invite,
    requestHash: await hashUsTeamCommand(a.organizationId, f.actor, invite),
  });
  const recipient: UsTeamContext = {
    ...owner,
    mode: 'recipient',
    role: 'admin',
    user: { userId, email, emailConfirmed: true },
  };
  const accept: UsTeamPrivateCommand = {
    schemaVersion: 1,
    requestId: randomUUID(),
    expectedTeamRevision: await store.revision(owner),
    action: 'accept_invitation',
    invitationId,
    tokenHash,
    membershipId,
    firstName: 'Synthetic',
    lastName: 'Admin',
    displayName: 'Synthetic Admin',
  };
  await store.commit({
    context: recipient,
    command: accept,
    requestHash: await hashUsTeamCommand(a.organizationId, userId, accept),
  });
  return {
    userId,
    async revoke() {
      const command: UsTeamPrivateCommand = {
        schemaVersion: 1,
        requestId: randomUUID(),
        expectedTeamRevision: await store.revision(owner),
        action: 'revoke_member',
        membershipId,
      };
      await store.commit({
        context: owner,
        command,
        requestHash: await hashUsTeamCommand(
          a.organizationId,
          f.actor,
          command,
        ),
      });
    },
  };
}

/** Complete real SQLite0000..0098, AES, discovery, message reader, strict
 * classifier and shared service. Only fixed-origin HTTP replies are synthetic. */
async function fixture(language: 'en' | 'fr' = 'en') {
  const f = await supportWorkerFixture();
  opened.push(f);
  let statements = 0;
  const statementKinds = new Map<string, number>();
  const originalPrepare = f.database.prepare.bind(f.database);
  const instrument = (
    statement: D1PreparedStatement,
    text: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === 'bind' && typeof value === 'function')
          return (...args: unknown[]) =>
            instrument(
              Reflect.apply(value, target, args) as D1PreparedStatement,
              text,
            );
        if (
          ['first', 'all', 'run', 'raw'].includes(String(property)) &&
          typeof value === 'function'
        )
          return (...args: unknown[]) => {
            statements++;
            statementKinds.set(text, (statementKinds.get(text) ?? 0) + 1);
            return Reflect.apply(value, target, args);
          };
        return value;
      },
    });
  // This real-SQLite D1 adapter executes batch statements through .run(), so
  // each SQL execution is counted exactly once, including every batch member.
  f.database.prepare = (text) => instrument(originalPrepare(text), text);
  const key = btoa('i'.repeat(32)),
    token = 'synthetic-composition-worker-token',
    connectionId = randomUUID();
  await f.mailbox.commit(
    f.context(),
    {
      ...f.connection,
      requestId: randomUUID(),
      expectedRevision: 1,
      connectionId,
      tokenSha256: await sha256Hex(token),
      credentialsCiphertext: await encryptSecret(
        key,
        token,
        usMailboxEncryptionContext(f.context(), connectionId, 2),
      ),
      verifiedAt: f.now(),
    },
    async () => f.context(),
  );
  const enabled = await f.worker.manage(
    f.context(),
    f.manageRequest({ connectionId, expectedMailboxRevision: 2 }),
    async () => f.context(),
  );
  const date = f.now(),
    subject = 'Synthetic private customer question',
    body =
      language === 'en'
        ? 'Does the product support international workspaces?'
        : 'Le produit prend-il en charge les espaces internationaux ?';
  const raw: Record<string, unknown> = {
    uid: '123@' + f.connection.folderId,
    date,
    subject,
    body,
    from: [{ name: 'Synthetic sender', email: 'sender@example.test' }],
    attachments: [],
  };
  let threads: unknown[] = [{ date, messages: [{ uid: raw.uid, date }] }],
    listReads = 0,
    detailReads = 0,
    emissions = 0;
  let afterDetail = async (_count: number) => {},
    afterDispatch = async () => {},
    modelResponse = async () => Response.json(typedResponse(language));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(urlOf(input));
    expect(init?.redirect).toBe('manual');
    if (url.origin === 'https://mail.infomaniak.com') {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer ' + token,
      );
      const prefix = `/api/mail/${f.connection.mailboxId}/folder/${f.connection.folderId}/message`;
      if (url.pathname === prefix) {
        listReads++;
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('thread')).toBe('off');
        return Response.json({ result: 'success', data: { threads } });
      }
      const uid = url.pathname.slice(prefix.length + 1);
      expect(uid).toMatch(/^\d{1,20}$/);
      expect(init?.method).toBe('GET');
      detailReads++;
      await afterDetail(detailReads);
      return Response.json({
        result: 'success',
        data:
          uid === '123'
            ? raw
            : { ...raw, uid: uid + '@' + f.connection.folderId },
      });
    }
    expect(url.href).toBe(JEV_ENDPOINT);
    expect(init?.method).toBe('POST');
    emissions++;
    return modelResponse();
  });
  const dispatch = f.triage.dispatch;
  f.triage.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (result.mayDispatch) await afterDispatch();
    return result;
  };
  const serviceDependencies: UsSupportTriageServiceDependencies = {
    now: f.now,
    store: async () => f.triage,
    mailbox: (context) => readUsSupportExecutionMailbox(f.database, context),
    policy: vi.fn(async () => f.policy),
    providerReady: vi.fn(async () => true),
    encryptionKey: vi.fn(async () => key),
    message: createUsSupportTriageMessageReader(fetcher),
    classify: createUsSupportTriageClassifier(
      'synthetic-decision-key',
      fetcher,
    ),
    recordTicket: vi.fn(async (context, jobId, check) => {
      await f.tickets.commit(
        context,
        {
          schemaVersion: 1,
          requestId: await completionId(jobId),
          action: 'create',
          jobId,
        },
        check,
      );
    }),
  };
  const service = createUsSupportTriageService(serviceDependencies),
    intake = createUsSupportIntakeProvider(fetcher);
  const dependencies: UsSupportWorkerDependencies = {
    enabled: async () => true,
    now: f.now,
    store: async () => f.worker,
    mailbox: (context) => readUsSupportExecutionMailbox(f.database, context),
    encryptionKey: vi.fn(async () => key),
    discover: (...args) => intake.discover(...args),
    resolveVersion: (...args) => intake.resolveVersion(...args),
    triage: (...args) => service.triage(...args),
    processingPolicyVersion: async () => f.policy.processingPolicyVersion,
    diagnostic: vi.fn(),
  };
  const count = (table: string) =>
    Number(f.sql.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
  return {
    ...f,
    enabled,
    raw,
    date,
    body,
    subject,
    dependencies,
    serviceDependencies,
    service,
    fetcher,
    count,
    reads: () => ({ listReads, detailReads, emissions }),
    statementCount: () => statements,
    statementKinds: () =>
      [...statementKinds]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([text, count]) => ({ text: text.slice(0, 90), count })),
    setThreads: (value: unknown[]) => {
      threads = value;
    },
    afterDetail: (value: typeof afterDetail) => {
      afterDetail = value;
    },
    afterDispatch: (value: typeof afterDispatch) => {
      afterDispatch = value;
    },
    modelResponse: (value: typeof modelResponse) => {
      modelResponse = value;
    },
    next: () => f.setNow(f.now() + 61),
    run: async () => {
      statements = 0;
      statementKinds.clear();
      const result = await createUsSupportWorker(dependencies).tick();
      expect(statements).toBeLessThanOrEqual(800);
      return result;
    },
  };
}

describe('US worker → durable H3a → human-review H3b, actual SQLite and local provider stubs', () => {
  it('measures D1 executions for a saturated five-source intake queue', async () => {
    const f = await fixture();
    f.setThreads([
      {
        date: f.date,
        messages: Array.from({ length: 5 }, (_, i) => ({
          uid: String(123 + i) + '@' + f.connection.folderId,
          date: f.date,
        })),
      },
    ]);
    const result = await f.run();
    console.info('US worker saturated queue', {
      ticketed: result.ticketed,
      statements: f.statementCount(),
      top: f.statementKinds(),
    });
    expect(result.ticketed).toBe(1);
    expect(f.count('international_us_support_worker_discovered')).toBe(5);
    expect((await f.worker.read(f.context())).pending).toBe(4);
  }, 60_000);
  it.each(['en', 'fr'] as const)(
    'classifies %s once, creates an audited auto-assigned ticket and reconciles without duplication',
    async (language) => {
      const f = await fixture(language),
        membershipId = String(
          f.sql
            .prepare(
              'SELECT membership_id FROM international_workspace_members WHERE organization_id=? AND user_id=?',
            )
            .get(f.intent.organizationId, f.actor)!.membership_id,
        );
      await f.tickets.saveRouting(
        f.context(),
        f.routingRequest({
          enabled: true,
          routes: [{ category: 'product', membershipId }],
        }),
        async () => f.context(),
      );
      expect(await f.run()).toEqual({
        acquired: 1,
        ticketed: 1,
        outcomes: ['completed'],
      });
      console.info('US worker one-source D1 executions', f.statementCount());
      expect(f.reads()).toEqual({ listReads: 1, detailReads: 2, emissions: 1 });
      const projection = await f.tickets.read(f.context());
      expect(projection.tickets).toHaveLength(1);
      expect(projection.tickets[0]).toMatchObject({
        category: 'product',
        language,
        needsReview: false,
        assigneeMembershipId: membershipId,
        assigneeActive: true,
        audit: {
          total: 1,
          events: [
            {
              actorKind: 'worker',
              delegationId: f.enabled.projection.delegation!.id,
            },
          ],
        },
      });
      expect(JSON.stringify(projection)).not.toContain(f.body);
      expect(JSON.stringify(projection)).not.toContain(f.subject);
      f.next();
      expect(await f.run()).toEqual({
        acquired: 1,
        ticketed: 0,
        outcomes: ['idle'],
      });
      console.info(
        'US worker reconciled-source D1 executions',
        f.statementCount(),
      );
      expect(f.reads()).toEqual({ listReads: 2, detailReads: 2, emissions: 1 });
      expect(f.count('international_us_support_triage_jobs')).toBe(1);
      expect(f.count('international_us_support_triage_dispatches')).toBe(1);
      expect(f.count('international_us_support_tickets')).toBe(1);
      expect((await f.triage.usage(f.context(), f.grant())).used).toBe(1);
      expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(
        f.legacyBefore,
      );
    },
  );
  it('resolves a missing version privately before two corroborating observations and quota', async () => {
    const f = await fixture();
    f.setThreads([{ date: f.date, messages: [{ uid: f.raw.uid }] }]);
    expect((await f.run()).ticketed).toBe(1);
    expect(f.reads()).toEqual({ listReads: 1, detailReads: 3, emissions: 1 });
    const prepared = JSON.parse(
      String(
        f.sql
          .prepare(
            "SELECT request_json FROM international_us_support_worker_stages WHERE stage='prepared'",
          )
          .get()!.request_json,
      ),
    );
    expect(prepared).toMatchObject({
      expectedMessageVersion: String(f.date),
      consent: true,
    });
  });
  it('keeps head refresh, backfill, private version resolution and required review inside the paid D1 budget', async () => {
    const f = await fixture(),
      run = await f.acquire();
    await f.worker.discover(
      run.context,
      { offset: 0, nextOffset: 20, references: [], issues: [] },
      run.current,
    );
    await f.worker.finish(run.context, { outcome: 'idle', nextDueAt: f.now() });
    f.setThreads([{ date: f.date, messages: [{ uid: f.raw.uid }] }]);
    f.raw.body = '';
    f.raw.preview = 'A bounded preview of the customer message';
    f.raw.attachments = [{ part_id: 1, name: 'unread.pdf' }];
    expect(await f.run()).toMatchObject({
      ticketed: 1,
      outcomes: ['completed'],
    });
    console.info(
      'US worker head/backfill/resolve/review D1 executions',
      f.statementCount(),
    );
    expect(f.reads()).toEqual({ listReads: 2, detailReads: 3, emissions: 1 });
    expect((await f.tickets.read(f.context())).tickets[0]).toMatchObject({
      needsReview: true,
      reviewReasons: ['unread_attachments', 'incomplete_body'],
      assigneeMembershipId: null,
    });
  });
  it('rejects older sources without historical import, quota or inference', async () => {
    const f = await fixture();
    f.setThreads([
      {
        date: f.date - 100,
        messages: [{ uid: f.raw.uid, date: f.date - 100 }],
      },
    ]);
    f.raw.date = f.date - 100;
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['partial'] });
    expect(f.reads()).toEqual({ listReads: 1, detailReads: 0, emissions: 0 });
    expect(await f.worker.read(f.context())).toMatchObject({
      rejected: 1,
      pending: 0,
    });
    expect(f.count('international_us_support_triage_jobs')).toBe(0);
    expect(
      f.sql
        .prepare(
          "SELECT code FROM international_us_support_worker_stages WHERE stage='rejected'",
        )
        .get()!.code,
    ).toBe('before_consent_date');
  });
  it('durably exposes a malformed reference and still classifies its healthy neighbour', async () => {
    const f = await fixture();
    f.setThreads([
      {
        date: f.date,
        messages: [
          {
            uid: 'private-invalid-uid',
            body: 'Do not persist this poison body',
          },
          { uid: f.raw.uid, date: f.date },
        ],
      },
    ]);
    expect((await f.run()).ticketed).toBe(1);
    expect(await f.worker.read(f.context())).toMatchObject({
      issues: 1,
      discovered: 1,
      pending: 0,
    });
    expect(
      JSON.stringify(
        f.sql
          .prepare('SELECT * FROM international_us_support_worker_issues')
          .all(),
      ),
    ).not.toMatch(/private-invalid-uid|poison body/);
  });
  it('rejects a changed body between source observations before any quota or model effect', async () => {
    const f = await fixture();
    f.afterDetail(async (count) => {
      if (count === 2) f.raw.body = 'Changed private content';
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['partial'] });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_jobs')).toBe(0);
    expect(await f.worker.read(f.context())).toMatchObject({
      rejected: 1,
      pending: 0,
    });
  });
  it('retains an ambiguous provider dispatch and never emits again under the next lease', async () => {
    const f = await fixture();
    f.modelResponse(
      async () =>
        new Response('Synthetic ambiguous upstream response', { status: 502 }),
    );
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['failed'] });
    expect(f.reads().emissions).toBe(1);
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    expect(f.count('international_us_support_triage_completions')).toBe(0);
    f.next();
    f.serviceDependencies.providerReady = vi.fn(async () => {
      throw Error('Must replay before provider config');
    });
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['uncertain'],
    });
    expect(f.reads().emissions).toBe(1);
    expect(f.serviceDependencies.providerReady).not.toHaveBeenCalled();
    expect(await f.worker.read(f.context())).toMatchObject({
      uncertain: 1,
      pending: 0,
    });
    expect(f.count('international_us_support_tickets')).toBe(0);
  });
  it('recovers a ticket acknowledgement lost after durable completion without a key or second inference', async () => {
    const f = await fixture(),
      sink = f.serviceDependencies.recordTicket!;
    let lose = true;
    f.serviceDependencies.recordTicket = vi.fn<
      NonNullable<UsSupportTriageServiceDependencies['recordTicket']>
    >(async (...args) => {
      await sink(...args);
      if (lose) throw Error('Lost ticket acknowledgement');
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['failed'] });
    expect(f.count('international_us_support_triage_completions')).toBe(1);
    expect(f.count('international_us_support_tickets')).toBe(1);
    const request = f.sql
      .prepare(
        "SELECT request_json FROM international_us_support_worker_stages WHERE stage='prepared'",
      )
      .get()!.request_json;
    lose = false;
    f.next();
    f.dependencies.encryptionKey = vi.fn(async () => {
      throw Error('Unavailable mailbox key');
    });
    f.serviceDependencies.encryptionKey = vi.fn(async () => {
      throw Error('No replay key');
    });
    expect(await f.run()).toMatchObject({ ticketed: 1, outcomes: ['partial'] });
    console.info(
      'US worker durable-completion recovery without key D1 executions',
      f.statementCount(),
    );
    expect(f.reads().emissions).toBe(1);
    expect(f.serviceDependencies.encryptionKey).not.toHaveBeenCalled();
    expect(
      f.sql
        .prepare(
          "SELECT request_json FROM international_us_support_worker_stages WHERE stage='prepared'",
        )
        .get()!.request_json,
    ).toBe(request);
    expect(f.count('international_us_support_tickets')).toBe(1);
    expect(f.count('international_us_support_ticket_revisions')).toBe(1);
    expect((await f.worker.read(f.context())).pending).toBe(0);
  });
  it('cannot emit after explicit revocation at the durable dispatch boundary', async () => {
    const f = await fixture();
    f.afterDispatch(async () => {
      await f.worker.manage(
        f.context(),
        {
          schemaVersion: 1,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'revoke',
        },
        async () => f.context(),
      );
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_completions')).toBe(0);
    expect(f.count('international_us_support_tickets')).toBe(0);
    expect((await f.worker.read(f.context())).status).toBe('revoked');
  });
  it('cannot emit after a mailbox disconnect at the durable dispatch boundary', async () => {
    const f = await fixture();
    f.afterDispatch(async () => {
      await f.mailbox.commit(
        f.context(),
        {
          schemaVersion: 1,
          requestId: randomUUID(),
          expectedRevision: 2,
          action: 'disconnect',
        },
        async () => f.context(),
      );
    });
    expect((await f.run()).ticketed).toBe(0);
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    expect(f.count('international_us_support_tickets')).toBe(0);
    expect((await f.worker.read(f.context())).status).toBe(
      'connection_changed',
    );
  });
  it('cannot emit after the actual admin delegation membership is revoked during dispatch', async () => {
    const f = await fixture(),
      admin = await adminMembership(f);
    await f.worker.manage(
      f.context(),
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'revoke',
      },
      async () => f.context(),
    );
    await f.worker.manage(
      f.context(admin.userId),
      f.manageRequest({
        expectedRevision: 2,
        connectionId: (await f.mailbox.read(f.context())).currentConnection!.id,
        expectedMailboxRevision: 2,
      }),
      async () => f.context(admin.userId),
    );
    f.afterDispatch(() => admin.revoke());
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    expect(f.count('international_us_support_tickets')).toBe(0);
    expect((await f.worker.read(f.context())).status).toBe('revoked');
  });
  it('replays a fenced dispatch after lease expiry and a verified paid-period renewal without inference', async () => {
    const f = await fixture();
    f.afterDispatch(async () => {
      f.setNow(f.date + 120);
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['revoked'] });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    await f.store.apply(f.binding, f.paid(), async () => {});
    f.serviceDependencies.providerReady = vi.fn(async () => {
      throw Error('No new model admission');
    });
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['uncertain'],
    });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_dispatches')).toBe(1);
    expect(f.serviceDependencies.providerReady).not.toHaveBeenCalled();
  });
  it('adopts the same completed human source from another admin without another quota or inference', async () => {
    const f = await fixture(),
      admin = await adminMembership(f),
      connection = (await f.mailbox.read(f.context())).currentConnection!;
    const q = f.request({
      connectionId: connection.id,
      expectedMailboxRevision: 2,
      expectedMessageVersion: String(f.date),
    });
    const message = await f.serviceDependencies.message(
      connection,
      'synthetic-composition-worker-token',
      q,
      async () => f.context(),
    );
    const claimed = await f.triage.claim(
      f.context(),
      { request: q, source: message.source, grant: f.grant() },
      async () => f.context(),
    );
    const reference = {
      requestId: q.requestId,
      requestHash: claimed.requestHash,
      dispatchId: randomUUID(),
    };
    await f.triage.dispatch(f.context(), reference, async () => f.context());
    await f.triage.complete(
      f.context(),
      { ...reference, decision: f.decision({ category: 'product' }) },
      async () => f.context(),
    );
    await f.worker.manage(
      f.context(),
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'revoke',
      },
      async () => f.context(),
    );
    await f.worker.manage(
      f.context(admin.userId),
      f.manageRequest({
        expectedRevision: 2,
        connectionId: connection.id,
        expectedMailboxRevision: 2,
      }),
      async () => f.context(admin.userId),
    );
    expect(await f.run()).toMatchObject({
      ticketed: 1,
      outcomes: ['completed'],
    });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_jobs')).toBe(1);
    expect(f.count('international_us_support_triage_requests')).toBe(2);
    expect((await f.triage.usage(f.context(), f.grant())).used).toBe(1);
    expect((await f.tickets.read(f.context())).tickets[0]).toMatchObject({
      originJobId: claimed.job.id,
      audit: { events: [{ actorKind: 'worker', actorUserId: admin.userId }] },
    });
  });
  it('uses the existing shared monthly quota rather than a worker allowance', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++)
      await f.completeJob({
        request: {
          connectionId: (await f.mailbox.read(f.context())).currentConnection!
            .id,
          expectedMailboxRevision: 2,
          uid: String(500 + i),
        },
        source: { uid: String(500 + i) },
      });
    expect(await f.run()).toMatchObject({
      ticketed: 0,
      outcomes: ['budget_blocked'],
    });
    expect(f.reads().emissions).toBe(0);
    expect(f.count('international_us_support_triage_jobs')).toBe(10);
    expect((await f.worker.read(f.context())).pending).toBe(1);
    expect(f.count('international_us_support_tickets')).toBe(0);
    expect((await f.triage.usage(f.context(), f.grant())).used).toBe(10);
  });
  it('preserves a transient pre-dispatch request exactly and completes it on the next lease', async () => {
    const f = await fixture(),
      reader = f.serviceDependencies.message;
    let unavailable = true;
    f.serviceDependencies.message = vi.fn<
      UsSupportTriageServiceDependencies['message']
    >(async (...args) => {
      if (unavailable) throw Error('Temporary source unavailable');
      return reader(...args);
    });
    expect(await f.run()).toMatchObject({ ticketed: 0, outcomes: ['failed'] });
    const prepared = f.sql
      .prepare(
        "SELECT request_json FROM international_us_support_worker_stages WHERE stage='prepared'",
      )
      .get()!.request_json;
    expect(f.count('international_us_support_triage_jobs')).toBe(0);
    unavailable = false;
    f.next();
    expect((await f.run()).ticketed).toBe(1);
    expect(f.reads().emissions).toBe(1);
    expect(
      f.sql
        .prepare(
          "SELECT request_json FROM international_us_support_worker_stages WHERE stage='prepared'",
        )
        .get()!.request_json,
    ).toBe(prepared);
    expect(f.count('international_us_support_tickets')).toBe(1);
  });
  it.each([true, false])(
    'rejects an old A connection receipt after explicit B consent, retaining its reservation=%s and processing healthy B next',
    async (reserved) => {
      const f = await fixture(),
        run = await f.acquire(),
        before = await f.mailbox.read(f.context()),
        connectionA = before.currentConnection!;
      await f.worker.discover(
        run.context,
        {
          offset: 0,
          nextOffset: null,
          references: [
            {
              uid: '123',
              version: reserved ? String(f.date) : null,
              receivedAt: reserved ? f.date : null,
            },
          ],
          issues: [],
        },
        run.current,
      );
      const reference = (await f.worker.pending(run.context))[0];
      let originalJobId: string | null = null;
      if (reserved) {
        const request = f.request({
          requestId: reference.requestId,
          connectionId: connectionA.id,
          expectedMailboxRevision: 2,
          expectedMessageVersion: String(f.date),
        });
        await f.worker.prepare(
          run.context,
          { discoveryId: reference.id, request },
          run.current,
        );
        const message = await f.serviceDependencies.message(
          connectionA,
          'synthetic-composition-worker-token',
          request,
          run.current,
        );
        originalJobId = (
          await f.triage.claim(
            run.context,
            {
              request,
              source: message.source,
              grant: createUsSupportTriageGrant(run.context, f.policy),
            },
            run.current,
          )
        ).job.id;
      }
      await f.worker.finish(run.context, {
        outcome: 'failed',
        nextDueAt: f.now() + 60,
      });
      const connectionBId = randomUUID(),
        token = 'synthetic-composition-worker-token',
        key = btoa('i'.repeat(32));
      await f.mailbox.commit(
        f.context(),
        {
          ...f.connection,
          requestId: randomUUID(),
          expectedRevision: 2,
          connectionId: connectionBId,
          tokenSha256: await sha256Hex(token),
          credentialsCiphertext: await encryptSecret(
            key,
            token,
            usMailboxEncryptionContext(f.context(), connectionBId, 3),
          ),
          verifiedAt: f.now(),
        },
        async () => f.context(),
      );
      await f.worker.manage(
        f.context(),
        f.manageRequest({
          expectedRevision: 1,
          connectionId: connectionBId,
          expectedMailboxRevision: 3,
        }),
        async () => f.context(),
      );
      f.setThreads([
        {
          date: f.date,
          messages: [{ uid: '124@' + f.connection.folderId, date: f.date }],
        },
      ]);
      const readsBefore = f.reads();
      expect(await f.run()).toMatchObject({
        ticketed: 0,
        outcomes: ['partial'],
      });
      expect(f.reads().detailReads).toBe(readsBefore.detailReads);
      expect(f.reads().emissions).toBe(0);
      expect(
        f.sql
          .prepare(
            "SELECT stage,code FROM international_us_support_worker_stages WHERE discovery_id=? AND stage='rejected'",
          )
          .get(reference.id),
      ).toEqual({ stage: 'rejected', code: 'connection_replaced' });
      expect(await f.worker.read(f.context())).toMatchObject({
        rejected: 1,
        pending: 1,
      });
      expect(f.count('international_us_support_triage_jobs')).toBe(
        reserved ? 1 : 0,
      );
      if (originalJobId)
        expect(
          f.sql
            .prepare(
              'SELECT id FROM international_us_support_triage_jobs WHERE id=?',
            )
            .get(originalJobId),
        ).toEqual({ id: originalJobId });
      f.next();
      expect(await f.run()).toMatchObject({
        ticketed: 1,
        outcomes: ['completed'],
      });
      expect(f.reads().emissions).toBe(1);
      expect((await f.triage.usage(f.context(), f.grant())).used).toBe(
        reserved ? 2 : 1,
      );
      expect(f.count('international_us_support_triage_dispatches')).toBe(1);
      expect((await f.tickets.read(f.context())).tickets[0].uid).toBe('124');
    },
  );
});
