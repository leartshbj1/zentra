import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { US_FINANCIAL_PILOT_EXPORT_HEADERS as h, validateUsFinancialPilotExportSelector, type UsFinancialPilotExportSelector } from './us-financial-pilot-export-contract';
import { browserUsFinancialPilotExportUrl, createBrowserUsFinancialPilotExportSession } from './browser-us-financial-pilot-export-session';
import { browserUsFinancialPilotExportErrorCopy, browserUsFinancialPilotExportCopy } from './browser-us-financial-pilot-export-copy';
import { AccountPublicError } from '../account-security';
import { ErpError } from './erp-contract';
import { createBrowserUsFinancialPilotSession, type BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { createUsFinancialPilotCommercialHandlers } from './us-financial-pilot-commercial-server';
import { createUsFinancialPilotAccountingHandlers } from './us-financial-pilot-accounting-server';
import { createUsFinancialPilotBankHandlers } from './us-financial-pilot-bank-server';
import { appendUsFinancialPilotBankRegister, validateUsFinancialPilotBankHistory, type UsFinancialPilotBankPort, type UsFinancialPilotBankRegister } from './us-financial-pilot-bank';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';
import { sha256Hex } from './canonical-hash';

const organizationId='synthetic-us-company',expectedUserId='synthetic-finance-user';
const selector:UsFinancialPilotExportSelector={kind:'invoice',invoiceId:'invoice-synthetic',revision:8,format:'pdf',language:'en'};
const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic transport bytes, not a rendered document.\n%%EOF');
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
const sessions: Array<{ dispose(): void }> = [];
afterEach(()=>{for(const session of sessions.splice(0)) session.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
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
    expect(init).toMatchObject({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

/** Real financial owner, V5 memory store, projections and HTTP handlers.
 * Only Auth/D1, seller identity, renderer bytes and transport faults are synthetic.
 * The separate PostgreSQL and renderer recipes prove those other boundaries. */
async function quoteFixture() {
  const original = await financialKernelFixture({ tax: '0', paid: '10000' });
  const org = '11111111-1111-4111-8111-111111111111', origin = 'https://zentra.test';
  const data = JSON.parse(JSON.stringify(original).replaceAll(original.actor.organizationId, org)) as typeof original;
  const initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const memory = await createInMemoryUsFinancialKernelStoreV5(initial, data.policy, actor => actor);
  const readBook = async () => await memory.read(org) as UsFinancialBookV5;
  let denied = 0, sequence = 100;
  const uid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const scope = { scope: { organizationId: org, actor: data.actor, policy: data.policy, grantVersion: 1 }, optInVersion: 1 };
  const shared = { enabled: () => true, authority: async () => { if (denied) throw new AccountPublicError('Synthetic access revoked', denied); return { mode: 'browser' as const, actor: data.actor }; }, configuration: async () => data.configuration, scope: async () => scope, rateLimit: async () => {}, diagnostic: () => {} };
  const store = { ...memory, head: async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: (await readBook()).revision }) };
  const deps: UsFinancialPilotDependencies = { ...shared, store: () => store };
  const finance = createUsFinancialPilotHandlers(deps), commercial = createUsFinancialPilotCommercialHandlers(deps), accounting = createUsFinancialPilotAccountingHandlers(deps);
  let register: UsFinancialPilotBankRegister = { schemaVersion: 1, organizationId: org, bankRevision: 0, records: [], operations: [] };
  const bankStore: UsFinancialPilotBankPort = {
    read: async () => ({ book: await readBook(), register }), head: async () => ({ ...await store.head(), bankRevision: register.bankRevision }),
    receipt: async requestId => register.operations.find(proof => proof.request.requestId === requestId) ?? null,
    commit: async input => {
      const previous = register.operations.find(proof => proof.request.requestId === input.request.requestId);
      if (previous) { if (canonicalErpJson(previous) !== canonicalErpJson(input.proof)) throw new ErpError('idempotency_conflict', 409); return previous; }
      if (input.request.expectedRevision !== (await readBook()).revision || input.request.expectedBankRevision !== register.bankRevision) throw new ErpError('revision_conflict', 409);
      const next = appendUsFinancialPilotBankRegister(register, input.record, input.proof);
      await validateUsFinancialPilotBankHistory(await readBook(), next); register = next; return input.proof;
    },
  };
  const bank = createUsFinancialPilotBankHandlers({ ...shared, store: () => bankStore });
  const exportDeps: UsFinancialPilotExportDependencies = {
    ...deps, diagnostic: () => {}, fonts: () => ({ regular: new Uint8Array([1]), bold: new Uint8Array([2]) }),
    render: vi.fn(() => new Uint8Array(pdf)), hash: sha256Hex,
    quoteIdentity: async () => ({ organizationId: org, countryRevision: 7, configuration: data.configuration, sellerRevision: 11, seller: { displayName: 'Synthetic Current Seller', contactEmail: 'seller@example.test' } }),
  };
  const exports = createUsFinancialPilotExportHandlers(exportDeps), base = `/api/international/workspaces/${org}/financial-pilot`;
  const dispatch = async (request: Request) => {
    const path = new URL(request.url).pathname.slice(base.length);
    if (path === '/snapshot') return finance.SNAPSHOT(request, org);
    if (path === '/head') return finance.HEAD(request, org);
    if (path === '/operations') return finance.POST(request, org);
    if (path === '/commercial/operations') return commercial.POST(request, org);
    if (path === '/accounting/operations') return accounting.POST(request, org);
    if (path === '/bank/head') return bank.HEAD(request, org);
    if (path === '/bank/context') return bank.CONTEXT(request, org);
    if (path === '/bank/operations') return bank.POST(request, org);
    if (path.startsWith('/estimates/')) return commercial.ESTIMATE(request, org, decodeURIComponent(path.slice(11)));
    if (path.startsWith('/exports/estimates/')) return exports.ESTIMATE(request, org, decodeURIComponent(path.slice(19)));
    throw Error('Unexpected synthetic quote test route ' + path);
  };
  type Intercept = (request: Request, next: () => Promise<Response>) => Promise<Response>;
  let intercept: Intercept | undefined;
  const requests: { path: string; method: string; body: string; signal: AbortSignal }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin');
    const request = new Request(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, origin), { ...init, headers });
    requests.push({ path: new URL(request.url).pathname.slice(base.length), method: request.method, body: request.method === 'POST' ? await request.clone().text() : '', signal: request.signal });
    return intercept ? intercept(request, () => dispatch(request)) : dispatch(request);
  });
  const financialSession: BrowserUsFinancialPilotSession = createBrowserUsFinancialPilotSession({ organizationId: org, expectedUserId: data.actor.userId, fetch: fetcher, newId: uid, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } });
  sessions.push(financialSession);
  const makeExport = (owner: Pick<BrowserUsFinancialPilotSession, 'getState' | 'subscribe'> | undefined = financialSession) => {
    const session = createBrowserUsFinancialPilotExportSession({ organizationId: org, expectedUserId: data.actor.userId, fetch: fetcher, financialSession: owner }); sessions.push(session); return session;
  };
  const exportSession = makeExport();
  const quote = () => ({ kind: 'estimate' as const, estimateId: 'estimate-1', estimateRevision: 2, revision: financialSession.getState().snapshot!.revision, language: 'en' as const, format: 'pdf' as const });
  const payment = { type: 'customer_payment' as const, invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic quote test payment' };
  const customer = { kind: 'business' as const, name: 'Synthetic customer', billingAddress: data.configuration.address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 };
  const importDraft = { text: 'date,amount,reference\n2026-10-10,100.00,Synthetic receipt\n', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: '0', closing: '100.00' };
  const externalBank = async () => bank.POST(new Request(`${origin}${base}/bank/operations`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': data.actor.userId },
    body: JSON.stringify({ consumer: 'financial-pilot', schemaVersion: 1, requestId: uid(), expectedRevision: (await readBook()).revision, expectedBankRevision: register.bankRevision, expectedStatementRevision: null,
      command: { type: 'create_statement', cashAccountId: 'cash', start: importDraft.start, end: importDraft.end, openingMinor: '0', closingMinor: '10000', lines: [{ date: '2026-10-10', amountMinor: '10000', reference: 'Synthetic receipt' }] } }) }), org);
  const externalFinance = async () => executeUsFinancialKernelV5({ configuration: data.configuration, actor: data.actor, policy: data.policy, store: memory, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }), resolveTax: async () => { throw Error('No external provider in this quote test'); } },
    { idempotencyKey: 'synthetic-quote-test-' + uid(), expectedRevision: (await readBook()).revision, command: { type: 'erp_command', request: { type: 'close_period', periodId: '2026' } } });
  return { ...data, org, initial, financialSession, exportSession, makeExport, quote, readBook, register: () => register, requests, fetcher, customer, payment, importDraft, externalBank, externalFinance,
    ready: () => financialSession.load(), intercept: (value?: Intercept) => { intercept = value; }, deny: (status: number) => { denied = status; } };
}

