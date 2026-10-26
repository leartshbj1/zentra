import { describe, expect, it } from 'vitest';
import { centsFromText } from './PaymentSafetyParts';
import {
  approvalText,
  defaultPaymentSafetySettings,
  entryFindingText,
  entryHabit,
  findingDetail,
  historyLines,
  missingReceipts,
  paymentSafetyFromRaw,
  receiptRecipients,
  receiptRequestDraft,
  type PaymentApproval,
} from './paymentSafety';
import type { Attachment, BankMovement, BankWorkspace, Employee, SupplierInvoice } from './types';

const movement = (id: string, bookingDate: string, extra: Partial<BankMovement> = {}): BankMovement => ({
  id, importId: 'import', accountId: 'CH9300762011623852957', accountCurrency: 'CHF', amountCents: 8_450, currency: 'CHF', creditDebit: 'DBIT', status: 'BOOK',
  reversal: false, bookingDate, valueDate: bookingDate, accountServicerRef: '', endToEndId: '', transactionId: '', referenceType: 'NON', referenceLevel: '', reference: '',
  unstructured: '', counterpartyName: 'Coop Bau+Hobby', counterpartyIban: '', strongKey: id, createdAt: bookingDate, reconciliation: null, supplierReconciliation: null,
  expenseReconciliation: null, refundMatch: null,
  suggestion: { kind: 'none', confirmable: false, reason: '', candidates: [] } as never,
  supplierSuggestion: { entityType: 'supplier_invoice', kind: 'none' as never, supplierInvoiceId: null, reason: '', confirmable: false, requiresConfirmation: false, candidates: [] },
  ...extra,
});
const bank = (movements: BankMovement[]) => ({ movements } as unknown as BankWorkspace);
const attachment = (entityType: string, entityId: string) => ({ id: 'a-' + entityId, entityType, entityId } as Attachment);
const invoice = (id: string, attachments: Attachment[] = []) => ({ id, attachments } as unknown as SupplierInvoice);

