import { describe, expect, it } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { balanceSheet, generalLedger, profitAndLoss, trialBalance } from './accounting/reports';
import { buildTaxRequest } from './invoicing';
import { money } from './money';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import type { UsFinancialErpCommandV5, UsFinancialOperationV5 } from './us-financial-kernel-types';
import { validateUsFinancialPilotExportSnapshot, type UsFinancialPilotExportSelector, type UsFinancialPilotEstimateExportSelector } from './us-financial-pilot-export-contract';
import { buildUsFinancialPilotEstimateExportSnapshot, buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';
import type { UsFinancialPilotQuoteIdentity } from './us-financial-pilot-quote-identity';

async function fixture(options: Parameters<typeof financialKernelFixture>[0] = {}) {
  const data = await financialKernelFixture(options); let book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const apply = async (operation: UsFinancialOperationV5, id = `synthetic-entity-${book.revision}`) => { book = (await applyUsFinancialOperationV5(book, operation, data.actor, operation.type === 'erp_command' ? usFinancialErpEntityIdV5(operation.command, data.configuration.organizationId) : id)).book; };
  const erp = (command: UsFinancialErpCommandV5) => apply({ type: 'erp_command', idempotencyKey: `PRIVATE-ERP-${book.revision}`, command, facts: { kind: 'none' } });
  const credit = async () => {
    const input = { type: 'customer_credit' as const, idempotencyKey: 'PRIVATE-CREDIT-KEY', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic quantity correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] };
    const candidate = await buildUsFinancialCreditCandidateV5(book, input);
    await apply({ ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'PRIVATE-PROOF', verifiedBy: 'PRIVATE-REVIEWER', verifiedAt: data.actor.timestamp, providerAccountReference: 'PRIVATE-PROVIDER-ACCOUNT', originalTaxTransactionReference: 'testtxn_PRIVATE', adjustmentPlanReference: 'PRIVATE-ADJUSTMENT-PLAN', authorizedTaxMinor: candidate.allocation.taxMinor } }, 'synthetic-credit');
  };
  const payment = (index = 0, amount = '1000') => apply({ type: 'customer_payment', idempotencyKey: `PRIVATE-PAYMENT-KEY-${index}`, invoiceId: 'invoice-1', amountMinor: amount, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: `Synthetic receipt ${index}` }, `synthetic-payment-${index}`);
  const invoice = (language: 'fr' | 'de' | 'it' | 'en' = 'en'): UsFinancialPilotExportSelector => ({ kind: 'invoice', invoiceId: 'invoice-1', revision: book.revision, language, format: 'pdf' });
  const report = (reportType: 'trial_balance' | 'balance_sheet' | 'profit_loss' | 'cash_flow' | 'general_ledger' | 'receivables'): UsFinancialPilotExportSelector => {
    const base = { kind: 'report' as const, reportType, revision: book.revision, language: 'en' as const, format: 'csv' as const };
    if (reportType === 'trial_balance' || reportType === 'balance_sheet') return { ...base, reportType, asOf: '2027-12-31' };
    if (reportType === 'receivables') return { ...base, reportType };
    if (reportType === 'general_ledger') return { ...base, reportType, from: '2026-01-01', to: '2027-12-31', accountId: 'receivables' };
    return { ...base, reportType, from: '2026-01-01', to: '2027-12-31' };
  };
  const quote = (estimateId = 'estimate-1', estimateRevision = 2): UsFinancialPilotEstimateExportSelector => ({ kind: 'estimate', estimateId, estimateRevision, revision: book.revision, language: 'en', format: 'pdf' });
  const identity = (sellerRevision = 3): UsFinancialPilotQuoteIdentity => ({ organizationId: data.configuration.organizationId, countryRevision: 2, configuration: data.configuration, sellerRevision, seller: { displayName: 'Synthetic Current Quote Seller', contactEmail: 'current-quote-seller@example.test', contactPhone: '+1 212 555 0100' } });
  return { ...data, apply, erp, credit, payment, invoice, report, quote, identity, book: () => book };
}

