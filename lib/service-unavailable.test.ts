import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({ database: () => { throw new Error('No database expected'); }, runtimeValue: () => '' }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
import { accountJsonError } from './account';
import { AccountPublicError } from './account-security';
import { supportError } from './support/service';
import { createSupabaseServerClient, SupabaseServerError } from './supabase-server';

afterEach(() => vi.restoreAllMocks());
describe.each([['account', accountJsonError], ['support', supportError]] as const)('%s infrastructure failures', (_, respond) => {
  it.each([402, 429, 502, 503, 504])('reports provider %s as unavailable without asking the customer to pay', async status => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = respond(new SupabaseServerError(status, 'service_restricted', '/rest/v1/zentra_workspaces'), { operation: 'company.watch' });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(status === 402 ? '60' : '5');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const body = await response.json() as { error: string; reference: string };
    expect(body.error).toContain('indisponible');
    expect(body.reference).toBe(response.headers.get('X-Zentra-Request-Id'));
    expect(JSON.stringify(body)).not.toMatch(/quota|Supabase|upgrade|payer|service_restricted/);
    expect(log).toHaveBeenCalledWith('zentra_service_failure', expect.objectContaining({ upstreamStatus: status, upstreamCode: 'service_restricted' }));
  });
  it('preserves an actual customer subscription error and access denial', async () => {
    for (const status of [402, 403]) {
      const response = respond(new AccountPublicError('Accès à vérifier.', status), { operation: 'company.watch' });
      expect(response.status).toBe(status);
      expect(response.headers.has('Retry-After')).toBe(false);
      expect((await response.json() as { error: string }).error).toBe('Accès à vérifier.');
    }
  });
});
it('records only a structural restriction code, without copying or retrying the provider response', async () => {
  const fetcher = vi.fn(async () => Response.json({ message: 'restricted exceed_egress_quota private@example.test sb_secret_private', code: 'private_email' }, { status: 402 }));
  const client = createSupabaseServerClient({ url: 'https://example.supabase.co', secretKey: 'sb_secret_' + 'a'.repeat(32) }, fetcher);
  let failure: unknown;
  try { await client.insert('zentra_workspaces', { organization_id: 'fixture' }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 402, code: 'service_restricted', resource: '/rest/v1/zentra_workspaces' });
  expect(String(failure)).not.toMatch(/private|exceed_egress|sb_secret/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
