import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { financialRelationsFixture } from '../tests/financial-relations-fixture';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';

function useFixture(raw: ReturnType<typeof financialRelationsFixture>) {
  invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: true } : raw);
}

it('preserves first invoice links, settlement order, signed refunds and attachment isolation', async () => {
  const raw = financialRelationsFixture(8);
  // Deliberately overlap both link roles and repeat IDs. First match must win;
  // a settlement referencing the same document in both roles must occur once.
  raw.quote_invoice_pairs.unshift({ deposit_invoice_id: 'invoice-0', balance_invoice_id: 'invoice-0' });
  raw.customer_credit_balances.push({ credit_note_id: 'invoice-0', remaining_cents: 999999 });
  raw.attachments.push(
    { id: 'unrelated', entity_type: 'project', entity_id: 'supplier-invoice-0' },
    { id: 'older', entity_type: 'supplier_invoice', entity_id: 'supplier-invoice-0', created_at: '2026-08-01' },
    { id: 'same-date', entity_type: 'supplier_invoice', entity_id: 'supplier-invoice-0', created_at: '2026-09-01T10:00:00Z' },
  );
  for (const key of ['customer_credit_settlements', 'supplier_credit_allocations', 'supplier_credit_refunds', 'expense_refunds', 'supplier_expense_reclassification_lines']) raw[key].reverse();
  const before = JSON.stringify(raw);
  useFixture(raw);
  const workspace = await desktopApi.loadWorkspace();
  for (const invoice of workspace.invoices) {
    const pair = raw.quote_invoice_pairs.find((row: any) => row.deposit_invoice_id === invoice.id || row.balance_invoice_id === invoice.id);
    expect(invoice.billingPair).toEqual({ depositInvoiceId: pair.deposit_invoice_id, balanceInvoiceId: pair.balance_invoice_id });
    expect(invoice.customerCredit?.remainingCents).toBe(9310);
    expect(invoice.creditSettlements?.map(row => row.id)).toEqual(raw.customer_credit_settlements.filter((row: any) => row.credit_note_id === invoice.id || row.invoice_id === invoice.id).map((row: any) => row.id));
  }
  for (const credit of workspace.supplierCreditNotes) {
    const refunds = raw.supplier_credit_refunds.filter((row: any) => row.supplier_credit_note_id === credit.id);
    const allocations = raw.supplier_credit_allocations.filter((row: any) => row.supplier_credit_note_id === credit.id);
    expect(credit.refunds.map(row => row.id)).toEqual(refunds.map((row: any) => row.id));
    expect(credit.refundedCents).toBe(refunds.reduce((total: number, row: any) => total + (row.event_type === 'reverse' ? -row.amount_cents : row.amount_cents), 0));
    expect(credit.allocatedCents).toBe(allocations.reduce((total: number, row: any) => total + (row.event_type === 'reverse' ? -row.amount_cents : row.amount_cents), 0));
  }
  for (const expense of workspace.expenses) expect(expense.refunds?.map(row => row.id)).toEqual(raw.expense_refunds.filter((row: any) => row.expense_id === expense.id).map((row: any) => row.id));
  for (const reclassification of workspace.supplierExpenseReclassifications) expect(reclassification.lines.map(row => row.id)).toEqual(raw.supplier_expense_reclassification_lines.filter((row: any) => row.reclassification_id === reclassification.id).map((row: any) => row.id));
  expect(workspace.supplierInvoices[0].attachments.map(row => row.id)).toEqual(['older', 'attachment-0', 'same-date']);
  expect(workspace.supplierInvoices[0]).toMatchObject({ balanceCents: 6810, paymentStatus: 'partial' });
  expect(workspace.stockAvailability.map(row => row.reservedMilli)).toEqual([1000, -500, 1000, -500, 1000, -500, 1000, -500]);
  expect(JSON.stringify(raw)).toBe(before);

  // The same IDs in another company or a subsequent sync must not reuse rows.
  const next = financialRelationsFixture(1);
  next.customer_credit_balances[0].remaining_cents = 4321;
  next.customer_credit_settlements = [];
  next.attachments = [];
  next.expense_refunds = [];
  next.supplier_credit_allocations = [];
  next.supplier_credit_refunds = [];
  next.stock_reservation_events = [];
  useFixture(next);
  const reloaded = await desktopApi.loadWorkspace();
  expect(reloaded.invoices[0].customerCredit?.remainingCents).toBe(4321);
  expect(reloaded.invoices[0].creditSettlements).toEqual([]);
  expect(reloaded.supplierInvoices[0].attachments).toEqual([]);
  expect(reloaded.supplierCreditNotes[0]).toMatchObject({ refundedCents: 0, allocatedCents: 0 });
  expect(reloaded.expenses[0].refunds).toEqual([]);
  expect(reloaded.stockAvailability[0].reservedMilli).toBe(0);
  expect(workspace.invoices[0].customerCredit?.remainingCents).toBe(9310);
});

it.skipIf(!process.env.ZENTRA_PROFILE_FINANCIAL_RELATIONS)('profiles synthetic financial history through the production bridge', async () => {
  const evidence = [];
  for (const count of [1000, 3000, 6000]) {
    const raw = financialRelationsFixture(count);
    useFixture(raw);
    await desktopApi.loadWorkspace();
    const elapsedMs = [];
    let sha256 = '';
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const workspace = await desktopApi.loadWorkspace();
      elapsedMs.push(performance.now() - start);
      const digest = createHash('sha256').update(JSON.stringify(workspace)).digest('hex');
      if (sha256) expect(digest).toBe(sha256);
      sha256 = digest;
    }
    evidence.push({ count, elapsedMs, medianMs: [...elapsedMs].sort((a, b) => a - b)[1], sha256 });
  }
  console.log('FINANCIAL_RELATIONS_PROFILE', JSON.stringify({ synthetic: true, scope: 'JavaScript workspace normalization only; mocked native reads', evidence }));
}, 120000);
