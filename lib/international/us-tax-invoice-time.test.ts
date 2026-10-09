import { describe, expect, it } from 'vitest';
import { usTaxInvoiceLocalCandidates, validateUsTaxInvoiceTime } from './us-tax-invoice-time';

describe('explicit US invoice time', () => {
  it('enumerates a unique company-zone instant independently of device zone', () => {
    expect(usTaxInvoiceLocalCandidates('2026-10-10T09:15:00', 'America/New_York')).toEqual([{ instant: '2026-10-10T13:15:00.000Z', offset: '-04:00' }]);
  });
  it('never invents a spring-forward gap', () => {
    expect(usTaxInvoiceLocalCandidates('2026-03-08T02:30:00', 'America/New_York')).toEqual([]);
  });
  it('retains both autumn offsets for an explicit human choice', () => {
    expect(usTaxInvoiceLocalCandidates('2026-11-01T01:30:00', 'America/New_York')).toEqual([{ instant: '2026-11-01T05:30:00.000Z', offset: '-04:00' }, { instant: '2026-11-01T06:30:00.000Z', offset: '-05:00' }]);
  });
  it('handles a non-DST US zone and midnight without a date shift', () => {
    expect(usTaxInvoiceLocalCandidates('2026-10-10T00:00:00', 'Pacific/Honolulu')).toEqual([{ instant: '2026-10-10T10:00:00.000Z', offset: '-10:00' }]);
  });
  it.each(['2026-02-30T12:00:00', '2026-10-10T24:00:00', '2026-10-10T09:15', '2026-10-10T09:15:00Z'])('rejects invalid or implicit civil input %s', value => {
    expect(() => usTaxInvoiceLocalCandidates(value, 'America/New_York')).toThrowError('invalid_tax_date');
  });
  it('rejects unsupported zones', () => { expect(() => usTaxInvoiceLocalCandidates('2026-10-10T09:00:00', 'Europe/Zurich')).toThrowError('invalid_tax_date'); });
  it('normalizes a whole-second explicit offset to a stable instant', () => {
    expect(validateUsTaxInvoiceTime({ taxDateInstant: '2026-10-10T09:15:00-04:00', invoiceDate: '2026-10-10', timeZone: 'America/New_York', now: '2026-10-10T13:00:00.000Z' })).toBe('2026-10-10T13:15:00.000Z');
  });
  it.each(['2026-10-10T00:30:00Z', '2026-10-10T13:15:00.001Z', '2026-08-10T13:15:00Z', '2026-10-10T13:15:00'])('rejects mismatched, fractional, old or implicit instant %s', taxDateInstant => {
    expect(() => validateUsTaxInvoiceTime({ taxDateInstant, invoiceDate: '2026-10-10', timeZone: 'America/New_York', now: '2026-10-10T13:00:00.000Z' })).toThrowError('invalid_tax_date');
  });
});
