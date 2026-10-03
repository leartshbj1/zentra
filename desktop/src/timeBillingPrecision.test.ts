import { describe, expect, it } from 'vitest';
import { summarizeTimeBilling, timeEntryNetCents } from './timeBilling';
import type { TimeEntry } from './types';

function entry(minutes: number, rate: number): TimeEntry {
  return { id:'synthetic-time', projectId:'project', employeeId:'employee', taskId:null, date:'2026-10-03', minutes, hourlyCostCents:0, billable:true, billingRateCents:rate, status:'approved', billingStatus:'unbilled', billingBatchId:null, billingInvoiceId:null, billingInvoiceNumber:null, note:'', createdAt:'2026-10-03T09:00:00Z' };
}
const netOracle=(row: TimeEntry)=>Number((BigInt(row.minutes)*BigInt(row.billingRateCents!)+30n)/60n);
const taxOracle=(net: number, vatBp: number)=>Number((BigInt(net)*BigInt(vatBp)+5000n)/10000n);

describe('time-billing integer monetary boundaries',()=>{
  it.each([
    [3_863_116,65_465_199],
    [4_647_808,28_895_187],
  ])('keeps the configured VAT integer-exact for %i minutes at %i cents', (minutes,rate)=>{
    const row=entry(minutes,rate),net=netOracle(row),vat=taxOracle(net,9999);
    expect(timeEntryNetCents(row)).toBe(net);
    expect(summarizeTimeBilling([row],9999)).toMatchObject({netCents:net,vatCents:vat,totalCents:net+vat});
  });
  it('sums 500 independently rounded lines without accumulating one-cent errors',()=>{
    const row=entry(3_863_116,65_465_199),net=netOracle(row),vat=taxOracle(net,9999);
    const rows=Array.from({length:500},(_,index)=>({...row,id:`synthetic-${index}`}));
    expect(summarizeTimeBilling(rows,9999)).toMatchObject({netCents:net*500,vatCents:vat*500,totalCents:(net+vat)*500});
  });
  it('preserves Swiss VAT controls and the maximum native minute/rate boundary',()=>{
    for(const row of [entry(11,5010),entry(61,10001),entry(5_256_000,100_000_000)]){
      const net=netOracle(row);
      for(const vatBp of [0,260,380,810,10000]){
        const vat=taxOracle(net,vatBp);
        expect(summarizeTimeBilling([row],vatBp)).toMatchObject({netCents:net,vatCents:vat,totalCents:net+vat});
      }
    }
  });
});
