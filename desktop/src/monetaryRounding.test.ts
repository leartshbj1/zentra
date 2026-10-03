import { describe, expect, it, vi } from 'vitest';
import { documentLineTotals, documentTotals, formatMoney, invoiceOpenBalance, projectFinancials, roundBasisPoints } from './utils';
import { summarizeTimeBilling, timeEntryNetCents } from './timeBilling';
import { buildProjectReport } from './projectReport';
import type { DocumentLine, Invoice, Payment, Project, TimeEntry, Workspace } from './types';

// These exact constants come from the native i128 minute/VAT contract.
// 9999 bp is a formal admitted boundary, not a Swiss tax rate.
const rows=[
  {minutes:3_863_116,rate:65_465_199,net:4_214_994_295_001,vat:4_214_572_795_571},
  {minutes:4_647_808,rate:28_895_187,net:2_238_321_355_002,vat:2_238_097_522_866},
];
const bpOracle=(value:number,bp:number)=>{
  const rounded=Number((BigInt(Math.abs(value))*BigInt(bp)+5000n)/10000n);
  return value<0?-rounded:rounded;
};
const line=(row:typeof rows[number],sign=1,discountBp=0):DocumentLine=>({id:'line',description:'Prestation fictive',quantity:row.minutes/60,unit:'heure',unitPriceCents:sign*row.rate,discountBp,vatRateBp:9999});
const lineOracle=(row:typeof rows[number],sign=1,discountBp=0)=>{
  const subtotalCents=sign*row.net,discountCents=bpOracle(subtotalCents,discountBp),netCents=subtotalCents-discountCents,vatCents=bpOracle(netCents,9999);
  return {subtotalCents,discountCents,netCents,vatCents,totalCents:netCents+vatCents};
};
const timeEntry=(row:typeof rows[number]):TimeEntry=>({id:'time',projectId:'p',employeeId:'e',taskId:null,date:'2026-10-03',minutes:row.minutes,hourlyCostCents:0,billable:true,billingRateCents:row.rate,status:'approved',billingStatus:'unbilled',billingBatchId:null,billingInvoiceId:null,billingInvoiceNumber:null,note:'',createdAt:'2026-10-03T09:00:00Z'});

