import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,rpc:vi.fn(async()=>null)}));
vi.mock('cloudflare:workers',()=>({env:fixture.env}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:fixture.rpc})}));
import { erpServerDependencies, erpSyncHandlers, usPurchasingSchemaVersion } from './runtime-bindings';

beforeEach(()=>{for(const key of Object.keys(fixture.env))delete fixture.env[key];vi.clearAllMocks();});
describe('trusted purchasing binding is closed by default and capped to protocol support',()=>{
  it.each([undefined,'false','TRUE','1','true '] as const)('does not enable v2 for flag %j',async flag=>{
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED=flag;
    expect(await usPurchasingSchemaVersion(2)).toBe(1);
    const store=await erpServerDependencies.store(2);expect(store.supportedSchemaVersion).toBe(1);await store.read('fictitious-space');expect(fixture.rpc).toHaveBeenCalledWith('zentra_read_us_erp',{p_organization:'fictitious-space'});
  });
  it('enables only the explicitly capable server port, while old/missing client capabilities stay1',async()=>{
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';
    expect(await usPurchasingSchemaVersion()).toBe(1);expect(await usPurchasingSchemaVersion(1)).toBe(1);expect(await usPurchasingSchemaVersion(2)).toBe(2);
    const legacy=await erpServerDependencies.store(),current=await erpServerDependencies.store(2);expect(legacy.supportedSchemaVersion).toBe(1);expect(current.supportedSchemaVersion).toBe(2);await current.read('fictitious-space');expect(fixture.rpc).toHaveBeenCalledWith('zentra_read_us_erp_v2',{p_organization:'fictitious-space'});
  });
  it('purchasing alone does not open the US ERP or sync routes or connect a tax provider',async()=>{
    fixture.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED='true';
    expect(await erpServerDependencies.enabled()).toBe(false);expect(await erpServerDependencies.taxProvider({} as Parameters<typeof erpServerDependencies.taxProvider>[0])).toBeNull();
    const response=await erpSyncHandlers.changes(new Request('https://zentraapp.ch/erp/changes?after=0',{headers:{'X-Zentra-Erp-Schema-Version':'2'}}),'fictitious-space');expect(response.status).toBe(404);expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('does not infer purchasing support when only existing US flags are enabled',async()=>{
    fixture.env.INTERNATIONAL_CORE_ENABLED='true';fixture.env.INTERNATIONAL_US_ERP_ENABLED='true';
    expect(await erpServerDependencies.enabled()).toBe(true);expect(await usPurchasingSchemaVersion(2)).toBe(1);expect(fixture.rpc).not.toHaveBeenCalled();
  });
});
