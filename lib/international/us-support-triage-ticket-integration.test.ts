import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../support/crypto';
import { sha256Hex } from './canonical-hash';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { usMailboxEncryptionContext } from './us-support-mailbox-contract';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { createUsSupportTriageHandlers, type UsSupportTriageDependencies } from './us-support-triage-server';
import { usSupportTicketCompletionRequestId } from './us-support-ticket-bindings';
import { supportTicketFixture } from './us-support-ticket-test-fixture';

type Fixture = Awaited<ReturnType<typeof supportTicketFixture>>;
const opened: Fixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });

/** Actual encrypted mailbox, H3a completion/fence and H3b receipt in local
 * SQLite. Only Auth and classification observations are synthetic. */
async function fixture() {
  const f = await supportTicketFixture(); opened.push(f);
  const key = btoa('i'.repeat(32)), token = 'synthetic-private-mail-token', connectionId = randomUUID();
  const credentialsCiphertext = await encryptSecret(key, token, usMailboxEncryptionContext(f.context(), connectionId, 2));
  await f.mailbox.commit(f.context(), { ...f.connection, requestId: randomUUID(), expectedRevision: 1, connectionId, credentialsCiphertext, tokenSha256: await sha256Hex(token), verifiedAt: f.now() }, async () => f.context());
  const input = f.request({ connectionId, expectedMailboxRevision: 2 });
  const d: UsSupportTriageDependencies = { enabled: async () => true, now: f.now, member: async () => f.context(), store: async () => f.triage,
    mailboxStore: async () => f.mailbox, policy: async () => f.policy, providerReady: vi.fn(async () => true), encryptionKey: vi.fn(async () => key),
    message: vi.fn(async (_connection, supplied, _request, check) => { await check(); expect(supplied).toBe(token); return { source: f.source(), subject: 'Synthetic private subject', body: 'Synthetic private message' }; }),
    classify: vi.fn(async (_message, _grant, check) => { await check(); return f.decision(); }), diagnostic: vi.fn(),
    recordTicket: vi.fn(async (context, jobId, check) => { await f.tickets.commit(context, { schemaVersion: 1, requestId: await usSupportTicketCompletionRequestId(jobId), action: 'create', jobId }, check); }),
  };
  const handlers = createUsSupportTriageHandlers(d), org = f.intent.organizationId;
  const run = () => handlers.triage(new Request(`https://zentra.test/api/international/workspaces/${org}/support-mailbox/triage`, { method: 'POST', headers: {
    Origin: 'https://zentra.test', 'Content-Type': 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': f.actor,
  }, body: JSON.stringify(input) }), org);
  const counts = () => ({ jobs: f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_jobs').get()!.n,
    dispatches: f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_dispatches').get()!.n,
    completions: f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_completions').get()!.n,
    tickets: f.sql.prepare('SELECT count(*) AS n FROM international_us_support_tickets').get()!.n });
  return { f, d, run, counts };
}

describe('H3a completed result → optional H3b durable ticket integration, no network', () => {
  it('records one ticket after completion and exact replay needs no mailbox, provider key or model', async () => {
    const t = await fixture(), first = await t.run(); expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json() as Record<string, unknown>; expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: 1 });
    await t.f.mailbox.commit(t.f.context(), { schemaVersion: 1, requestId: randomUUID(), action: 'disconnect', expectedRevision: 2 }, async () => t.f.context());
    t.d.policy = async () => { throw new Error('do not load current classification policy'); }; t.d.providerReady = async () => { throw new Error('do not resolve provider'); }; t.d.encryptionKey = async () => { throw new Error('do not decrypt disconnected mailbox'); };
    const retry = await t.run(); expect(retry.status, await retry.clone().text()).toBe(200); expect(await retry.json()).toEqual({ ...result, replayed: true });
    expect(t.d.classify).toHaveBeenCalledOnce(); expect(t.d.message).toHaveBeenCalledOnce(); expect(t.d.recordTicket).toHaveBeenCalledTimes(2);
    expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: 1 }); expect((await t.f.tickets.read(t.f.context())).tickets[0].audit.total).toBe(1);
  });
  it.each(['before', 'after'] as const)('sink failure %s its write preserves H3a completion and exact retry finishes one ticket', async moment => {
    const t = await fixture(), record = t.d.recordTicket!; let lost = true;
    t.d.recordTicket = vi.fn(async (...args: Parameters<NonNullable<UsSupportTriageDependencies['recordTicket']>>) => { if (!lost) return record(...args); lost = false; if (moment === 'after') await record(...args); throw new Error('private sink confirmation failure'); });
    const failed = await t.run(); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: 'service_unavailable' });
    expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: moment === 'after' ? 1 : 0 });
    const retry = await t.run(); expect(retry.status, await retry.clone().text()).toBe(200); expect(await retry.json()).toMatchObject({ state: 'completed', replayed: true });
    expect(t.d.classify).toHaveBeenCalledOnce(); expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: 1 });
    expect((await t.f.tickets.read(t.f.context())).tickets[0].audit.total).toBe(1); expect(JSON.stringify((t.d.diagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private sink');
  });
  it('a delayed Auth loss after the ticket sink suppresses the classification response', async () => {
    const t = await fixture(), record = t.d.recordTicket!;
    t.d.recordTicket = async (...args) => { await record(...args); t.d.member = async () => { throw new UsSupportWorkspaceError('forbidden', 403); }; };
    const result = await t.run(); expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: 'forbidden' });
    expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: 1 }); expect(t.d.classify).toHaveBeenCalledOnce();
  });
  it('leaves the optional sink unused when classification I/O is uncertain', async () => {
    const t = await fixture(); t.d.classify = vi.fn(async () => { throw new Error('synthetic lost model response'); });
    expect((await t.run()).status).toBe(503); const retry = await t.run(); expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ state: 'uncertain', result: null });
    expect(t.d.recordTicket).not.toHaveBeenCalled(); expect(t.d.classify).toHaveBeenCalledOnce(); expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 0, tickets: 0 });
  });
  it('keeps H3a standalone when no ticket sink is configured', async () => {
    const t = await fixture(); delete t.d.recordTicket; expect((await t.run()).status).toBe(200); expect(t.counts()).toEqual({ jobs: 1, dispatches: 1, completions: 1, tickets: 0 });
  });
});
