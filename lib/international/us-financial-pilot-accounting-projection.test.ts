import { beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { buildTaxRequest } from './invoicing';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpState, ErpStore } from './runtime-types';
import { validateStoredErp } from './runtime-validation';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialErpFactsV5 } from './us-financial-kernel-types';
import { financialPilotCursor } from './us-financial-pilot-contract';
import { projectUsFinancialPilotList } from './us-financial-pilot-projection';
import { financialPilotJournalLinesCursor, financialPilotJournalLinesCursorOffset, projectUsFinancialPilotAccountingContext, projectUsFinancialPilotJournal, projectUsFinancialPilotPeriod,
  validateUsFinancialPilotAccountingContext, validateUsFinancialPilotAccountingContextQuery, validateUsFinancialPilotJournalDetail, validateUsFinancialPilotJournalDetailQuery,
  validateUsFinancialPilotJournalLinesPage, validateUsFinancialPilotPeriodDetail, validateUsFinancialPilotPeriodDetailQuery } from './us-financial-pilot-accounting-projection';

const manual = (id: string, amount = '100') => ({ type: 'post_manual_journal', id, transactionDate: '2025-12-31', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic journal — Genève 🌍', sourceReference: 'Public manual source', lines: [{ accountId: 'inventory', debitMinor: amount, creditMinor: '0', description: 'Historical debit 🌍' }, { accountId: 'equity', debitMinor: '0', creditMinor: amount }] }) as const;

async function setup(periodCount = 1, seedJournals = 0) {
  const t = await financialKernelFixture({ tax: '0' });
  // A bounded valid initial-period catalogue is a synthetic baseline, not100 V5 events.
  let state: ErpState = validateStoredErp({ ...t.baseline, ledger: { ...t.baseline.ledger, periods: Array.from({ length: periodCount }, (_, index) => ({ id: String(2026 + index), start: `${2026 + index}-01-01`, end: `${2026 + index}-12-31`, status: 'open' })) } }, t.actor.organizationId);
  const store: ErpStore = { supportedSchemaVersion: 4, read: async () => state, receipt: async () => null, commit: async commit => {
    const next = applyErpDelta(state, { schemaVersion: 4, organizationId: t.actor.organizationId, fromRevision: commit.expectedRevision, toRevision: commit.header.revision, headRevision: commit.header.revision, hasMore: false, resetRequired: false,
      events: [{ schemaVersion: 4, organizationId: t.actor.organizationId, revision: commit.header.revision, header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt, actorId: t.actor.userId, occurredAt: t.actor.timestamp }] }, t.actor.organizationId, 4);
    if (!next) throw Error('Synthetic ERP seed failed'); state = next; return commit.receipt;
  } };
  for (let index = 0; index < seedJournals; index++) await executeErp({ ...t, store, revalidate: async () => t.actor, taxProvider: async () => null, seller: async () => null }, { idempotencyKey: `DO-NOT-EXPOSE-SEED-${index}`, expectedRevision: state.revision, command: manual(`seed-${index}`) });
  let book = await promoteUsFinancialBookV5(state, t.policy, t.actor), sequence = 0;
  const send = async (command: UsFinancialErpCommandV5, facts: UsFinancialErpFactsV5 = { kind: 'none' }) => {
    const result = await applyUsFinancialOperationV5(book, { type: 'erp_command', idempotencyKey: `DO-NOT-EXPOSE-ERP-${++sequence}`, command, facts }, t.actor, usFinancialErpEntityIdV5(command, t.actor.organizationId)); book = result.book; return result;
  };
  const credit = async () => {
    const input = { type: 'customer_credit' as const, idempotencyKey: `DO-NOT-EXPOSE-CREDIT-${++sequence}`, invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] };
    const c = await buildUsFinancialCreditCandidateV5(book, input);
    book = (await applyUsFinancialOperationV5(book, { ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'historical_zero_tax', invoiceFingerprint: c.invoiceFingerprint, allocationSha256: c.allocationSha256, verifiedBy: 'synthetic-reviewer', verifiedAt: t.actor.timestamp, reference: 'DO-NOT-EXPOSE-PROOF' } }, t.actor, 'public-credit')).book;
  };
  const issue = async () => {
    await send({ type: 'save_estimate', id: 'estimate-2', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, notes: 'Synthetic V5 issue', lines: t.baseline.estimates[0].lines });
    await send({ type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 });
    const view = await projectUsFinancialBookV5(book), estimate = view.estimates.find(row => row.id === 'estimate-2');
    if (!estimate) throw Error('Synthetic estimate missing');
    const tax = buildTaxRequest(view.configuration, estimate, '2026-10-10'), invoice = t.baseline.invoices[0];
    await send({ type: 'issue_invoice', id: 'invoice-2', estimateId: estimate.id, expectedEstimateRevision: estimate.revision, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' }, { kind: 'invoice_issuance', sellerSnapshot: invoice.sellerSnapshot,
      taxAssessment: { ...invoice.taxAssessment, documentId: estimate.id, documentRevision: estimate.revision, fingerprint: tax.fingerprint, lines: estimate.lines.map(row => ({ id: row.id, taxMinor: '0', jurisdiction: 'synthetic', evidenceReference: 'DO-NOT-EXPOSE-TAX-PROOF' })) } });
  };
  const payment = async () => { book = (await applyUsFinancialOperationV5(book, { type: 'customer_payment', idempotencyKey: 'DO-NOT-EXPOSE-PAYMENT', invoiceId: 'invoice-1', amountMinor: '1', paymentDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic recorded receipt' }, t.actor, 'public-payment')).book; };
  return { ...t, send, credit, issue, payment, book: () => book };
}

describe('accounting projections from the cumulative true V5 ledger', () => {
  let book: UsFinancialBookV5, journalRevision: number, reversedRevision: number;
  beforeAll(async () => {
    const t = await setup(30, 26); await t.credit();
    const wide = { ...manual('wide-original'), lines: Array.from({ length: 13 }, () => manual('unused', '9'.repeat(36)).lines).flat() };
    const posted = await t.send(wide); journalRevision = posted.view.ledger.entries.at(-1)!.revision;
    await t.issue(); await t.payment();
    await t.send({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor-1', name: 'Synthetic supplier' } });
    await t.send({ type: 'record_vendor_bill', id: 'bill-1', vendorId: 'vendor-1', reference: 'Public supplier reference', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '100', purchaseTaxMinor: '7', expenseAccountId: 'purchases', sourceReference: 'Public supplier source' });
    await t.send({ type: 'record_vendor_payment', id: 'vendor-payment-1', billId: 'bill-1', amountMinor: '1', paymentDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', reference: 'Public supplier payment' });
    const reversible = await t.send({ ...manual('cash-original'), cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '100', creditMinor: '0', description: 'Exact original 🌍' }, { accountId: 'equity', debitMinor: '0', creditMinor: '100' }] });
    reversedRevision = reversible.view.ledger.entries.at(-1)!.revision;
    await t.send({ type: 'reverse_manual_journal', id: 'cash-reversal', entryId: 'cash-original', transactionDate: '2024-01-01', accountingDate: '2026-10-10', periodId: '2026', reason: 'Public correction reason' });
    book = t.book();
  }, 60_000);
  it('selects the oldest open period beyond page1 and seven current eligible accounts with cash flags', async () => {
    const context = await projectUsFinancialPilotAccountingContext(book, { revision: book.revision }), first = await projectUsFinancialPilotList(book, { revision: book.revision, kind: 'periods' });
    expect(context.periodCount).toBe(30); expect(context.latestPeriodEnd).toBe('2055-12-31'); expect(context.earliestOpenPeriod?.id).toBe('2026'); expect(first.items).toHaveLength(25); expect(first.items).not.toContainEqual(context.earliestOpenPeriod);
    expect(context.accounts.map(row => row.accountId)).toEqual(['cash', 'inventory', 'fixed-assets', 'equity', 'sales', 'purchases', 'bank-fees']);
    expect(context.accounts.find(row => row.accountId === 'cash')?.cash).toBe(true); expect(context.accounts.filter(row => row.cash)).toHaveLength(1); expect(Object.isFrozen(context.accounts[0])).toBe(true);
    expect(validateUsFinancialPilotAccountingContext(context, context.organizationId, book.revision)).toEqual(context);
    const target = await projectUsFinancialPilotPeriod(book, { revision: book.revision, periodId: '2026' }), later = await projectUsFinancialPilotPeriod(book, { revision: book.revision, periodId: '2027' });
    expect(target.canClose).toBe(true); expect(later.canClose).toBe(false); expect(target.earliestOpenPeriod).toEqual(context.earliestOpenPeriod);
  });
  it('reads a source journal beyond page1 and pages26 lines with whole-journal totals above36digits', async () => {
    const firstList = await projectUsFinancialPilotList(book, { revision: book.revision, kind: 'journals' }); expect(firstList.items).toHaveLength(25); expect(firstList.items.some(row => 'journalRevision' in row && row.journalRevision === 1)).toBe(false);
    const first = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision }), second = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision, lineCursor: first.lines.nextCursor });
    expect(first.lineCount).toBe(26); expect(first.lines.items).toHaveLength(25); expect(second.lines.items).toHaveLength(1); expect(second.lines.items[0].ordinal).toBe(26); expect(second.lines.nextCursor).toBeNull();
    expect([...first.lines.items, ...second.lines.items].map(row => row.ordinal)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    const total = (BigInt('9'.repeat(36)) * BigInt(13)).toString(); expect(first.journal.debitMinor).toBe(total); expect(first.journal.creditMinor).toBe(total); expect(total.length).toBeGreaterThan(36); expect(second.journal).toEqual(first.journal);
    expect(first.lines.scope).toBe(`journal:${journalRevision}`); expect(first.canReverse).toBe(true); expect(first.ledgerRevision).toBeLessThan(first.revision); expect(JSON.parse(first.lines.nextCursor!)[1]).toBe(book.revision);
    expect(validateUsFinancialPilotJournalDetail(second, second.organizationId, book.revision, journalRevision, first.lines.nextCursor)).toEqual(second);
    const original = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: 1 }); expect(original.journal.source.kind).toBe('customer_invoice'); expect(original.canReverse).toBe(false);
  });
  it('exposes every real source kind and immutable reversal links without internal entry IDs, keys, hashes or proofs', async () => {
    const view = await projectUsFinancialBookV5(book), before = canonicalErpJson(book), kinds = new Set<string>();
    for (const entry of view.ledger.entries.filter(row => row.source.type !== 'manual_journal' || row.revision === reversedRevision)) {
      const detail = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: entry.revision }); kinds.add(detail.journal.source.kind);
      expect(detail.journal.journalRevision).toBe(entry.revision); expect(detail.lines.items.every(row => row.account.code.length > 0)).toBe(true);
      const text = JSON.stringify(detail); for (const forbidden of ['DO-NOT-EXPOSE', 'idempotencyKey', 'fingerprint', 'entryId', 'wide-original', 'cash-original', 'cash-reversal', 'taxAssessment', 'policyVersion', 'baselineSha256', 'grant', 'effects', 'commit']) expect(text).not.toContain(forbidden);
    }
    expect(kinds).toEqual(new Set(['customer_invoice', 'customer_credit', 'customer_payment', 'vendor_bill', 'vendor_payment', 'manual_journal', 'manual_reversal']));
    const original = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: reversedRevision }), reversal = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: original.journal.reversedByJournalRevision! });
    expect(original.canReverse).toBe(false); expect(reversal.canReverse).toBe(false); expect(reversal.journal.reversesJournalRevision).toBe(reversedRevision); expect(reversal.journal.source.journalRevision).toBe(reversedRevision); expect(reversal.cashFlowCategory).toBe('financing');
    expect(reversal.lines.items[0]).toMatchObject({ debitMinor: '0', creditMinor: '100', description: 'Exact original 🌍' }); expect(original.lines.items[1].description).toBeNull(); expect(canonicalErpJson(book)).toBe(before);
    expect(validateUsFinancialPilotJournalDetail({ ...original, journal: { ...original.journal, source: { kind: 'other', entityId: null, reference: null, journalRevision: null }, reversedByJournalRevision: null }, canReverse: false }).journal.source.kind).toBe('other');
  }, 30_000);
  it('rejects line cursor retargeting across journal/type/global revision and noncanonical/out-of-range pages', async () => {
    const first = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision });
    for (const cursor of [financialPilotCursor('journals', book.revision, 25, null), financialPilotJournalLinesCursor(book.revision, 25, journalRevision + 1), financialPilotJournalLinesCursor(book.revision - 1, 25, journalRevision), financialPilotJournalLinesCursor(first.ledgerRevision, 25, journalRevision), JSON.stringify(['journal_lines', book.revision, 24, `journal:${journalRevision}`]), first.lines.nextCursor + ' ', financialPilotJournalLinesCursor(book.revision, 50, journalRevision)]) {
      await expect(projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision, lineCursor: cursor })).rejects.toMatchObject({ status: 422 });
    }
    expect(() => validateUsFinancialPilotJournalDetail(first, first.organizationId, book.revision, journalRevision + 1)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotJournalLinesPage(first.lines, first.organizationId, book.revision, journalRevision, financialPilotJournalLinesCursor(book.revision, 25, journalRevision))).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('rejects incomplete/duplicate/out-of-order pages and contradictory total/next/head metadata', async () => {
    const first = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision }), last = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision, lineCursor: first.lines.nextCursor });
    for (const patch of [{ kind: 'journals' }, { scope: `journal:0${journalRevision}` }, { total: 1001 }, { total: 25 }, { total: 1 }, { items: first.lines.items.slice(0, 24) }, { items: [first.lines.items[0], ...first.lines.items.slice(0, 24)] }, { items: [...first.lines.items].reverse() }, { nextCursor: null }, { nextCursor: financialPilotJournalLinesCursor(book.revision, 50, journalRevision) }, { ledgerRevision: book.revision + 1 }, { private: true }]) expect(() => validateUsFinancialPilotJournalLinesPage({ ...first.lines, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    for (const patch of [{ items: [] }, { total: 27 }, { nextCursor: financialPilotJournalLinesCursor(book.revision, 50, journalRevision) }]) expect(() => validateUsFinancialPilotJournalLinesPage({ ...last.lines, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    for (const patch of [{ lineCount: 25 }, { cashFlowCategory: 'other' }, { canReverse: false }, { journal: { ...first.journal, debitMinor: '1', creditMinor: '1' } }, { lines: { ...first.lines, ledgerRevision: first.ledgerRevision - 1 } }, { hash: 'private' }]) expect(() => validateUsFinancialPilotJournalDetail({ ...first, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    const small = await projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: reversedRevision });
    for (const patch of [{ cashFlowCategory: null }, { canReverse: true }, { journal: { ...small.journal, reversedByJournalRevision: small.journal.journalRevision } }, { lines: { ...small.lines, items: small.lines.items.map(row => ({ ...row, description: '' })) } }, { lines: { ...small.lines, items: small.lines.items.map(row => ({ ...row, account: { ...row.account, cash: false } })) } }]) expect(() => validateUsFinancialPilotJournalDetail({ ...small, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('closes context and period DTOs to corrupt counts, cash flags, private fields and wrong eligibility', async () => {
    const context = await projectUsFinancialPilotAccountingContext(book, { revision: book.revision }), detail = await projectUsFinancialPilotPeriod(book, { revision: book.revision, periodId: '2027' });
    for (const patch of [{ periodCount: 101 }, { periodCount: 0 }, { latestPeriodEnd: '2020-01-01' }, { accounts: context.accounts.slice(1) }, { accounts: [...context.accounts, context.accounts[0]] }, { accounts: context.accounts.map(row => ({ ...row, cash: false })) }, { earliestOpenPeriod: { ...context.earliestOpenPeriod, status: 'closed' } }, { policy: 'private' }]) expect(() => validateUsFinancialPilotAccountingContext({ ...context, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    for (const patch of [{ canClose: true }, { earliestOpenPeriod: null }, { earliestOpenPeriod: { id: '2028', start: '2028-01-01', end: '2028-12-31', status: 'open' } }, { earliestOpenPeriod: { ...detail.earliestOpenPeriod, status: 'closed' } }, { period: { ...detail.period, status: 'closed' }, canClose: true }, { ledgerRevision: book.revision + 1 }, { source: 'private' }]) expect(() => validateUsFinancialPilotPeriodDetail({ ...detail, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotPeriodDetail(detail, detail.organizationId, book.revision, 'other')).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotAccountingContext(context, 'other')).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('captures source and each query synchronously and rejects stale/future head or corrupt books', async () => {
    const raw = structuredClone(book), query = { revision: book.revision, journalRevision }, pending = projectUsFinancialPilotJournal(raw, query); query.journalRevision = 1; (raw as { revision: number }).revision++;
    expect((await pending).journal.journalRevision).toBe(journalRevision);
    const periodRaw = structuredClone(book), periodQuery = { revision: book.revision, periodId: '2027' }, periodPending = projectUsFinancialPilotPeriod(periodRaw, periodQuery); periodQuery.periodId = 'missing'; (periodRaw as { revision: number }).revision++;
    expect((await periodPending).period.id).toBe('2027');
    const contextRaw = structuredClone(book), contextQuery = { revision: book.revision }, contextPending = projectUsFinancialPilotAccountingContext(contextRaw, contextQuery); contextQuery.revision++; (contextRaw as { revision: number }).revision++;
    expect((await contextPending).revision).toBe(book.revision);
    for (const revision of [book.revision - 1, book.revision + 1]) {
      await expect(projectUsFinancialPilotJournal(book, { revision, journalRevision })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
      await expect(projectUsFinancialPilotAccountingContext(book, { revision })).rejects.toMatchObject({ status: 409 });
      await expect(projectUsFinancialPilotPeriod(book, { revision, periodId: '2026' })).rejects.toMatchObject({ status: 409 });
    }
    await expect(projectUsFinancialPilotJournal({ ...book, revision: book.revision + 1 }, { revision: book.revision, journalRevision })).rejects.toMatchObject({ status: 503 });
    await expect(projectUsFinancialPilotJournal(book, { revision: book.revision, journalRevision: book.revision })).rejects.toMatchObject({ status: 404 });
    await expect(projectUsFinancialPilotPeriod(book, { revision: book.revision, periodId: 'missing' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('accounting period and line bounds', () => {
  it('reads100 periods, rejects101, allows opening with prior open periods and refuses closing a newer period', async () => {
    const t = await setup(100), before = canonicalErpJson(t.book()), context = await projectUsFinancialPilotAccountingContext(t.book(), { revision: t.book().revision });
    expect(context.periodCount).toBe(100); expect(context.latestPeriodEnd).toBe('2125-12-31'); expect(context.earliestOpenPeriod?.id).toBe('2026');
    await expect(t.send({ type: 'open_period', id: '2126', start: '2126-01-01', end: '2126-12-31' })).rejects.toMatchObject({ code: 'period_limit_reached', status: 409 });
    await expect(t.send({ type: 'close_period', periodId: '2027' })).rejects.toMatchObject({ code: 'accounting_period_order_conflict', status: 409 }); expect(canonicalErpJson(t.book())).toBe(before);
    await t.send({ type: 'close_period', periodId: '2026' }); const closed = await projectUsFinancialPilotPeriod(t.book(), { revision: t.book().revision, periodId: '2026' }); expect(closed.canClose).toBe(false); expect(closed.earliestOpenPeriod?.id).toBe('2027');
    const smaller = await setup(); await smaller.send({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    const two = await projectUsFinancialPilotAccountingContext(smaller.book(), { revision: smaller.book().revision }); expect(two.periodCount).toBe(2); expect(two.earliestOpenPeriod?.id).toBe('2026');
  }, 30_000);
  it('paginates1000 original lines into40 exact pages without total truncation', async () => {
    const t = await setup(), posted = await t.send({ ...manual('thousand'), lines: Array.from({ length: 500 }, () => manual('unused', '9'.repeat(36)).lines).flat() }), target = posted.view.ledger.entries.at(-1)!.revision;
    const first = await projectUsFinancialPilotJournal(t.book(), { revision: t.book().revision, journalRevision: target }), lastCursor = financialPilotJournalLinesCursor(t.book().revision, 975, target), last = await projectUsFinancialPilotJournal(t.book(), { revision: t.book().revision, journalRevision: target, lineCursor: lastCursor });
    expect(first.lineCount).toBe(1000); expect(first.lines.items).toHaveLength(25); expect(last.lines.items).toHaveLength(25); expect(last.lines.items[0].ordinal).toBe(976); expect(last.lines.items.at(-1)?.ordinal).toBe(1000); expect(last.lines.nextCursor).toBeNull(); expect(last.journal).toEqual(first.journal);
    expect(first.journal.debitMinor).toBe((BigInt('9'.repeat(36)) * BigInt(500)).toString());
    await expect(projectUsFinancialPilotJournal(t.book(), { revision: t.book().revision, journalRevision: target, lineCursor: financialPilotJournalLinesCursor(t.book().revision, 1000, target) })).rejects.toMatchObject({ status: 422 });
  }, 30_000);
  it('rejects unexpected selectors, accessors, symbols and prototype data without evaluating getters', () => {
    const getter = vi.fn(() => 'private');
    const validators = [validateUsFinancialPilotAccountingContextQuery, validateUsFinancialPilotJournalDetailQuery, validateUsFinancialPilotPeriodDetailQuery];
    for (const validate of validators) for (const raw of [Object.defineProperty({}, 'revision', { enumerable: true, get: getter }), Object.assign(Object.create({ revision: 9 }) as object, { journalRevision: 2, periodId: '2026' }), { revision: 9, journalRevision: 2, periodId: '2026', [Symbol('private')]: true }, { revision: 9, organizationId: 'caller', journalRevision: 2, periodId: '2026' }]) expect(() => validate(raw)).toThrow(expect.objectContaining({ status: 422 }));
    expect(getter).not.toHaveBeenCalled(); expect(financialPilotJournalLinesCursorOffset(null, 9, 2)).toBe(0);
    for (const cursor of ['[]', 'x'.repeat(513), JSON.stringify(['journal_lines', 9, 0, 'journal:2']), JSON.stringify(['journal_lines', 9, 1025, 'journal:2'])]) expect(() => financialPilotJournalLinesCursorOffset(cursor, 9, 2)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validateUsFinancialPilotJournalDetailQuery({ revision: 9, journalRevision: 10 })).toThrow(expect.objectContaining({ status: 422 }));
  });
});
