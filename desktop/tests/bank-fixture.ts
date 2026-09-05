// Synthetic bank RPCs for browser acceptance; no real bank or local account is used.
import { desktopApi } from '../src/bridge';
import { bankReconciliationResultFromRaw, bankSupplierReconciliationResultFromRaw, bankWorkspaceFromRaw } from '../src/bank';
import type { Workspace } from '../src/types';

export function installBankFixture(getWorkspace: () => Workspace) {
  const workspace = getWorkspace();
  workspace.accountingSettings = Object.fromEntries(['arAccountId','revenueAccountId','vatPayableAccountId','vatDeferredPayableAccountId','bankAccountId','expenseAccountId','vatReceivableAccountId','wagesExpenseAccountId','wagesPayableAccountId','socialExpenseAccountId','socialPayableAccountId','supplierPayableAccountId'].map((key) => [key,key])) as Workspace['accountingSettings'];
  workspace.accountingSettings!.enabled = true;
  workspace.invoices = ['full','partial','manual-a','manual-b'].map((id,index) => ({ ...structuredClone(workspace.invoices[0]), id, number: `F-2026-${index+1}`, title: `Facture ${id}`, status: 'issued', currency: 'CHF', lines: [{ id: `${id}-line`, description: 'Conseil', quantity: 1, unit: 'forfait', unitPriceCents: 10000, discountBp: 0, vatRateBp: 810 }], dueDate: '2026-09-30' }));
  workspace.supplierInvoices = [{ id: 'supplier-invoice', supplierId: 'supplier-qa', supplierName: 'Fournitures du Léman', reference: 'ACH-2026-45', currency: 'CHF', documentDate: '2026-08-10', dueDate: '2026-09-30', documentStatus: 'validated', paymentStatus: 'unpaid', netCents: 5000, vatCents: 405, totalCents: 5405, paidCents: 0, creditedCents: 0, balanceCents: 5405, lines: [], payments: [], attachments: [] }] as unknown as Workspace['supplierInvoices'];
  const account = 'CH9300762011623852957';
  const candidate = (id: string) => ({ invoice_id: id, invoice_number: workspace.invoices.find((row) => row.id===id)!.number, remaining_cents: 10810, amount_relation: 'partial', confirmable: true, reason: 'Montant compatible, facture à vérifier.' });
  const movement = (id: string, date: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, import_id: 'bank-import', account_id: account, account_currency: 'CHF', amount_cents: amount, currency: 'CHF', credit_debit: 'CRDT', status: 'BOOK', reversal: false, booking_date: date, value_date: date, created_at: `${date}T10:00:00Z`, reference_type: 'NON', counterparty_name: `Mouvement ${id}`, suggestion: { kind: 'none', confirmable: false, candidates: [], reason: 'Aucune facture correspondante.' }, ...extra });
  const rows: Array<Record<string, any>> = [
    movement('full','2026-09-04',10810,{ reference_type: 'SCOR', reference: 'RF18539007547034', counterparty_name: 'Client intégral', suggestion: { kind: 'automatic_exact', confirmable: true, invoice_id: 'full', candidates: [candidate('full')] } }),
    movement('partial','2026-09-03',5000,{ reference_type: 'QRR', reference: '210000000003139471430009017', counterparty_name: 'Client acompte', suggestion: { kind: 'automatic_partial', confirmable: true, invoice_id: 'partial', candidates: [candidate('partial')] } }),
    movement('manual-client','2026-09-02',4500,{ counterparty_name: 'Électricité du Léman', unstructured: 'Règlement à identifier', suggestion: { kind: 'manual', confirmable: true, candidates: [candidate('manual-a'),candidate('manual-b')] } }),
    movement('manual-supplier','2026-09-01',5405,{ credit_debit: 'DBIT', reference_type: 'SCOR', reference: 'RF18539007547034', counterparty_name: 'Fournitures du Léman', supplier_suggestion: { entity_type: 'supplier_invoice', kind: 'supplier_match', confirmable: true, requires_confirmation: true, supplier_invoice_id: 'supplier-invoice', candidates: [{ supplier_invoice_id: 'supplier-invoice', supplier_id: 'supplier-qa', supplier_name: 'Fournitures du Léman', reference: 'ACH-2026-45', document_date: '2026-08-10', remaining_cents: 5405, amount_relation: 'exact', confirmable: true, reason: 'Référence et montant compatibles.' }] } }),
    movement('pending','2026-08-30',1000,{ status: 'PDNG', counterparty_name: 'Versement en attente' }),
    movement('overpayment','2026-08-29',20000,{ counterparty_name: 'Montant supérieur au solde', suggestion: { kind: 'review', confirmable: false, candidates: [{ ...candidate('manual-b'), confirmable: false, amount_relation: 'overpayment', reason: 'Le montant dépasse le solde.' }] } }),
    movement('reversal','2026-08-28',1000,{ reversal: true, counterparty_name: 'Extourne à contrôler' }),
    ...Array.from({length: 26}, (_,index) => movement(`older-${index}`,`2026-07-${String(index+1).padStart(2,'0')}`,100+index)),
  ];
  const imported = { id: 'bank-import', source_name: 'releve-recette.xml', file_sha256: 'a'.repeat(64), file_size: 12345, message_type: 'camt.053', namespace_version: '001.08', account_id: account, account_currency: 'CHF', entry_count: rows.length, imported_count: rows.length, ignored_count: 0, created_at: '2026-09-05T08:00:00Z' };
  let hasImport = false;
  const loadWorkspace = desktopApi.loadWorkspace;
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-bank-workspace-refresh-fail')==='1') throw new Error('Lecture des factures temporairement indisponible.');
    return loadWorkspace();
  };
  function bankSnapshot() {
    const active = hasImport ? rows : [];
    const open = active.filter((row) => row.status==='BOOK' && !row.reversal && !row.reconciliation && !row.supplier_reconciliation);
    return bankWorkspaceFromRaw({ summary: { import_count: hasImport ? 1 : 0, movement_count: active.length, unreconciled_count: open.filter((row) => row.credit_debit==='CRDT').length, unreconciled_supplier_count: open.filter((row) => row.credit_debit==='DBIT').length, pending_count: active.filter((row) => row.status==='PDNG').length, booked_credit_count: active.filter((row) => row.status==='BOOK' && row.credit_debit==='CRDT').length, booked_debit_count: active.filter((row) => row.status==='BOOK' && row.credit_debit==='DBIT').length }, accounts: hasImport ? [{ account_id: account, currency: 'CHF', linked: true, link_source: 'settings_iban', movement_count: active.length }] : [], movements: active, imports: hasImport ? [imported] : [], reconciliations: active.flatMap((row) => row.reconciliation ? [row.reconciliation] : []), supplier_reconciliations: active.flatMap((row) => row.supplier_reconciliation ? [row.supplier_reconciliation] : []) });
  }
  function customerPayment(id: string, invoiceId: string) {
    const row = rows.find((item) => item.id===id)!;
    const current = getWorkspace();
    const invoice = current.invoices.find((item) => item.id===invoiceId)!;
    if (!row.reconciliation) {
      row.reconciliation = { id: `rec-${id}`, movement_id: id, invoice_id: invoiceId, payment_id: `payment-${id}`, amount_cents: row.amount_cents, confirmed_at: '2026-09-05T08:00:00Z', created_at: '2026-09-05T08:00:00Z' };
      current.payments.push({ id: `payment-${id}`, invoiceId, date: row.booking_date, amountCents: row.amount_cents, method: 'bank_transfer', reference: row.reference || '' });
      invoice.status = row.amount_cents===10810 ? 'paid' : 'partially_paid';
    }
    return bankReconciliationResultFromRaw({ movement: row, reconciliation: row.reconciliation, payment: { id: `payment-${id}`, invoice_id: invoiceId, date: row.booking_date, amount_cents: row.amount_cents, method: 'bank_transfer', reference: row.reference || '' }, invoice: { id: invoiceId, number: invoice.number, status: invoice.status==='paid' ? 'payee' : 'partiellement_payee' } });
  }
  desktopApi.getBankWorkspace = async () => {
    if (sessionStorage.getItem('qa-bank-refresh-fail')==='1') throw new Error('Lecture bancaire temporairement indisponible.');
    return bankSnapshot();
  };
  desktopApi.chooseCamtFile = async () => 'releve-recette.xml';
  desktopApi.importCamtFile = async (_path, automatic) => {
    sessionStorage.setItem('qa-bank-import-attempts', String(Number(sessionStorage.getItem('qa-bank-import-attempts') || 0)+1));
    const duplicate = hasImport;
    hasImport = true;
    sessionStorage.setItem('qa-bank-import-automatic', String(automatic));
    if (automatic) { customerPayment('full','full'); customerPayment('partial','partial'); }
    if (sessionStorage.getItem('qa-bank-fail-import-refresh')==='1') { sessionStorage.setItem('qa-bank-workspace-refresh-fail','1'); sessionStorage.setItem('qa-bank-refresh-fail','1'); }
    return { duplicate, import: bankSnapshot().imports[0], importedCount: duplicate ? 0 : rows.length, skippedDuplicateCount: duplicate ? rows.length : 0, ignoredCount: 0, warnings: [], automaticReconciliation: { enabled: automatic, paidCount: duplicate ? 0 : 1, partialCount: duplicate ? 0 : 1, reviewCount: 1, failures: [] } };
  };
  desktopApi.confirmBankReconciliation = async (id,invoiceId) => {
    sessionStorage.setItem('qa-bank-customer-attempts', String(Number(sessionStorage.getItem('qa-bank-customer-attempts') || 0)+1));
    if (sessionStorage.getItem('qa-bank-reject')==='1') throw new Error('Période clôturée, paiement refusé.');
    const result = customerPayment(id,invoiceId);
    if (sessionStorage.getItem('qa-bank-fail-after-save')==='1') sessionStorage.setItem('qa-bank-refresh-fail','1');
    return result;
  };
  desktopApi.confirmSupplierBankReconciliation = async (id,invoiceId) => {
    const row = rows.find((item) => item.id===id)!;
    const invoice = getWorkspace().supplierInvoices.find((item) => item.id===invoiceId)!;
    invoice.paidCents = row.amount_cents; invoice.balanceCents = 0;
    row.supplier_reconciliation = { id: `rec-${id}`, movement_id: id, supplier_invoice_id: invoiceId, supplier_payment_id: `payment-${id}`, amount_cents: row.amount_cents, confirmed_at: '2026-09-05T08:00:00Z', created_at: '2026-09-05T08:00:00Z' };
    sessionStorage.setItem('qa-bank-supplier-attempts', String(Number(sessionStorage.getItem('qa-bank-supplier-attempts') || 0)+1));
    return bankSupplierReconciliationResultFromRaw({ movement: row, supplier_reconciliation: row.supplier_reconciliation, payment: { id: `payment-${id}`, supplier_invoice_id: invoiceId, amount_cents: row.amount_cents, date: row.booking_date }, supplier_invoice: { id: invoiceId, supplier_id: invoice.supplierId, reference: invoice.reference, status: 'validated', total_cents: 5405, paid_cents: 5405 } });
  };
}
