import { afterEach, expect, it } from 'vitest';
import { appLanguages, getAppLocale, setAppLanguage } from './language';
import { documentTotals, formatDate, formatDateTime, formatMoney, invoiceOpenBalance, invoicePaid } from './utils';
import { salesTotalsByCurrency, type SalesCurrencyTotal } from './salesFinancials';
import type { Invoice, Payment } from './types';

afterEach(() => setAppLanguage('fr'));
it('retains exact formatted output through every language, currency and negative amount', () => {
  for (const language of [...appLanguages, 'fr'] as const) {
    setAppLanguage(language);
    for (const currency of ['CHF','EUR','USD','JPY']) for (const cents of [0,123456,-12345]) {
      expect(formatMoney(cents,currency)).toBe(new Intl.NumberFormat(getAppLocale(),{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100));
    }
    expect(formatDate('2026-09-25')).toBe(new Date('2026-09-25T12:00:00').toLocaleDateString(getAppLocale(),{day:'2-digit',month:'short',year:'numeric'}));
    expect(formatDateTime('2026-09-25T12:00:00Z')).toBe(new Date('2026-09-25T12:00:00Z').toLocaleString(getAppLocale(),{dateStyle:'medium',timeStyle:'short'}));
  }
  expect(formatDate(null)).toBe('—'); expect(formatDate('invalid')).toBe('—'); expect(formatDateTime('invalid')).toBe('—');
});

it('agrees with the invoice-level rules for mixed credits, reversals, discounts, VAT and payments', () => {
  const invoices: Invoice[] = Array.from({length:400},(_,index)=>({id:`i-${index}`,originalInvoiceId:index%5===0?`i-${index+1}`:null,type:index%5===0?'credit_note':'standard',status: ['issued','draft','cancelled','paid','partially_paid'][index%5],currency:index%2?'CHF':'EUR',creditedCents:index%11===0?0:index%13===0?1250:undefined,lines:[{id:`line-${index}`,quantity:1.75,unitPriceCents:index%5===0?-2535:9987,discountBp:175,vatRateBp:810}]} as Invoice));
  const payments = invoices.flatMap(invoice=>[{invoiceId:invoice.id,amountCents:4200},{invoiceId:invoice.id,amountCents:-700}]) as Payment[];
  function reference(): SalesCurrencyTotal[] {
    const totals=new Map<string,SalesCurrencyTotal>();
    for(const invoice of invoices) {
      if(['draft','cancelled'].includes(invoice.status))continue;
      const currency=invoice.currency||'CHF';
      const value=totals.get(currency)||{currency,invoicedCents:0,paidCents:0,openCents:0};
      value.invoicedCents+=documentTotals(invoice.lines).totalCents;
      if(invoice.type!=='credit_note'){value.paidCents+=invoicePaid(invoice.id,payments);value.openCents+=invoiceOpenBalance(invoice,invoices,payments);}
      totals.set(currency,value);
    }
    return [...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency));
  }
  expect(salesTotalsByCurrency(invoices,payments)).toEqual(reference());
  // Recompute after a received payment, an edit and a revocation. No stale cache.
  payments.push({invoiceId:'i-13',amountCents:9000} as Payment);
  invoices[13].lines[0].unitPriceCents=16000;
  invoices[0].status='cancelled';
  expect(salesTotalsByCurrency(invoices,payments)).toEqual(reference());
  expect(salesTotalsByCurrency([],[])).toEqual([]);
});
