import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { executeErp } from './runtime';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpRequest, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import type { TaxCalculationProvider } from './invoicing';

const org = 'response-guard-US';
const config: CompanyConfiguration = {schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'configured'}};
const actor: FinancialAuthority = {organizationId:org,userId:'fictitious-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
const initial: ErpRequest = {idempotencyKey:'original-request',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}};
type Authority = {mode:'browser'|'device';actor:FinancialAuthority};
type Change = 'revoked'|'user'|'scope'|'mode'|'role'|'entitlement'|'flags'|'configuration';

// HTTP interleaving proof only. Storage records commits in memory and tax
// calculation is explicitly fictitious; no hosted database/provider is used.
function fixture() {
  let open = true, current: Authority = {mode:'browser',actor:{...actor}}, currentConfig = structuredClone(config);
  let authError: Error | null = null, state: ErpState | null = null, authCalls = 0, configCalls = 0;
  const receipts = new Map<string,ErpReceipt>();
  const hooks: {read?:()=>void;authority?:(call:number)=>void;configuration?:(call:number)=>void;commit?:()=>void;tax?:()=>void} = {};
  const commit = vi.fn(async (input: ErpCommit) => {
    const rows = <T extends {id:string}>(kind: ErpCommit['changes'][number]['kind'], old: readonly T[]) => {
      const values = new Map(old.map(row => [row.id,row]));
      for (const change of input.changes.filter(change => change.kind===kind)) values.set(change.id,structuredClone(change.payload) as T);
      return [...values.values()];
    };
    state = {...structuredClone(input.header),customers:rows('customer',state?.customers??[]),estimates:rows('estimate',state?.estimates??[]),invoices:rows('invoice',state?.invoices??[]),ledger:{...structuredClone(input.header.ledger),entries:rows('journal',state?.ledger.entries??[]),audit:[...(state?.ledger.audit??[]),...structuredClone(input.ledgerAudit)]}};
    receipts.set(input.receipt.idempotencyKey,structuredClone(input.receipt)); hooks.commit?.();
    return structuredClone(input.receipt);
  });
  const store: ErpStore = {read:async()=>{const captured=state;hooks.read?.();return captured;},receipt:async(_organizationId,key)=>receipts.get(key)??null,commit};
  const provider: TaxCalculationProvider = {id:'fixture-only',async calculate(request){hooks.tax?.();return {...request,source:'external-provider',providerReference:'fictitious-not-a-tax-determination',determinedAt:actor.timestamp,validUntil:'2026-10-09T12:00:00Z',lines:request.lines.map(line=>({id:line.id,taxMinor:'0',jurisdiction:'fictitious',evidenceReference:'fixture-only'}))};}};
  const dependencies: ErpServerDependencies = {
    enabled:vi.fn(async()=>open),
    authority:vi.fn(async()=>{if(authError)throw authError;const captured=structuredClone(current);hooks.authority?.(++authCalls);return captured;}),
    configuration:async()=>{const captured=structuredClone(currentConfig);hooks.configuration?.(++configCalls);return captured;},
    store:()=>store,taxProvider:async()=>provider,seller:async()=>({organizationId:org,displayName:'Fictitious seller'}),rateLimit:async()=>{},diagnostic:vi.fn(),
  };
  function change(kind: Change) {
    if(kind==='revoked')authError=new AccountPublicError('private revocation token',401);
    if(kind==='user')current={...current,actor:{...current.actor,userId:'different-user'}};
    if(kind==='scope')current={...current,actor:{...current.actor,organizationId:'different-workspace'}};
    if(kind==='mode')current.mode='device';
    if(kind==='role')current={...current,actor:{...current.actor,role:'read_only'}};
    if(kind==='entitlement')current={...current,actor:{...current.actor,managementEntitled:false}};
    if(kind==='flags')open=false;
    if(kind==='configuration')currentConfig={...currentConfig,language:'fr'};
  }
  function restore() {open=true;authError=null;current={mode:'browser',actor:{...actor}};currentConfig=structuredClone(config);for(const key of Object.keys(hooks))delete hooks[key as keyof typeof hooks];}
  const handlers = createErpHandlers(dependencies);
  const sync = createErpSyncHandlers({...dependencies,syncStore:()=>({revision:async()=>{hooks.read?.();return {schemaVersion:1,organizationId:org,revision:1};},changes:async()=>{hooks.read?.();return {schemaVersion:1,organizationId:org,fromRevision:1,toRevision:1,headRevision:1,hasMore:false,resetRequired:false,events:[]};}})});
  const request = () => new Request('https://zentra.test/erp/changes?after=1');
  const post = (body: ErpRequest = initial) => new Request('https://zentra.test/erp',{method:'POST',headers:{Origin:'https://zentra.test','Content-Type':'application/json'},body:JSON.stringify(body)});
  async function seed(command: ErpCommand) {return executeErp({store,configuration:config,actor,revalidate:async()=>actor,taxProvider:async()=>provider,seller:async()=>({organizationId:org,displayName:'Fictitious seller'})},{idempotencyKey:`seed-${receipts.size}`,expectedRevision:state?.revision??0,command});}
  async function issueRequest() {
    await seed(initial.command);
    await seed({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Fictitious customer',billingAddress:config.address,paymentTermsDays:30}});
    await seed({type:'save_estimate',id:'estimate',expectedEstimateRevision:0,customerId:'customer',date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:[{id:'line',description:'Fictitious service',quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'10000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:''});
    await seed({type:'accept_estimate',estimateId:'estimate',expectedEstimateRevision:1});commit.mockClear();
    return {idempotencyKey:'issue-original',expectedRevision:4,command:{type:'issue_invoice',id:'invoice',estimateId:'estimate',expectedEstimateRevision:2,date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-08',periodId:'2026'}} satisfies ErpRequest;
  }
  return {dependencies,handlers,sync,hooks,change,restore,commit,receipts,request,post,seed,issueRequest,state:()=>state};
}

async function rejected(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});
  expect(response.headers.get('Cache-Control')).toContain('no-store');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
const errors: Record<Change,[number,string]> = {revoked:[401,'unauthorized'],user:[401,'session_changed'],scope:[401,'session_changed'],mode:[401,'session_changed'],role:[403,'forbidden'],entitlement:[402,'management_entitlement_required'],flags:[404,'feature_unavailable'],configuration:[409,'configuration_changed']};

describe('fresh US HTTP response and feature policy guards', () => {
  it.each(['get','revision','changes'] as const)('withholds %s when flags close during storage',async operation=>{
    const t=fixture();t.hooks.read=()=>t.change('flags');
    const response=operation==='get'?await t.handlers.GET(t.request(),org):await t.sync[operation](t.request(),org);
    await rejected(response,404,'feature_unavailable');expect(t.commit).not.toHaveBeenCalled();
  });
  it.each(['get','revision','changes'] as const)('checks flags after the last authority await for %s',async operation=>{
    const t=fixture();t.hooks.authority=call=>{if(call===2)t.change('flags');};
    const response=operation==='get'?await t.handlers.GET(t.request(),org):await t.sync[operation](t.request(),org);
    await rejected(response,404,'feature_unavailable');expect(t.commit).not.toHaveBeenCalled();
  });
  it('withholds an initialized snapshot rather than exposing its records after flags close',async()=>{
    const t=fixture();await t.seed(initial.command);t.hooks.read=()=>t.change('flags');await rejected(await t.handlers.GET(t.request(),org),404,'feature_unavailable');expect(t.state()?.revision).toBe(1);expect(t.commit).toHaveBeenCalledTimes(1);
  });
  it('blocks initialize before commit when flags close during fresh configuration',async()=>{
    const t=fixture();t.hooks.configuration=call=>{if(call===2)t.change('flags');};await rejected(await t.handlers.POST(t.post(),org),404,'feature_unavailable');expect(t.commit).not.toHaveBeenCalled();expect(t.receipts.size).toBe(0);
  });
  it('blocks a CRUD write when flags close during its state read',async()=>{
    const t=fixture();await t.seed(initial.command);t.commit.mockClear();t.hooks.read=()=>t.change('flags');
    const command: ErpRequest = {idempotencyKey:'customer-original',expectedRevision:1,command:{type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Fictitious customer',billingAddress:config.address,paymentTermsDays:30}}};
    await rejected(await t.handlers.POST(t.post(command),org),404,'feature_unavailable');expect(t.commit).not.toHaveBeenCalled();expect(t.state()?.customers).toEqual([]);
  });
  it('blocks posttax commit without consuming an invoice number, receipt or journal',async()=>{
    const t=fixture();const request=await t.issueRequest();t.hooks.tax=()=>t.change('flags');
    await rejected(await t.handlers.POST(t.post(request),org),404,'feature_unavailable');expect(t.commit).not.toHaveBeenCalled();expect(t.state()?.counters.invoice).toBe(0);expect(t.state()?.invoices).toEqual([]);expect(t.state()?.ledger.entries).toEqual([]);expect(t.receipts.has(request.idempotencyKey)).toBe(false);
  });
  it.each(Object.keys(errors) as Change[])('withholds a committed receipt after %s, then replays the original request without another commit',async change=>{
    const t=fixture();t.hooks.commit=()=>t.change(change);
    await rejected(await t.handlers.POST(t.post(),org),...errors[change]);
    expect(t.commit).toHaveBeenCalledTimes(1);expect(t.state()?.revision).toBe(1);expect(t.receipts.has(initial.idempotencyKey)).toBe(true);
    t.restore();const response=await t.handlers.POST(t.post(),org);expect(response.status).toBe(200);expect(await response.json()).toEqual({receipt:t.receipts.get(initial.idempotencyKey),replayed:true});expect(t.commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('private revocation token');
  });
  it('checks the final flags after postcommit configuration and authority awaits',async()=>{
    const t=fixture();let committed=false;t.hooks.commit=()=>{committed=true;};t.hooks.configuration=()=>{if(committed)t.change('flags');};
    await rejected(await t.handlers.POST(t.post(),org),404,'feature_unavailable');expect(t.commit).toHaveBeenCalledTimes(1);expect(t.receipts.size).toBe(1);
  });
  it('rejects a role change during the last postcommit configuration await',async()=>{
    const t=fixture();let committed=false;t.hooks.commit=()=>{committed=true;};t.hooks.configuration=()=>{if(committed)t.change('role');};
    await rejected(await t.handlers.POST(t.post(),org),403,'forbidden');expect(t.commit).toHaveBeenCalledTimes(1);expect(t.dependencies.authority).toHaveBeenCalledTimes(3);
  });
  it('checks flags after the last postcommit authority await',async()=>{
    const t=fixture();let committed=false;t.hooks.commit=()=>{committed=true;};t.hooks.authority=()=>{if(committed)t.change('flags');};
    await rejected(await t.handlers.POST(t.post(),org),404,'feature_unavailable');expect(t.commit).toHaveBeenCalledTimes(1);expect(t.receipts.size).toBe(1);expect(t.dependencies.authority).toHaveBeenCalledTimes(3);
  });
  it('rejects a role change during precommit configuration with one final authority read',async()=>{
    const t=fixture();t.hooks.configuration=call=>{if(call===2)t.change('role');};
    await rejected(await t.handlers.POST(t.post(),org),403,'forbidden');expect(t.commit).not.toHaveBeenCalled();expect(t.receipts.size).toBe(0);expect(t.dependencies.authority).toHaveBeenCalledTimes(2);
  });
  it('preserves normal initial GET and successful POST JSON',async()=>{
    const t=fixture();const read=await t.handlers.GET(t.request(),org);expect(await read.json()).toEqual({status:'uninitialized',configuration:config});
    const written=await t.handlers.POST(t.post(),org);expect(written.status).toBe(200);expect(await written.json()).toEqual({receipt:t.receipts.get(initial.idempotencyKey),replayed:false});expect(t.commit).toHaveBeenCalledTimes(1);
  });
});
