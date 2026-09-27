import { describe, expect, it } from 'vitest';
import { mailInvoiceStage, purchaseInboxCount } from './purchaseInboxPresentation';
import type { MailInvoice, SupplierInboxState } from './supplierInbox';
import type { SupplierInvoice } from './types';
const item = (id: string, state: string, invoiceId: string | null = null) => ({id, state, invoiceId, automatic: true}) as MailInvoice;
const inbox = (...items: MailInvoice[]) => ({items}) as SupplierInboxState;
const invoice = (documentStatus: string, paymentStatus = 'unpaid') => ({id: 'invoice-1', documentStatus, paymentStatus}) as SupplierInvoice;
describe('A single, truthful purchase queue', () => {
  it('includes received documents even when no local purchase has been created', () => {
    expect(purchaseInboxCount([], 0, 0, inbox(item('a','ready'),item('b','needs_review')))).toBe(2);
  });
  it('does not double count an import awaiting acknowledgement and its existing draft', () => {
    expect(purchaseInboxCount(['invoice-1'], 2, 1, inbox(item('a','processing','invoice-1'),item('b','ready')))).toBe(5);
  });
  it('excludes ignored/imported mail while retaining local work and other-device processing', () => {
    expect(purchaseInboxCount(['invoice-1'], 0, 0, inbox(item('a','ignored'), item('b','imported','invoice-1'), {...item('c','processing'),otherDevice:true}))).toBe(2);
    expect(purchaseInboxCount(['invoice-1'], 2, 1, null)).toBe(4);
  });
  it('never claims that an automatic import was posted without a validated local document', () => {
    const received = item('mail-1','imported','invoice-1');
    expect(mailInvoiceStage(received,[])).toBe('Enregistrée dans Gestion');
    expect(mailInvoiceStage(received,[invoice('draft')])).toBe('Brouillon à valider');
    expect(mailInvoiceStage(received,[invoice('validated')])).toBe('Comptabilisée · à payer');
    expect(mailInvoiceStage(received,[invoice('validated','paid')])).toBe('Payée');
  });
  it('keeps an in-progress import distinct from an item requiring review', () => {
    expect(mailInvoiceStage(item('a','processing'),[])).toBe('Import en cours');
    expect(mailInvoiceStage({...item('a','ready'),otherDevice:true},[])).toBe('Import en cours');
    expect(mailInvoiceStage(item('a','needs_review'),[])).toBe('À vérifier');
  });
});
