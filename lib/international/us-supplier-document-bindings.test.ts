import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, rpc: vi.fn(async () => null), archive: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: f.env }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ({ rpc: f.rpc }) }));
vi.mock('../runtime', () => ({ fileArchive: f.archive, runtimeValue: vi.fn() }));
import { usSupplierDocumentHandlers, usSupplierDocumentsReadiness } from './us-supplier-document-bindings';
const gates = ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_PURCHASING_V2_ENABLED', 'INTERNATIONAL_US_PROJECTS_V3_ENABLED', 'INTERNATIONAL_US_ACCOUNTING_V4_ENABLED', 'INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED'];
beforeEach(() => { for (const key of Object.keys(f.env)) delete f.env[key]; vi.clearAllMocks(); });
describe('US supplier originals runtime is separately closed', () => {
  it.each(gates)('requires explicit %s without archive or database access', async absent => {
    for (const key of gates) f.env[key] = 'true'; delete f.env[absent];
    expect(await usSupplierDocumentsReadiness()).toBe(false); expect(f.rpc).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1', 'true '])('refuses documents gate %j at the boundary', async value => {
    for (const key of gates) f.env[key] = 'true'; f.env.INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED = value;
    const response = await usSupplierDocumentHandlers.GET(new Request('https://zentra.test/api/documents'), '54b7ee3b-5753-4af1-98f6-b2a568fb3890');
    expect(response.status).toBe(404); expect(f.rpc).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });
  it('does not require or imply the separate Automation/provider gate for archive readiness', async () => {
    for (const key of gates) f.env[key] = 'true';
    expect(await usSupplierDocumentsReadiness()).toBe(true);
    expect(f.env.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED).toBeUndefined(); expect(f.env.INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED).toBeUndefined();
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });
});
