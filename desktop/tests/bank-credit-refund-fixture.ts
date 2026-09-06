import { desktopApi } from '../src/bridge';
import { bankWorkspaceFromRaw } from '../src/bank';
import { installPurchaseFulfillmentFixture } from './purchase-fulfillment-fixture';
import { installCreditSettlementFixture } from './credit-settlement-fixture';
import type { SupplierCreditRefund, Workspace } from '../src/types';

/** Error/retry UI fixture only. Real persistence is exercised in the Rust tests. */
export function installBankCreditRefundFixture(initial: Workspace) {
  installPurchaseFulfillmentFixture(initial);
  installCreditSettlementFixture(initial);
  initial.schemaVersion = 52;
  initial.supplierCreditNotes.forEach((credit) => {
    credit.documentDate = '2026-08-21';
  });
  const saved = structuredClone(initial);
  const credit = saved.supplierCreditNotes.find(
    (row) => row.id === 'available-credit',
  )!;
  const requests = new Map<string, string>();
  let active: Record<string, unknown> | null = null;
  const history: Record<string, unknown>[] = [];
  const flag = (name: string) =>
    sessionStorage.getItem(`qa-credit-bank-${name}`) === '1';
  const log = (name: string, input: unknown) =>
    sessionStorage.setItem(
      `qa-credit-bank-${name}`,
      JSON.stringify([
        ...JSON.parse(sessionStorage.getItem(`qa-credit-bank-${name}`) || '[]'),
        input,
      ]),
    );
  desktopApi.loadWorkspace = async () => {
    if (flag('read')) throw Error('Lecture indisponible.');
    return structuredClone(saved);
  };
  desktopApi.openAttachment = async (id) => {
    sessionStorage.setItem('qa-credit-bank-opened', id);
    return id;
  };
  desktopApi.createBankSupplierCreditRefund = async (input) => {
    const proof = JSON.stringify({
      ...input,
      receipt: { name: input.receipt.name, size: input.receipt.size },
    });
    log('attempts', { ...input, receipt: input.receipt.name });
    if (flag('deny'))
      throw Error(
        'La période est clôturée. Le remboursement n’a pas été enregistré.',
      );
    const previous = requests.get(input.requestId);
    if (previous && previous !== proof)
      throw Error('Cette demande a un contenu différent.');
    if (!previous) {
      const refund: SupplierCreditRefund = {
        id: 'credit-refund',
        supplierCreditNoteId: credit.id,
        sequence: 1,
        eventType: 'refund',
        reversesId: null,
        date: '2026-08-31',
        amountCents: 5405,
        reference: input.reference,
        reason: input.reason,
        bankAccountId: 'bank',
        payableAccountId: 'ap',
        journalEntryId: 'refund-journal',
      };
      credit.refunds.push(refund);
      credit.refundedCents += 5405;
      active = {
        id: input.requestId,
        movement_id: 'bank-credit',
        supplier_credit_note_id: credit.id,
        refund_id: refund.id,
        reference: refund.reference,
        supplier: credit.supplierName,
        amount_cents: 5405,
        payment_date: refund.date,
        confirmed_at: '2026-09-06T10:00:00Z',
      };
      saved.attachments!.push({
        id: 'credit-receipt',
        entityType: 'supplier_credit_refund',
        entityId: refund.id,
        projectId: null,
        originalName: input.receipt.name,
        sizeBytes: input.receipt.size,
        mimeType: 'application/pdf',
        sha256: 'a'.repeat(64),
        createdAt: '',
        updatedAt: '',
      });
      requests.set(input.requestId, proof);
      sessionStorage.setItem('qa-credit-bank-commits', String(requests.size));
    }
    if (flag('lost'))
      throw Error('Réponse interrompue. Réessayez cette même saisie.');
    if (flag('after-save')) sessionStorage.setItem('qa-credit-bank-read', '1');
  };
  desktopApi.addSupplierCreditRefundAttachment = async (id, file) => {
    log('attach', { id, name: file.name });
    saved.attachments!.push({
      id: 'extra-credit-receipt',
      entityType: 'supplier_credit_refund',
      entityId: id,
      projectId: null,
      originalName: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
      sha256: 'b'.repeat(64),
      createdAt: '',
      updatedAt: '',
    });
    return structuredClone(saved);
  };
  desktopApi.unmatchBankSupplierCreditRefund = async (
    requestId,
    matchId,
    reason,
  ) => {
    log('unlinks', { requestId, matchId, reason });
    if (!active || active.id !== matchId) throw Error('Rapprochement absent.');
    history.unshift({ ...active, reason, unlinked_at: '2026-09-06T11:00:00Z' });
    active = null;
  };
  desktopApi.matchBankSupplierCreditRefund = async (
    requestId,
    movementId,
    refundId,
    dateDifferenceReason,
  ) => {
    log('matches', { requestId, movementId, refundId, dateDifferenceReason });
    if (active) throw Error('Déjà rapproché.');
    active = {
      ...history[0],
      id: requestId,
      confirmed_at: '2026-09-06T12:00:00Z',
    };
  };
  desktopApi.matchBankExpenseRefund = async () => {
    throw Error('Wrong source: supplier credit is not an expense.');
  };
  desktopApi.unmatchBankExpenseRefund = async () => {
    throw Error('Wrong source: supplier credit is not an expense.');
  };
  desktopApi.getBankWorkspace = async () => {
    if (flag('read')) throw Error('Relevé indisponible.');
    return bankWorkspaceFromRaw({
      summary: {
        movement_count: 1,
        import_count: 1,
        unreconciled_count: active ? 0 : 1,
        booked_credit_count: 1,
      },
      accounts: [
        {
          account_id: 'CH9300762011623852957',
          currency: 'CHF',
          linked: true,
          link_source: 'explicit',
          movement_count: 1,
        },
      ],
      imports: [],
      reconciliations: [],
      supplier_reconciliations: [],
      movements: [
        {
          id: 'bank-credit',
          account_id: 'CH9300762011623852957',
          account_currency: 'CHF',
          amount_cents: 5405,
          currency: 'CHF',
          credit_debit: 'CRDT',
          status: 'BOOK',
          reversal: false,
          booking_date: '2026-08-31',
          value_date: '2026-08-31',
          created_at: '2026-08-31',
          strong_key: 'bank-credit',
          reference_type: 'NON',
          counterparty_name: credit.supplierName,
          unstructured: 'Retour de marchandises',
          refund_match: active,
          refund_history: history,
          suggestion: {
            kind: 'none',
            candidates: [],
            confirmable: false,
            reason: 'Aucune facture client correspondante.',
          },
          refund_suggestion: {
            can_create: !active,
            candidates: active
              ? []
              : credit.refunds.map((refund) => ({
                  refund_id: refund.id,
                  supplier_credit_note_id: credit.id,
                  reference: refund.reference,
                  supplier: credit.supplierName,
                  expense_reference: credit.number,
                  payment_date: refund.date,
                  total_cents: refund.amountCents,
                  requires_date_reason: false,
                  confirmable: true,
                  reason: 'Remboursement déjà comptabilisé.',
                })),
            reason: 'Associez le remboursement à son avoir fournisseur.',
          },
        },
      ],
    });
  };
}