function downloads() {
  const click = vi.fn(); vi.stubGlobal('document', { createElement: vi.fn(() => ({ href: '', download: '', rel: '', click })) });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-quote');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { click, create, revoke };
}

describe('quote PDF transport with the real shared financial owner', () => {
  it('encodes the closed estimate selector without another document or bank parameter', () => {
    const value: UsFinancialPilotExportSelector = { kind: 'estimate', estimateId: 'estimate:é /#', estimateRevision: 2, revision: 8, language: 'fr', format: 'pdf' };
    expect(browserUsFinancialPilotExportUrl(organizationId, value)).toBe('/api/international/workspaces/synthetic-us-company/financial-pilot/exports/estimates/estimate%3A%C3%A9%20%2F%23?revision=8&language=fr&format=pdf&estimateRevision=2');
  });
  it.each(['fr', 'de', 'it', 'en'] as const)('explains current issuer, saved recipient and quote-specific recovery in %s', language => {
    const copy = browserUsFinancialPilotExportCopy[language];
    expect(copy.estimatePdf).not.toBe(copy.invoicePdf); expect(copy.identityCurrent.length).toBeGreaterThan(40);
    expect(browserUsFinancialPilotExportErrorCopy(language, 'financial_pilot_export_too_large', 'estimate')).toBe(copy.estimateTooLarge);
    expect(browserUsFinancialPilotExportErrorCopy(language, 'financial_snapshot_changed', 'estimate')).toBe(copy.estimateChanged);
    for (const code of ['financial_pilot_seller_required', 'financial_pilot_quote_identity_changed', 'financial_export_owner_required', 'financial_export_owner_changed', 'export_in_progress']) expect(browserUsFinancialPilotExportErrorCopy(language, code, 'estimate')).not.toBe(copy.unavailable);
  });
  it('reads a saved real V5 quote through ESTIMATE and preserves every financial and bank byte', async () => {
    const t = await quoteFixture(); await t.ready();
    const detail = await t.financialSession.readEstimate('estimate-1'), before = canonicalErpJson(await t.readBook()), bankBefore = canonicalErpJson(t.register());
    const selected = t.quote(), result = await t.exportSession.file(selected);
    expect(detail.estimate.revision).toBe(selected.estimateRevision); expect(result.revision).toBe(detail.revision);
    expect(result.filename).toBe(`zentra-estimate-r${selected.revision}-e2-en.pdf`); expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(pdf);
    expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain(`/exports/estimates/estimate-1?revision=${selected.revision}&language=en&format=pdf&estimateRevision=2`);
    expect(canonicalErpJson(await t.readBook())).toBe(before); expect(canonicalErpJson(t.register())).toBe(bankBefore);
    expect(t.financialSession.getState()).toMatchObject({ pending: false, writing: false, requiresRefresh: false });
  });
  it('requires the financial owner for a quote but leaves historical invoice reads available without one', async () => {
    const t = await quoteFixture(); await t.ready(); const absent = createBrowserUsFinancialPilotExportSession({ organizationId: t.org, expectedUserId: t.actor.userId, fetch: t.fetcher }); sessions.push(absent);
    const count = t.requests.length; await expect(absent.file(t.quote())).rejects.toMatchObject({ code: 'financial_export_owner_required', status: 409 }); expect(t.requests).toHaveLength(count);
    const oldInvoice = fixture(vi.fn(async () => response())); sessions.push(oldInvoice); expect((await oldInvoice.file(selector)).revision).toBe(8);
  });
  it('rejects an F mismatch before GET and never silently retargets the saved quote', async () => {
    const t = await quoteFixture(); await t.ready(); const count = t.requests.length;
    await expect(t.exportSession.file({ ...t.quote(), revision: t.quote().revision + 1 })).rejects.toMatchObject({ code: 'financial_export_owner_changed' });
    expect(t.requests).toHaveLength(count);
  });
  it('captures the owner methods instead of following replacements on the same object', async () => {
    const t = await quoteFixture(); await t.ready(); const selected = t.quote();
    const owner: Pick<BrowserUsFinancialPilotSession, 'getState' | 'subscribe'> = {
      getState: () => t.financialSession.getState(), subscribe: listener => t.financialSession.subscribe(listener),
    };
    const exportSession = createBrowserUsFinancialPilotExportSession({ organizationId: t.org, expectedUserId: t.actor.userId, financialSession: owner, fetch: t.fetcher }); sessions.push(exportSession);
    owner.getState = () => { throw Error('Replaced owner method must not run'); };
    owner.subscribe = () => { throw Error('Replaced owner subscription must not run'); };
    expect((await exportSession.file(selected)).revision).toBe(selected.revision);
  });
  it.each([
    [h.estimateRevision, null], [h.estimateRevision, '3'], [h.estimateRevision, '02'],
    [h.countryRevision, null], [h.countryRevision, '0'], [h.countryRevision, '9007199254740991'],
    [h.sellerRevision, null], [h.sellerRevision, '0'], [h.sellerRevision, '1e2'],
    [h.issuerBasis, null], [h.issuerBasis, 'at_issue'],
    ['Content-Disposition', 'attachment; filename="zentra-invoice-r7-en.pdf"'],
  ])('rejects forged quote metadata %s=%s and cancels before the body reader', async (name, value) => {
    const t = await quoteFixture(); await t.ready(); const cancel = vi.fn();
    t.intercept(async (request, next) => {
      const reply = await next(); if (!request.url.includes('/exports/')) return reply;
      const headers = new Headers(reply.headers); if (value === null) headers.delete(name); else headers.set(name, value);
      await reply.body?.cancel(); return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdf); }, cancel }), { status: reply.status, headers });
    });
    await expect(t.exportSession.file(t.quote())).rejects.toMatchObject({ code: 'invalid_export_response' });
    expect(cancel).toHaveBeenCalledOnce(); expect(t.requests.at(-1)?.signal.aborted).toBe(true);
  });
  it('captures the estimate selector and allows only one flight synchronously', async () => {
    const t = await quoteFixture(); await t.ready(); const held = deferred<Response>();
    t.intercept((request, next) => request.url.includes('/exports/') ? held.promise : next());
    const mutable = { ...t.quote() }, original = { ...mutable }, task = t.exportSession.file(mutable);
    mutable.estimateId = 'substituted'; mutable.estimateRevision = 3; mutable.revision++;
    await expect(t.exportSession.file(original)).rejects.toMatchObject({ code: 'export_in_progress' });
    await vi.waitFor(() => expect(t.requests.filter(row => row.path.startsWith('/exports/'))).toHaveLength(1));
    expect(t.requests.at(-1)?.path).toBe('/exports/estimates/estimate-1');
    t.intercept();
    const reply = await t.fetcher(browserUsFinancialPilotExportUrl(t.org, original), { method: 'GET', headers: { [h.scope]: '1', 'X-Zentra-Expected-User': t.actor.userId } });
    held.resolve(reply); expect((await task).revision).toBe(original.revision);
  });
  it.each(['payment', 'commercial', 'purchasing', 'accounting', 'invoice_prepare', 'bank'] as const)('refuses before GET while a real owner keeps an uncertain %s pending', async kind => {
    const t = await quoteFixture(); await t.ready();
    const review = kind === 'bank' ? (await t.financialSession.refreshBank(), await t.financialSession.readBankContext(), t.financialSession.reviewBankImport(t.importDraft)) : null;
    t.intercept((request, next) => request.method === 'POST' ? Promise.resolve(Response.json({ error: 'service_unavailable' }, { status: 503 })) : next());
    const write = kind === 'payment' ? t.financialSession.recordPayment(t.payment)
      : kind === 'commercial' ? t.financialSession.commercial({ type: 'create_customer', customer: t.customer })
      : kind === 'purchasing' ? t.financialSession.purchasing({ type: 'save_vendor', vendorId: null, vendor: t.customer })
      : kind === 'accounting' ? t.financialSession.accounting({ type: 'close_period', periodId: '2026' })
      : kind === 'bank' ? t.financialSession.submitBank(review!, true)
      : t.financialSession.prepareInvoice({ type: 'issue_invoice', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026' }, { classifications: [{ lineId: 'line-1', taxCode: 'txcd_20030000', confirmedService: true }], taxDateInstant: '2026-10-10T12:00:00.000Z', addressSource: 'billing' });
    await expect(write).rejects.toMatchObject({ outcome: 'uncertain' });
    const pending = t.financialSession.getState(), body = t.requests.find(row => row.method === 'POST')?.body, count = t.requests.length;
    await expect(t.exportSession.file(t.quote())).rejects.toMatchObject({ code: 'financial_export_owner_changed' });
    expect(t.requests).toHaveLength(count); expect(t.financialSession.getState()).toBe(pending); expect(t.financialSession.hasPending()).toBe(true);
    expect(t.requests.find(row => row.method === 'POST')?.body).toBe(body);
  });
  it('aborts an in-flight quote on payment start without blocking the real payment or changing its pending body', async () => {
    const t = await quoteFixture(); await t.ready(); const held = deferred<Response>();
    t.intercept((request, next) => request.url.includes('/exports/') ? held.promise : next());
    const task = t.exportSession.file(t.quote()), rejected = expect(task).rejects.toMatchObject({ code: 'financial_export_owner_changed' });
    await vi.waitFor(() => expect(t.requests.some(row => row.path.startsWith('/exports/'))).toBe(true));
    const receipt = await t.financialSession.recordPayment(t.payment); await rejected;
    expect(receipt.revision).toBe(t.initial.revision + 1); expect(t.requests.find(row => row.path.startsWith('/exports/'))?.signal.aborted).toBe(true);
    const cancel = vi.fn(); held.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }))); await settle(); expect(cancel).toHaveBeenCalledOnce();
    expect(t.financialSession.hasPending()).toBe(false);
  });
  it('cancels a quote body already being read when the real owner begins a write', async () => {
    const t = await quoteFixture(); await t.ready(); const cancel = vi.fn(), pull = vi.fn();
    t.intercept(async (request, next) => {
      const reply = await next(); if (!request.url.includes('/exports/')) return reply;
      await reply.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdf.subarray(0, 2)); }, pull, cancel }), { status: reply.status, headers: reply.headers });
    });
    const task = t.exportSession.file(t.quote()), rejected = expect(task).rejects.toMatchObject({ code: 'financial_export_owner_changed' });
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    await t.financialSession.recordPayment(t.payment); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(t.requests.find(row => row.path.startsWith('/exports/'))?.signal.aborted).toBe(true);
  });
  it('keeps the deadline active for a real quote body and permits another request after timeout', async () => {
    const t = await quoteFixture(); await t.ready(); const cancel = vi.fn();
    t.intercept(async (request, next) => {
      const reply = await next(); if (!request.url.includes('/exports/')) return reply;
      await reply.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdf.subarray(0, 2)); }, cancel }), { status: reply.status, headers: reply.headers });
    });
    const short = createBrowserUsFinancialPilotExportSession({ organizationId: t.org, expectedUserId: t.actor.userId, fetch: t.fetcher, financialSession: t.financialSession, timeoutMs: 500 }); sessions.push(short);
    await expect(short.file(t.quote())).rejects.toMatchObject({ code: 'export_timeout' }); expect(cancel).toHaveBeenCalledOnce();
    t.intercept(); expect((await short.file(t.quote())).revision).toBe(t.quote().revision);
  });
  it('checks the owner again after content hashing and never adopts bytes after synchronous stop', async () => {
    const t = await quoteFixture(); await t.ready();
    const digest = crypto.subtle.digest.bind(crypto.subtle); let pdfDigests = 0;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      const output = await digest(algorithm, bytes);
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // First PDF digest is the real server's content hash; second is the browser's verification.
      if (new TextDecoder().decode(view).startsWith('%PDF-') && ++pdfDigests === 2) t.financialSession.stop();
      return output;
    });
    await expect(t.exportSession.file(t.quote())).rejects.toMatchObject({ code: 'session_changed', unauthorized: true });
    expect(pdfDigests).toBe(2); expect(t.financialSession.getState().status).toBe('stopped');
  });
  it('invalidates owned URLs on a local bank write even when F stays unchanged', async () => {
    const t = await quoteFixture(); await t.ready(); await t.financialSession.refreshBank(); await t.financialSession.readBankContext();
    const download = downloads(), selected = t.quote(), result = await t.exportSession.file(selected); t.exportSession.download(result);
    const review = t.financialSession.reviewBankImport(t.importDraft), receipt = await t.financialSession.submitBank(review, true); await settle();
    expect(receipt.revision).toBe(selected.revision); expect(receipt.bankRevision).toBe(1); expect(download.revoke).toHaveBeenCalledWith('blob:synthetic-quote');
    expect(() => t.exportSession.download(result)).toThrow('financial_export_owner_changed');
  });
  it('preserves a quote and snapshot identity after external B-only changes or a bank-only read error', async () => {
    const t = await quoteFixture(); await t.ready(); await t.financialSession.refreshBank(); const snapshot = t.financialSession.getState().snapshot;
    const download = downloads(), result = await t.exportSession.file(t.quote());
    expect((await t.externalBank()).status).toBe(200); await t.financialSession.refreshBank();
    expect(t.financialSession.getState().snapshot).toBe(snapshot); expect(t.financialSession.getState().bank.head?.bankRevision).toBe(1);
    t.intercept((request, next) => request.url.includes('/bank/head') ? Promise.resolve(Response.json({ error: 'service_unavailable' }, { status: 503 })) : next());
    await expect(t.financialSession.refreshBank()).rejects.toBeDefined();
    expect(t.financialSession.getState()).toMatchObject({ requiresRefresh: false, bank: { requiresRefresh: true } });
    t.exportSession.download(result); expect(download.click).toHaveBeenCalledOnce();
  });
  it('rejects downloads and in-flight bytes as soon as HEAD proves F changed, even while the snapshot is held', async () => {
    const t = await quoteFixture(); await t.ready(); const old = t.financialSession.getState().snapshot, selected = t.quote(), download = downloads();
    const result = await t.exportSession.file(selected); t.exportSession.download(result);
    const heldExport = deferred<Response>(), heldSnapshot = deferred<Response>();
    t.intercept((request, next) => request.url.includes('/exports/') ? heldExport.promise : request.url.includes('/snapshot') ? heldSnapshot.promise : next());
    const task = t.exportSession.file(selected), rejected = expect(task).rejects.toMatchObject({ code: 'financial_export_owner_changed' });
    await vi.waitFor(() => expect(t.requests.filter(row => row.path.startsWith('/exports/'))).toHaveLength(2));
    await t.externalFinance(); const refreshing = t.financialSession.refresh();
    await vi.waitFor(() => expect(t.financialSession.getState().requiresRefresh).toBe(true)); await rejected;
    expect(t.financialSession.getState().snapshot).toBe(old); expect(download.revoke).toHaveBeenCalledWith('blob:synthetic-quote');
    expect(() => t.exportSession.download(result)).toThrow('financial_export_owner_changed');
    heldSnapshot.resolve(Response.json({ error: 'service_unavailable' }, { status: 503 })); await expect(refreshing).rejects.toBeDefined();
    heldExport.resolve(new Response('Late unowned response')); await settle();
  });
  it('releases the flight after a rejected write and permits a fresh request after same-F reload, never an old result', async () => {
    const t = await quoteFixture(); await t.ready(); const selected = t.quote(), previous = await t.exportSession.file(selected);
    t.intercept((request, next) => request.method === 'POST' ? Promise.resolve(Response.json({ error: 'revision_conflict' }, { status: 409 })) : next());
    await expect(t.financialSession.recordPayment(t.payment)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(t.financialSession.hasPending()).toBe(false); t.intercept(); await t.financialSession.load();
    expect(t.quote().revision).toBe(selected.revision); expect(() => t.exportSession.download(previous)).toThrow('financial_export_owner_changed');
    expect((await t.exportSession.file(t.quote())).revision).toBe(selected.revision);
  });
  it.each(['stop', 'denial', 'dispose'] as const)('purges quote results, URLs and late responses on %s', async reason => {
    const t = await quoteFixture(); await t.ready(); const download = downloads(), selected = t.quote(), result = await t.exportSession.file(selected); t.exportSession.download(result);
    const held = deferred<Response>(); t.intercept((request, next) => request.url.includes('/exports/') ? held.promise : next());
    const task = t.exportSession.file(selected), rejected = expect(task).rejects.toMatchObject({ code: 'session_changed', unauthorized: true });
    await vi.waitFor(() => expect(t.requests.filter(row => row.path.startsWith('/exports/'))).toHaveLength(2));
    if (reason === 'stop') t.financialSession.stop();
    else if (reason === 'dispose') t.exportSession.dispose();
    else { t.deny(403); await expect(t.financialSession.refresh()).rejects.toMatchObject({ outcome: 'unauthorized' }); }
    await rejected; expect(() => t.exportSession.download(result)).toThrow('session_changed'); expect(download.revoke).toHaveBeenCalledWith('blob:synthetic-quote');
    const cancel = vi.fn(); held.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }))); await settle(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects cloned and foreign-session results and rechecks ownership after a reentrant link creation', async () => {
    const t = await quoteFixture(); await t.ready(); const result = await t.exportSession.file(t.quote()), other = t.makeExport();
    expect(() => t.exportSession.download({ ...result })).toThrow('invalid_export_response'); expect(() => other.download(result)).toThrow('invalid_export_response');
    const download = downloads(); vi.stubGlobal('document', { createElement: () => { t.financialSession.stop(); return { href: '', download: '', rel: '', click: download.click }; } });
    expect(() => t.exportSession.download(result)).toThrow('session_changed'); expect(download.click).not.toHaveBeenCalled(); expect(download.revoke).toHaveBeenCalledWith('blob:synthetic-quote');
  });
});
