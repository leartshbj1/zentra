import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { US_FINANCIAL_PILOT_EXPORT_HEADERS as h, validateUsFinancialPilotExportSelector, type UsFinancialPilotExportSelector } from './us-financial-pilot-export-contract';
import { browserUsFinancialPilotExportUrl, createBrowserUsFinancialPilotExportSession } from './browser-us-financial-pilot-export-session';
import { browserUsFinancialPilotExportErrorCopy } from './browser-us-financial-pilot-export-copy';

const organizationId='synthetic-us-company',expectedUserId='synthetic-finance-user';
const selector:UsFinancialPilotExportSelector={kind:'invoice',invoiceId:'invoice-synthetic',revision:8,format:'pdf',language:'en'};
const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic transport bytes, not a rendered document.');
async function hash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('');}
async function response(input:UsFinancialPilotExportSelector=selector,options:{body?:Uint8Array;headers?:Record<string,string|null>;status?:number;stream?:ReadableStream<Uint8Array>}={}):Promise<Response>{
  const bytes=options.body??pdf,headers=new Headers({
    'Content-Type':input.format==='pdf'?'application/pdf':'text/csv; charset=utf-8',
    'Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="Zentra-synthetic.${input.format}"`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',[h.scope]:'1',[h.organization]:organizationId,
    [h.currency]:'USD',[h.language]:input.language,[h.format]:input.format,[h.revision]:String(input.revision),[h.ledgerRevision]:'5',
    [h.selectorHash]:await hash(new TextEncoder().encode(canonicalErpJson(validateUsFinancialPilotExportSelector(input)))),[h.contentHash]:await hash(bytes),
  });
  for(const [name,value] of Object.entries(options.headers??{})){if(value===null)headers.delete(name);else headers.set(name,value);}
  return new Response(options.stream??new Uint8Array(bytes),{status:options.status??200,headers});
}
const fixture=(fetcher:typeof fetch,timeoutMs?:number)=>createBrowserUsFinancialPilotExportSession({organizationId,expectedUserId,fetch:fetcher,timeoutMs});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('financial pilot export browser transport',()=>{
  it.each(['fr','de','it','en'] as const)('offers a recovery for the actual document kind in %s',language=>{
    const code='financial_pilot_export_too_large';
    const invoice=browserUsFinancialPilotExportErrorCopy(language,code,'invoice');
    const report=browserUsFinancialPilotExportErrorCopy(language,code,'report');
    expect(invoice).not.toBe(report);expect(invoice).toMatch(/numéro|number|Rechnungsnummer|numero/);
    expect(browserUsFinancialPilotExportErrorCopy(language,'financial_export_timeout')).not.toBe(browserUsFinancialPilotExportErrorCopy(language,'private-secret'));
  });
  it('downloads only the exact revision with cookie-only scoped headers and verified bytes',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>response()),session=fixture(fetcher);const result=await session.file(selector);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(pdf);expect(result).toMatchObject({filename:'Zentra-synthetic.pdf',revision:8,ledgerRevision:5});
    expect(fetcher).toHaveBeenCalledTimes(1);const [url,init]=fetcher.mock.calls[0];
    expect(url).toBe('/api/international/workspaces/synthetic-us-company/financial-pilot/exports/invoices/invoice-synthetic?revision=8&language=en&format=pdf');
    expect(init).toMatchObject({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error'});
    expect(init?.headers).toEqual({Accept:'application/pdf',[h.scope]:'1','X-Zentra-Expected-User':expectedUserId});session.dispose();
  });
  it.each([
    [{kind:'report',reportType:'trial_balance',asOf:'2026-10-10'},'trial_balance?revision=8&language=de&format=csv&asOf=2026-10-10'],
    [{kind:'report',reportType:'profit_loss',from:'2026-01-01',to:'2026-10-10'},'profit_loss?revision=8&language=de&format=csv&from=2026-01-01&to=2026-10-10'],
    [{kind:'report',reportType:'general_ledger',from:'2026-01-01',to:'2026-10-10',accountId:'account:bank'},'general_ledger?revision=8&language=de&format=csv&from=2026-01-01&to=2026-10-10&accountId=account%3Abank'],
    [{kind:'report',reportType:'receivables'},'receivables?revision=8&language=de&format=csv'],
  ])('encodes only the declared report selector %j',(report,suffix)=>{
    const value={...report,revision:8,language:'de',format:'csv'} as UsFinancialPilotExportSelector;
    expect(browserUsFinancialPilotExportUrl(organizationId,value)).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/exports/reports/${suffix}`);
  });
  it('accepts exact UTF-8 BOM CSV bytes without interpreting spreadsheet text',async()=>{
    const value:UsFinancialPilotExportSelector={kind:'report',reportType:'receivables',revision:8,language:'fr',format:'csv'};
    const bytes=new TextEncoder().encode('\uFEFF"Créances","10.50"\r\n');const session=fixture(vi.fn(async()=>response(value,{body:bytes})));
    expect(new Uint8Array(await(await session.file(value)).blob.arrayBuffer())).toEqual(bytes);session.dispose();
  });
  it.each([
    [h.scope,'4'],[h.organization,'other-company'],[h.currency,'CHF'],[h.language,'fr'],[h.format,'csv'],
    [h.selectorHash,'0'.repeat(64)],[h.contentHash,'0'.repeat(64)],[h.contentHash,'private:secret'],
    [h.ledgerRevision,'9'],[h.revision,'08'],[h.revision,null],[h.ledgerRevision,'9007199254740992'],
    ['Content-Type','text/html'],['Content-Length',null],['Content-Length','0'],['Content-Length','012'],
    ['Content-Length',String(12*1024*1024+1)],['Content-Disposition','inline; filename="Zentra.pdf"'],
    ['Content-Disposition','attachment; filename="../../secret.pdf"'],['Content-Disposition','attachment; filename="file.csv"'],
    ['Cache-Control','public, max-age=600'],['X-Content-Type-Options',null],
  ])('rejects a substituted or unsafe response header %s=%s',async(name,value)=>{
    const session=fixture(vi.fn(async()=>response(selector,{headers:{[name]:value}})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'invalid_export_response'});session.dispose();
  });
  it('reports a changed financial revision without retargeting or retrying',async()=>{
    const fetcher=vi.fn(async()=>response(selector,{headers:{[h.revision]:'9'}})),session=fixture(fetcher);
    await expect(session.file(selector)).rejects.toMatchObject({code:'financial_snapshot_changed',status:409});expect(fetcher).toHaveBeenCalledTimes(1);session.dispose();
  });
  it('rejects truncated bytes and never trusts the advertised size alone',async()=>{
    const session=fixture(vi.fn(async()=>response(selector,{headers:{'Content-Length':String(pdf.length+1)}})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'invalid_export_response'});session.dispose();
  });
  it('stops a body that exceeds its advertised limit before making a Blob',async()=>{
    const cancel=vi.fn(),stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(pdf);controller.enqueue(new Uint8Array([1]));},cancel});
    const session=fixture(vi.fn(async()=>response(selector,{stream})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'invalid_export_response'});expect(cancel).toHaveBeenCalledOnce();session.dispose();
  });
  it.each(['<html>not a pdf</html>','{"private":"not a document"}'])('rejects false PDF content after all headers match',async text=>{
    const session=fixture(vi.fn(async()=>response(selector,{body:new TextEncoder().encode(text)})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'invalid_export_response'});session.dispose();
  });
  it('rejects invalid UTF-8 or absent BOM in a CSV response',async()=>{
    const value:UsFinancialPilotExportSelector={kind:'report',reportType:'receivables',revision:8,language:'en',format:'csv'};
    for(const bytes of [new Uint8Array([239,187,191,255]),new TextEncoder().encode('plain,csv\r\n')]){
      const session=fixture(vi.fn(async()=>response(value,{body:bytes})));await expect(session.file(value)).rejects.toBeDefined();session.dispose();
    }
  });
  it.each([401,402,403])('terminally clears this instance on access refusal %s',async status=>{
    const fetcher=vi.fn(async()=>new Response('{"error":"forbidden"}',{status})),session=fixture(fetcher);
    await expect(session.file(selector)).rejects.toMatchObject({unauthorized:true,status});
    await expect(session.file(selector)).rejects.toMatchObject({code:'session_changed',unauthorized:true});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reveals only closed public errors, never private server detail',async()=>{
    for(const body of ['{"error":"secret-provider-reference"}','{"error":"financial_snapshot_changed","detail":"private"}','not json']){
      const session=fixture(vi.fn(async()=>new Response(body,{status:503})));await expect(session.file(selector)).rejects.toMatchObject({code:'export_unavailable'});session.dispose();
    }
    const session=fixture(vi.fn(async()=>new Response('{"error":"financial_snapshot_changed"}',{status:409})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'financial_snapshot_changed',status:409});session.dispose();
  });
  it('bounds error response bodies too',async()=>{
    const session=fixture(vi.fn(async()=>new Response('x'.repeat(4097),{status:503})));
    await expect(session.file(selector)).rejects.toMatchObject({code:'invalid_export_response'});session.dispose();
  });
  it('captures a mutable selector before the first await',async()=>{
    const mutable={...selector},fetcher=vi.fn<typeof fetch>(async()=>response(selector)),session=fixture(fetcher);
    const promise=session.file(mutable);mutable.revision=9;mutable.language='fr';
    expect((await promise).revision).toBe(8);expect(fetcher.mock.calls[0][0]).toContain('revision=8&language=en');session.dispose();
  });
  it('invalidates a late fetch response after disposal',async()=>{
    let resolve!:(response:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(done=>{resolve=done;})),session=fixture(fetcher);
    const promise=session.file(selector);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());const rejected=expect(promise).rejects.toMatchObject({code:'session_changed'});
    session.dispose();resolve(await response());await rejected;
  });
  it('invalidates a late body and cancels the stream after disposal',async()=>{
    const cancel=vi.fn(),stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(pdf.subarray(0,2));},cancel});
    const fetcher=vi.fn(async()=>response(selector,{stream})),session=fixture(fetcher);
    const promise=session.file(selector);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,5));
    const rejected=expect(promise).rejects.toMatchObject({code:'session_changed'});session.dispose();await rejected;expect(cancel).toHaveBeenCalledOnce();
  });
  it('keeps the deadline active while a body never completes',async()=>{
    const cancel=vi.fn(),stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(pdf.subarray(0,2));},cancel});
    const session=fixture(vi.fn(async()=>response(selector,{stream})),100);
    await expect(session.file(selector)).rejects.toMatchObject({code:'export_timeout'});expect(cancel).toHaveBeenCalledOnce();session.dispose();
  });
  it('allows only owned results and revokes download URLs on disposal',async()=>{
    const click=vi.fn(),link={href:'',download:'',rel:'',click};vi.stubGlobal('document',{createElement:vi.fn(()=>link)});
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:synthetic'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    const session=fixture(vi.fn(async()=>response())),other=fixture(vi.fn(async()=>response())),result=await session.file(selector);
    expect(()=>other.download(result)).toThrow('invalid_export_response');session.download(result);expect(click).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();expect(link.download).toBe(result.filename);
    session.dispose();expect(revoke).toHaveBeenCalledWith('blob:synthetic');expect(()=>session.download(result)).toThrow('session_changed');other.dispose();
  });
  it.each([{organizationId:'../cross-tenant',expectedUserId},{organizationId,expectedUserId:'private\u0085user'},{organizationId,expectedUserId,timeoutMs:0},{organizationId,expectedUserId,timeoutMs:120001}])('rejects invalid constructor scope %j',options=>expect(()=>createBrowserUsFinancialPilotExportSession(options)).toThrow('invalid_export_request'));
  it('refuses an expanded selector before fetch',async()=>{
    const fetcher=vi.fn(),session=fixture(fetcher);await expect(session.file({...selector,actor:'owner'} as UsFinancialPilotExportSelector)).rejects.toBeDefined();expect(fetcher).not.toHaveBeenCalled();session.dispose();
  });
});
