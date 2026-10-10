import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5 } from './us-financial-kernel-runtime';
import { validateUsFinancialPilotExportSelector } from './us-financial-pilot-export-contract';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';

const org='0a7ec0b8-a465-4df9-b756-e99aca4439ce';
const markerPdf=()=>new TextEncoder().encode('%PDF-1.7\nSynthetic boundary-test bytes, not a rendered document\n%%EOF');
async function fixture(){
  const raw=await financialKernelFixture(),f=JSON.parse(JSON.stringify(raw).replaceAll(raw.actor.organizationId,org)) as typeof raw;
  const book=await promoteUsFinancialBookV5(f.baseline,f.policy,f.actor),memory=await createInMemoryUsFinancialKernelStoreV5(book,f.policy,a=>a);
  const scope={scope:{organizationId:org,actor:f.actor,policy:f.policy,grantVersion:1},optInVersion:1};
  const store={...memory,read:vi.fn(memory.read),receipt:vi.fn(memory.receipt),commit:vi.fn(memory.commit),head:vi.fn(async()=>({consumer:'financial-pilot' as const,schemaVersion:1 as const,organizationId:org,revision:book.revision}))};
  const deps:UsFinancialPilotExportDependencies={enabled:vi.fn(()=>true),authority:vi.fn(async()=>({mode:'browser' as const,actor:f.actor})),configuration:vi.fn(async()=>f.configuration),scope:vi.fn(async()=>scope),store:vi.fn(()=>store),rateLimit:vi.fn(async()=>{}),fonts:vi.fn(()=>({regular:new Uint8Array([1,2]),bold:new Uint8Array([3,4])})),render:vi.fn((_snapshot,format)=>format==='pdf'?markerPdf():'\uFEFF"Synthetic boundary CSV"\r\n'),hash:vi.fn(sha256Hex),diagnostic:vi.fn()};
  const query=`revision=${book.revision}&format=pdf&language=en`;
  const request=(search=query,headers:Record<string,string>={},init:RequestInit={})=>new Request(`https://zentra.test/api/international/workspaces/${org}/financial-pilot/exports/invoices/invoice-1?${search}`,{...init,headers:{Origin:'https://zentra.test','X-Zentra-Financial-Pilot':'1','X-Zentra-Expected-User':f.actor.userId,...headers}});
  const invoice=()=>createUsFinancialPilotExportHandlers(deps).INVOICE(request(),org,'invoice-1');
  return{...f,book,scope,store,deps,query,request,invoice};
}

