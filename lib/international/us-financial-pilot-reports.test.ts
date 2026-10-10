import { describe, expect, it } from 'vitest';
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from './accounting/reports';
import { canonicalErpJson } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialOperationV5 } from './us-financial-kernel-types';
import { financialPilotCursor, validateUsFinancialPilotReports } from './us-financial-pilot-contract';
import { projectUsFinancialPilotOverview } from './us-financial-pilot-projection';
import { projectUsFinancialPilotReports } from './us-financial-pilot-reports';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';

const range = { from: '2026-01-01', to: '2027-12-31', asOf: '2027-12-31' };
async function fixture() {
  const data = await financialKernelFixture(); let actor = data.actor, book = await promoteUsFinancialBookV5(data.baseline, data.policy, actor);
  const apply = async (operation: UsFinancialOperationV5, id = `public-event-${book.revision}`) => { book = (await applyUsFinancialOperationV5(book, operation, actor, operation.type === 'erp_command' ? usFinancialErpEntityIdV5(operation.command, data.configuration.organizationId) : id)).book; };
  const erp = (command: UsFinancialErpCommandV5, key = `PRIVATE-KEY-${book.revision}`) => apply({ type: 'erp_command', idempotencyKey: key, command, facts: { kind: 'none' } });
  const credit = async (id: string, nextYear = false) => {
    const date = nextYear ? '2027-01-05' : '2026-10-10', input = { type: 'customer_credit' as const, idempotencyKey: `PRIVATE-CREDIT-${id}`, invoiceId: 'invoice-1', transactionDate: date, accountingDate: date, periodId: nextYear ? '2027' : '2026', reason: 'Synthetic credit', selections: [{ lineId: 'line-1', quantityUnits: '1' }] }, candidate = await buildUsFinancialCreditCandidateV5(book, input);
    await apply({ ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'PRIVATE-PROOF', verifiedBy: 'synthetic-reviewer', verifiedAt: actor.timestamp, providerAccountReference: 'PRIVATE-PROVIDER-ACCOUNT', originalTaxTransactionReference: 'testtxn_synthetic', adjustmentPlanReference: `private-plan-${id}`, authorizedTaxMinor: candidate.allocation.taxMinor } }, id);
  };
  const manual = (id: string, amount = '5000') => erp({ type: 'post_manual_journal', id, transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic capital', sourceReference: 'Reviewed synthetic capital', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: amount, creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: amount }] });
  const next = () => { actor = { ...actor, timestamp: '2027-01-05T12:00:00.000Z' }; };
  return { ...data, erp, apply, credit, manual, next, book: () => book };
}

describe('financial-pilot real-ledger reports and current receivables', () => {
  it('reports the complete mixed AR/AP/credit/payment/year-close cycle with actual ledger revisions', async () => {
    const t = await fixture(); await t.credit('credit-A'); await t.erp({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor', name: 'Synthetic supplier' } });
    await t.erp({ type: 'record_vendor_bill', id: 'bill', vendorId: 'vendor', reference: 'Synthetic supplier invoice', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'synthetic-source' });
    await t.erp({ type: 'record_vendor_payment', id: 'vendor-partial', billId: 'bill', amountMinor: '4000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic partial transfer' }); await t.manual('public-capital');
    await t.erp({ type: 'close_period', periodId: '2026' }); await t.erp({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); t.next();
    await t.apply({ type: 'customer_payment', idempotencyKey: 'PRIVATE-CUSTOMER-PAYMENT', invoiceId: 'invoice-1', amountMinor: '1000', paymentDate: '2027-01-05', accountingDate: '2027-01-05', periodId: '2027', reference: 'Synthetic receipt' }, 'public-receipt'); await t.credit('credit-B', true);
    await t.erp({ type: 'record_vendor_payment', id: 'vendor-final', billId: 'bill', amountMinor: '6825', paymentDate: '2027-01-05', accountingDate: '2027-01-05', periodId: '2027', reference: 'Synthetic final transfer' });
    await t.erp({ type: 'reverse_manual_journal', id: 'public-reversal', entryId: 'public-capital', transactionDate: '2027-01-05', accountingDate: '2027-01-05', periodId: '2027', reason: 'Synthetic correction' });
    const book = t.book(), before = canonicalErpJson(book), view = await projectUsFinancialBookV5(book), result = await projectUsFinancialPilotReports(book, { revision: book.revision, ...range, accountId: 'cash' });
    expect(result.ledgerRevision).toBe(11); expect(result.currentReceivables).toMatchObject({ scope: 'current', summary: { totalMinor: '32475', receivedMinor: '1000', creditedMinor: '21650', outstandingMinor: '9825' } });
    expect(result.profitAndLoss).toMatchObject({ incomeMinor: '10000', expenseMinor: '10825', profitMinor: '-825' });
    expect(result.cashFlow).toMatchObject({ status: 'available', method: 'direct', operatingMinor: '-9825', financingMinor: '0', closingMinor: '-9825' });
    expect(result.generalLedger).toMatchObject({ openingMinor: '0', closingMinor: '-9825', pageOpeningMinor: '0', pageClosingMinor: '-9825' });
    expect(result.trialBalance.rows).toEqual(trialBalance(view.ledger, range.asOf).rows);
    expect(result.balanceSheet).toMatchObject({ assetsMinor: balanceSheet(view.ledger, range.asOf).assetsMinor, unclosedEarningsMinor: balanceSheet(view.ledger, range.asOf).unclosedEarningsMinor, balanced: true });
    expect(result.profitAndLoss.profitMinor).toBe(profitAndLoss(view.ledger, { start: range.from, end: range.to }).profitMinor);
    expect(result.cashFlow.status === 'available' && result.cashFlow.closingMinor).toBe(cashFlow(view.ledger, { start: range.from, end: range.to }).closingMinor);
    const text = JSON.stringify(result); for (const privateText of ['PRIVATE-', 'entry:', 'idempotencyKey', 'fingerprint', 'providerReference', 'testtxn_', 'baselineSha256', 'commandHash']) expect(text).not.toContain(privateText);
    const overview = await projectUsFinancialPilotOverview(book), original = overview.journals.items.find(row => row.description === 'Synthetic capital')!, reversal = overview.journals.items.find(row => row.reversesJournalRevision !== null)!;
    expect(original.reversedByJournalRevision).toBe(reversal.journalRevision); expect(reversal.reversesJournalRevision).toBe(original.journalRevision); expect(reversal.source).toEqual({ kind: 'manual_reversal', entityId: null, reference: null, journalRevision: original.journalRevision });
    expect(canonicalErpJson(book)).toBe(before);
  }, 20_000);
  it('keeps historical accounting reports independent from explicitly current AR', async () => {
    const t = await fixture(); await t.erp({ type: 'close_period', periodId: '2026' }); await t.erp({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' }); t.next();
    await t.credit('later-credit', true);
    const result = await projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, from: '2026-01-01', to: '2026-12-31', asOf: '2026-12-31', accountId: 'receivables' });
    expect(result.generalLedger?.closingMinor).toBe('32475'); expect(result.profitAndLoss.incomeMinor).toBe('30000');
    expect(result.currentReceivables.scope).toBe('current'); expect(result.currentReceivables.summary.outstandingMinor).toBe('21650');
  });
  it('keeps aggregates above Number safe integer and beyond the per-line 36-digit bound exact', async () => {
    const t = await fixture(), maximum = '9'.repeat(36); await t.manual('large-capital-A', maximum); await t.manual('large-capital-B', maximum);
    const result = await projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, ...range, accountId: 'cash' });
    const expected = (BigInt(maximum) * BigInt(2)).toString(); expect(result.generalLedger?.closingMinor).toBe(expected); expect(result.cashFlow).toMatchObject({ closingMinor: expected }); expect(result.trialBalance.balanced).toBe(true);
  });
  it('bounds general-ledger rows and preserves page running balances across an interval-bound cursor', async () => {
    const t = await fixture(); for (let i = 0; i < 26; i++) await t.manual(`public-journal-${i}`, '1');
    const first = await projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, ...range, accountId: 'cash' }), cursor = first.generalLedger!.movements.nextCursor;
    expect(first.generalLedger!.movements.items).toHaveLength(25); expect(first.generalLedger!.pageClosingMinor).toBe('25'); expect(first.generalLedger!.closingMinor).toBe('26');
    const second = await projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, ...range, accountId: 'cash', cursor });
    expect(second.generalLedger!.movements.items).toHaveLength(1); expect(second.generalLedger!.pageOpeningMinor).toBe('25'); expect(second.generalLedger!.pageClosingMinor).toBe('26');
    await expect(projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, ...range, from: '2026-02-01', accountId: 'cash', cursor })).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotReports(t.book(), { revision: t.book().revision, ...range, accountId: 'equity', cursor })).rejects.toMatchObject({ status: 422 });
  }, 20_000);
  it('rejects malformed dates, missing revision, scope switches and corrupted report arithmetic', async () => {
    const t = await fixture(), request = { revision: t.book().revision, ...range, accountId: 'cash' };
    for (const patch of [{ from: '2026-02-30' }, { from: '2028-01-01' }, { revision: undefined }, { policy: {} }, { accountId: null, cursor: financialPilotCursor('general_ledger', request.revision, 25, 'cash') }]) await expect(projectUsFinancialPilotReports(t.book(), { ...request, ...patch } as never)).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotReports(t.book(), { ...request, revision: request.revision + 1 })).rejects.toMatchObject({ status: 409 });
    await expect(projectUsFinancialPilotReports(t.book(), { ...request, accountId: 'missing' })).rejects.toMatchObject({ status: 404 });
    const result = await projectUsFinancialPilotReports(t.book(), request);
    expect(() => validateUsFinancialPilotReports({ ...result, profitAndLoss: { ...result.profitAndLoss, profitMinor: '1' } })).toThrow();
    expect(() => validateUsFinancialPilotReports({ ...result, currentReceivables: { ...result.currentReceivables, scope: 'as_of' } })).toThrow();
    expect(() => validateUsFinancialPilotReports({ ...result, generalLedger: { ...result.generalLedger!, entryId: 'entry:PRIVATE-KEY' } })).toThrow();
    expect(() => validateUsFinancialPilotReports({ ...result, balanceSheet: { ...result.balanceSheet, unclosedEarningsMinor: '0' } })).toThrow();
  });
  it('captures the report query and book before replay and refuses private ledger corruption', async () => {
    const t = await fixture(), book = structuredClone(t.book()), request = { revision: book.revision, ...range, accountId: 'cash' };
    const pending = projectUsFinancialPilotReports(book, request); request.accountId = 'missing'; (book as { revision: number }).revision++;
    expect((await pending).generalLedger?.account.accountId).toBe('cash');
    const corrupt: UsFinancialBookV5 = structuredClone(t.book()); (corrupt.baseline.ledger.entries[0].lines[0] as { debitMinor: string }).debitMinor = '1';
    await expect(projectUsFinancialPilotReports(corrupt, { revision: t.book().revision, ...range })).rejects.toMatchObject({ status: 503 });
  });
});
