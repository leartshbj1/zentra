// Fictitious data for the safe payment captures (?erp=safety). Excluded from production.
// Native checks are replaced by fixed answers: the real rules run in payment_safety.rs.
import { desktopApi } from '../src/bridge';
import type { EntryReview, PaymentReview, PaymentSafetyOverview } from '../src/paymentSafety';
import type { BankMovement, BankWorkspace, Employee, SupplierInvoice, Workspace } from '../src/types';
import { installErpPaymentsFixture } from './erp-payments-fixture';

const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const now = new Date().toISOString();

function history(paymentCount: number, totalCents: number, lastDays: number, lastCents: number, usualCents: number | null, ibans: string[]): PaymentReview['history'] {
  return { paymentCount, total12MonthsCents: totalCents, lastPaymentDate: paymentCount ? shift(lastDays) : null, lastPaymentCents: paymentCount ? lastCents : null, usualCents, invoiceCount: paymentCount, paidIbans: ibans };
}

const noApproval: PaymentReview['approval'] = { required: false, covered: false, status: null, stale: false, amountCents: null, preparedBy: null, preparedByMe: false, preparedAt: null, approvedBy: null, approvedAt: null, refusal: null };

function debit(id: string, days: number, amountCents: number, counterparty: string): BankMovement {
  const date = shift(-days);
  return {
    id, importId: 'camt-1', accountId: 'CH9300762011623852957', accountCurrency: 'CHF', amountCents, currency: 'CHF', creditDebit: 'DBIT', status: 'BOOK', reversal: false,
    bookingDate: date, valueDate: date, accountServicerRef: '', endToEndId: '', transactionId: '', referenceType: 'NON', referenceLevel: '', reference: '', unstructured: 'Achat carte',
    counterpartyName: counterparty, counterpartyIban: '', strongKey: id, createdAt: now, reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null,
    expenseSuggestion: { reason: '', canCreate: true, candidates: [] },
    suggestion: { entityType: 'invoice', kind: 'none', invoiceId: null, reason: '', confirmable: false, requiresConfirmation: false, candidates: [] } as never,
    supplierSuggestion: { entityType: 'supplier_invoice', kind: 'none' as never, supplierInvoiceId: null, reason: '', confirmable: false, requiresConfirmation: false, candidates: [] },
  };
}

