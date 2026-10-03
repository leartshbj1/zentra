import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { bankMovementFromRaw } from './bank';
import { BankRefundPicker } from './BankRefunds';
import { BankCreditRefundCreate } from './BankCreditRefundCreate';
import type { Workspace } from './types';

afterEach(() => invokeMock.mockReset());
const reason = 'Un remboursement conservé a déjà été relié à ce crédit. Rapprochez le remboursement existant ; la dissociation ne l’a pas annulé.';
function movement(suggestion: Record<string, unknown>) {
  return bankMovementFromRaw({ id: 'synthetic-movement', credit_debit: 'CRDT', amount_cents: 2702, currency: 'CHF', booking_date: '2026-08-31', refund_suggestion: suggestion });
}
function picker(suggestion: Record<string, unknown>) {
  return renderToStaticMarkup(<BankRefundPicker movement={movement(suggestion)} disabled={false} onCreate={vi.fn()} onCreateCredit={vi.fn()} onCreateCustomer={vi.fn()} onConfirm={vi.fn()} />);
}

describe('supplier-specific bank refund history admission', () => {
  it('maps the supplier refusal without altering generic admission or candidates', () => {
    const mapped = movement({ can_create: true, can_create_supplier_credit: false, supplier_credit_creation_reason: reason, candidates: [{ refund_id: 'existing-refund', supplier_credit_note_id: 'existing-credit', amount_cents: 2702, confirmable: true }] });
    expect(mapped.refundSuggestion?.canCreate).toBe(true);
    expect(mapped.refundSuggestion?.canCreateSupplierCredit).toBe(false);
    expect(mapped.refundSuggestion?.supplierCreditCreationReason).toBe(reason);
    expect(mapped.refundSuggestion?.candidates[0]).toMatchObject({ refundId: 'existing-refund', supplierCreditNoteId: 'existing-credit', confirmable: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('removes only the supplier creation action and keeps existing refund choices', () => {
    const html = picker({ can_create: true, can_create_supplier_credit: false, supplier_credit_creation_reason: reason, candidates: [{ refund_id: 'existing-refund', supplier_credit_note_id: 'existing-credit', reference: 'Refund already accounted', total_cents: 2702, payment_date: '2026-08-31', confirmable: true }] });
    expect(html).not.toContain('Rembourser un avoir fournisseur');
    expect(html).toContain('Créer le remboursement reçu');
    expect(html).toContain('Enregistrer un remboursement client');
    expect(html).toContain('Refund already accounted');
    expect(html).toContain('Associer le remboursement');
    expect(html).toContain(reason);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('preserves legacy generic admission when supplier fields are absent', () => {
    const mapped = movement({ can_create: true, candidates: [] });
    expect(mapped.refundSuggestion?.canCreateSupplierCredit).toBeUndefined();
    expect(mapped.refundSuggestion?.supplierCreditCreationReason).toBeUndefined();
    const html = picker({ can_create: true, candidates: [] });
    expect(html).toContain('Rembourser un avoir fournisseur');
    expect(html).toContain('Créer le remboursement reçu');
    expect(html).toContain('Enregistrer un remboursement client');
  });

  it('never widens a generic refusal even if the supplier-specific field is true', () => {
    const html = picker({ can_create: false, can_create_supplier_credit: true, candidates: [] });
    expect(html).not.toContain('Rembourser un avoir fournisseur');
    expect(html).not.toContain('Créer le remboursement reçu');
    expect(html).not.toContain('Enregistrer un remboursement client');
  });

  it('keeps normal supplier creation visible without a history warning', () => {
    const html = picker({ can_create: true, can_create_supplier_credit: true, candidates: [] });
    expect(html).toContain('Rembourser un avoir fournisseur');
    expect(html).not.toContain(reason);
  });

  it('shows the server refusal in an already-open supplier form without performing a write', () => {
    const workspace = { supplierCreditNotes: [] } as unknown as Workspace;
    const html = renderToStaticMarkup(<BankCreditRefundCreate movement={movement({ can_create: true, can_create_supplier_credit: false, supplier_credit_creation_reason: reason, candidates: [] })} workspace={workspace} busy={false} readOnly={false} close={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain(reason);
    expect(html).toContain('role="status"');
    expect(html).toMatch(/disabled=""[^>]*>Créer et rapprocher le remboursement/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
