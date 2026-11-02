import { describe, expect, it } from 'vitest';
import { invoiceDatesError, isSalesDate } from './salesFormValidation';

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
