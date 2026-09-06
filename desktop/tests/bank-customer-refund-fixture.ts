// Synthetic UI transport only. Rust tests exercise money, proofs, migration and rollback.
import { desktopApi } from '../src/bridge';
import { bankWorkspaceFromRaw } from '../src/bank';
import type { CustomerCreditSettlement, Workspace } from '../src/types';
import { installCustomerCreditSettlementFixture } from './customer-credit-settlement-fixture';

export function installBankCustomerRefundFixture(data: Workspace) {
  installCustomerCreditSettlementFixture(() => data);
  data.settings!.payroll.enabled = false;
  Object.assign(data.accountingSettings!, { revenueAccountId: 'qa-revenue', vatPayableAccountId: 'qa-vat-due', expenseAccountId: 'qa-expense', vatReceivableAccountId: 'qa-vat-input', wagesExpenseAccountId: null, wagesPayableAccountId: null, socialExpenseAccountId: null, socialPayableAccountId: null, supplierPayableAccountId: 'qa-suppliers' });
  const stored = sessionStorage.getItem('qa-bank-customer-state');
  let state = stored ? JSON.parse(stored) : { workspace: structuredClone(data), active: null, history: [], requests: {}, commits: 0 };
  const saved: Workspace = state.workspace;
  const credit = saved.invoices.find(row => row.type === 'credit_note')!;
  const movementId = 'c9264804-678c-49db-8aa1-d8901ee4c451';
  const persist = () => sessionStorage.setItem('qa-bank-customer-state', JSON.stringify(state));
  const log = (kind: string, input: unknown) => {
    const entries = JSON.parse(sessionStorage.getItem('qa-bank-customer-attempts') || '[]');
    entries.push({ kind, input }); sessionStorage.setItem('qa-bank-customer-attempts', JSON.stringify(entries));
  };
  const proof = (requestId: string, refund: CustomerCreditSettlement, dateReason?: string) => ({ id: requestId, movement_id: movementId, refund_id: refund.id, customer_credit_note_id: credit.id, customer_name: 'Client de recette', reference: refund.reference, amount_cents: refund.amountCents, payment_date: refund.date, payment_journal_id: refund.journalEntryId, confirmed_at: '2026-09-06T12:00:00Z', date_difference_reason: dateReason || null });
  if (!stored && new URLSearchParams(location.search).has('existingRefund')) {
    credit.customerCredit = { allocatedCents: 0, refundedCents: 2703, remainingCents: 2702 };
    credit.creditSettlements = [{ id: 'existing-customer-refund', creditNoteId: credit.id, invoiceId: null, eventType: 'refund', date: '2026-03-14', amountCents: 2703, reference: 'REMBOURSEMENT-EXISTANT', reason: 'Retour de prestation', reversesId: null, bankAccountId: 'customer-bank', journalEntryId: 'existing-journal', journalValid: true }];
  }
  Object.assign(data, structuredClone(saved));
  desktopApi.loadWorkspace = async () => structuredClone(saved);
  desktopApi.openAttachment = async id => { sessionStorage.setItem('qa-bank-customer-opened', id); return 'opened'; };
  const complete = (requestId: string, signature: string, act: () => void) => {
    if (state.requests[requestId]) {
      if (state.requests[requestId] !== signature) throw Error('Contenu différent pour la même demande.');
    } else { act(); state.requests[requestId] = signature; persist(); }
    if (sessionStorage.getItem('qa-bank-customer-lost') === '1') throw Error('Réponse interrompue après enregistrement.');
  };
  desktopApi.createBankCustomerCreditRefund = async input => {
    const bytes = input.receipt ? Array.from(new Uint8Array(await input.receipt.arrayBuffer())) : null;
    const payload = { ...input, receipt: input.receipt ? { name: input.receipt.name, type: input.receipt.type, bytes } : null };
    log('create', payload);
    complete(input.requestId, JSON.stringify(payload), () => {
      if (state.active) throw Error('Déjà rapproché.');
      const refund: CustomerCreditSettlement = { id: input.requestId, creditNoteId: credit.id, invoiceId: null, eventType: 'refund', date: input.date, amountCents: input.amountCents, reference: input.reference, reason: input.reason, reversesId: null, bankAccountId: 'customer-bank', journalEntryId: `journal-${input.requestId}`, journalValid: true, bankMatchId: input.requestId };
      credit.creditSettlements!.unshift(refund);
      credit.customerCredit!.remainingCents -= input.amountCents; credit.customerCredit!.refundedCents += input.amountCents;
      state.active = proof(input.requestId, refund); state.commits++;
      if (input.receipt) saved.attachments!.push({ id: 'customer-bank-receipt', projectId: credit.projectId, entityType: 'customer_credit_settlement', entityId: refund.id, originalName: input.receipt.name, sizeBytes: input.receipt.size, mimeType: input.receipt.type, sha256: 'a'.repeat(64), createdAt: '', updatedAt: '' });
    });
  };
  desktopApi.matchBankCustomerCreditRefund = async (requestId, movement, refundId, dateDifferenceReason) => {
    const input = { requestId, movement, refundId, dateDifferenceReason }; log('match', input);
    complete(requestId, JSON.stringify(input), () => {
      if (state.active) throw Error('Déjà rapproché.');
      const refund = credit.creditSettlements!.find(row => row.id === refundId)!;
      state.active = proof(requestId, refund, dateDifferenceReason); refund.bankMatchId = requestId;
    });
  };
  desktopApi.unmatchBankCustomerCreditRefund = async (requestId, matchId, reason) => {
    const input = { requestId, matchId, reason }; log('unlink', input);
    complete(requestId, JSON.stringify(input), () => {
      if (state.active?.id !== matchId) throw Error('Association absente.');
      state.history.unshift({ ...state.active, reason, unlinked_at: '2026-09-06T13:00:00Z' });
      credit.creditSettlements!.find(row => row.id === state.active.refund_id)!.bankMatchId = null;
      state.active = null;
    });
  };
  desktopApi.matchBankExpenseRefund = desktopApi.unmatchBankExpenseRefund = async () => { throw Error('Wrong refund source.'); };
  desktopApi.getBankWorkspace = async () => bankWorkspaceFromRaw({
    summary: { import_count: 1, movement_count: 1, unreconciled_supplier_count: state.active ? 0 : 1, booked_debit_count: 1 },
    accounts: [{ account_id: 'CH9300762011623852957', currency: 'CHF', linked: true, link_source: 'explicit', movement_count: 1 }], imports: [], reconciliations: [], supplier_reconciliations: [],
    movements: [{ id: movementId, account_id: 'CH9300762011623852957', account_currency: 'CHF', amount_cents: 2703, currency: 'CHF', credit_debit: 'DBIT', status: 'BOOK', reversal: false, booking_date: '2026-03-15', value_date: '2026-03-15', created_at: '2026-03-15', strong_key: 'customer-bank-key', reference_type: 'NON', counterparty_name: 'Client de recette', unstructured: 'Remboursement de prestation client', refund_match: state.active, refund_history: state.history,
      suggestion: { kind: 'none', candidates: [], confirmable: false, reason: 'Débit bancaire.' },
      refund_suggestion: { can_create: !state.active && !state.history.length, reason: state.history.length ? 'Rapprochez le remboursement conservé.' : 'Reliez le débit au remboursement client de son avoir.', candidates: state.active ? [] : credit.creditSettlements!.filter(row => row.eventType === 'refund').map(row => ({ refund_id: row.id, customer_credit_note_id: credit.id, customer_name: 'Client de recette', reference: row.reference, expense_reference: credit.number, payment_date: row.date, total_cents: row.amountCents, requires_date_reason: row.date !== '2026-03-15', confirmable: true, reason: 'Remboursement déjà comptabilisé.' })) },
    }],
  });
}
