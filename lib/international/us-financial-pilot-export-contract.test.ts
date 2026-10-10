import { describe, expect, it } from 'vitest';
import {
  US_FINANCIAL_PILOT_EXPORT_COLUMNS, US_FINANCIAL_PILOT_EXPORT_HEADERS, US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES,
  US_FINANCIAL_PILOT_ESTIMATE_EXPORT_MAX_SNAPSHOT_BYTES,
  validateUsFinancialPilotExportSelector, validateUsFinancialPilotExportSnapshot,
  type UsFinancialPilotExportSelector, type UsFinancialPilotExportSnapshot, type UsFinancialPilotEstimateExportSnapshot,
} from './us-financial-pilot-export-contract';

function receivables(): Exclude<UsFinancialPilotExportSnapshot, { estimate: unknown }> {
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
function estimate(): UsFinancialPilotEstimateExportSnapshot {
  const base = receivables();
  return {
    ...base, selector: { kind: 'estimate', estimateId: 'estimate-1', estimateRevision: 2, revision: 12, language: 'fr', format: 'pdf' }, number: 'EST-000001',
    issuer: { ...base.issuer, name: 'Synthetic Current Seller', email: 'seller@example.test' },
    recipient: { ...base.issuer, name: 'Synthetic Historical Customer' },
    estimate: { estimateId: 'estimate-1', estimateRevision: 2, status: 'draft', countryRevision: 3, sellerRevision: 4, issuerBasis: 'current_at_export', amountBasis: 'before_sales_tax' },
    facts: [...base.facts, { label: 'estimateDate', kind: 'date', value: '2026-10-10' }, { label: 'expiresAt', kind: 'date', value: '2026-11-10' },
      { label: 'paymentTermsDays', kind: 'text', value: '30' }, { label: 'estimateRevision', kind: 'text', value: '2' }, { label: 'status', kind: 'text', value: 'draft' },
      { label: 'countryRevision', kind: 'text', value: '3' }, { label: 'sellerRevision', kind: 'text', value: '4' }],
    sections: [{ kind: 'estimate_lines', columns: US_FINANCIAL_PILOT_EXPORT_COLUMNS.estimate_lines,
      rows: [['Synthetic full units', '3', '10000', '125', '29625'], ['Synthetic fractional rounding', '1.005', '100', '125', '100']],
      totals: [{ label: 'subtotal', minorUnits: '30101' }, { label: 'discount', minorUnits: '376' }, { label: 'net', minorUnits: '29725' }] }],
    notes: 'Synthetic conditions\nSecond line retained.',
  };
}

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

describe('financial pilot estimate PDF: separate closed variant, identity metadata and exact line discounts', () => {
  it('captures the PDF-only selector in every language, including encoded-route characters without transforming the ID', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const input = { ...estimate().selector, language, estimateId: 'synthetic/é?x#1' }, captured = validateUsFinancialPilotExportSelector(input);
      input.estimateId = 'changed'; expect(captured).toMatchObject({ kind: 'estimate', estimateId: 'synthetic/é?x#1', estimateRevision: 2, language }); expect(Object.isFrozen(captured)).toBe(true);
    }
  });
  it.each([
    { estimateId: '' }, { estimateId: ' padded' }, { estimateId: 'trailing ' }, { estimateId: 'a\nb' }, { estimateId: 'x'.repeat(161) },
    { estimateId: '\ud800' }, { estimateRevision: 0 }, { estimateRevision: 1.5 }, { estimateRevision: Number.MAX_SAFE_INTEGER },
    { revision: Number.MAX_SAFE_INTEGER }, { format: 'csv' }, { format: 'html' }, { status: 'accepted' }, { seller: {} }, { bankRevision: 1 },
  ])('rejects malformed/extra estimate selector fields %#', changes => {
    expect(() => validateUsFinancialPilotExportSelector({ ...estimate().selector, ...changes })).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_export_selector', status: 422 }));
  });
  it('keeps the old 15-field variants closed and requires exactly the new quote metadata', () => {
    const valid = estimate(), result = validateUsFinancialPilotExportSnapshot(valid, valid.organizationId, valid.selector);
    expect(result).toEqual(valid); expect(Object.keys(result)).toHaveLength(16); expect(Object.keys(receivables())).toHaveLength(15);
    expect(Object.isFrozen(result.estimate)).toBe(true); expect(Object.isFrozen(result.sections[0].rows[1])).toBe(true);
    const { estimate: omitted, ...without } = valid; expect(omitted).toBeDefined();
    for (const input of [without, { ...receivables(), estimate: valid.estimate }, { ...valid, estimate: { ...valid.estimate, policy: 'PRIVATE' } }, { ...valid, recipient: null }, { ...valid, issuer: { ...valid.issuer, name: null } }]) expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow(expect.objectContaining({ status: 503 }));
  });
  it.each([
    { estimateId: 'other' }, { estimateRevision: 3 }, { status: 'issued' }, { countryRevision: 0 }, { countryRevision: Number.MAX_SAFE_INTEGER },
    { sellerRevision: -1 }, { sellerRevision: 5 }, { issuerBasis: 'at_issuance' }, { amountBasis: 'tax_included' },
  ])('rejects metadata substitution/correlation mismatch %#', changes => {
    const input = estimate(); expect(() => validateUsFinancialPilotExportSnapshot({ ...input, estimate: { ...input.estimate, ...changes } })).toThrow();
  });
  it('accepts draft, accepted and declined without pretending the export changes a status', () => {
    for (const status of ['draft', 'accepted', 'declined'] as const) {
      const input = estimate(); expect(validateUsFinancialPilotExportSnapshot({ ...input, estimate: { ...input.estimate, status }, facts: input.facts.map(fact => fact.label === 'status' ? { ...fact, value: status } : fact) }).estimate?.status).toBe(status);
    }
  });
  it.each([
    ['estimateDate', '2026-02-30'], ['expiresAt', '2026-10-09'], ['paymentTermsDays', '366'], ['paymentTermsDays', '030'],
    ['estimateRevision', '02'], ['status', 'accepted'], ['countryRevision', '4'], ['sellerRevision', '3'], ['financialRevision', '13'],
  ])('rejects a forged quote fact %s=%s', (label, value) => {
    const input = estimate(); expect(() => validateUsFinancialPilotExportSnapshot({ ...input, facts: input.facts.map(fact => fact.label === label ? { ...fact, value } : fact) })).toThrow();
  });
  it('verifies each line gross, rounded discount and net as well as the full totals', () => {
    const input = estimate(); expect(validateUsFinancialPilotExportSnapshot(input).sections[0].totals.map(total => total.minorUnits)).toEqual(['30101', '376', '29725']);
    for (const [index, value] of [[1, '3.0000001'], [1, '03'], [1, '0'], [1, '-1'], [1, '1e2'], [2, '010000'], [3, '0125'], [3, '10001'], [3, '-1'], [3, '12.5'], [4, '29626']] as const) {
      const changed = structuredClone(input); (changed.sections[0].rows as string[][])[0][index] = value; expect(() => validateUsFinancialPilotExportSnapshot(changed)).toThrow();
    }
    // Both forged totals balance, but neither matches the row-level computation.
    const changed = structuredClone(input); (changed.sections[0].totals[0] as { minorUnits: string }).minorUnits = '30102'; (changed.sections[0].totals[2] as { minorUnits: string }).minorUnits = '29726';
    expect(() => validateUsFinancialPilotExportSnapshot(changed)).toThrow();
  });
  it('preserves cents beyond Number precision and permits zero/full discounts exactly', () => {
    for (const [discount, net] of [['0', '900719925474099301'], ['10000', '0']] as const) {
      const input = estimate(), amount = '900719925474099301';
      const sections = [{ ...input.sections[0], rows: [['Synthetic large amount', '1', amount, discount, net]], totals: [{ label: 'subtotal' as const, minorUnits: amount }, { label: 'discount' as const, minorUnits: (BigInt(amount) - BigInt(net)).toString() }, { label: 'net' as const, minorUnits: net }] }];
      expect(validateUsFinancialPilotExportSnapshot({ ...input, sections }).sections[0].rows[0][4]).toBe(net);
    }
  });
  it('refuses missing/extra rows, fiscal columns and inferred tax totals', () => {
    const input = estimate();
    for (const section of [
      { ...input.sections[0], rows: [] },
      { ...input.sections[0], columns: [...input.sections[0].columns, { label: 'tax', kind: 'money', align: 'right' }] },
      { ...input.sections[0], totals: [...input.sections[0].totals, { label: 'tax', minorUnits: '0' }] },
      { ...input.sections[0], kind: 'invoice_lines' },
    ]) expect(() => validateUsFinancialPilotExportSnapshot({ ...input, sections: [section] })).toThrow();
  });
  it('captures hostile quote inputs without invoking accessors or accepting symbols/prototypes', () => {
    let calls = 0; const getter = { ...estimate(), get estimate() { calls++; return {}; } };
    expect(() => validateUsFinancialPilotExportSnapshot(getter)).toThrow(); expect(calls).toBe(0);
    for (const input of [{ ...estimate(), [Symbol('private')]: true }, Object.assign(Object.create({ inherited: true }), estimate()), { ...estimate(), notes: '\udfff' }]) expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow();
  });
  it('enforces the quote UTF-8 serialized budget after bounded capture, without truncation', () => {
    expect(US_FINANCIAL_PILOT_ESTIMATE_EXPORT_MAX_SNAPSHOT_BYTES).toBe(2_097_152);
    // Escaped controls fit the structural character budget but exceed the JSON
    // byte budget; budget rejection occurs before later field validation.
    const input = { ...estimate(), notes: '\u0001'.repeat(350_000) };
    expect(() => validateUsFinancialPilotExportSnapshot(input)).toThrow(expect.objectContaining({ code: 'financial_pilot_export_too_large', status: 413 }));
    const rows = Array.from({ length: 1001 }, () => estimate().sections[0].rows[0]);
    expect(() => validateUsFinancialPilotExportSnapshot({ ...estimate(), sections: [{ ...estimate().sections[0], rows }] })).toThrow(expect.objectContaining({ status: 413 }));
  });
});
