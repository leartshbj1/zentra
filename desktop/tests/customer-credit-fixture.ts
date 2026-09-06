// Synthetic data only. Native issue rejection/rollback is tested in Rust.
import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';

export function installCustomerCreditFixture(workspace: Workspace) {
  const original = workspace.invoices[0];
  original.title = 'Facture au taux historique';
  original.type = 'standard'; original.currency = 'CHF'; original.status = 'issued';
  original.issueDate = '2026-02-15'; original.dueDate = '2026-03-15';
  original.lines = [{ ...original.lines[0], quantity: 1, unitPriceCents: 10_000, vatRateBp: 250 }];
  workspace.invoices.push({
    ...structuredClone(original), id: 'customer-credit-qa', number: '', type: 'credit_note',
    status: 'draft', originalInvoiceId: original.id, title: 'Avoir à vérifier',
    issueDate: '2026-02-01', serviceDateFrom: '2026-02-01', serviceDateTo: '2026-02-01',
    lines: [{ ...original.lines[0], id: 'customer-credit-line', vatRateBp: 810 }],
  });
  const save = desktopApi.saveDocument;
  desktopApi.saveDocument = async (...args) => {
    sessionStorage.setItem('customer-credit-save', JSON.stringify(args));
    return save(...args);
  };
}
