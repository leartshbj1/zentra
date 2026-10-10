import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordUsSupportTicketCompletion, usSupportTicketCompletionRequestId, usSupportTicketHandlers, usSupportTicketsEnabled } from './us-support-ticket-bindings';
import type { UsMailboxContext } from './us-support-mailbox-contract';
import { US_SUPPORT_WORKER_ID, type UsSupportWorkerContext } from './us-support-execution-contract';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
const context: UsMailboxContext = { schemaVersion: 1, workspaceId: '22222222-2222-4222-8222-222222222222', authority: {
  schemaVersion: 1, organizationId: '11111111-1111-4111-8111-111111111111', userId: '33333333-3333-4333-8333-333333333333',
  role: 'owner', ownerUserId: '33333333-3333-4333-8333-333333333333', subscriptionId: 'sub_BindingFixture', environment: 'TEST',
  catalogVersion: 'binding_fixture', priceId: 'price_BindingFixture', authorityReference: 'in_BindingFixture',
  validStartsAt: 1_799_999_940, validEndsAt: 1_800_003_600, seatLimit: 8, checkedAt: 1_800_000_000, credential: { kind: 'browser' },
} };
vi.mock('cloudflare:workers', () => ({ env: runtime.env }));
afterEach(() => { for (const key of Object.keys(runtime.env)) delete runtime.env[key]; });

describe('US Support ticket bindings, closed local capability', () => {
  const gates = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED', 'INTERNATIONAL_US_SUPPORT_TICKETS_ENABLED'];
  it('requires every dedicated gate with an exact true value', async () => {
    expect(await usSupportTicketsEnabled()).toBe(false);
    for (const key of gates) runtime.env[key] = 'true';
    expect(await usSupportTicketsEnabled()).toBe(true);
    for (const key of gates) {
      delete runtime.env[key]; expect(await usSupportTicketsEnabled()).toBe(false);
      runtime.env[key] = 'TRUE'; expect(await usSupportTicketsEnabled()).toBe(false);
      runtime.env[key] = 'true';
    }
  });
  it('does not require a current mailbox, classifier, import or financial Automation gate', async () => {
    for (const key of gates) runtime.env[key] = 'true';
    expect(await usSupportTicketsEnabled()).toBe(true);
    for (const key of ['INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED', 'INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED', 'INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED', 'INTERNATIONAL_US_AUTOMATION_ENABLED']) runtime.env[key] = 'false';
    expect(await usSupportTicketsEnabled()).toBe(true);
  });
  it('closes all HTTP routes before Auth, storage or provider access', async () => {
    const org = '11111111-1111-4111-8111-111111111111', url = `https://zentra.test/api/international/workspaces/${org}/support-tickets`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const operation of ['read', 'head', 'write', 'routing'] as const) {
        const mutation = operation === 'write' || operation === 'routing';
        const response = await usSupportTicketHandlers[operation](new Request(url, mutation ? { method: 'POST', body: '{}' } : {}), org);
        expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'feature_unavailable' });
        expect(response.headers.get('Cache-Control')).toContain('no-store');
      }
    } finally { warn.mockRestore(); }
  });
  it('derives a stable valid request UUID for each completed job', async () => {
    const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
    const first = await usSupportTicketCompletionRequestId(a);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await usSupportTicketCompletionRequestId(a)).toBe(first); expect(await usSupportTicketCompletionRequestId(b)).not.toBe(first);
  });
  it.each(['', '../../private', '11111111-1111-4111-8111-11111111111Z', '11111111-1111-0111-8111-111111111111'])('refuses a malformed completed job %j', async value => {
    await expect(usSupportTicketCompletionRequestId(value)).rejects.toMatchObject({ code: 'invalid_ticket_request', status: 422 });
  });
  it('closed completion gate performs no revalidation or runtime database lookup', async () => {
    const check = vi.fn(async () => { throw new Error('closed sink must never touch Auth or runtime'); });
    await recordUsSupportTicketCompletion(context, 'invalid-before-gate', check); expect(check).not.toHaveBeenCalled();
  });
  it('closed completion gate refuses a worker without revalidation or runtime database lookup', async () => {
    const worker: UsSupportWorkerContext = { ...context, authority: { ...context.authority, credential: {
      kind: 'worker', workerId: US_SUPPORT_WORKER_ID, delegationId: '44444444-4444-4444-8444-444444444444',
      delegationRevision: 1, runId: '55555555-5555-4555-8555-555555555555',
    } } };
    const check = vi.fn(async () => { throw new Error('closed worker sink must never touch Auth or runtime'); });
    await expect(recordUsSupportTicketCompletion(worker, 'invalid-before-gate', check)).rejects.toMatchObject({ code: 'feature_unavailable', status: 404 });
    expect(check).not.toHaveBeenCalled();
  });
});