describe('justificatifs manquants', () => {
  const today = '2026-10-25';
  it('relance une dépense sans pièce à partir du délai réglé, la plus ancienne d’abord', () => {
    const rows = missingReceipts(bank([movement('m1', '2026-10-20'), movement('m2', '2026-10-15'), movement('m3', '2026-09-30')]), [], [], 10, today);
    expect(rows.map((row) => [row.movement.id, row.reason, row.ageDays])).toEqual([['m3', 'unlinked', 25], ['m2', 'unlinked', 10]]);
  });

  it('suit la dépense ou la facture rapprochée tant qu’elle n’a pas de pièce jointe', () => {
    const linkedExpense = (id: string, expenseId: string) => movement(id, '2026-10-01', { expenseReconciliation: { id: 'r-' + id, expenseId, journalEntryId: 'j', confirmedAt: '2026-10-02' } });
    const linkedInvoice = (id: string, supplierInvoiceId: string) => movement(id, '2026-10-01', { supplierReconciliation: { id: 's-' + id, movementId: id, supplierInvoiceId, supplierPaymentId: 'p', amountCents: 8_450, confirmedAt: '2026-10-02', createdAt: '2026-10-02' } });
    const rows = missingReceipts(
      bank([linkedExpense('e1', 'exp-1'), linkedExpense('e2', 'exp-2'), linkedInvoice('s1', 'inv-1'), linkedInvoice('s2', 'inv-2')]),
      [attachment('expense', 'exp-2')],
      [invoice('inv-1'), invoice('inv-2', [attachment('supplier_invoice', 'inv-2')])],
      10, today,
    );
    expect(rows.map((row) => [row.movement.id, row.reason, row.expenseId ?? row.supplierInvoiceId])).toEqual([['e1', 'expense', 'exp-1'], ['s1', 'supplier_invoice', 'inv-1']]);
  });

  it('ne demande rien pour un crédit, un remboursement, une opération en attente ou un rapprochement possible', () => {
    const rows = missingReceipts(bank([
      movement('credit', '2026-09-01', { creditDebit: 'CRDT' }),
      movement('pending', '2026-09-01', { status: 'PDNG' }),
      movement('reversal', '2026-09-01', { reversal: true }),
      movement('refund', '2026-09-01', { refundMatch: { id: 'x' } as never }),
      movement('matchable', '2026-09-01', { expenseSuggestion: { reason: '', candidates: [{ confirmable: true } as never] } }),
    ]), [], [], 10, today);
    expect(rows).toEqual([]);
    expect(missingReceipts(null, [], [], 10, today)).toEqual([]);
  });

  it('prépare un brouillon avec les données du relevé, à valider dans la messagerie', () => {
    const [row] = missingReceipts(bank([movement('m1', '2026-10-01')]), [], [], 10, today);
    const draft = receiptRequestDraft(row, { name: 'Luca Rossi', email: 'luca@atelier.example' }, 'Atelier Léman Sàrl');
    expect(draft.subject).toContain('84.50');
    expect(draft.body).toContain('Bonjour Luca,');
    expect(draft.body).toContain('Coop Bau+Hobby');
    expect(draft.body.endsWith('Atelier Léman Sàrl')).toBe(true);
    expect(draft.href.startsWith('mailto:luca%40atelier.example?subject=')).toBe(true);
    expect(decodeURIComponent(draft.href.split('&body=')[1])).toBe(draft.body);
  });

  it('propose d’abord le collaborateur déjà sollicité, parmi ceux qui ont un e-mail', () => {
    const person = (id: string, name: string, email: string, employmentEnd = '') => ({ id, name, email, employmentEnd } as Employee);
    const people = receiptRecipients([person('a', 'Zoé', 'zoe@x.ch'), person('b', 'Anna', 'anna@x.ch'), person('c', 'Marc', ''), person('d', 'Paul', 'paul@x.ch', '2026-06-30')], 'a');
    expect(people.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('textes des contrôles', () => {
  it('explique l’IBAN changé avec l’ancien et le nouvel IBAN masqués et la date du changement', () => {
    const text = findingDetail({ kind: 'iban_changed', previousIban: 'CH93 •••• 2957', currentIban: 'CH56 •••• 8009', changedOn: '2026-10-20', lastPaidOn: '2026-08-01' }, 12_000);
    expect(text).toContain('CH93 •••• 2957');
    expect(text).toContain('CH56 •••• 8009');
    expect(text).toContain('Appelez le fournisseur');
  });

  it('donne la règle du montant inhabituel en clair', () => {
    expect(findingDetail({ kind: 'unusual_amount', usualCents: 10_500, historyCount: 4, factor: 3 }, 40_000)).toMatch(/médiane de 4 factures.*3 fois/);
  });

  it('résume l’historique du fournisseur, ou dit qu’il n’y a jamais eu de paiement', () => {
    expect(historyLines({ paymentCount: 0, total12MonthsCents: 0, lastPaymentDate: null, lastPaymentCents: null, usualCents: null, invoiceCount: 0, paidIbans: [] })).toEqual([{ label: 'Historique', value: 'Aucun paiement enregistré' }]);
    const lines = historyLines({ paymentCount: 3, total12MonthsCents: 22_000, lastPaymentDate: '2026-09-01', lastPaymentCents: 12_000, usualCents: 11_000, invoiceCount: 2, paidIbans: ['CH56 •••• 8009'] });
    expect(lines.map((line) => line.label)).toEqual(['Paiements', '12 derniers mois', 'Dernier paiement', 'Montant habituel', 'IBAN utilisé']);
  });

  it('dit où en est le circuit préparé → approuvé', () => {
    const base: PaymentApproval = { required: true, covered: false, status: null, stale: false, amountCents: null, preparedBy: null, preparedByMe: false, preparedAt: null, approvedBy: null, approvedAt: null, refusal: null };
    expect(approvalText(base, defaultPaymentSafetySettings)).toContain('deuxième personne');
    expect(approvalText({ ...base, status: 'prepared', preparedBy: 'Anna', preparedByMe: true }, defaultPaymentSafetySettings)).toBe('En attente d’approbation par une autre personne');
    expect(approvalText({ ...base, status: 'prepared', preparedBy: 'Anna' }, defaultPaymentSafetySettings)).toBe('Préparé par Anna · à approuver');
    expect(approvalText({ ...base, status: 'approved', covered: true, approvedBy: 'Marc' }, defaultPaymentSafetySettings)).toBe('Approuvé par Marc');
    expect(approvalText({ ...base, required: false }, defaultPaymentSafetySettings)).toBe('');
  });

  it('écrit l’habitude d’écriture du fournisseur, comme « 4000 Achats de matériel avec TVA 8,1 % »', () => {
    const review = { supplierInvoiceId: 'i', supplierName: 'Fournisseur X', historyCount: 5, usualAccount: '4000 Achats de matériel', usualVatBp: 810, findings: [] };
    expect(entryHabit(review)).toBe('D’habitude, Fournisseur X va en 4000 Achats de matériel avec TVA 8,1 %.');
    expect(entryFindingText({ kind: 'unusual_vat_rate', line: 0, description: 'Livre', vatBp: 260 })).toContain('2,6 %');
  });

  it('lit les montants saisis à la suisse et garde des réglages sûrs si le natif ne répond pas tout', () => {
    expect([centsFromText('5000'), centsFromText("5'000.50"), centsFromText('5 000,5'), centsFromText('abc')]).toEqual([500_000, 500_050, 500_050, null]);
    expect(paymentSafetyFromRaw(undefined).settings).toEqual(defaultPaymentSafetySettings);
  });
});
