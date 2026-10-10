import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_ENDPOINT } from '../automation/transport';
import { encryptSecret } from '../support/crypto';
import { triageQuestions } from '../support/jev';
import { CATEGORIES, LANGUAGES, PRIORITIES } from '../support/types';
import { sha256Hex } from './canonical-hash';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { usMailboxEncryptionContext } from './us-support-mailbox-contract';
import { US_SUPPORT_TRIAGE_MODEL, UsSupportTriageError, type UsSupportTriageRequest, type UsSupportTriageStore } from './us-support-triage-contract';
import { createUsSupportTriageClassifier, createUsSupportTriageMessageReader } from './us-support-triage-provider';
import { createUsSupportTriageHandlers, type UsSupportTriageDependencies } from './us-support-triage-server';
import { supportTriageFixture } from './us-support-triage-test-fixture';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';

type Fixture = Awaited<ReturnType<typeof supportTriageFixture>>;
const opened: Fixture[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) {
    expect(fixture.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    fixture.sql.close();
  }
});
const urlOf = (input: RequestInfo | URL) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function choice(options: object, selected: string) {
  return { type: 'choice', choice: selected, confidence: 0.97,
    probabilities: Object.fromEntries(Object.keys(options).map(key => [key, key === selected ? 0.98 : 0.02 / (Object.keys(options).length - 1)])) };
}
function typedResponse(language: 'en' | 'fr') {
  return { model: US_SUPPORT_TRIAGE_MODEL, answers: {
    category: choice(CATEGORIES, 'product'), priority: choice(PRIORITIES, 'normal'), language: choice(LANGUAGES, language),
    frustration: { type: 'score', score: 0, confidence: 1, probabilities: { '0': 1, '1': 0, '2': 0 },
      legend: Object.fromEntries(triageQuestions('', '').questions.frustration.criteria.map((value, index) => [String(index), value])) },
    human_requested: { type: 'noul', noul: 0 },
  }, usage: { input_tokens: 123, output_tokens: 45 } };
}
async function adminMembership(f: Fixture) {
  const a = f.context().authority, userId = randomUUID(), email = userId + '@example.test';
  const owner: UsTeamContext = { schemaVersion: 1, organizationId: a.organizationId, mode: 'member', role: a.role,
    user: { userId: a.userId, email: null, emailConfirmed: false }, subscriptionId: a.subscriptionId, environment: a.environment,
    catalogVersion: a.catalogVersion, priceId: a.priceId, seatLimit: a.seatLimit, checkedAt: a.checkedAt,
    validStartsAt: a.validStartsAt, validEndsAt: a.validEndsAt, credential: a.credential };
  const store = d1UsTeamStore(f.database, { now: f.now }), invitationId = randomUUID(), membershipId = randomUUID(), tokenHash = await hashUsTeamToken(newUsTeamToken());
  const invite: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner),
    action: 'create_invitation', email, role: 'admin', invitationId, tokenHash, expiresAt: f.now() + 604800 };
  await store.commit({ context: owner, command: invite, requestHash: await hashUsTeamCommand(a.organizationId, f.actor, invite) });
  const recipient: UsTeamContext = { ...owner, mode: 'recipient', role: 'admin', user: { userId, email, emailConfirmed: true } };
  const accept: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner),
    action: 'accept_invitation', invitationId, tokenHash, membershipId, firstName: 'Synthetic', lastName: 'Admin', displayName: 'Synthetic Admin' };
  await store.commit({ context: recipient, command: accept, requestHash: await hashUsTeamCommand(a.organizationId, userId, accept) });
  return { userId, async revoke() {
    const command: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'revoke_member', membershipId };
    await store.commit({ context: owner, command, requestHash: await hashUsTeamCommand(a.organizationId, f.actor, command) });
  } };
}

/** The handlers, AES-GCM, complete SQLite migration chain and both adapters
 * are real. Only Auth identity and fixed-origin provider HTTP are synthetic. */
