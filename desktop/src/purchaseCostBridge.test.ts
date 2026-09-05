import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';

async function load(extra: Record<string, unknown>) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') return {
      expenses: [{ id: 'expense', net_cents: 10000, vat_cents: 810, ...extra }],
      supplier_invoices: [{ id: 'invoice', status: 'validated' }],
      supplier_invoice_items: [{ id: 'item', supplier_invoice_id: 'invoice', line_net_cents: 10000, line_vat_cents: 810, ...extra }],
      supplier_credit_notes: [{ id: 'credit', status: 'validated' }],
      supplier_credit_note_items: [{ id: 'credit-item', supplier_credit_note_id: 'credit', line_net_cents: 10000, line_vat_cents: 810, ...extra }],
    };
    throw new Error(`Unexpected ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace();
  return [workspace.expenses[0], workspace.supplierInvoices[0].lines[0], workspace.supplierCreditNotes[0].items[0]];
}

describe('coûts de projet transmis par le moteur comptable', () => {
  it('conserve les coûts et les signes des achats et avoirs', async () => {
    for (const row of await load({ cost_cents: 10810, cost_review_required: false, cost_basis: 'accounted' })) {
      expect(row).toMatchObject({ costCents: 10810, costReviewRequired: false, costBasis: 'accounted', netCents: 10000, vatCents: 810 });
    }
  });
  it('ne présente pas une ancienne réponse sans preuve TVA comme vérifiée', async () => {
    for (const row of await load({})) expect(row).toMatchObject({ costCents: undefined, costReviewRequired: true });
  });
  it.each(['invalide', '', -1, Number.MAX_SAFE_INTEGER + 1, 10.5])('écarte un coût invalide : %s', async (cost_cents) => {
    for (const row of await load({ cost_cents, cost_review_required: false, cost_basis: 'accounted' })) {
      expect(row).toMatchObject({ costCents: undefined, costReviewRequired: true });
    }
  });
  it('préserve un coût nul prouvé et un signal de contrôle même sans TVA', async () => {
    for (const row of await load({ cost_cents: 0, cost_review_required: false, cost_basis: 'accounted' })) expect(row).toMatchObject({ costCents: 0, costReviewRequired: false });
    for (const row of await load({ cost_cents: 10000, cost_basis: 'review', cost_review_required: false })) expect(row.costReviewRequired).toBe(true);
    for (const row of await load({ vat_cents: 0, line_vat_cents: 0, cost_review_required: true })) expect(row.costReviewRequired).toBe(true);
  });
});
