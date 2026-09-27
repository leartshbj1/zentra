import {expect,it} from 'vitest';
import type {Invoice,Payment} from './types';
import {salesMetricRows,salesTotalsByCurrency,turnoverByCurrency,type SalesMetric} from './salesFinancials';
const invoice=(id:string,net:number,extra:Partial<Invoice>={}):Invoice=>({id,number:id,title:id,type:'standard',status:'issued',currency:'CHF',issueDate:'2026-09-01',lines:[{id:'l',quantity:1,unitPriceCents:net,vatRateBp:810}],...extra} as Invoice);
const documents=[invoice('CURRENT',10000,{creditedCents:1081}),invoice('CREDIT',-1000,{type:'credit_note',originalInvoiceId:'CURRENT'}),invoice('OLD',20000,{issueDate:'2025-01-01'}),invoice('EUR',40000,{currency:'EUR'}),invoice('DRAFT',999999,{status:'draft'}),invoice('CANCELLED',999999,{status:'cancelled'})];
const payments=[{invoiceId:'CURRENT',amountCents:5000},{invoiceId:'CURRENT',amountCents:-500},{invoiceId:'OLD',amountCents:21620},{invoiceId:'DRAFT',amountCents:999999}] as Payment[];
it('shows the exact recorded contribution, excludes drafts and retains refunds and credits',()=>{
  expect(salesMetricRows(documents,payments,'openCents',2026).map(row=>[row.invoice.id,row.openCents])).toEqual([['EUR',43240],['CURRENT',5229]]);
  expect(salesMetricRows(documents,payments,'paidCents',2026).map(row=>[row.invoice.id,row.paidCents])).toEqual([['CURRENT',4500],['OLD',21620]]);
  expect(salesMetricRows(documents,payments,'invoicedCents',2026).find(row=>row.invoice.id==='CREDIT')?.invoicedCents).toBe(-1081);
});
it('annual net detail excludes previous years and preserves a negative credit contribution',()=>{
  const rows=salesMetricRows(documents,payments,'netCents',2026);
  expect(rows.map(row=>[row.invoice.id,row.netCents])).toEqual([['EUR',40000],['CURRENT',10000],['CREDIT',-1000]]);
  expect(rows.some(row=>['DRAFT','CANCELLED','OLD'].includes(row.invoice.id))).toBe(false);
});
it('reconciles every detail with dashboard totals for each currency before and after an edit',()=>{
  const copied=structuredClone(documents);
  for(let pass=0;pass<2;pass++) {
    if(pass===1)copied[0].lines[0].unitPriceCents=30000;
    const data=copied;
    for(const metric of ['invoicedCents','paidCents','openCents','netCents'] as SalesMetric[]) {
      const rows=salesMetricRows(data,payments,metric,2026);
      for(const currency of ['CHF','EUR']) {
        const sum=rows.filter(row=>row.currency===currency).reduce((total,row)=>total+row[metric],0);
        const expected=metric==='netCents'?turnoverByCurrency(data,2026).find(row=>row.currency===currency)?.netCents:salesTotalsByCurrency(data,payments).find(row=>row.currency===currency)?.[metric];
        expect(sum).toBe(expected);
      }
    }
  }
  expect(salesMetricRows([],[],'openCents',2026)).toEqual([]);
});