async function fixture(language: 'en' | 'fr' = 'en', asAdmin = false) {
  const f = await supportTriageFixture(); opened.push(f);
  const org = f.intent.organizationId, key = btoa('c'.repeat(32)), token = 'private-composition-mail-token', connectionId = randomUUID();
  const credentialsCiphertext = await encryptSecret(key, token, usMailboxEncryptionContext(f.context(), connectionId, 2));
  await f.mailbox.commit(f.context(), { ...f.connection, requestId: randomUUID(), expectedRevision: 1, connectionId,
    tokenSha256: await sha256Hex(token), credentialsCiphertext, verifiedAt: f.now() }, async () => f.context());
  const head = await f.mailbox.read(f.context());
  expect(head).toMatchObject({ revision: 2, currentConnection: { id: connectionId, tokenSha256: await sha256Hex(token), credentialsCiphertext } });
  const admin = asAdmin ? await adminMembership(f) : null, actor = admin?.userId ?? f.actor;
  const subject = language === 'en' ? 'Synthetic product question' : 'Question produit fictive';
  const body = language === 'en' ? 'Does this product support English and French?' : 'Ce produit fonctionne-t-il en français et en anglais ?';
  const raw: Record<string, unknown> = { uid: '123@' + f.connection.folderId, date: 1700000000, subject, body,
    from: [{ name: 'Synthetic sender', email: 'sender@example.test' }], attachments: [] };
  let mailReads = 0, modelEmissions = 0;
  let afterMailRead = async (_count: number) => {};
  let afterDispatch = async () => {};
  let modelOutcome = async (): Promise<Response> => Response.json(typedResponse(language));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input);
    if (new URL(url).origin === 'https://mail.infomaniak.com') {
      expect(url).toBe(`https://mail.infomaniak.com/api/mail/${f.connection.mailboxId}/folder/${f.connection.folderId}/message/123?prefered_format=html&with=auto_uncrypt,thread_context`);
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + token);
      mailReads++; await afterMailRead(mailReads);
      return Response.json({ result: 'success', data: raw });
    }
    expect(url).toBe(JEV_ENDPOINT); expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-model-key');
    if (typeof init?.body !== 'string') throw new Error('Expected the serialized shared recipe');
    const observedBody = typeof raw.body === 'string' && raw.body ? raw.body : raw.preview;
    if (typeof observedBody !== 'string') throw new Error('Expected the synthetic body or preview');
    expect(JSON.parse(init.body)).toEqual(triageQuestions(subject, observedBody));
    modelEmissions++; return modelOutcome();
  });
  const store: UsSupportTriageStore = { ...f.triage, async dispatch(context, input, revalidate) {
    const result = await f.triage.dispatch(context, input, revalidate); await afterDispatch(); return result;
  } };
  const d: UsSupportTriageDependencies = {
    enabled: async () => true, now: f.now,
    async member(_request, organizationId) {
      const member = f.sql.prepare('SELECT role FROM international_workspace_members WHERE organization_id=? AND user_id=? AND revoked_at IS NULL').get(organizationId, actor);
      if (organizationId !== org || !member) throw new UsSupportTriageError('forbidden', 403);
      return f.context(actor);
    },
    store: async () => store, mailboxStore: async () => f.mailbox, policy: async () => f.policy,
    providerReady: vi.fn(async () => true), encryptionKey: vi.fn(async () => key),
    message: createUsSupportTriageMessageReader(fetcher), classify: createUsSupportTriageClassifier('synthetic-model-key', fetcher), diagnostic: vi.fn(),
  };
  const handlers = createUsSupportTriageHandlers(d);
  const command = (patch: Partial<UsSupportTriageRequest> = {}) => f.request({ connectionId, expectedMailboxRevision: 2, ...patch });
  const request = (input: UsSupportTriageRequest) => new Request(`https://zentraapp.ch/api/international/workspaces/${org}/support-mailbox/triage`, {
    method: 'POST', headers: { Origin: 'https://zentraapp.ch', 'Content-Type': 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': actor }, body: JSON.stringify(input),
  });
  const run = (input: UsSupportTriageRequest) => handlers.triage(request(input), org);
  const count = (suffix: 'jobs' | 'requests' | 'dispatches' | 'completions' | 'uncertain') => Number(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_' + suffix).get()!.n);
  const disconnect = () => f.mailbox.commit(f.context(), { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 2, action: 'disconnect' }, async () => f.context());
  const revokeMembership = async () => { if (!admin) throw new Error('Use an invited admin to exercise real membership revocation'); await admin.revoke(); };
  return { f, d, org, raw, run, command, count, disconnect, revokeMembership, calls: () => ({ mailReads, modelEmissions }),
    afterMailRead: (hook: typeof afterMailRead) => { afterMailRead = hook; }, afterDispatch: (hook: typeof afterDispatch) => { afterDispatch = hook; },
    modelOutcome: (hook: typeof modelOutcome) => { modelOutcome = hook; } };
}

describe('US Support triage HTTP + real SQLite + actual message/classifier composition', () => {
  it.each(['en', 'fr'] as const)('classifies %s once, persists a closed result and exactly replays after disconnect', async language => {
    const t = await fixture(language), input = t.command();
    const first = await t.run(input); expect(first.status).toBe(200); expect(first.headers.get('Cache-Control')).toContain('no-store');
    const result = await first.json() as Record<string, unknown>; expect(result).toMatchObject({ organizationId: t.org, userId: t.f.actor, state: 'completed', replayed: false, result: { category: 'product', priority: 'normal', language, needsReview: false } });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 }); expect(t.count('jobs')).toBe(1); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(1);
    await t.disconnect(); t.d.policy = async () => { throw new Error('Historical replay must not need the current policy'); };
    t.d.providerReady = async () => { throw new Error('Historical replay must not resolve the model key'); };
    t.d.encryptionKey = async () => { throw new Error('Historical replay must not decrypt a mailbox credential'); };
    const replay = await t.run(input); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ...result, replayed: true });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 });
    const retained = JSON.stringify(t.f.sql.prepare('SELECT * FROM international_us_support_triage_jobs').all());
    for (const privateValue of [t.raw.subject, t.raw.body, 'sender@example.test', 'private-composition-mail-token', 'synthetic-model-key']) if (typeof privateValue === 'string') expect(retained).not.toContain(privateValue);
    expect(t.f.snapshot()).toEqual(t.f.before); expect(t.f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(t.f.legacyBefore);
  });
  it('preserves preview/attachment review flags through the actual adapters and SQL completion', async () => {
    const t = await fixture('fr'); t.raw.preview = t.raw.body; t.raw.body = ''; t.raw.attachments = [{ name: 'unread.pdf', size: 100, resource: 'https://foreign.example/never-follow' }];
    const result = await t.run(t.command()); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ state: 'completed', result: { language: 'fr', needsReview: true, reviewReasons: ['unread_attachments', 'incomplete_body'] } });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 }); expect(t.count('completions')).toBe(1);
  });
  it('refuses content drift between the two real reader observations before reserving or emitting', async () => {
    const t = await fixture(); t.afterMailRead(async count => { if (count === 2) t.raw.body = 'Changed during the observation'; });
    const result = await t.run(t.command()); expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: 'triage_source_conflict' });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 0 }); expect(t.count('jobs')).toBe(0); expect(t.count('dispatches')).toBe(0);
  });
  it('corroborates an immutable persisted source when a later command observes changed body bytes', async () => {
    const t = await fixture(); expect((await t.run(t.command())).status).toBe(200); t.raw.body = 'Changed after the first classification';
    const changed = await t.run(t.command()); expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: 'triage_source_conflict' });
    expect(t.calls()).toEqual({ mailReads: 4, modelEmissions: 1 }); expect(t.count('jobs')).toBe(1); expect(t.count('requests')).toBe(1); expect(t.count('dispatches')).toBe(1);
  });
  it('consumes ambiguous model I/O once and returns durable uncertainty on exact retry', async () => {
    const t = await fixture(), input = t.command(); t.modelOutcome(async () => { throw new Error('Synthetic lost model response containing private data'); });
    const failed = await t.run(input); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: 'triage_provider_unavailable' });
    const replay = await t.run(input); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true, state: 'uncertain', result: null });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 }); expect(t.count('jobs')).toBe(1); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(0);
    expect(await t.f.triage.usage(t.f.context(), t.f.grant())).toEqual({ limit: 10, used: 1, remaining: 9 });
    expect(JSON.stringify((t.d.diagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private data');
  });
  it('checks fresh membership after the real durable dispatch and prevents an emission', async () => {
    const t = await fixture('en', true), input = t.command(); t.afterDispatch(async () => { await t.revokeMembership(); });
    const result = await t.run(input); expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: 'forbidden' });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 0 }); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(0);
    expect((await t.run(input)).status).toBe(403); expect(t.calls().modelEmissions).toBe(0);
  });
  it('checks the actual mailbox head between durable dispatch and provider transport', async () => {
    const t = await fixture(), input = t.command(); t.afterDispatch(async () => { await t.disconnect(); });
    const result = await t.run(input); expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: 'mailbox_revision_conflict' });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 0 }); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(0);
    const replay = await t.run(input); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ state: 'uncertain', replayed: true }); expect(t.calls().modelEmissions).toBe(0);
  });
  it('suppresses the actual provider result if mailbox consent is revoked while its HTTP response is in flight', async () => {
    const t = await fixture(), input = t.command(); t.modelOutcome(async () => { await t.disconnect(); return Response.json(typedResponse('en')); });
    const result = await t.run(input); expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: 'mailbox_revision_conflict' });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 }); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(0);
    const replay = await t.run(input); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ state: 'uncertain', result: null, replayed: true }); expect(t.calls().modelEmissions).toBe(1);
  });
  it('lets fresh membership loss outrank an ambiguous model response and prevents SQL completion', async () => {
    const t = await fixture('en', true), input = t.command(); t.modelOutcome(async () => { await t.revokeMembership(); throw new Error('Private ambiguous model response'); });
    const result = await t.run(input); expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: 'forbidden' });
    expect(t.calls()).toEqual({ mailReads: 2, modelEmissions: 1 }); expect(t.count('dispatches')).toBe(1); expect(t.count('completions')).toBe(0);
  });
});
