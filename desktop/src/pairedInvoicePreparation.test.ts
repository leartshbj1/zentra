import { describe, expect, it } from 'vitest';
import type { Invoice } from './types';
import { invoiceDateIssues, invoiceDatesError } from './salesFormValidation';
import { changePairedIssueDate, initialPairedInvoiceFields, pairedDateStep, pairedServiceReference } from './pairedInvoicePreparation';

const invoice = { id:'deposit',quoteId:'quote',clientId:'client',currency:'CHF',type:'deposit',status:'draft',issueDate:'2026-09-01',dueDate:'2026-10-01',serviceDateFrom:'',serviceDateTo:'',notes:'Garder cette note\nEt cette ligne',billingPair:{depositInvoiceId:'deposit',balanceInvoiceId:'balance'} } as Invoice;
const other = { ...invoice,id:'balance',type:'final',serviceDateFrom:'2026-08-01',serviceDateTo:'2026-08-31' } as Invoice;

describe('preparing the two invoices without re-entering or replacing business values', () => {
  it('preserves saved dates and multiline notes and only supplies missing draft payment dates', () => {
    expect(initialPairedInvoiceFields(invoice,30,'2026-09-13')).toEqual({issueDate:'2026-09-01',dueDate:'2026-10-01',serviceDateFrom:'',serviceDateTo:'',notes:invoice.notes});
    const blank={...invoice,issueDate:'',dueDate:''};
    expect(initialPairedInvoiceFields(blank,14,'2026-09-13').dueDate).toBe('2026-09-27');
    expect(initialPairedInvoiceFields(blank,14,'2026-09-13',true).issueDate).toBe('');
    expect(initialPairedInvoiceFields(blank,14,'2026-09-13',true).dueDate).toBe('');
  });
  it('moves an automatic deadline but keeps a manually changed deadline', () => {
    const fields=initialPairedInvoiceFields(invoice,30,'2026-09-13');
    expect(changePairedIssueDate(fields,'2026-09-10',30).dueDate).toBe('2026-10-10');
    expect(changePairedIssueDate({...fields,dueDate:'2026-12-01'},'2026-09-10',30).dueDate).toBe('2026-12-01');
    expect(changePairedIssueDate(fields,'',30).dueDate).toBe(fields.dueDate);
    expect(changePairedIssueDate(fields,'2026-02-31',30).dueDate).toBe(fields.dueDate);
  });
  it('offers service dates only from the exact same linked dossier', () => {
    expect(pairedServiceReference(invoice,[invoice,other])).toEqual(other);
    for (const patch of [{quoteId:'elsewhere'},{clientId:'other-client'},{currency:'EUR'},{status:'cancelled'},{serviceDateFrom:''},{serviceDateTo:'2026-07-30'},{serviceDateTo:'2026-02-31'},{billingPair:{depositInvoiceId:'different',balanceInvoiceId:'balance'}}]) {
      expect(pairedServiceReference(invoice,[{...other,...patch} as Invoice])).toBeNull();
    }
    expect(pairedServiceReference({...invoice,billingPair:undefined},[other])).toBeNull();
    expect(pairedServiceReference({...invoice,id:'unrelated'},[other])).toBeNull();
  });
  it('a missing payment date on the counterpart does not discard its valid service dates', () => {
    expect(pairedServiceReference(invoice,[{...other,dueDate:''}])?.serviceDateFrom).toBe('2026-08-01');
  });
  it('identifies every erroneous field, retains the existing first-error message and routes to its step', () => {
    const fields={issueDate:'',dueDate:'',serviceDateFrom:'',serviceDateTo:'2026-02-31'};
    const issues=invoiceDateIssues(fields);
    expect(issues.map(issue=>issue.field)).toEqual(['issueDate','dueDate','serviceDateFrom','serviceDateTo']);
    expect(invoiceDatesError(fields)).toBe(issues[0].message);
    expect(issues.map(issue=>pairedDateStep(issue.field))).toEqual(['payment','payment','service','service']);
  });
  it('accepts a single day, a real leap date and orders both date ranges', () => {
    const fields={issueDate:'2024-02-29',dueDate:'2024-03-01',serviceDateFrom:'2024-02-29',serviceDateTo:''};
    expect(invoiceDateIssues(fields)).toEqual([]);
    expect(invoiceDateIssues({...fields,dueDate:'2024-02-28',serviceDateTo:'2024-02-28'}).map(value=>value.field)).toEqual(['dueDate','serviceDateTo']);
  });
});