describe('financial pilot read-only export HTTP boundary — synthetic authority and real memory kernel',()=>{
  it('binds the emitted bytes to organization, exact financial/ledger revision and public selector hashes',async()=>{
    const t=await fixture(),before=canonicalErpJson(await t.store.read(org)),r=await t.invoice(),bytes=new Uint8Array(await r.arrayBuffer());
    expect(r.status).toBe(200);expect(bytes).toEqual(markerPdf());expect(r.headers.get('Content-Type')).toBe('application/pdf');expect(r.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(r.headers.get('Content-Disposition')).toBe(`attachment; filename="zentra-invoice-r${t.book.revision}-en.pdf"`);expect(r.headers.get('Cache-Control')).toContain('no-store');expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('X-Zentra-Financial-Pilot')).toBe('1');expect(r.headers.get('X-Zentra-Organization-Id')).toBe(org);expect(r.headers.get('X-Zentra-Financial-Revision')).toBe(String(t.book.revision));expect(r.headers.get('X-Zentra-Ledger-Revision')).toBe(String(t.book.baseline.ledger.revision));expect(r.headers.get('X-Zentra-Erp-Revision')).toBeNull();
    expect(r.headers.get('X-Zentra-Content-SHA256')).toBe(await sha256Hex(bytes));expect(r.headers.get('X-Zentra-Export-Selector-SHA256')).toBe(await sha256Hex(canonicalErpJson(validateUsFinancialPilotExportSelector({kind:'invoice',invoiceId:'invoice-1',revision:t.book.revision,format:'pdf',language:'en'}))));
    expect(canonicalErpJson(await t.store.read(org))).toBe(before);expect(t.store.receipt).not.toHaveBeenCalled();expect(t.store.commit).not.toHaveBeenCalled();
  });
  it('allows browser Fetch Metadata on a same-origin GET without manufacturing Origin',async()=>{
    const t=await fixture(),r=t.request();r.headers.delete('Origin');r.headers.set('Sec-Fetch-Site','same-origin');expect((await createUsFinancialPilotExportHandlers(t.deps).INVOICE(r,org,'invoice-1')).status).toBe(200);
  });
  it('renders a complete CSV report without loading fonts',async()=>{
    const t=await fixture(),r=await createUsFinancialPilotExportHandlers(t.deps).REPORT(t.request(`revision=${t.book.revision}&format=csv&language=fr&asOf=2026-12-31`),org,'trial_balance');expect(r.status).toBe(200);expect(r.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');expect(new Uint8Array(await r.arrayBuffer()).subarray(0,3)).toEqual(new Uint8Array([239,187,191]));expect(t.deps.fonts).not.toHaveBeenCalled();
  });
  it.each(['revision=01&format=pdf&language=en','revision=1e3&format=pdf&language=en','revision=9007199254740992&format=pdf&language=en','format=pdf&language=en','revision=1&format=pdf','revision=1&format=csv&language=en','revision=1&format=html&language=en','revision=1&format=pdf&language=es','revision=1&format=pdf&language=en&actor=owner','revision=1&revision=2&format=pdf&language=en','revision=1&format=pdf&language=en&cursor=abc'])('rejects forged or ambiguous invoice parameters %s before private reads',async query=>{
    const t=await fixture(),r=await createUsFinancialPilotExportHandlers(t.deps).INVOICE(t.request(query),org,'invoice-1');expect(r.status).toBe(422);expect(t.store.read).not.toHaveBeenCalled();expect(t.deps.render).not.toHaveBeenCalled();
  });
  it.each(['from=2026-01-01','asOf=2026-12-31','accountId=1000','cursor=abc'])('refuses extra current-receivable report fields %s',async suffix=>{
    const t=await fixture(),r=await createUsFinancialPilotExportHandlers(t.deps).REPORT(t.request(`revision=${t.book.revision}&format=csv&language=en&${suffix}`),org,'receivables');expect(r.status).toBe(422);expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each(['authorization','missing-user','wrong-user','missing-protocol','cross-origin','cross-site','missing-origin','member','read_only','tenant','entitlement','disabled'] as const)('denies %s without reading/rendering financial data',async reason=>{
    const t=await fixture(),r=t.request();
    if(reason==='authorization')r.headers.set('Authorization','Bearer synthetic');if(reason==='missing-user')r.headers.delete('X-Zentra-Expected-User');if(reason==='wrong-user')r.headers.set('X-Zentra-Expected-User','another-user');if(reason==='missing-protocol')r.headers.delete('X-Zentra-Financial-Pilot');if(reason==='cross-origin')r.headers.set('Origin','https://other.test');if(reason==='cross-site')r.headers.set('Sec-Fetch-Site','cross-site');if(reason==='missing-origin')r.headers.delete('Origin');
    if(reason==='member'||reason==='read_only')t.deps.authority=vi.fn(async()=>({mode:'browser' as const,actor:{...t.actor,role:reason}}));if(reason==='tenant')t.deps.authority=vi.fn(async()=>({mode:'browser' as const,actor:{...t.actor,organizationId:'other-tenant'}}));if(reason==='entitlement')t.deps.authority=vi.fn(async()=>({mode:'browser' as const,actor:{...t.actor,managementEntitled:false}}));if(reason==='disabled')t.deps.enabled=vi.fn(()=>false);
    const response=await createUsFinancialPilotExportHandlers(t.deps).INVOICE(r,org,'invoice-1');expect([401,402,403,404,422]).toContain(response.status);expect(t.store.read).not.toHaveBeenCalled();expect(t.deps.render).not.toHaveBeenCalled();
  });
  it.each(['read','fonts','render','hash','head','last-scope'] as const)('withholds a successful export after logout during %s',async stage=>{
    const t=await fixture();let lost=false,headDone=false;t.deps.authority=vi.fn(async()=>{if(lost)throw new AccountPublicError('SYNTHETIC SECRET auth revoked',401);return{mode:'browser' as const,actor:t.actor};});
    if(stage==='read'){const read=t.store.read;t.store.read=vi.fn(async id=>{const result=await read(id);lost=true;return result;});}
    if(stage==='fonts')t.deps.fonts=vi.fn(async()=>{await Promise.resolve();lost=true;return{regular:new Uint8Array([1]),bold:new Uint8Array([2])};});
    if(stage==='render')t.deps.render=vi.fn(async()=>{await Promise.resolve();lost=true;return markerPdf();});
    if(stage==='hash')t.deps.hash=vi.fn(async bytes=>{const hash=await sha256Hex(bytes);lost=true;return hash;});
    if(stage==='head'||stage==='last-scope'){const head=t.store.head;t.store.head=vi.fn(async()=>{const result=await head();headDone=true;if(stage==='head')lost=true;return result;});}
    if(stage==='last-scope')t.deps.scope=vi.fn(async()=>{if(headDone){await Promise.resolve();lost=true;}return t.scope;});
    const r=await t.invoice();expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'unauthorized'});expect(r.headers.has('Content-Disposition')).toBe(false);
  });
  it.each(['flag','configuration','grant','opt-in','policy','role','plan'] as const)('rechecks %s after the render/hash waits',async reason=>{
    const t=await fixture();let changed=false;t.deps.hash=vi.fn(async bytes=>{const h=await sha256Hex(bytes);changed=true;return h;});
    if(reason==='flag')t.deps.enabled=vi.fn(()=>!changed);
    if(reason==='configuration')t.deps.configuration=vi.fn(async()=>({...t.configuration,...(changed?{timeZone:'America/Chicago'}:{})}));
    if(reason==='grant'||reason==='opt-in'||reason==='policy')t.deps.scope=vi.fn(async()=>({...t.scope,scope:{...t.scope.scope,...(changed&&reason==='grant'?{grantVersion:2}:{}),policy:changed&&reason==='policy'?{...t.policy,approval:{...t.policy.approval,reference:'another-private-policy'}}:t.policy},optInVersion:changed&&reason==='opt-in'?2:1}));
    if(reason==='role'||reason==='plan')t.deps.authority=vi.fn(async()=>({mode:'browser' as const,actor:{...t.actor,...(changed?(reason==='role'?{role:'member' as const}:{managementEntitled:false}):{})}}));
    const r=await t.invoice();expect([402,403,404,409]).toContain(r.status);expect(r.headers.has('Content-Disposition')).toBe(false);expect(Object.keys(await r.json() as object)).toEqual(['error']);
  });
  it('refuses a changed financial head after rendering rather than silently retargeting the document',async()=>{
    const t=await fixture();t.store.head=vi.fn(async()=>({consumer:'financial-pilot',schemaVersion:1,organizationId:org,revision:t.book.revision+1}));const r=await t.invoice();expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'financial_snapshot_changed'});expect(t.deps.render).toHaveBeenCalledOnce();
  });
  it('withholds the binary when rollout closes during the final post-head authority wait',async()=>{
    const t=await fixture();let headDone=false,postHeadAuthorityCalls=0,enabled=true;const head=t.store.head;
    t.store.head=vi.fn(async()=>{const result=await head();headDone=true;return result;});t.deps.enabled=vi.fn(()=>enabled);
    t.deps.authority=vi.fn(async()=>{if(headDone&&++postHeadAuthorityCalls===2){await Promise.resolve();enabled=false;}return{mode:'browser' as const,actor:t.actor};});
    const r=await t.invoice();expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'feature_unavailable'});expect(r.headers.has('Content-Disposition')).toBe(false);expect(t.deps.render).toHaveBeenCalledOnce();
  });
  it('captures dependency functions and private store methods before yielding to another callback',async()=>{
    const t=await fixture(),render=t.deps.render,head=t.store.head;t.deps.fonts=vi.fn(async()=>{t.deps.render=()=>{throw Error('Mutated callback SECRET');};t.deps.authority=async()=>{throw new AccountPublicError('Replaced callback',401);};t.store.head=vi.fn(async()=>{throw Error('Replaced store method');});return{regular:new Uint8Array([1]),bold:new Uint8Array([2])};});
    expect((await t.invoice()).status).toBe(200);expect(render).toHaveBeenCalledOnce();expect(head).toHaveBeenCalledOnce();expect(t.store.head).not.toHaveBeenCalled();
  });
  it('owns font and rendered buffers before later hash callbacks mutate their inputs',async()=>{
    const t=await fixture(),regular=new Uint8Array([10,11]),output=markerPdf();t.deps.fonts=()=>({regular,bold:new Uint8Array([12])});t.deps.render=(_s,_f,fonts)=>{expect(fonts?.regular).not.toBe(regular);regular.fill(99);expect(fonts?.regular).toEqual(new Uint8Array([10,11]));return output;};t.deps.hash=async bytes=>{const value=await sha256Hex(bytes);bytes.fill(0);output.fill(0);return value;};const r=await t.invoice();expect(r.status).toBe(200);expect(new Uint8Array(await r.arrayBuffer())).toEqual(markerPdf());
  });
  it('rejects accessor-based privileged outputs without invoking their getters',async()=>{
    const t=await fixture(),get=vi.fn(()=>new Uint8Array([1]));t.deps.fonts=()=>Object.defineProperty({bold:new Uint8Array([2])},'regular',{enumerable:true,get}) as never;const r=await t.invoice();expect(r.status).toBe(503);expect(get).not.toHaveBeenCalled();expect(await r.json()).toEqual({error:'financial_export_unavailable'});
  });
  it.each(['invalid-hash','bad-pdf','pdf-overflow','secret-error'] as const)('does not publish %s or private diagnostics',async reason=>{
    const t=await fixture();if(reason==='invalid-hash')t.deps.hash=async()=> 'SECRET invalid digest';if(reason==='bad-pdf')t.deps.render=()=>new Uint8Array([1,2,3]);if(reason==='pdf-overflow')t.deps.render=()=>new Uint8Array(12*1024*1024+1);if(reason==='secret-error')t.deps.render=()=>{throw new Error('SECRET taxproof provider EIN');};const r=await t.invoice();expect(reason==='pdf-overflow'?413:503).toBe(r.status);expect(await r.text()).not.toContain('SECRET');expect(r.headers.has('Content-Disposition')).toBe(false);
  });
  it('keeps an aborted or deadline-exceeded render from publishing a late binary',async()=>{
    const t=await fixture();t.deps.deadlineMs=40;t.deps.render=()=>new Promise<Uint8Array>(()=>{});const r=await t.invoice();expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'financial_export_timeout'});
    const u=await fixture(),abort=new AbortController();u.deps.render=async()=>{abort.abort();return markerPdf();};const cancelled=await createUsFinancialPilotExportHandlers(u.deps).INVOICE(u.request(u.query,{}, {signal:abort.signal}),org,'invoice-1');expect(cancelled.status).toBe(503);expect(cancelled.headers.has('Content-Disposition')).toBe(false);
  });
  it('requires strict method, organization and financial configuration',async()=>{
    const t=await fixture();expect((await createUsFinancialPilotExportHandlers(t.deps).INVOICE(t.request(t.query,{}, {method:'POST'}),org,'invoice-1')).status).toBe(405);expect((await createUsFinancialPilotExportHandlers(t.deps).INVOICE(t.request(),'bad-organization','invoice-1')).status).toBe(422);
    t.deps.configuration=async()=>({...t.configuration,accountingBasis:'cash'});expect((await t.invoice()).status).toBe(409);expect(t.deps.render).not.toHaveBeenCalled();
  });
  it('preserves an authorization denial over a concurrent failed renderer without disclosing private errors',async()=>{
    const t=await fixture();let lost=false;t.deps.render=async()=>{lost=true;throw new ErpError('SECRET unknown provider code',500);};t.deps.authority=async()=>{if(lost)throw new AccountPublicError('Synthetic revoked',403);return{mode:'browser',actor:t.actor};};const r=await t.invoice();expect(r.status).toBe(403);expect(await r.json()).toEqual({error:'forbidden'});
  });
  it('does not invoke a malformed private authorization exception accessor during failure revalidation',async()=>{
    const t=await fixture();let failed=false;const get=vi.fn(()=>{throw Error('SECRET exception getter');}),error=Object.defineProperty(new ErpError('SECRET unknown',500),'status',{get});
    t.deps.render=()=>{failed=true;throw Error('SECRET renderer');};t.deps.authority=async()=>{if(failed)throw error;return{mode:'browser',actor:t.actor};};
    const r=await t.invoice();expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'financial_export_unavailable'});expect(get).not.toHaveBeenCalled();
  });
});
