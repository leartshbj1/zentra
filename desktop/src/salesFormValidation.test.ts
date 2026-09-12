import { describe, expect, it } from 'vitest';
import { invoiceDatesError, isSalesDate, paymentInput } from './salesFormValidation';

describe('payment entered from a real receipt', () => {
  it('accepts the exact open balance or a partial payment', () => {
    expect(paymentInput('100,25', '2026-09-03', '2026-09-01', 10025)).toEqual({ amountCents: 10025, error: '' });
    expect(paymentInput('10.20', '2026-09-01', '2026-09-01', 10025)).toEqual({ amountCents: 1020, error: '' });
  });
  it.each(['', '0', '-12', '1.005', 'Infinity', '9007199254740991', '1e3'])('rejects an invalid amount %s', value => {
    expect(paymentInput(value, '2026-09-01', '2026-09-01', 10025).error).not.toBe('');
  });
  it('explains an excess payment and dates before issue', () => {
    expect(paymentInput('100.26', '2026-09-01', '2026-09-01', 10025).error).toContain('dépasse');
    expect(paymentInput('1', '2026-08-31', '2026-09-01', 10025).error).toContain('précéder');
    expect(paymentInput('1', '2026-02-30', '2026-01-01', 10025).error).toContain('date');
  });
});
describe('linked invoice dates', () => {
  const dates = { issueDate: '2026-09-01', dueDate: '2026-09-30', serviceDateFrom: '2026-08-10', serviceDateTo: '' };
  it('allows one day or a real date range', () => {
    expect(invoiceDatesError(dates)).toBe('');
    expect(invoiceDatesError({ ...dates, serviceDateTo: '2026-08-10' })).toBe('');
    expect(invoiceDatesError({ ...dates, serviceDateTo: '2026-08-09' })).toContain('fin');
  });
  it.each(['issueDate', 'dueDate', 'serviceDateFrom', 'serviceDateTo'])('rejects an impossible %s', field => {
    expect(invoiceDatesError({ ...dates, [field]: '2026-02-29' })).not.toBe('');
  });
  it('validates leap years and deadline order', () => {
    expect(isSalesDate('2024-02-29')).toBe(true);
    expect(isSalesDate('2026-02-29')).toBe(false);
    expect(invoiceDatesError({ ...dates, dueDate: '2026-08-31' })).toContain('échéance');
  });
});