describe('integer-exact document and time percentage calculations',()=>{
  for(const row of rows) for(const sign of [1,-1]){
    it(`preserves signed document VAT at ${sign*row.net} cents`,()=>{
      const totals=lineOracle(row,sign);
      expect(roundBasisPoints(sign*row.net,9999)).toBe(sign*row.vat);
      expect(documentLineTotals(line(row,sign))).toEqual(totals);
    });
    it(`applies the discount before VAT at ${sign*row.net} cents`,()=>{
      for(const discount of [50,260,810,3333,9999,10000])expect(documentLineTotals(line(row,sign,discount))).toEqual(lineOracle(row,sign,discount));
    });
  }
  it('keeps signed half-cent and old fractional line behavior',()=>{
    expect(roundBasisPoints(100,50)).toBe(1);
    expect(roundBasisPoints(-100,50)).toBe(-1);
    expect(Object.is(roundBasisPoints(-1,50),-0)).toBe(true);
    expect(roundBasisPoints(100,50.9)).toBe(1);
    expect(roundBasisPoints(100,-50)).toBe(0);
    expect(roundBasisPoints(100,10001)).toBe(100);
    expect(roundBasisPoints(NaN,810)).toBe(0);
    expect(Number.isNaN(roundBasisPoints(100,NaN))).toBe(true);
    expect(documentLineTotals({id:'credit',description:'Correction',quantity:0.5,unit:'forfait',unitPriceCents:-999,discountBp:333,vatRateBp:260})).toEqual({subtotalCents:-500,discountCents:-17,netCents:-483,vatCents:-13,totalCents:-496});
  });
  it('keeps integer precision across both sides of the safe intermediate boundary',()=>{
    for(const bp of [1,50,260,380,810,9999,10000]){
      const threshold=Math.floor((Number.MAX_SAFE_INTEGER-5000)/bp);
      for(const absolute of [threshold-2,threshold-1,threshold,threshold+1,threshold+2,Number.MAX_SAFE_INTEGER])if(Number.isSafeInteger(absolute)&&absolute>=0){
        for(const sign of [1,-1])expect(roundBasisPoints(sign*absolute,bp)).toBe(bpOracle(sign*absolute,bp));
      }
    }
  });
  it('sums 500 independently rounded positive, negative and mixed lines',()=>{
    for(const mode of ['positive','negative','mixed'] as const){
      const documents=Array.from({length:500},(_,index)=>line(rows[index%2],mode==='negative'?-1:mode==='mixed'&&index%3===0?-1:1,index%2?810:3333));
      const expected=documents.reduce((sum,document,index)=>{
        const value=lineOracle(rows[index%2],Math.sign(document.unitPriceCents),document.discountBp);
        for(const key of Object.keys(sum) as (keyof typeof sum)[])sum[key]+=value[key];return sum;
      },{subtotalCents:0,discountCents:0,netCents:0,vatCents:0,totalCents:0});
      for(const amount of Object.values(expected))expect(Number.isSafeInteger(amount)).toBe(true);
      expect(documentTotals(documents)).toEqual(expected);
    }
  });
  it('matches an integer oracle for 2000 seeded values, both signs and discounted documents',()=>{
    let seed=721091;
    const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    for(let index=0;index<2000;index++){
      const absolute=1+Number(((BigInt(next())<<32n)|BigInt(next()))%8_760_000_000_000n);
      for(const sign of [1,-1]){
        const value=sign*absolute;
        for(const bp of [0,50,260,380,810,9999,10000])expect(roundBasisPoints(value,bp)).toBe(bpOracle(value,bp));
        for(const discountBp of [0,1250,9999]){
          const discountCents=bpOracle(value,discountBp),netCents=value-discountCents,vatCents=bpOracle(netCents,9999);
          expect(documentLineTotals({id:'matrix-line',description:'Fictif',quantity:1,unit:'forfait',unitPriceCents:value,discountBp,vatRateBp:9999})).toEqual({subtotalCents:value,discountCents,netCents,vatCents,totalCents:netCents+vatCents});
        }
      }
    }
  });
  it('agrees between time summary and generated hourly lines',()=>{
    for(const row of rows){
      expect(timeEntryNetCents(timeEntry(row))).toBe(row.net);
      expect(summarizeTimeBilling([timeEntry(row)],9999)).toMatchObject({netCents:row.net,vatCents:row.vat,totalCents:row.net+row.vat});
      expect(documentLineTotals(line(row))).toEqual(lineOracle(row));
    }
    const entries=Array.from({length:500},()=>timeEntry(rows[0]));
    expect(summarizeTimeBilling(entries,9999)).toMatchObject({netCents:rows[0].net*500,vatCents:rows[0].vat*500,totalCents:(rows[0].net+rows[0].vat)*500});
  });
  it('keeps ordinary computation on the Number path and exact overflow on BigInt',()=>{
    const original=globalThis.BigInt;
    const spy=vi.spyOn(globalThis,'BigInt').mockImplementation(value=>original(value));
    try{
      roundBasisPoints(5247,810);timeEntryNetCents({...timeEntry(rows[0]),minutes:61,billingRateCents:10001});
      expect(spy).not.toHaveBeenCalled();
      expect(roundBasisPoints(rows[0].net,9999)).toBe(rows[0].vat);
      expect(spy).toHaveBeenCalled();
    }finally{spy.mockRestore();}
  });
  it('carries exact totals into project financials, credits, payments and the real report builder',()=>{
    const project={id:'p',clientId:'c',name:'Projet fictif',status:'in_progress',budgetCents:0,plannedMinutes:0,notes:''} as Project;
    const invoice={id:'invoice',number:'F-TEST',title:'Heures',type:'standard',status:'issued',currency:'CHF',projectId:'p',issueDate:'2026-10-03',dueDate:'2026-11-03',lines:rows.map(row=>line(row))} as Invoice;
    const credit={...invoice,id:'credit',number:'A-TEST',type:'credit_note',originalInvoiceId:invoice.id,lines:[line(rows[0],-1)]} as Invoice;
    const payments=[{id:'payment',invoiceId:invoice.id,amountCents:12345,date:'2026-10-03'}] as Payment[];
    const expectedTotal=rows.reduce((sum,row)=>sum+row.net+row.vat,0),credited=rows[0].net+rows[0].vat,open=expectedTotal-credited-12345;
    const workspace={projects:[project],clients:[{id:'c',name:'Client fictif',company:'Client SA'}],invoices:[invoice,credit],quotes:[],payments,supplierInvoices:[],supplierCreditNotes:[],expenses:[],employees:[],timeEntries:[],projectMilestones:[],projectTasks:[],agendaEvents:[],attachments:[]} as unknown as Workspace;
    expect(invoiceOpenBalance(invoice,workspace.invoices,payments)).toBe(open);
    const finances=projectFinancials(project,workspace.invoices,payments,[],[]);
    expect(finances.invoicedNet).toBe(rows[1].net);
    expect(finances.invoicedTotal).toBe(rows[1].net+rows[1].vat);
    const report=buildProjectReport(workspace,project,['overview','sales']);
    const sales=report.sections.find(section=>section.title==='Factures et avoirs')!;
    expect(sales.rows[0][2]).toBe(`${formatMoney(expectedTotal)}\nReste ${formatMoney(open)}`);
    expect(sales.rows[1][2]).toBe(`${formatMoney(-credited)}\nReste —`);
    const financial=report.sections.find(section=>section.title==='Situation financière')!;
    expect(financial.rows.find(row=>row[0]==='Facturé TTC')?.[1]).toBe(formatMoney(rows[1].net+rows[1].vat));
  });
});
