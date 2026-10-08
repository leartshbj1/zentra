import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportFixture } from './export-test-fixture';
import { createUsExportHandlers, type ExportServerDependencies } from './export-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { AccountPublicError } from '../account-security';

const org='fictitious-export-company', user='fictitious-export-viewer';
async function fixture() {
  const state=await exportFixture('accrual','Recorded project notes','Fictitious TEST service','12345',true);
  let ceiling:ErpSchemaVersion=3, open=true, actor:FinancialAuthority={organizationId:org,userId:user,role:'read_only',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
  const commit=vi.fn(), read=vi.fn(async()=>state), fonts=vi.fn(async()=>({regular:new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Regular.ttf'))),bold:new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Bold.ttf')))}));
  const deps:ExportServerDependencies={enabled:async()=>open,authority:async()=>structuredClone({mode:'browser',actor}),configuration:async()=>state.configuration,store:async()=>({supportedSchemaVersion:ceiling,read,receipt:async()=>null,commit}),seller:async()=>({organizationId:org,displayName:'Fictitious public company'}),rateLimit:async()=>{},fonts,freshSupportedSchemaVersion:()=>ceiling};
  const handlers=createUsExportHandlers(deps), request=(cap=3,query='format=json&language=en')=>new Request('https://zentra.test/exports?'+query,{headers:{'X-Zentra-Erp-Schema-Version':String(cap),'X-Zentra-Expected-User':user}});
  return {deps,handlers,request,commit,read,fonts,state,ceiling:(value:ErpSchemaVersion)=>{ceiling=value;},close:()=>{open=false;},actor:(update:Partial<FinancialAuthority>)=>{actor={...actor,...update};}};
}
describe('actual project export through authenticated HTTP',()=>{
  it.each(['json','html','csv','pdf'])('returns %s only from the recorded schema3 dossier',async format=>{
    const t=await fixture(),response=await t.handlers.documents(t.request(3,`format=${format}&language=de`),org,'project','project 1 é');
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('X-Zentra-Erp-Revision')).toBe('11'); expect(response.headers.get('X-Zentra-Record-Revision')).toBe('2'); expect(response.headers.get('X-Zentra-Organization-Id')).toBe(org); expect(response.headers.get('X-Zentra-Content-SHA256')).toMatch(/^[0-9a-f]{64}$/);
    const bytes=await response.arrayBuffer(); expect(bytes.byteLength).toBeGreaterThan(100); if(format==='json')expect(JSON.parse(new TextDecoder().decode(bytes)).selector).toEqual({kind:'document',documentType:'project',id:'project 1 é'});
    expect(t.commit).not.toHaveBeenCalled(); expect(t.fonts).toHaveBeenCalledTimes(format==='pdf'?1:0);
  },20000);
  it.each([1,2])('refuses incapable schema %s before disclosing a schema3 dossier',async capability=>{
    const t=await fixture(),response=await t.handlers.documents(t.request(capability),org,'project','project 1 é'); expect(response.status).toBe(409); expect(await response.json()).toEqual({error:'client_upgrade_required'}); expect(t.commit).not.toHaveBeenCalled();
  });
  it('refuses a closed server capability even when client announces3',async()=>{
    const t=await fixture(); t.ceiling(2); const response=await t.handlers.documents(t.request(),org,'project','project 1 é'); expect(response.status).toBe(409); expect(await response.json()).toEqual({error:'client_upgrade_required'});
  });
  it.each(['flag','entitlement','session','ceiling','revocation'])('rechecks %s after the actual renderer awaits',async change=>{
    const t=await fixture(); t.deps.render=async()=>{if(change==='flag')t.close();if(change==='entitlement')t.actor({managementEntitled:false});if(change==='session')t.actor({userId:'different-user'});if(change==='ceiling')t.ceiling(2);if(change==='revocation')t.deps.authority=async()=>{throw new AccountPublicError('no_session',401);};return '<!doctype html><p>Fictitious isolated render</p>';};
    const response=await createUsExportHandlers(t.deps).documents(t.request(3,'format=html'),org,'project','project 1 é'); expect(response.status).toBe({flag:404,entitlement:402,session:401,ceiling:409,revocation:401}[change]); const body=await response.text(); expect(body).not.toContain('Fictitious isolated render');expect(body).not.toContain('Recorded project notes');expect(t.commit).not.toHaveBeenCalled();
  });
  it('refuses a cross-workspace read and does not return a private source',async()=>{
    const t=await fixture();const response=await t.handlers.documents(t.request(),'other-workspace','project','project 1 é'); expect(response.status).toBe(403);expect(t.read).not.toHaveBeenCalled();
  });
  it('returns a source-not-found result for unknown dossier without any mutation',async()=>{
    const t=await fixture();const response=await t.handlers.documents(t.request(),org,'project','missing');expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'export_source_not_found'});expect(t.commit).not.toHaveBeenCalled();
  });
});
