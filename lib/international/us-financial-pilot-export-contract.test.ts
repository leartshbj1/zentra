import { describe, expect, it } from 'vitest';
import {
  US_FINANCIAL_PILOT_EXPORT_COLUMNS, US_FINANCIAL_PILOT_EXPORT_HEADERS, US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES,
  validateUsFinancialPilotExportSelector, validateUsFinancialPilotExportSnapshot,
  type UsFinancialPilotExportSelector, type UsFinancialPilotExportSnapshot,
} from './us-financial-pilot-export-contract';

function receivables(): UsFinancialPilotExportSnapshot {
  const selector: UsFinancialPilotExportSelector = { kind: 'report', reportType: 'receivables', revision: 12, language: 'fr', format: 'csv' };
  return {
    consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'synthetic-export-org', revision: 12, ledgerRevision: 5,
    currency: 'USD', paper: 'Letter', language: 'fr', selector, number: null,
    issuer: { name: null, address: { country: 'US', line1: '1 Synthetic Way', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, email: null, phone: null }, recipient: null,
    facts: [
      { label: 'organization', kind: 'text', value: 'synthetic-export-org' }, { label: 'currency', kind: 'text', value: 'USD' }, { label: 'accountingBasis', kind: 'text', value: 'accrual' },
      { label: 'financialRevision', kind: 'text', value: '12' }, { label: 'ledgerRevision', kind: 'text', value: '5' },
    ],
    sections: [{ kind: 'receivables', columns: US_FINANCIAL_PILOT_EXPORT_COLUMNS.receivables,
      rows: [['SYNTHETIC-1', 'Synthetic Customer', '2026-10-09', '2026-11-08', '10700', '5000', '3500', '2200', 'partially_settled']],
      totals: [{ label: 'total', minorUnits: '10700' }, { label: 'received', minorUnits: '5000' }, { label: 'credited', minorUnits: '3500' }, { label: 'outstanding', minorUnits: '2200' }],
    }], notes: '',
  };
}
function mutable(): Record<string, unknown> { return structuredClone(receivables()) as unknown as Record<string, unknown>; }

describe('financial pilot export selector: closed read-only protocol', () => {
  it('accepts the six specific report selectors and invoice PDF in all four languages', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const base = { revision: 12, language, format: 'pdf' as const, kind: 'report' as const };
      for (const value of [
        { ...base, reportType: 'trial_balance', asOf: '2026-10-10' }, { ...base, reportType: 'balance_sheet', asOf: '2026-10-10' },
        { ...base, reportType: 'profit_loss', from: '2026-01-01', to: '2026-12-31' }, { ...base, reportType: 'cash_flow', from: '2026-01-01', to: '2026-12-31' },
        { ...base, reportType: 'general_ledger', from: '2026-01-01', to: '2026-12-31', accountId: 'receivables' }, { ...base, reportType: 'receivables', format: 'csv' },
        { revision: 12, language, format: 'pdf', kind: 'invoice', invoiceId: 'invoice-1' },
      ]) expect(validateUsFinancialPilotExportSelector(value)).toEqual(value);
    }
  });
  it.each([
    { kind: 'invoice', revision: 12, language: 'fr', format: 'csv', invoiceId: 'invoice-1' },
    { kind: 'report', revision: 12, language: 'fr', format: 'html', reportType: 'receivables' },
    { kind: 'report', revision: 12, language: 'fr', format: 'csv', reportType: 'receivables', asOf: '2026-10-10' },
    { kind: 'report', revision: 12, language: 'fr', format: 'pdf', reportType: 'cash_flow', from: '2026-12-31', to: '2026-01-01' },
    { kind: 'report', revision: 12, language: 'fr', format: 'pdf', reportType: 'trial_balance', asOf: '2026-02-30' },
    { kind: 'report', revision: 12, language: 'fr', format: 'pdf', reportType: 'trial_balance', asOf: '0000-01-01' },
    { kind: 'report', revision: 12, language: 'fr', format: 'pdf', reportType: 'general_ledger', from: '2026-01-01', to: '2026-12-31' },
    { kind: 'report', revision: 0, language: 'fr', format: 'pdf', reportType: 'receivables' },
    { kind: 'report', revision: 12, language: 'es', format: 'pdf', reportType: 'receivables' },
    { kind: 'report', revision: 12, language: 'fr', format: 'pdf', reportType: 'receivables', actor: { role: 'owner' } },
  ])('refuses malformed, ambiguous or falsely historical selector %#', value => {
    expect(() => validateUsFinancialPilotExportSelector(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_export_selector', status: 422 }));
  });
  it('never invokes getters and captures a detached frozen selector', () => {
    let calls = 0; const input = { ...receivables().selector, get actor() { calls++; return 'owner'; } };
    expect(() => validateUsFinancialPilotExportSelector(input)).toThrow(); expect(calls).toBe(0);
    const raw = { ...receivables().selector }, result = validateUsFinancialPilotExportSelector(raw); raw.revision = 99;
    expect(result.revision).toBe(12); expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('financial pilot export public snapshot whitelist and exact arithmetic', () => {
  it('preserves all four independent amounts with immutable detached data', () => {
    const input = structuredClone(receivables()), result = validateUsFinancialPilotExportSnapshot(input, input.organizationId, input.selector);
    expect(result).toEqual(input); expect(result.sections[0].totals.map(total => total.minorUnits)).toEqual(['10700', '5000', '3500', '2200']);
    (input.sections[0].rows as string[][])[0][5] = '8500'; expect(result.sections[0].rows[0][5]).toBe('5000');
    expect(Object.isFrozen(result.sections[0].rows[0])).toBe(true);
  });
  it('accepts selector keys in another order, but rejects different scope or selector values', () => {
    const input = receivables(); const same = { format: 'csv', language: 'fr', reportType: 'receivables', kind: 'report', revision: 12 } as const;
    expect(validateUsFinancialPilotExportSnapshot(input, input.organizationId, same)).toEqual(input);
    expect(() => validateUsFinancialPilotExportSnapshot(input, 'other-org')).toThrow();
    expect(() => validateUsFinancialPilotExportSnapshot(input, input.organizationId, { ...same, revision: 11 })).toThrow();
    expect(() => validateUsFinancialPilotExportSnapshot(input, input.organizationId, { ...same, language: 'en' })).toThrow();
  });
  it.each(['baseline', 'policy', 'promotion', 'grantVersion', 'providerReference', 'ein', 'idempotencyKey'])('rejects private or unexpected field %s', field => {
    const input = mutable(); input[field] = 'PRIVATE'; expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('rejects getters, prototypes, sparse arrays, invalid Unicode and extra nested fields without invoking code', () => {
    let calls = 0; const getter = { ...receivables(), get secret() { calls++; return 'PRIVATE'; } };
    expect(() => validateUsFinancialPilotExportSnapshot(getter)).toThrow(); expect(calls).toBe(0);
    for (const input of [Object.assign(Object.create({ inherited: true }), receivables()), { ...receivables(), notes: '\ud800' }, { ...receivables(), notes: '\u0000' }, { ...receivables(), facts: Array(5) }, { ...receivables(), issuer: { ...receivables().issuer, ein: 'PRIVATE' } }]) expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow();
  });
  it('refuses a made-up report seller identity or stale headers/facts', () => {
    for (const input of [
      { ...receivables(), issuer: { ...receivables().issuer, name: 'Uncorroborated Seller' } }, { ...receivables(), ledgerRevision: 13 }, { ...receivables(), currency: 'CHF' },
      { ...receivables(), facts: receivables().facts.map(fact => fact.label === 'financialRevision' ? { ...fact, value: '13' } : fact) },
      { ...receivables(), issuer: { ...receivables().issuer, address: { country: 'US', line1: '1 Example', city: 'City', postalCode: '00000', subdivision: 'XX' } } },
    ]) expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow();
  });
  it('rejects received=paid+credit, bad status and forged totals rather than hiding a mismatch', () => {
    for (const modify of [
      (input: UsFinancialPilotExportSnapshot) => { (input.sections[0].rows as string[][])[0][5] = '8500'; },
      (input: UsFinancialPilotExportSnapshot) => { (input.sections[0].rows as string[][])[0][8] = 'paid'; },
      (input: UsFinancialPilotExportSnapshot) => { (input.sections[0].totals[3] as { minorUnits: string }).minorUnits = '2199'; },
      (input: UsFinancialPilotExportSnapshot) => { (input.sections[0].rows as string[][])[0][4] = '010700'; },
      (input: UsFinancialPilotExportSnapshot) => { (input.sections[0].columns[4] as { kind: string }).kind = 'text'; },
    ]) { const input = structuredClone(receivables()); modify(input); expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow(); }
  });
  it('keeps large cents exact and rejects overflow-sized/noncanonical numeric strings', () => {
    const input = structuredClone(receivables()), total = '900719925474099300';
    (input.sections[0].rows as string[][])[0].splice(4, 5, total, '5000', '3500', (BigInt(total) - BigInt(8500)).toString(), 'partially_settled');
    (input.sections[0].totals[0] as { minorUnits: string }).minorUnits = total;
    (input.sections[0].totals[3] as { minorUnits: string }).minorUnits = (BigInt(total) - BigInt(8500)).toString();
    expect(validateUsFinancialPilotExportSnapshot(input).sections[0].rows[0][4]).toBe(total);
    for (const value of ['1e18', 'NaN', '-0', '1'.repeat(97)]) { const raw = structuredClone(input); (raw.sections[0].rows as string[][])[0][4] = value; expect(() => validateUsFinancialPilotExportSnapshot(raw)).toThrow(); }
  });
  it('rejects oversized row/text budgets explicitly without truncation', () => {
    const input = structuredClone(receivables()); (input.sections[0] as unknown as { rows: string[][] }).rows = Array.from({ length: 1001 }, () => [...input.sections[0].rows[0]]);
    expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow(expect.objectContaining({ code: 'financial_pilot_export_too_large', status: 413 }));
    expect(() => validateUsFinancialPilotExportSnapshot({ ...receivables(), notes: 'x'.repeat(500001) })).toThrow(expect.objectContaining({ status: 413 }));
    expect(US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES).toBe(12 * 1024 * 1024); expect(US_FINANCIAL_PILOT_EXPORT_HEADERS.scope).toBe('X-Zentra-Financial-Pilot');
  });
});