describe('financial pilot exports: real V5 financial projection, not UI pages or ERP4 exports', () => {
  it('separates received/credited/outstanding and keeps parties frozen at issuance', async () => {
    const t = await fixture(); await t.credit(); await t.payment();
    await t.erp({ type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Changed customer after issuance' } });
    const before = canonicalErpJson(t.book()), snapshot = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice());
    expect(snapshot.sections[0].totals.map(total => total.minorUnits)).toEqual(['30000', '0', '30000', '2475', '32475', '1000', '10825', '20650']);
    expect(snapshot.sections[1].rows).toEqual([['Synthetic receipt 0', '2026-10-10', '2026-10-10', '1000']]);
    expect(snapshot.sections[2].rows[0]).toContain('adjustment_pending'); expect(snapshot.recipient?.name).toBe(t.baseline.invoices[0].customer.name);
    expect(snapshot.issuer.name).toBe(t.baseline.invoices[0].sellerSnapshot.displayName); expect(snapshot.issuer.address).toEqual(t.baseline.invoices[0].companyConfiguration.address);
    const text = JSON.stringify(snapshot);
    for (const secret of ['PRIVATE-', 'testtxn_', 'taxAssessment', 'idempotencyKey', 'baselineSha256', 'invoiceFingerprint', 'allocationSha256', 'policy', 'providerReference', 'grantVersion', 'logoRef', 'ein']) expect(text).not.toContain(secret);
    expect(canonicalErpJson(t.book())).toBe(before); expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('exports every payment and GL movement beyond the UI page size25', async () => {
    const t = await fixture(); for (let index = 0; index < 26; index++) await t.payment(index, '1');
    const snapshot = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice());
    expect(snapshot.sections[1].rows).toHaveLength(26); expect(new Set(snapshot.sections[1].rows.map(row => row[0])).size).toBe(26);
    expect(snapshot.sections[1].totals).toEqual([{ label: 'received', minorUnits: '26' }]);
    const gl = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('general_ledger'));
    expect(gl.sections[0].rows).toHaveLength(27); expect(gl.sections[0].totals).toEqual([{ label: 'opening', minorUnits: '0' }, { label: 'closing', minorUnits: '32449' }]);
    expect(gl.sections[0].rows.at(-1)?.[7]).toBe('32449');
  }, 25_000);
  it('exports all 26 immutable credits on a genuinely issued V5 invoice and their current AR', async () => {
    const t = await fixture({ tax: '0' });
    await t.erp({ type: 'save_estimate', id: 'estimate-many', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, notes: 'Synthetic quantity fixture', lines: [{ id: 'line-many', description: 'Synthetic units', quantityUnits: '30', quantityScale: 0, unitPrice: money('USD', '1000'), discountBasisPoints: 0, taxTreatment: 'taxable' }] });
    await t.erp({ type: 'accept_estimate', estimateId: 'estimate-many', expectedEstimateRevision: 1 });
    const view = await projectUsFinancialBookV5(t.book()), estimate = view.estimates.find(row => row.id === 'estimate-many'); if (!estimate) throw Error('Missing synthetic estimate');
    const taxRequest = buildTaxRequest(view.configuration, estimate, '2026-10-10'), original = t.baseline.invoices[0];
    const command: UsFinancialErpCommandV5 = { type: 'issue_invoice', id: 'invoice-many', estimateId: estimate.id, expectedEstimateRevision: estimate.revision, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' };
    await t.apply({ type: 'erp_command', idempotencyKey: 'PRIVATE-ISSUE-MANY', command, facts: { kind: 'invoice_issuance', sellerSnapshot: original.sellerSnapshot, taxAssessment: { ...original.taxAssessment, documentId: estimate.id, documentRevision: estimate.revision, fingerprint: taxRequest.fingerprint, lines: [{ id: 'line-many', taxMinor: '0', jurisdiction: 'synthetic-only-no-law-claim', evidenceReference: 'PRIVATE-SYNTHETIC-EVIDENCE' }] } } });
    for (let index = 0; index < 26; index++) {
      const input = { type: 'customer_credit' as const, idempotencyKey: `PRIVATE-MANY-CREDIT-${index}`, invoiceId: 'invoice-many', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: `Synthetic correction ${index}`, selections: [{ lineId: 'line-many', quantityUnits: '1' }] };
      const candidate = await buildUsFinancialCreditCandidateV5(t.book(), input);
      await t.apply({ ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'historical_zero_tax', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'PRIVATE-HISTORICAL-REVIEW', verifiedBy: 'PRIVATE-REVIEWER', verifiedAt: t.actor.timestamp } }, `synthetic-credit-${index}`);
    }
    const selector: UsFinancialPilotExportSelector = { kind: 'invoice', invoiceId: 'invoice-many', revision: t.book().revision, language: 'en', format: 'pdf' };
    const snapshot = await buildUsFinancialPilotExportSnapshot(t.book(), selector);
    expect(snapshot.sections[2].rows).toHaveLength(26); expect(new Set(snapshot.sections[2].rows.map(row => row[0])).size).toBe(26);
    expect(snapshot.sections[2].totals[0].minorUnits).toBe('26000'); expect(snapshot.sections[0].totals.map(total => total.minorUnits).slice(4)).toEqual(['30000', '0', '26000', '4000']);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-');
    const ar = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('receivables')); expect(ar.sections[0].rows).toHaveLength(2); expect(ar.sections[0].totals.map(total => total.minorUnits)).toEqual(['60000', '0', '26000', '34000']);
  }, 25_000);
  it('uses current periods and actual credits, purchases and reversals in each report', async () => {
    const t = await fixture(); await t.credit(); await t.payment();
    await t.erp({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor-test', name: 'Synthetic vendor' } });
    await t.erp({ type: 'record_vendor_bill', id: 'bill-test', vendorId: 'vendor-test', reference: 'SYNTHETIC-BILL', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '5000', purchaseTaxMinor: '0', expenseAccountId: 'purchases', sourceReference: 'synthetic-document' });
    await t.erp({ type: 'post_manual_journal', id: 'manual-test', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic financing', sourceReference: 'SYNTHETIC-MANUAL', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '500', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '500' }] });
    const current = await projectUsFinancialBookV5(t.book()), original = current.ledger.entries.find(entry => entry.source.type === 'manual_journal'); if (!original) throw Error('Missing synthetic journal');
    await t.erp({ type: 'reverse_manual_journal', entryId: original.id, id: 'reversal-test', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic reversal' });
    await t.erp({ type: 'close_period', periodId: '2026' }); await t.erp({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    const view = await projectUsFinancialBookV5(t.book()), range = { start: '2026-01-01', end: '2027-12-31' };
    expect(view.ledger.revision).toBeGreaterThan(view.ledger.entries.length); expect(view.ledger.periods.map(period => period.status)).toEqual(['closed', 'open']);
    const tb = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('trial_balance')), expectedTb = trialBalance(view.ledger, '2027-12-31');
    expect(tb.sections[0].totals.map(total => total.minorUnits)).toEqual([expectedTb.totalDebitMinor, expectedTb.totalCreditMinor]);
    const pl = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('profit_loss')), expectedPl = profitAndLoss(view.ledger, range);
    expect(pl.sections[0].totals.map(total => total.minorUnits)).toEqual([expectedPl.incomeMinor, expectedPl.expenseMinor, expectedPl.profitMinor]);
    const bs = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('balance_sheet')), expectedBs = balanceSheet(view.ledger, '2027-12-31');
    expect(bs.sections[0].totals.map(total => total.minorUnits)).toEqual([expectedBs.assetsMinor, expectedBs.liabilitiesMinor, expectedBs.equityMinor, expectedBs.unclosedEarningsMinor]);
    const flow = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('cash_flow')); expect(flow.sections[0].totals.find(total => total.label === 'financing')?.minorUnits).toBe('0');
    const gl = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('general_ledger')), expectedGl = generalLedger(view.ledger, 'receivables', range);
    expect(gl.ledgerRevision).toBe(view.ledger.revision); expect(gl.sections[0].rows).toHaveLength(expectedGl.movements.length); expect(gl.sections[0].totals[1].minorUnits).toBe(expectedGl.closingMinor);
    const ar = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('receivables')); expect(ar.sections[0].totals.map(total => total.minorUnits)).toEqual(['32475', '1000', '10825', '20650']);
    for (const snapshot of [tb, pl, bs, flow, gl, ar]) { expect(snapshot.issuer.name).toBeNull(); expect(snapshot.issuer.address).toEqual(view.configuration.address); expect(snapshot.recipient).toBeNull(); expect(validateUsFinancialPilotExportSnapshot(snapshot)).toEqual(snapshot); }
  });
  it('supports exact large minor amounts and source discounts without recasting them as Number', async () => {
    const t = await fixture({ tax: '900719925474099300', discountBasisPoints: 125 });
    const invoice = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice());
    expect(invoice.sections[0].totals.map(total => total.minorUnits).slice(0, 5)).toEqual(['30000', '375', '29625', '900719925474099300', '900719925474128925']);
    expect(invoice.sections[0].rows[0].slice(3)).toEqual(['29625', '900719925474099300', '900719925474128925']);
  });
  it('keeps user data unchanged and dates ISO in all four presentation languages', async () => {
    const t = await fixture();
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const snapshot = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice(language));
      expect(snapshot.language).toBe(language); expect(snapshot.facts.find(fact => fact.label === 'date')).toEqual({ label: 'date', value: '2026-10-09', kind: 'date' });
      expect(snapshot.sections[0].rows[0][0]).toBe(t.baseline.invoices[0].lines[0].description);
    }
  });
  it('does not admit an unclassified cash movement into the source financial book', async () => {
    const t = await fixture(), before = canonicalErpJson(t.book());
    await expect(t.erp({ type: 'post_manual_journal', id: 'unclassified-manual', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic cash movement awaiting classification', sourceReference: 'Synthetic review pending', lines: [{ accountId: 'cash', debitMinor: '500', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '500' }] })).rejects.toMatchObject({ code: 'CASH_FLOW_CLASSIFICATION_REQUIRED' });
    expect(canonicalErpJson(t.book())).toBe(before);
    const flow = await buildUsFinancialPilotExportSnapshot(t.book(), t.report('cash_flow'));
    expect(flow.sections[0].totals.every(total => total.minorUnits === '0')).toBe(true);
  });
  it('captures source and selector synchronously, rejects corruption/stale scope and never changes its source', async () => {
    const t = await fixture(), source = structuredClone(t.book()), selector = { ...t.invoice() };
    const pending = buildUsFinancialPilotExportSnapshot(source, selector);
    (source as { revision: number }).revision++; (selector as { invoiceId: string }).invoiceId = 'missing';
    expect((await pending).number).toBe(t.baseline.invoices[0].number);
    await expect(buildUsFinancialPilotExportSnapshot(source, t.invoice())).rejects.toMatchObject({ status: 503 });
    await expect(buildUsFinancialPilotExportSnapshot(t.book(), { ...t.invoice(), revision: t.book().revision - 1 })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(buildUsFinancialPilotExportSnapshot(t.book(), { ...t.invoice(), invoiceId: 'missing' } as UsFinancialPilotExportSelector)).rejects.toMatchObject({ code: 'financial_pilot_export_source_not_found', status: 404 });
    await expect(buildUsFinancialPilotExportSnapshot(t.book(), { ...t.report('general_ledger'), accountId: 'missing' } as UsFinancialPilotExportSelector)).rejects.toMatchObject({ status: 404 });
  });
});

describe('financial pilot quote PDF projection: complete V5 estimate and separately versioned current issuer', () => {
  it('also exports a declined quote from a genuinely validated promoted historical baseline', async () => {
    const data = await financialKernelFixture(), historical = { ...data.baseline.estimates[0], id: 'quote-declined', number: 'EST-000002', revision: 1, status: 'declined' as const };
    const baseline = { ...data.baseline, counters: { ...data.baseline.counters, estimate: 2 }, estimates: [...data.baseline.estimates, historical] };
    const book = await promoteUsFinancialBookV5(baseline, data.policy, data.actor);
    const identity: UsFinancialPilotQuoteIdentity = { organizationId: data.configuration.organizationId, configuration: data.configuration, countryRevision: 1, sellerRevision: 1, seller: { displayName: 'Synthetic Current Seller' } };
    const snapshot = await buildUsFinancialPilotEstimateExportSnapshot(book, { kind: 'estimate', estimateId: historical.id, estimateRevision: 1, revision: book.revision, language: 'en', format: 'pdf' }, identity);
    expect(snapshot.estimate.status).toBe('declined'); expect(snapshot.facts.find(fact => fact.label === 'status')?.value).toBe('declined'); expect(snapshot.number).toBe(historical.number);
  });
  it('exports the accepted source quote with current seller, historical customer and no invented tax', async () => {
    const t = await fixture({ discountBasisPoints: 125 }), before = canonicalErpJson(t.book());
    const snapshot = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), t.identity());
    expect(snapshot.estimate).toEqual({ estimateId: 'estimate-1', estimateRevision: 2, status: 'accepted', countryRevision: 2, sellerRevision: 3, issuerBasis: 'current_at_export', amountBasis: 'before_sales_tax' });
    expect(snapshot.number).toBe(t.baseline.estimates[0].number); expect(snapshot.recipient?.name).toBe(t.baseline.estimates[0].customer.name);
    expect(snapshot.issuer).toEqual({ name: 'Synthetic Current Quote Seller', address: t.configuration.address, email: 'current-quote-seller@example.test', phone: '+1 212 555 0100' });
    expect(snapshot.sections[0].rows).toEqual([[t.baseline.estimates[0].lines[0].description, '3', '10000', '125', '29625']]);
    expect(snapshot.sections[0].totals.map(total => total.minorUnits)).toEqual(['30000', '375', '29625']);
    expect(snapshot.facts.map(fact => fact.label)).toEqual(['organization', 'currency', 'accountingBasis', 'financialRevision', 'ledgerRevision', 'estimateDate', 'expiresAt', 'paymentTermsDays', 'estimateRevision', 'status', 'countryRevision', 'sellerRevision']);
    expect(snapshot.facts.find(fact => fact.label === 'estimateDate')).toEqual({ label: 'estimateDate', kind: 'date', value: '2026-10-09' });
    const publicText = JSON.stringify(snapshot);
    for (const secret of ['PRIVATE-', 'idempotencyKey', 'policy', 'taxAssessment', 'providerReference', 'baselineSha256', 'grantVersion', 'logoRef', 'ein', 'taxMinor', 'outstanding']) expect(publicText).not.toContain(secret);
    expect(canonicalErpJson(t.book())).toBe(before); expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.estimate)).toBe(true);
  });
  it('keeps the quote customer historical after a party edit and changes it only on explicit quote resave', async () => {
    const t = await fixture();
    const command = { type: 'save_estimate' as const, id: 'quote-editable', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 14, notes: 'Synthetic terms\nKeep this second line.', lines: [{ id: 'quote-line', description: 'Synthetic service', quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '1000'), discountBasisPoints: 0, taxTreatment: 'taxable' as const }] };
    await t.erp(command);
    const first = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(command.id, 1), t.identity());
    await t.erp({ type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Synthetic Corrected Customer', email: 'corrected@example.test' } });
    const unchanged = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(command.id, 1), t.identity());
    expect(unchanged.recipient).toEqual(first.recipient); expect(unchanged.notes).toBe(command.notes); expect(unchanged.sections).toEqual(first.sections);
    await t.erp({ ...command, expectedEstimateRevision: 1 });
    const resaved = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(command.id, 2), t.identity());
    expect(resaved.recipient).toMatchObject({ name: 'Synthetic Corrected Customer', email: 'corrected@example.test' }); expect(resaved.estimate.status).toBe('draft');
    const invoice = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice()); expect(invoice.recipient?.name).toBe(t.baseline.invoices[0].customer.name);
  });
  it('uses a later current seller revision without rewriting the quote or the issued invoice identity', async () => {
    const t = await fixture(), before = canonicalErpJson(t.book()), issuedBefore = await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice());
    const first = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), t.identity());
    const updated = { ...t.identity(4), seller: { displayName: 'Synthetic Current Seller Renamed' } };
    const next = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), updated);
    expect(next.estimate.sellerRevision).toBe(4); expect(next.issuer.name).toBe('Synthetic Current Seller Renamed'); expect(next.issuer.email).toBeNull();
    expect(next.recipient).toEqual(first.recipient); expect(next.sections).toEqual(first.sections); expect(next.number).toBe(first.number);
    expect(await buildUsFinancialPilotExportSnapshot(t.book(), t.invoice())).toEqual(issuedBefore); expect(canonicalErpJson(t.book())).toBe(before);
  });
  it('reads all 101 persisted lines independently of the commercial form page limit', async () => {
    const t = await fixture();
    await t.erp({ type: 'save_estimate', id: 'quote-long', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 0, notes: 'Synthetic long document', lines: Array.from({ length: 101 }, (_, index) => ({ id: `quote-line-${index}`, description: `Synthetic line ${index}`, quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '100'), discountBasisPoints: 0, taxTreatment: 'taxable' as const })) });
    const snapshot = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote('quote-long', 1), t.identity());
    expect(snapshot.sections[0].rows).toHaveLength(101); expect(new Set(snapshot.sections[0].rows.map(row => row[0])).size).toBe(101);
    expect(snapshot.sections[0].totals.map(total => total.minorUnits)).toEqual(['10100', '0', '10100']); expect(snapshot.facts.find(fact => fact.label === 'paymentTermsDays')?.value).toBe('0');
  }, 25_000);
  it('uses two-stage exact rounding for fractional quantities and values beyond Number precision', async () => {
    const t = await fixture();
    await t.erp({ type: 'save_estimate', id: 'quote-exact', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, notes: '', lines: [
      { id: 'fractional', description: 'Synthetic fractional rounding', quantityUnits: '1005', quantityScale: 3, unitPrice: money('USD', '100'), discountBasisPoints: 125, taxTreatment: 'taxable' },
      { id: 'large', description: 'Synthetic large amount', quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '900719925474099301'), discountBasisPoints: 0, taxTreatment: 'non_taxable' },
    ] });
    const snapshot = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote('quote-exact', 1), t.identity());
    expect(snapshot.sections[0].rows.map(row => row.slice(1))).toEqual([['1.005', '100', '125', '100'], ['1', '900719925474099301', '0', '900719925474099301']]);
    expect(snapshot.sections[0].totals.map(total => total.minorUnits)).toEqual(['900719925474099402', '1', '900719925474099401']);
  });
  it('leaves a mixed paid/credited/purchase/manual book entirely unchanged in every presentation language', async () => {
    const t = await fixture(); await t.credit(); await t.payment();
    await t.erp({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'quote-vendor', name: 'Synthetic Vendor' } });
    await t.erp({ type: 'record_vendor_bill', id: 'quote-bill', vendorId: 'quote-vendor', reference: 'SYNTHETIC-QUOTE-BILL', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-10', periodId: '2026', netMinor: '5000', purchaseTaxMinor: '0', expenseAccountId: 'purchases', sourceReference: 'synthetic-source' });
    await t.erp({ type: 'post_manual_journal', id: 'quote-journal', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic financing', sourceReference: 'synthetic-quote-journal', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '500', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '500' }] });
    const before = canonicalErpJson(t.book()), view = await projectUsFinancialBookV5(t.book());
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const snapshot = await buildUsFinancialPilotEstimateExportSnapshot(t.book(), { ...t.quote(), language }, t.identity());
      expect(snapshot.language).toBe(language); expect(snapshot.revision).toBe(view.revision); expect(snapshot.ledgerRevision).toBe(view.ledger.revision); expect(snapshot.sections[0].rows[0][0]).toBe(view.estimates[0].lines[0].description); expect(validateUsFinancialPilotExportSnapshot(snapshot)).toEqual(snapshot);
    }
    expect(canonicalErpJson(t.book())).toBe(before);
  });
  it('captures book, selector and identity synchronously before replay and never invokes hostile accessors', async () => {
    const t = await fixture(), source = structuredClone(t.book()), selector = { ...t.quote() }, identity = structuredClone(t.identity());
    const pending = buildUsFinancialPilotEstimateExportSnapshot(source, selector, identity);
    (source as { revision: number }).revision++; selector.estimateId = 'changed'; (identity.seller as { displayName: string }).displayName = 'Changed during await';
    const result = await pending; expect(result.estimate.estimateId).toBe('estimate-1'); expect(result.issuer.name).toBe('Synthetic Current Quote Seller');
    let calls = 0; const hostile = { ...t.identity(), get seller() { calls++; return {}; } } as unknown as UsFinancialPilotQuoteIdentity;
    await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), hostile)).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_snapshot', status: 503 }); expect(calls).toBe(0);
  });
  it('refuses missing source, stale E/F, mismatched identity configuration and the old identity-free builder', async () => {
    const t = await fixture();
    await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), { ...t.quote(), estimateId: 'missing' }, t.identity())).rejects.toMatchObject({ code: 'financial_pilot_export_source_not_found', status: 404 });
    await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), { ...t.quote(), estimateRevision: 1 }, t.identity())).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await t.payment();
    await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), { ...t.quote(), revision: t.book().revision - 1 }, t.identity())).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    const changed = { ...t.identity(), configuration: { ...t.configuration, timeZone: 'America/Chicago' } };
    await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), changed)).rejects.toMatchObject({ code: 'financial_pilot_quote_identity_changed', status: 409 });
    for (const identity of [{ ...t.identity(), countryRevision: 0 }, { ...t.identity(), sellerRevision: Number.MAX_SAFE_INTEGER }, { ...t.identity(), organizationId: 'other-workspace' }, { ...t.identity(), organizationId: 'other-workspace', configuration: { ...t.configuration, organizationId: 'other-workspace' } }]) await expect(buildUsFinancialPilotEstimateExportSnapshot(t.book(), t.quote(), identity)).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_snapshot', status: 503 });
    await expect(buildUsFinancialPilotExportSnapshot(t.book(), t.quote())).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_selector', status: 422 });
  });
});
