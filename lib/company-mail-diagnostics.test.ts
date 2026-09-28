import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), state: vi.fn() }));
vi.mock('./runtime', () => ({
  database: vi.fn(() => { throw new Error('Unexpected database access'); }),
  runtimeValue: vi.fn(),
}));
vi.mock('./automation/access', () => ({ automationActor: mocks.actor }));
vi.mock('./supplier-inbox/service', () => ({ gestionActive: vi.fn() }));
vi.mock('./company-mail/service', () => ({
  sharedMailState: mocks.state,
  sharedMailReceipt: vi.fn(),
  connectSharedMail: vi.fn(),
  disconnectSharedMail: vi.fn(),
  sendSharedMail: vi.fn(),
}));
import { GET } from '@/app/api/company-mail/route';
import { SupabaseServerError } from './supabase-server';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('shared mail read incident timing', () => {
  it.each(['session', 'mailbox'])('includes time waiting for %s and keeps the client correlation', async stage => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = () => new Promise((_, reject) => setTimeout(() => reject(
      new SupabaseServerError(402, 'service_restricted', '/rest/v1/company_mail_connections'),
    ), 1500));
    mocks.actor.mockResolvedValue({ userId: 'fixture-user', organizationId: 'fixture-org', role: 'owner' });
    if (stage === 'session') mocks.actor.mockImplementation(failure);
    else mocks.state.mockImplementation(failure);
    const pending = GET(new Request('https://zentraapp.ch/api/company-mail?organizationId=fixture-org', {
      headers: { 'User-Agent': 'Zentra/1.90.6', Authorization: 'Bearer fixture-not-a-real-session' },
    }));
    await vi.advanceTimersByTimeAsync(1500);
    const response = await pending;
    expect(response.status).toBe(503);
    const result = await response.json() as { reference: string };
    expect(result.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get('X-Zentra-Request-Id')).toBe(result.reference);
    expect(log).toHaveBeenCalledWith('zentra_service_failure', expect.objectContaining({
      reference: result.reference, operation: 'company-mail.read', durationMs: 1500,
      upstreamStatus: 402, upstreamCode: 'service_restricted', clientVersion: '1.90.6',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-not-a-real-session|fixture-org/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
