import { desktopApi } from '../src/bridge';
import { bankWorkspaceFromRaw } from '../src/bank';
import type { ExpenseRefund, Workspace } from '../src/types';

/** Simulated UI persistence; native SQLite tests cover bank identity, journals and VAT. */
export function installBankRefundFixture(initial: Workspace) {
  initial.schemaVersion = 48;
  const reference = 'AV-2026-RETOUR-MATERIEL-ELECTRIQUE-POUR-LE-PROJET';
  initial.expenses = [0,1].map((index) => {
    const refund: ExpenseRefund = { id: `refund-${index}`, expenseId: `expense-${index}`, eventType: 'refund', reversesId: null, creditDate: '2026-08-21', paymentDate: '2026-08-31', reference: index ? 'AV-AUTRE-54' : reference, reason: 'Retour partiel de marchandises', netCents: 5000, vatCents: 405, totalCents: 5405, costCents: 5000, treatment: 'input_materials', creditJournalId: `credit-${index}`, paymentJournalId: `payment-${index}`, createdAt: '2026-08-31T10:00:00Z' };
    return { id: refund.expenseId, projectId: initial.projects[0]?.id, date: '2026-08-20', supplier: index ? 'Autre fournisseur' : 'Électricité du Léman', category: 'Marchandises', reference: `RECU-${index}`, netCents: 10000, vatCents: 810, totalCents: 10810, paymentStatus: 'paid', paidAt: '2026-08-20', note: '', costCents: 10000, costReviewRequired: false, costBasis: 'accounted', refunds: [refund] };
  });
  const readOnly = new URLSearchParams(location.search).has('readOnly');
  if (readOnly) {
    initial.expenses[0].refunds![0].bankMatchId = 'read-only-match';
    initial.attachments = [{ id: 'read-only-receipt', projectId: initial.expenses[0].projectId || null, entityType: 'expense_refund', entityId: 'refund-0', originalName: 'avoir-consultable.pdf', mimeType: 'application/pdf', sizeBytes: 64, sha256: 'a'.repeat(64), createdAt: '2026-09-05', updatedAt: '2026-09-05' }];
    desktopApi.openAttachment = async id => { sessionStorage.setItem('qa-read-only-opened', id); return id; };
  }
  const persisted = structuredClone(initial);
  desktopApi.loadWorkspace = async () => structuredClone(persisted);
  let active: Record<string, unknown> | null = readOnly ? { id: 'read-only-match', refund_id: 'refund-0', expense_id: 'expense-0', reference, supplier: initial.expenses[0].supplier, amount_cents: 5405, payment_date: '2026-08-31', payment_journal_id: 'payment-0', confirmed_at: '2026-09-05T12:00:00Z' } : null;
  const history: Record<string, unknown>[] = [];
  const requests = new Map<string,string>();
  const unlinks = new Map<string,string>();
  const account = 'CH9300762011623852957';
  desktopApi.getBankWorkspace = async () => {
    if (sessionStorage.getItem('qa-bank-refund-read-fail') === '1') throw new Error('Lecture du relevé temporairement indisponible.');
    return bankWorkspaceFromRaw({ summary: { movement_count: 1, import_count: 1, unreconciled_count: active ? 0 : 1, booked_credit_count: 1 }, accounts: [{ account_id: account, currency: 'CHF', linked: true, link_source: 'explicit', movement_count: 1 }], imports: [{ id: 'import', source_name: 'remboursement-fournisseur.xml', message_type: 'camt.053', entry_count: 1, imported_count: 1, created_at: '2026-09-05T08:00:00Z' }], movements: [{ id: 'refund-credit', account_id: account, account_currency: 'CHF', amount_cents: 5405, currency: 'CHF', credit_debit: 'CRDT', status: 'BOOK', reversal: false, booking_date: '2026-09-01', value_date: '2026-08-31', created_at: '2026-09-01T10:00:00Z', strong_key: 'refund-credit', reference_type: 'NON', unstructured: 'Retour de marchandises', counterparty_name: 'Électricité du Léman', refund_match: active, refund_history: history, refund_suggestion: { reason: 'Vérifiez le fournisseur, la pièce et le montant remboursé.', candidates: active ? [] : persisted.expenses.map((expense) => { const refund = expense.refunds![0]; return { refund_id: refund.id, expense_id: expense.id, reference: refund.reference, expense_reference: expense.reference, supplier: expense.supplier, payment_date: refund.paymentDate, total_cents: 5405, requires_date_reason: true, confirmable: true, reason: 'Écart de dates à justifier ; le remboursement reste comptabilisé au 31 août.' }; }) }, suggestion: { kind: 'none', candidates: [], confirmable: false, reason: active ? 'Remboursement déjà rapproché.' : 'Aucune facture client correspondante.' } }], reconciliations: [], supplier_reconciliations: [] });
  };
  desktopApi.matchBankExpenseRefund = async (requestId, movementId, refundId, dateReason) => {
    const input = { requestId, movementId, refundId, dateReason };
    sessionStorage.setItem('qa-bank-refund-attempts', JSON.stringify([...JSON.parse(sessionStorage.getItem('qa-bank-refund-attempts') || '[]'), input]));
    if (sessionStorage.getItem('qa-bank-refund-deny') === '1') throw new Error('Le compte bancaire a changé. Vérifiez son association avant de réessayer.');
    const previous = requests.get(requestId);
    if (previous && previous !== JSON.stringify(input)) throw new Error('Cette tentative a déjà été utilisée avec un autre choix.');
    if (!previous) {
      if (active) throw new Error('Le remboursement est déjà rapproché.');
      const expense = persisted.expenses.find((expense) => expense.refunds?.some((refund) => refund.id === refundId))!;
      const refund = expense.refunds![0];
      active = { id: requestId, refund_id: refundId, expense_id: expense.id, reference: refund.reference, supplier: expense.supplier, amount_cents: 5405, payment_date: refund.paymentDate, payment_journal_id: refund.paymentJournalId, confirmed_at: '2026-09-05T12:00:00Z', date_difference_reason: dateReason };
      refund.bankMatchId = requestId; requests.set(requestId, JSON.stringify(input));
      sessionStorage.setItem('qa-bank-refund-matches', String(requests.size));
    }
    if (sessionStorage.getItem('qa-bank-refund-lost') === '1') throw new Error('Réponse interrompue. Réessayez avec la même sélection.');
    if (sessionStorage.getItem('qa-bank-refund-fail-after-save') === '1') sessionStorage.setItem('qa-bank-refund-read-fail', '1');
  };
  desktopApi.unmatchBankExpenseRefund = async (requestId, matchId, reason) => {
    const input = { requestId, matchId, reason };
    sessionStorage.setItem('qa-bank-refund-unlink-attempts', JSON.stringify([...JSON.parse(sessionStorage.getItem('qa-bank-refund-unlink-attempts') || '[]'), input]));
    if (sessionStorage.getItem('qa-bank-refund-unlink-deny') === '1') throw new Error('Cette association a changé. Vérifiez le rapprochement avant de réessayer.');
    const previous = unlinks.get(requestId);
    if (previous && previous !== JSON.stringify(input)) throw new Error('Motif de reprise différent.');
    if (!previous) {
      if (!active || active.id !== matchId) throw new Error('Cette association n’est plus active.');
      history.unshift({ ...active, reason, unlinked_at: '2026-09-05T12:10:00Z' });
      persisted.expenses.flatMap((expense) => expense.refunds ?? []).forEach((refund) => { if (refund.bankMatchId === matchId) refund.bankMatchId = null; });
      active = null; unlinks.set(requestId, JSON.stringify(input));
      sessionStorage.setItem('qa-bank-refund-unlinks', String(unlinks.size));
    }
    if (sessionStorage.getItem('qa-bank-refund-unlink-lost') === '1') throw new Error('Réponse interrompue. Réessayez avec le même motif.');
    if (sessionStorage.getItem('qa-bank-refund-fail-after-save') === '1') sessionStorage.setItem('qa-bank-refund-read-fail', '1');
  };
}
