import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, rpc: vi.fn(async () => null) }));
vi.mock('cloudflare:workers', () => ({ env: fixture.env }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: fixture.rpc }) }));
import { usBankHandlers, usBankReadiness } from './us-bank-bindings';
import { erpServerDependencies } from './runtime-bindings';
const flags = ['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_PURCHASING_V2_ENABLED','INTERNATIONAL_US_PROJECTS_V3_ENABLED','INTERNATIONAL_US_ACCOUNTING_V4_ENABLED','INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED'];
beforeEach(() => { for (const key of Object.keys(fixture.env)) delete fixture.env[key]; vi.clearAllMocks(); });
describe('US bank source binding stays closed without every separately approved capability', () => {
  it.each(flags)('requires exact flag %s, not a header or financial JSON grant', async absent => {
    for (const key of flags) fixture.env[key] = 'true';
    delete fixture.env[absent]; expect(await usBankReadiness()).toBe(false); expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined,'false','TRUE','1','true '])('keeps the bank HTTP surface closed at flag %j before private reads', async value => {
    for (const key of flags) fixture.env[key] = 'true'; fixture.env.INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED = value;
    expect(await usBankReadiness()).toBe(false);
    const request = () => new Request('https://zentra.test/api/bank', { method: 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': '4' }, body: JSON.stringify({ managementEntitled: true, role: 'owner' }) });
    expect((await usBankHandlers.POST(request(), 'fictitious')).status).toBe(404); expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('shows only informational readiness while all flags are current and leaves tax provider absent', async () => {
    for (const key of flags) fixture.env[key] = 'true'; expect(await usBankReadiness()).toBe(true);
    fixture.env.INTERNATIONAL_US_ACCOUNTING_V4_ENABLED = 'false'; expect(await usBankReadiness()).toBe(false);
    expect(await erpServerDependencies.taxProvider({} as Parameters<typeof erpServerDependencies.taxProvider>[0])).toBeNull(); expect(fixture.rpc).not.toHaveBeenCalled();
  });
});