export function installErpSafetyFixture(data: Workspace) {
  installErpPaymentsFixture(data);
  const favre = { ...data.suppliers[0], id: 's-favre', name: 'Menuiserie Favre Sàrl', iban: 'CH56 0483 5012 3456 7800 9', address: 'Route de Riaz 8\n1630 Bulle' };
  data.suppliers.push(favre);
  const big: SupplierInvoice = { ...data.supplierInvoices[0], id: 'i-6', supplierId: favre.id, supplierName: favre.name, reference: 'F-2026-0418', dueDate: shift(3), netCents: 1_240_000, totalCents: 1_240_000, balanceCents: 1_240_000, paymentDetails: null };
  const draft: SupplierInvoice = {
    ...data.supplierInvoices[0], id: 'i-7', supplierId: 's-papeterie', supplierName: 'Papeterie des Alpes', reference: 'F-102', documentStatus: 'draft', paymentStatus: null,
    validatedAt: null, validationJournalEntryId: null, dueDate: shift(28), netCents: 129_900, vatCents: 10_522, totalCents: 140_422, balanceCents: 140_422,
    lines: [{ id: 'l-7', supplierInvoiceId: 'i-7', position: 0, description: 'Ordinateur portable', quantityMilli: 1000, unit: 'pce', unitPriceCents: 129_900, discountBp: 0, vatBp: 810, netCents: 129_900, vatCents: 10_522, totalCents: 140_422, category: 'Informatique', expenseAccountId: 'it', projectId: null }] as never,
  };
  data.supplierInvoices.push(big, draft);
  data.accounts = [...(data.accounts ?? []), { id: 'it', code: '6570', name: 'Matériel informatique', accountType: 'expense', normalBalance: 'debit', reportSection: 'other_operating_expense', active: true }] as Workspace['accounts'];
  const base = data.employees[0] ?? ({} as Employee);
  data.employees = [
    { ...base, id: 'e-luca', name: 'Luca Rossi', role: 'Chef de chantier', email: 'luca.rossi@atelier-leman.example', employmentEnd: '' },
    { ...base, id: 'e-sara', name: 'Sara Meier', role: 'Administration', email: 'sara.meier@atelier-leman.example', employmentEnd: '' },
  ] as Employee[];

  let favreApproval: PaymentReview['approval'] = { ...noApproval, required: true, status: 'prepared', amountCents: 1_240_000, preparedBy: 'Anna Keller', preparedAt: now };
  const reviews = (): PaymentReview[] => [
    { supplierInvoiceId: 'i-2', supplierId: 's-bois', amountCents: 94_975, creditorIban: 'CH44 •••• 9012', approval: noApproval,
      findings: [{ kind: 'iban_changed', previousIban: 'CH93 •••• 2957', currentIban: 'CH44 •••• 9012', changedOn: shift(-4), lastPaidOn: shift(-63) }],
      history: history(6, 512_400, -63, 88_000, 86_500, ['CH93 •••• 2957']) },
    { supplierInvoiceId: 'i-4', supplierId: 's-garage', amountCents: 61_000, creditorIban: null, approval: noApproval, findings: [{ kind: 'new_supplier' }], history: history(0, 0, 0, 0, null, []) },
    { supplierInvoiceId: 'i-3', supplierId: 's-papeterie', amountCents: 20_035, creditorIban: 'CH93 •••• 2957', approval: noApproval,
      findings: [{ kind: 'possible_duplicate', otherInvoiceId: 'i-old', otherReference: 'F-76', otherTotalCents: 20_035, otherDocumentDate: shift(-24), reason: 'same_amount_and_date' }],
      history: history(9, 186_300, -12, 20_035, 19_800, ['CH93 •••• 2957']) },
    { supplierInvoiceId: 'i-1', supplierId: 's-swisscom', amountCents: 8_990, creditorIban: 'CH58 •••• 9012', approval: noApproval, findings: [], history: history(12, 107_880, -30, 8_990, 8_990, ['CH58 •••• 9012']) },
    { supplierInvoiceId: 'i-5', supplierId: 's-papeterie', amountCents: 4_500, creditorIban: 'CH93 •••• 2957', approval: noApproval, findings: [], history: history(9, 186_300, -12, 20_035, 19_800, ['CH93 •••• 2957']) },
    { supplierInvoiceId: 'i-6', supplierId: favre.id, amountCents: 1_240_000, creditorIban: 'CH56 •••• 8009', approval: favreApproval,
      findings: [{ kind: 'unusual_amount', usualCents: 285_000, historyCount: 5, factor: 3 }], history: history(5, 1_425_000, -41, 290_000, 285_000, ['CH56 •••• 8009']) },
  ];
  const overview = (): PaymentSafetyOverview => ({
    settings: { approvalEnabled: true, approvalThresholdCents: 500_000, receiptReminderDays: 10 },
    actor: { userId: 'marc', displayName: 'Marc Dubois', role: 'owner', solo: false, mayApprove: true },
    invoices: reviews(),
  });
  desktopApi.paymentSafetyOverview = async () => overview();
  desktopApi.getCloudTeam = async () => ({ members: [{}, {}, {}] }) as never;
  desktopApi.rememberCompanyTeamSize = async () => ({});
  desktopApi.prepareSupplierPayment = async () => ({});
  desktopApi.approveSupplierPayment = async () => { favreApproval = { ...favreApproval, status: 'approved', covered: true, approvedBy: 'Marc Dubois', approvedAt: now, refusal: 'Ce paiement est déjà approuvé.' }; return {}; };
  desktopApi.revokeSupplierPaymentApproval = async () => { favreApproval = { ...favreApproval, status: 'prepared', covered: false, approvedBy: null, approvedAt: null, refusal: null }; return {}; };
  desktopApi.withdrawSupplierPaymentPreparation = async () => ({});
  desktopApi.savePaymentSafetySettings = async (settings) => settings;
  desktopApi.recordPaymentSafetyAcknowledgement = async () => ({});
  const entry: EntryReview = {
    supplierInvoiceId: 'i-7', supplierName: 'Papeterie des Alpes', historyCount: 9, usualAccount: '6500 Frais de bureau', usualVatBp: 810,
    findings: [{ kind: 'unusual_account', line: 0, description: 'Ordinateur portable', account: '6570 Matériel informatique' }, { kind: 'unusual_amount', usualCents: 19_800, factor: 3 }],
  };
  desktopApi.reviewSupplierInvoiceEntry = async (id) => (id === 'i-7' ? entry : { ...entry, supplierInvoiceId: id, findings: [] });
  const bank: BankWorkspace = {
    summary: { importCount: 1, movementCount: 3, unreconciledCount: 0, unreconciledSupplierCount: 3, pendingCount: 0, bookedCreditCount: 0, bookedDebitCount: 3 },
    accounts: [{ accountId: 'CH9300762011623852957', currency: 'CHF', linked: true, linkSource: 'settings_iban', movementCount: 3 }],
    imports: [{ id: 'camt-1', sourceName: 'camt053_UBS.xml', fileSha256: 'a'.repeat(64), fileSize: 4_000, messageType: 'camt.053', namespaceVersion: '001.08', accountId: 'CH9300762011623852957', accountCurrency: 'CHF', entryCount: 3, importedCount: 3, ignoredCount: 0, createdAt: now }],
    movements: [debit('m-coop', 22, 8_450, 'Coop Bau+Hobby Bulle'), debit('m-shell', 14, 11_230, 'Shell Riaz'), debit('m-hornbach', 11, 34_990, 'Hornbach Villeneuve')],
    reconciliations: [], supplierReconciliations: [],
  };
  desktopApi.getBankWorkspace = async () => bank;
}
