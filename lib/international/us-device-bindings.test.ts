import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const f=vi.hoisted(()=>({env:{} as Record<string,string>,database:null as unknown as D1Database,select:vi.fn(),user:vi.fn(),legacyDevice:vi.fn(),rate:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:f.env}));
vi.mock('../runtime',()=>({database:()=>f.database}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({select:f.select,rpc:vi.fn()})}));
vi.mock('../../app/zentra-auth',()=>({getZentraUser:f.user}));
vi.mock('../account',()=>({requireDeviceSession:f.legacyDevice,enforceAccountRateLimit:f.rate}));
import { requireUsDeviceSession, usDeviceHandlers, usNativeAdmissionEnabled, usNativeMaximumSchemaVersion } from './us-device-bindings';
import { erpServerDependencies } from './runtime-bindings';
import { workspaceCountryDependencies } from './workspace-server';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase } from './us-device-test-fixture';
const databases:ReturnType<typeof sqliteUsDeviceDatabase>[]=[];
beforeEach(()=>{vi.clearAllMocks();for(const key of Object.keys(f.env))delete f.env[key];f.rate.mockResolvedValue(undefined);});
afterEach(()=>{for(const db of databases.splice(0))db.sql.close();});
async function fixture(){
  const db=sqliteUsDeviceDatabase();databases.push(db);f.database=db.database;const seeded=await seedUsDeviceFixture(db.database);
  Object.assign(f.env,{INTERNATIONAL_CORE_ENABLED:'true',INTERNATIONAL_US_ERP_ENABLED:'true',INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED:'true',INTERNATIONAL_US_BILLING_ENVIRONMENT:'TEST',INTERNATIONAL_US_SAAS_CATALOG_JSON:JSON.stringify(seeded.policy.catalog)});
  f.user.mockResolvedValue({userId:seeded.actor});
  f.select.mockImplementation(async(table:string,query:Record<string,unknown>)=>{
    if(query.organization_id!=='eq.'+seeded.intent.organizationId)throw new Error('Private unexpected tenant');
    if(table==='zentra_workspaces')return [{organization_id:seeded.intent.organizationId}];
    if(table==='zentra_workspace_country_configs')return [{organization_id:seeded.intent.organizationId,schema_version:1,config:seeded.intent.configuration,country:'US',currency:'USD',revision:1,updated_by:seeded.owner,updated_at:new Date().toISOString()}];
    throw new Error('Private unexpected business read');
  });
  const c=await seeded.start();await seeded.approve(c.userCode);expect((await seeded.exchange(c.deviceCode)).status).toBe(200);return {...db,...seeded};
}
describe('actual US bearer binding, fresh catalog/config and isolated CH dispatch',()=>{
  it.each(['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED','INTERNATIONAL_US_PURCHASING_V2_ENABLED','INTERNATIONAL_US_PROJECTS_V3_ENABLED','INTERNATIONAL_US_ACCOUNTING_V4_ENABLED'])('requires the exact server flag %s before a new capability4 credential',async flag=>{
    const flags=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED','INTERNATIONAL_US_PURCHASING_V2_ENABLED','INTERNATIONAL_US_PROJECTS_V3_ENABLED','INTERNATIONAL_US_ACCOUNTING_V4_ENABLED'];for(const name of flags)f.env[name]='true';expect(await usNativeMaximumSchemaVersion()).toBe(4);for(const value of [undefined,'false','TRUE','1']){if(value===undefined)delete f.env[flag];else f.env[flag]=value;expect(await usNativeMaximumSchemaVersion()).toBe(3);}
  });
  it('keeps captured3 unchanged and rejects a forged header4 even when all server gates open',async()=>{
    const x=await fixture();Object.assign(f.env,{INTERNATIONAL_US_PURCHASING_V2_ENABLED:'true',INTERNATIONAL_US_PROJECTS_V3_ENABLED:'true',INTERNATIONAL_US_ACCOUNTING_V4_ENABLED:'true'});const forged=new Request(x.request('me',undefined,true),{headers:{Authorization:'Bearer '+x.sessionToken,'X-Zentra-Erp-Schema-Version':'4'}});expect((await requireUsDeviceSession(forged)).supportedSchemaVersion).toBe(3);await expect(erpServerDependencies.authority(forged,x.intent.organizationId)).rejects.toMatchObject({code:'client_upgrade_required',status:409});delete f.env.INTERNATIONAL_US_ACCOUNTING_V4_ENABLED;expect((await(await usDeviceHandlers.ME(x.request('me',undefined,true))).json() as {supportedSchemaVersion:number}).supportedSchemaVersion).toBe(3);expect((await usDeviceHandlers.REVOKE(x.request('revoke',undefined,true))).status).toBe(200);
  });
  it('actual bindings capture4 only for new pairing and retain me/revoke when accounting closes',async()=>{
    const db=sqliteUsDeviceDatabase();databases.push(db);f.database=db.database;const x=await seedUsDeviceFixture(db.database);Object.assign(f.env,{INTERNATIONAL_CORE_ENABLED:'true',INTERNATIONAL_US_ERP_ENABLED:'true',INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED:'true',INTERNATIONAL_US_PURCHASING_V2_ENABLED:'true',INTERNATIONAL_US_PROJECTS_V3_ENABLED:'true',INTERNATIONAL_US_ACCOUNTING_V4_ENABLED:'true',INTERNATIONAL_US_BILLING_ENVIRONMENT:'TEST',INTERNATIONAL_US_SAAS_CATALOG_JSON:JSON.stringify(x.policy.catalog)});f.user.mockResolvedValue({userId:x.actor});f.select.mockImplementation(async(table:string)=>table==='zentra_workspaces'?[{organization_id:x.intent.organizationId}]:[{organization_id:x.intent.organizationId,schema_version:1,config:x.intent.configuration,country:'US',currency:'USD',revision:1,updated_by:x.owner,updated_at:new Date().toISOString()}]);const c=await(await usDeviceHandlers.START(x.request('start',{protocol:'zentra-us-device-v1',installationId:x.installationId,sessionTokenHash:x.sessionTokenHash,supportedSchemaVersion:4}))).json() as {userCode:string;deviceCode:string};expect((await usDeviceHandlers.APPROVE(x.request('approve',{protocol:'zentra-us-device-v1',userCode:c.userCode,organizationId:x.intent.organizationId}))).status).toBe(200);expect((await usDeviceHandlers.EXCHANGE(x.request('exchange',{protocol:'zentra-us-device-v1',deviceCode:c.deviceCode,installationId:x.installationId,sessionToken:x.sessionToken}))).status).toBe(200);delete f.env.INTERNATIONAL_US_ACCOUNTING_V4_ENABLED;expect((await(await usDeviceHandlers.ME(x.request('me',undefined,true))).json() as {supportedSchemaVersion:number}).supportedSchemaVersion).toBe(4);expect((await usDeviceHandlers.REVOKE(x.request('revoke',undefined,true))).status).toBe(200);
  });
  it.each([undefined,'false','TRUE','1'])('defaults native admission closed for nonexact flag %s',async value=>{
    f.env.INTERNATIONAL_CORE_ENABLED='true';f.env.INTERNATIONAL_US_ERP_ENABLED='true';if(value!==undefined)f.env.INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED=value;
    expect(await usNativeAdmissionEnabled()).toBe(false);expect((await usDeviceHandlers.START(new Request('https://zentraapp.ch/api/international/device/start',{method:'POST'}))).status).toBe(404);expect(f.user).not.toHaveBeenCalled();expect(f.select).not.toHaveBeenCalled();
  });
  it('requires all three feature flags and never accepts the declaration as a v3 grant',async()=>{
    const x=await fixture();expect(await usNativeAdmissionEnabled()).toBe(true);
    const s=await requireUsDeviceSession(x.request('me',undefined,true));expect(s.supportedSchemaVersion).toBe(3);
    expect((await erpServerDependencies.store(3)).supportedSchemaVersion).toBe(1);
    delete f.env.INTERNATIONAL_US_ERP_ENABLED;expect(await usNativeAdmissionEnabled()).toBe(false);
  });
  it('uses the same ready USD registry for ERP and omits legacy licence/cookie readers',async()=>{
    const x=await fixture();const result=await erpServerDependencies.authority(x.request('me',undefined,true),x.intent.organizationId);
    expect(result.mode).toBe('device');expect(result.actor).toMatchObject({organizationId:x.intent.organizationId,userId:x.actor,role:'owner',managementEntitled:true});expect(f.legacyDevice).not.toHaveBeenCalled();expect(f.user).not.toHaveBeenCalled();
  });
  it('country routes explicitly dispatch US and CH credentials without rewriting the CH reader',async()=>{
    const x=await fixture();expect((await workspaceCountryDependencies.deviceSession(x.request('me',undefined,true))).organizationId).toBe(x.intent.organizationId);expect(f.legacyDevice).not.toHaveBeenCalled();
    f.legacyDevice.mockResolvedValue({organizationId:'org_ch',role:'owner'});const request=new Request('https://zentraapp.ch/api/country',{headers:{Authorization:'Bearer zds_'+Buffer.alloc(32).toString('base64url')}});
    expect(await workspaceCountryDependencies.deviceSession(request,['owner'])).toEqual({organizationId:'org_ch',role:'owner'});expect(f.legacyDevice).toHaveBeenCalledWith(request,['owner']);
    await expect(erpServerDependencies.authority(request,x.intent.organizationId)).rejects.toMatchObject({code:'unauthorized',status:401});expect(f.legacyDevice).toHaveBeenCalledOnce();
  });
  it('rejects a missing/unapproved USD catalogue even though the credential and legacy subscription would be valid',async()=>{
    const x=await fixture();f.env.INTERNATIONAL_US_SAAS_CATALOG_JSON='[]';await expect(requireUsDeviceSession(x.request('me',undefined,true))).rejects.toMatchObject({status:422});expect(f.legacyDevice).not.toHaveBeenCalled();
  });
  it.each(['CH','foreign'])('fails closed on fresh %s configuration before returning native metadata',async scenario=>{
    const x=await fixture();f.select.mockImplementation(async(table:string)=>table==='zentra_workspaces'?[{organization_id:x.intent.organizationId}]:[{organization_id:x.intent.organizationId,schema_version:1,config:{...x.intent.configuration,organizationId:scenario==='foreign'?randomUUID():x.intent.organizationId,country:scenario==='CH'?'CH':'US',currency:scenario==='CH'?'CHF':'USD'},country:scenario==='CH'?'CH':'US',currency:scenario==='CH'?'CHF':'USD',revision:1,updated_by:x.owner,updated_at:new Date().toISOString()}]);
    await expect(requireUsDeviceSession(x.request('me',undefined,true))).rejects.toBeDefined();expect(f.legacyDevice).not.toHaveBeenCalled();
  });
  it('does not disclose a session revoked while awaiting PostgreSQL configuration',async()=>{
    const x=await fixture(),original=f.select.getMockImplementation()!;let changed=false;f.select.mockImplementation(async(...args:unknown[])=>{if(args[0]==='zentra_workspace_country_configs'&&!changed){changed=true;await x.store.revoke(x.sessionTokenHash,x.now());}return original(...args);});
    await expect(requireUsDeviceSession(x.request('me',undefined,true))).rejects.toMatchObject({status:401});
  });
  it('logout remains usable while catalogue and native flags are unavailable',async()=>{
    const x=await fixture();delete f.env.INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED;delete f.env.INTERNATIONAL_US_SAAS_CATALOG_JSON;expect((await usDeviceHandlers.REVOKE(x.request('revoke',undefined,true))).status).toBe(200);expect(f.select).not.toHaveBeenCalled();
  });
});
