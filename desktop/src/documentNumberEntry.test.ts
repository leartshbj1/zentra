import { describe, expect, it } from 'vitest';
import { documentNumberEntry } from './documentNumberEntry';
import { documentLineIssue } from './documentUi';

describe('written numbers in quotes and invoices', () => {
  it('distinguishes a missing price from an explicit free line', () => {
    expect(documentNumberEntry('', 'price').value).toBeNull();
    expect(documentNumberEntry('0', 'price')).toEqual({ value: 0, error: '' });
    expect(documentNumberEntry('0,00', 'price').value).toBe(0);
  });
  it('accepts decimal commas and Swiss thousands separators without floating rounding', () => {
    for (const input of ["1'234,56", '1’234.56', '1 234,56', '1\u202f234,56']) expect(documentNumberEntry(input, 'price').value).toBe(123456);
    expect(documentNumberEntry('0,29', 'price').value).toBe(29);
    expect(documentNumberEntry('2,125', 'quantity').value).toBe(2.125);
    expect(documentNumberEntry('0,0001', 'quantity').value).toBe(0.0001);
    expect(documentNumberEntry('12,50', 'discount').value).toBe(1250);
  });
  it('rejects ambiguous, incomplete, excessive and out-of-range numbers', () => {
    for (const input of ['1e3', '-2', '1,', '1.235', '1,234.56', '12 34', "1'23", 'NaN', 'Infinity', '90071992547409.92']) expect(documentNumberEntry(input, 'price').value, input).toBeNull();
    expect(documentNumberEntry('0', 'quantity').value).toBeNull();
    expect(documentNumberEntry('1,12345', 'quantity').value).toBeNull();
    expect(documentNumberEntry('100,01', 'discount').value).toBeNull();
    expect(documentNumberEntry('100', 'discount').value).toBe(10000);
    expect(documentNumberEntry('', 'discount').value).toBe(0);
  });
  it('identifies the precise line and field without rejecting a free item', () => {
    const line = { id:'one', catalogItemId:null, description:'Conseil offert', quantity:1, unit:'forfait', unitPriceCents:0, discountBp:0, vatRateBp:0 };
    expect(documentLineIssue([line])).toBeNull();
    expect(documentLineIssue([line, { ...line, id:'two', unit:' ' }])).toMatchObject({ index:1, field:'Unité', message:expect.stringContaining('Ligne 2') });
    expect(documentLineIssue([{ ...line, quantity: 2, unitPriceCents: Number.MAX_SAFE_INTEGER }])?.message).toContain('trop grand');
  });
});
