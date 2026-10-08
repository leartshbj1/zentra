import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,rpc:vi.fn(async()=>null)}));
vi.mock('cloudflare:workers',()=>({env:fixture.env}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:fixture.rpc})}));
import { erpServerDependencies, erpSyncHandlers, usPurchasingSchemaVersion } from './runtime-bindings';
import { usExportReadiness } from './export-bindings';
beforeEach(()=>{for(const key of Object.keys(fixture.env))delete fixture.env[key];vi.clearAllMocks();});
describe('trusted project capability is never a grant',()=>{
  it.each([undefined,'false','TRUE','1','true '] as const)('requires the exact project flag %j with purchasing',async flag=>{
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';fixture.env.INTERNATIONAL_US_PROJECTS_V3_ENABLED=flag;
    expect(await usPurchasingSchemaVersion(3)).toBe(2);expect(await erpServerDependencies.enabled()).toBe(false);expect(await usExportReadiness()).toEqual({enabled:false,supportedSchemaVersion:1});expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('requires purchasing2 in addition to project3 and caps the client explicitly',async()=>{
    fixture.env.INTERNATIONAL_US_PROJECTS_V3_ENABLED='true';expect(await usPurchasingSchemaVersion(3)).toBe(1);
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';expect(await usPurchasingSchemaVersion()).toBe(1);expect(await usPurchasingSchemaVersion(2)).toBe(2);expect(await usPurchasingSchemaVersion(3)).toBe(3);
    const store=await erpServerDependencies.store(3);expect(store.supportedSchemaVersion).toBe(3);await store.read('fictitious-space');expect(fixture.rpc).toHaveBeenCalledWith('zentra_read_us_erp_v3',{p_organization:'fictitious-space'});
  });
  it('keeps HTTP/sync/export unavailable and does not connect a tax provider when CORE is off',async()=>{
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';fixture.env.INTERNATIONAL_US_PROJECTS_V3_ENABLED='true';fixture.env.INTERNATIONAL_US_ERP_ENABLED='true';
    expect(await usExportReadiness()).toEqual({enabled:false,supportedSchemaVersion:1});expect(await erpServerDependencies.taxProvider({} as Parameters<typeof erpServerDependencies.taxProvider>[0])).toBeNull();
    expect((await erpSyncHandlers.changes(new Request('https://zentra.test/changes?after=0',{headers:{'X-Zentra-Erp-Schema-Version':'3'}}),'fictitious-space')).status).toBe(404);expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('advertises project readiness only while all actual feature gates are enabled',async()=>{
    fixture.env.INTERNATIONAL_CORE_ENABLED='true';fixture.env.INTERNATIONAL_US_ERP_ENABLED='true';fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';expect(await usExportReadiness()).toEqual({enabled:true,supportedSchemaVersion:2});
    fixture.env.INTERNATIONAL_US_PROJECTS_V3_ENABLED='true';expect(await usExportReadiness()).toEqual({enabled:true,supportedSchemaVersion:3});expect(fixture.rpc).not.toHaveBeenCalled();
    fixture.env.INTERNATIONAL_US_PROJECTS_V3_ENABLED='false';expect(await erpServerDependencies.freshSupportedSchemaVersion?.(3)).toBe(2);
  });
});
