import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, rpc: vi.fn(async () => null) }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
import { usSupplierHandlers, usSupplierReadiness } from './us-supplier-bindings';
const flags = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_PURCHASING_V2_ENABLED', 'INTERNATIONAL_US_PROJECTS_V3_ENABLED', 'INTERNATIONAL_US_ACCOUNTING_V4_ENABLED', 'INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED'];
beforeEach(() => { for (const key of Object.keys(f.env)) delete f.env[key]; vi.clearAllMocks(); });
describe('US supplier source is a separately closed capability', () => {
  it.each(flags)('requires explicit flag %s', async absent => {
    for (const key of flags) f.env[key] = 'true'; delete f.env[absent];
    expect(await usSupplierReadiness()).toBe(false); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1', 'true '])('refuses flag %j before private reads', async value => {
    for (const key of flags) f.env[key] = 'true'; f.env.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED = value;
    const request = new Request('https://zentra.test/api/mail', { method: 'POST', body: JSON.stringify({ role: 'owner' }) });
    expect((await usSupplierHandlers.POST(request, '54b7ee3b-5753-4af1-98f6-b2a568fb3890')).status).toBe(404);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('reports only review readiness when every flag exists; no inference is implied', async () => {
    for (const key of flags) f.env[key] = 'true'; expect(await usSupplierReadiness()).toBe(true);
    f.env.INTERNATIONAL_US_ACCOUNTING_V4_ENABLED = 'false'; expect(await usSupplierReadiness()).toBe(false);
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
