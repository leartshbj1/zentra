import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordUsSupportTicketCompletion, usSupportTicketCompletionRequestId, usSupportTicketHandlers, usSupportTicketsEnabled } from './us-support-ticket-bindings';
import type { UsMailboxContext } from './us-support-mailbox-contract';

const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }));
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
    await recordUsSupportTicketCompletion({} as UsMailboxContext, 'invalid-before-gate', check); expect(check).not.toHaveBeenCalled();
  });
});
