import { describe, expect, it } from 'vitest';
import { parseUsBankStatementCsv, type UsBankStatementCsvInput } from './us-bank-csv';

const base: UsBankStatementCsvInput = { text: 'date,amount,reference\n2026-10-01,100.00,Received payment\n2026-10-02,-25.50,Expense\n', id: '00000000-0000-4000-8000-000000000001', organizationId: 'local-bank-test', externalConnectionId: 'opaque-csv-ref', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: '0.00', closing: '74.50' };
const parse = (changes: Partial<UsBankStatementCsvInput> = {}) => parseUsBankStatementCsv({ ...base, ...changes });
const invalid = (changes: Partial<UsBankStatementCsvInput>) => expect(() => parse(changes)).toThrow(expect.objectContaining({ code: 'invalid_bank_statement', status: 422, message: 'invalid_bank_statement' }));

describe('explicit USD bank statement CSV', () => {
  it('parses exact signed cents and stable ordered line identities, deeply frozen without posting anything', () => {
    const first = parse(), again = parse();
    expect(first).toEqual(again);
    expect(first.lines.map(line => [line.id, line.amount.minorUnits])).toEqual([[`${base.id}:1`, '10000'], [`${base.id}:2`, '-2550']]);
    expect(first.opening.minorUnits).toBe('0'); expect(first.closing.minorUnits).toBe('7450');
    expect(Object.isFrozen(first.lines[0].amount)).toBe(true); expect(Object.isFrozen(first.lines)).toBe(true);
    expect(base.closing).toBe('74.50');
  });
  it('accepts BOM, CRLF and quoted commas/doubled quotes while preserving actual reference text', () => {
    const s = parse({ text: '\ufeffdate,amount,reference\r\n2026-10-01,100.00,"Paid, invoice ""A"" 😀"\r\n', closing: '100.00' });
    expect(s.lines[0].reference).toBe('Paid, invoice "A" 😀');
  });
  it('keeps values above the JavaScript safe integer exact without rounding', () => {
    const amount = '9007199254740993.01';
    const s = parse({ text: `date,amount,reference\n2026-10-01,${amount},Large exact movement`, closing: amount });
    expect(s.lines[0].amount.minorUnits).toBe('900719925474099301');
  });
  it.each(['-0', '-0.00', '+1.00', '01.00', '1,00', '1e2', 'NaN', 'Infinity', ' 1.00', '1.00 ', '.25', '1.001', '9'.repeat(36)])('rejects ambiguous/rounded amount %s', amount => {
    invalid({ text: `date,amount,reference\n2026-10-01,${amount},Value`, closing: amount });
  });
  it.each(['date;amount;reference\n2026-10-01;100.00;Value', 'Date,amount,reference\n2026-10-01,100.00,Value', 'date,amount,reference,account\n2026-10-01,100.00,Value,x', 'amount,date,reference\n100.00,2026-10-01,Value', ' date,amount,reference\n2026-10-01,100.00,Value'])('requires exact columns %#', text => { invalid({ text, closing: '100.00' }); });
  it.each(['date,amount,reference\n2026-10-01,100.00', 'date,amount,reference\n2026-10-01,100.00,"unterminated', 'date,amount,reference\n2026-10-01,100.00,"quoted"junk', 'date,amount,reference\n2026-10-01,100.00,bad"quote', 'date,amount,reference\r2026-10-01,100.00,Value', 'date,amount,reference\n\n', 'date,amount,reference\n2026-10-01,100.00,"multi\nline"'])('rejects malformed rows or controls %#', text => { invalid({ text, closing: '100.00' }); });
  it.each(['10/01/2026', '2026-02-30', '0000-01-01', '2026-10-01T12:00:00Z', '2026-11-01'])('requires a real ISO date inside the explicit period %s', date => { invalid({ text: `date,amount,reference\n${date},100.00,Value`, closing: '100.00' }); });
  it('checks explicit opening/closing balances and refuses a zero movement rather than guessing', () => {
    invalid({ opening: '1.00' }); invalid({ closing: '74.49' });
    invalid({ text: 'date,amount,reference\n2026-10-01,0.00,Zero', closing: '0.00' });
    expect(parse({ text: 'date,amount,reference', opening: '-10.00', closing: '-10.00' }).lines).toEqual([]);
  });
  it('supports exactly 1000 rows and rejects oversized input with a bounded error', () => {
    const lines = Array.from({ length: 1000 }, () => '2026-10-01,0.01,Explicit row');
    expect(parse({ text: 'date,amount,reference\n' + lines.join('\n'), closing: '10.00' }).lines).toHaveLength(1000);
    invalid({ text: 'date,amount,reference\n' + [...lines, lines[0]].join('\n'), closing: '10.01' });
    invalid({ text: 'x'.repeat(524289) });
  });
  it.each(['secret\u0000ref', 'ref\u007f', 'bad\ud800', 'bad\udc00'])('refuses PostgreSQL-incompatible text %#', reference => { invalid({ text: `date,amount,reference\n2026-10-01,100.00,${reference}`, closing: '100.00' }); });
  it('rejects getters, inherited parameters and extra grants without reading them or exposing their text', () => {
    let calls = 0; const getter = { ...base }; Object.defineProperty(getter, 'text', { enumerable: true, get() { calls++; throw new Error('secret-bank-data'); } });
    expect(() => parseUsBankStatementCsv(getter)).toThrow('invalid_bank_statement'); expect(calls).toBe(0);
    expect(() => parseUsBankStatementCsv(Object.assign(Object.create({ role: 'owner' }) as object, base) as UsBankStatementCsvInput)).toThrow('invalid_bank_statement');
    expect(() => parseUsBankStatementCsv({ ...base, authority: 'secret' } as UsBankStatementCsvInput)).toThrow('invalid_bank_statement');
  });
});
