import { describe,it,expect,vi } from 'vitest';
import { createErpHandlers,type ErpServerDependencies } from './runtime-server';
import { AccountPublicError } from '../account-security';
import type { CompanyConfiguration } from './types';
import type { ErpStore } from './runtime-types';

const organizationId='fictitious-us-space';
const configuration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}} satisfies CompanyConfiguration;
function setup(mode:'browser'|'device'='browser'){
 const store:ErpStore={read:vi.fn(async()=>null),receipt:vi.fn(async()=>null),commit:vi.fn(async input=>input.receipt)};
 const actor={organizationId,userId:'fictitious-owner',role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
 const dependencies:ErpServerDependencies={enabled:()=>true,authority:vi.fn(async()=>({mode,actor})),configuration:vi.fn(async()=>configuration),store:vi.fn(()=>store),taxProvider:async()=>null,rateLimit:vi.fn(async()=>{}),diagnostic:vi.fn()};
 const handlers=createErpHandlers(dependencies);
 const body={idempotencyKey:'initialize-test',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}};
 const post=(origin='https://zentraapp.ch',value:unknown=body)=>new Request(`https://zentraapp.ch/api/international/workspaces/${organizationId}/erp`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 return {store,dependencies,handlers,post,body};
}
describe('US ERP HTTP authorization and effects',()=>{
 it('returns initialization config without inventing a ledger or country',async()=>{const t=setup();const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);expect(r.status).toBe(200);expect(await r.json()).toEqual({status:'uninitialized',configuration});expect(t.store.commit).not.toHaveBeenCalled();});
 it('does not open persistence while feature is disabled',async()=>{const t=setup();t.dependencies.enabled=()=>false;expect((await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId)).status).toBe(404);expect(t.dependencies.authority).not.toHaveBeenCalled();expect(t.dependencies.store).not.toHaveBeenCalled();});
 it.each([401,402,403])('refuses authorization failure %s before persistence',async status=>{const t=setup();t.dependencies.authority=async()=>{throw new AccountPublicError('private detail',status);};const r=await t.handlers.POST(t.post(),organizationId);expect(r.status).toBe(status);expect(t.dependencies.store).not.toHaveBeenCalled();expect(JSON.stringify(await r.json())).not.toContain('private detail');});
 it('rejects cross-origin browser writes and allows authenticated native requests without cookies',async()=>{const browser=setup();expect((await browser.handlers.POST(browser.post('https://evil.example'),organizationId)).status).toBe(403);expect(browser.store.commit).not.toHaveBeenCalled();const device=setup('device');const r=await device.handlers.POST(device.post('tauri://localhost'),organizationId);expect(r.status).toBe(200);expect(device.store.commit).toHaveBeenCalledTimes(1);});
 it('refuses tenant mismatch returned by upstream membership',async()=>{const t=setup();t.dependencies.authority=async()=>({mode:'device',actor:{organizationId:'other',userId:'u',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}});expect((await t.handlers.POST(t.post(),organizationId)).status).toBe(403);expect(t.dependencies.configuration).not.toHaveBeenCalled();});
 it('rechecks authority immediately before commit and blocks revocation',async()=>{const t=setup();let calls=0;t.dependencies.authority=async()=>{if(++calls>1)throw new AccountPublicError('revoked',401);return {mode:'device',actor:{organizationId,userId:'u',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}};};expect((await t.handlers.POST(t.post(),organizationId)).status).toBe(401);expect(t.store.commit).not.toHaveBeenCalled();});
 it('rejects inflated bodies before commit',async()=>{const t=setup();const r=await t.handlers.POST(t.post(undefined,{...t.body,large:'x'.repeat(262144)}),organizationId);expect(r.status).toBe(413);expect(t.store.commit).not.toHaveBeenCalled();});
 it('refuses financial privilege in request and emits metadata-only diagnostics',async()=>{const t=setup();const r=await t.handlers.POST(t.post(undefined,{...t.body,role:'owner',password:'SECRET'}),organizationId);expect(r.status).toBe(422);expect(t.store.commit).not.toHaveBeenCalled();expect(t.dependencies.diagnostic).toHaveBeenCalledWith({operation:'write',code:'invalid_request',status:422});expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('SECRET');});
 it('sanitizes unknown storage exceptions and sets cache/security headers',async()=>{const t=setup();t.store.read=async()=>{throw new Error('private token');};const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});expect(r.headers.get('Cache-Control')).toContain('no-store');});
});
