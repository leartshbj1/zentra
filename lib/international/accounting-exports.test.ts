import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import { createUsExportHandlers } from './export-server';
import { getUsExportFonts } from './export-fonts';
import type { ExportSnapshot } from './export-snapshot';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { ErpSchemaVersion } from './erp-schema-capability';

async function fixture(){
  const organizationId='fictitious-accounting-export';
  const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictional Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'},ein:'12-3456789'};
  const actor={organizationId,userId:'fictitious-owner',role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'};
  let state:ErpState|null=null,ceiling:ErpSchemaVersion=4;const receipts=new Map<string,ErpReceipt>();
  const store:ErpStore={supportedSchemaVersion:4,read:async()=>state,receipt:async(_org,key)=>receipts.get(key)??null,commit:async input=>{state=applyErpDelta(state,{schemaVersion:input.header.schemaVersion,organizationId,fromRevision:input.expectedRevision,toRevision:input.header.revision,headRevision:input.header.revision,hasMore:false,resetRequired:false,events:[{schemaVersion:input.header.schemaVersion,organizationId,revision:input.header.revision,header:input.header,changes:input.changes,ledgerAudit:input.ledgerAudit,receipt:input.receipt,actorId:actor.userId,occurredAt:actor.timestamp}]},organizationId,4);receipts.set(input.receipt.idempotencyKey,input.receipt);return input.receipt;}};
  const send=(command:ErpCommand)=>executeErp({store,configuration,actor,revalidate:async()=>actor,taxProvider:async()=>null},{idempotencyKey:`export-${receipts.size}`,expectedRevision:state?.revision??0,command});
  await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
  await send({type:'post_manual_journal',id:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',description:'Fictitious reviewed capital',sourceReference:'FICTITIOUS-APPROVAL',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'9007199254740993',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'9007199254740993'}]});
  const deps={enabled:()=>true,authority:async()=>({mode:'browser' as const,actor}),configuration:async()=>configuration,store:()=>store,seller:async()=>({organizationId,displayName:'Fictitious test company'}),fonts:getUsExportFonts,rateLimit:async()=>{},freshSupportedSchemaVersion:async()=>ceiling};
  return {organizationId,send,state:()=>state!,closeCeiling:()=>{ceiling=3;},deps,handlers:createUsExportHandlers(deps),request:(query:string,cap=4)=>new Request(`https://zentraapp.ch/export?${query}`,{headers:{'X-Zentra-Erp-Schema-Version':String(cap),'X-Zentra-Expected-User':actor.userId}})};
}
describe('schema4 manual journal through actual exports (RAM/Auth test ports)',()=>{
  it.each(['fr','de','it','en'] as const)('exports real PDF/CSV/JSON exact report amounts in %s without private EIN',async language=>{
    const t=await fixture(),before=JSON.stringify(t.state());
    const snapshotResponse=await t.handlers.reports(t.request(`format=json&language=${language}&asOf=2026-12-31`),t.organizationId,'trial_balance');expect(snapshotResponse.status).toBe(200);const snapshot=await snapshotResponse.json() as ExportSnapshot;expect(snapshot.currency).toBe('USD');expect(snapshot.erpRevision).toBe(2);expect(snapshot.ledgerRevision).toBe(1);expect(snapshot.rows.some(row=>row.includes('9007199254740993'))).toBe(true);expect(JSON.stringify(snapshot)).not.toContain('12-3456789');
    const pdf=await t.handlers.reports(t.request(`format=pdf&language=${language}&asOf=2026-12-31`),t.organizationId,'trial_balance');expect(pdf.status).toBe(200);const document=await PDFDocument.load(await pdf.arrayBuffer());expect(document.getPageCount()).toBeGreaterThan(0);expect(document.getPage(0).getSize()).toEqual({width:612,height:792});expect(pdf.headers.get('X-Zentra-Ledger-Revision')).toBe('1');
    const csv=await t.handlers.reports(t.request(`format=csv&language=${language}&start=2026-01-01&end=2026-12-31&accountId=cash`),t.organizationId,'general_ledger');expect(csv.status).toBe(200);const csvText=await csv.text();expect(csvText).toContain('manual_journal: FICTITIOUS-APPROVAL');expect(csvText).toContain('90071992547409.93');expect(JSON.stringify(t.state())).toBe(before);
  });
  it('reports the reversal in the next period without rewriting the earlier report',async()=>{const t=await fixture();const query='format=json&language=en&asOf=2026-12-31',before=await(await t.handlers.reports(t.request(query),t.organizationId,'balance_sheet')).json() as ExportSnapshot;await t.send({type:'open_period',id:'2027',start:'2027-01-01',end:'2027-12-31'});await t.send({type:'close_period',periodId:'2026'});await t.send({type:'reverse_manual_journal',id:'reversal',entryId:'capital',transactionDate:'2027-01-08',accountingDate:'2027-01-08',periodId:'2027',reason:'Fictitious reviewed correction'});const old=await(await t.handlers.reports(t.request(query),t.organizationId,'balance_sheet')).json() as ExportSnapshot;expect(old.rows).toEqual(before.rows);expect(old.totals).toEqual(before.totals);const next=await(await t.handlers.reports(t.request('format=json&language=en&asOf=2027-12-31'),t.organizationId,'balance_sheet')).json() as ExportSnapshot;expect(next.totals.find(total=>total.label==='assets')?.minorUnits).toBe('0');});
  it('refuses older client capability and freshly closed server ceiling for a v4 book',async()=>{const t=await fixture();const old=await t.handlers.reports(t.request('format=pdf&asOf=2026-12-31',3),t.organizationId,'trial_balance');expect(old.status).toBe(409);expect(await old.json()).toEqual({error:'client_upgrade_required'});t.closeCeiling();const closed=await t.handlers.reports(t.request('format=pdf&asOf=2026-12-31'),t.organizationId,'trial_balance');expect(closed.status).toBe(409);expect(await closed.json()).toEqual({error:'client_upgrade_required'});});
});
