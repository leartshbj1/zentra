import type {
  BankImport,
  BankMovement,
  BankReconciliation,
  BankReconciliationCandidate,
  BankReconciliationSuggestion,
  BankReconciliationResult,
  BankSuggestionKind,
  BankWorkspace,
  CamtImportResult,
} from './types';

export type BankMovementFilter = 'unreconciled' | 'pending' | 'reconciled' | 'all';
type RawRecord = Record<string, unknown>;

const record = (value: unknown): RawRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {};
const array = (value: unknown): RawRecord[] => Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1';

const suggestionKinds = new Set<BankSuggestionKind>(['automatic_exact', 'automatic_partial', 'manual', 'review', 'none']);

export function bankReconciliationFromRaw(value: unknown): BankReconciliation {
  const row = record(value);
  return {
    id: text(row.id),
    movementId: text(row.movement_id),
    invoiceId: text(row.invoice_id),
    paymentId: text(row.payment_id),
    amountCents: integer(row.amount_cents),
    confirmedAt: text(row.confirmed_at),
    createdAt: text(row.created_at),
  };
}

function candidateFromRaw(value: unknown): BankReconciliationCandidate {
  const row = record(value);
  return {
    invoiceId: text(row.invoice_id),
    invoiceNumber: text(row.invoice_number),
    remainingCents: integer(row.remaining_cents),
    amountRelation: text(row.amount_relation),
    reason: text(row.reason),
    confirmable: bool(row.confirmable),
  };
}

function suggestionFromRaw(value: unknown): BankReconciliationSuggestion {
  const row = record(value);
  const candidateKind = text(row.kind) as BankSuggestionKind;
  return {
    kind: suggestionKinds.has(candidateKind) ? candidateKind : 'none',
    invoiceId: text(row.invoice_id) || null,
    invoiceNumber: text(row.invoice_number) || null,
    reason: text(row.reason),
    confirmable: bool(row.confirmable),
    candidates: array(row.candidates).map(candidateFromRaw).filter((item) => item.invoiceId),
  };
}

export function bankMovementFromRaw(value: unknown): BankMovement {
  const row = record(value);
  const reconciliation = record(row.reconciliation);
  return {
    id: text(row.id),
    importId: text(row.import_id),
    accountId: text(row.account_id),
    accountCurrency: text(row.account_currency),
    amountCents: integer(row.amount_cents),
    currency: text(row.currency) || text(row.account_currency) || 'CHF',
    creditDebit: text(row.credit_debit),
    status: text(row.status),
    reversal: bool(row.reversal),
    bookingDate: text(row.booking_date),
    valueDate: text(row.value_date),
    accountServicerRef: text(row.account_servicer_ref),
    endToEndId: text(row.end_to_end_id),
    transactionId: text(row.transaction_id),
    referenceType: text(row.reference_type),
    referenceLevel: text(row.reference_level),
    reference: text(row.reference),
    unstructured: text(row.unstructured),
    counterpartyName: text(row.counterparty_name) || text(row.debtor_name),
    strongKey: text(row.strong_key),
    createdAt: text(row.created_at),
    reconciliation: Object.keys(reconciliation).length ? bankReconciliationFromRaw(reconciliation) : null,
    suggestion: suggestionFromRaw(row.suggestion),
  };
}

export function bankImportFromRaw(value: unknown): BankImport {
  const row = record(value);
  return {
    id: text(row.id),
    sourceName: text(row.source_name),
    fileSha256: text(row.file_sha256),
    fileSize: integer(row.file_size),
    messageType: text(row.message_type),
    namespaceVersion: text(row.namespace_version),
    accountId: text(row.account_id),
    accountCurrency: text(row.account_currency),
    entryCount: integer(row.entry_count),
    ignoredCount: integer(row.ignored_count),
    createdAt: text(row.created_at),
  };
}

export function bankWorkspaceFromRaw(value: unknown): BankWorkspace {
  const row = record(value);
  const summary = record(row.summary);
  return {
    summary: {
      importCount: integer(summary.import_count),
      movementCount: integer(summary.movement_count),
      unreconciledCount: integer(summary.unreconciled_count),
      pendingCount: integer(summary.pending_count),
      bookedCreditCount: integer(summary.booked_credit_count),
    },
    accounts: array(row.accounts).map((account) => ({
      accountId: text(account.account_id),
      currency: text(account.currency) || 'CHF',
      linked: bool(account.linked),
      linkSource: (['settings_iban', 'explicit'].includes(text(account.link_source)) ? text(account.link_source) : 'unlinked') as BankWorkspace['accounts'][number]['linkSource'],
      movementCount: integer(account.movement_count),
    })),
    imports: array(row.imports).map(bankImportFromRaw),
    movements: array(row.movements).map(bankMovementFromRaw),
    reconciliations: array(row.reconciliations).map(bankReconciliationFromRaw),
  };
}

export function camtImportResultFromRaw(value: unknown): CamtImportResult {
  const row = record(value);
  return {
    duplicate: bool(row.duplicate),
    import: bankImportFromRaw(row.import),
    importedCount: integer(row.imported_count),
    skippedDuplicateCount: integer(row.skipped_duplicate_count),
    ignoredCount: integer(row.ignored_count),
    warnings: Array.isArray(row.warnings) ? row.warnings.map(text).filter(Boolean) : [],
  };
}

export function bankReconciliationResultFromRaw(value: unknown): BankReconciliationResult {
  const row = record(value);
  const payment = record(row.payment);
  const invoice = record(row.invoice);
  const rawStatus = text(invoice.status);
  const status = ({ brouillon: 'draft', emise: 'issued', en_retard: 'issued', partiellement_payee: 'partially_paid', payee: 'paid', annulee: 'cancelled' } as const)[rawStatus as 'brouillon' | 'emise' | 'en_retard' | 'partiellement_payee' | 'payee' | 'annulee'] ?? 'draft';
  return {
    movement: bankMovementFromRaw(row.movement),
    reconciliation: bankReconciliationFromRaw(row.reconciliation),
    payment: {
      id: text(payment.id),
      invoiceId: text(payment.invoice_id),
      date: text(payment.date),
      amountCents: integer(payment.amount_cents),
      method: text(payment.method),
      reference: text(payment.reference),
    },
    invoice: { id: text(invoice.id), number: text(invoice.number), status },
  };
}

export function filterBankMovements(movements: BankMovement[], filter: BankMovementFilter): BankMovement[] {
  return movements
    .filter((movement) => {
      if (filter === 'pending') return movement.status === 'PDNG' && !movement.reconciliation;
      if (filter === 'reconciled') return Boolean(movement.reconciliation);
      if (filter === 'unreconciled') return movement.status === 'BOOK' && !movement.reconciliation;
      return true;
    })
    .sort((left, right) => {
      const leftDate = left.bookingDate || left.valueDate || left.createdAt;
      const rightDate = right.bookingDate || right.valueDate || right.createdAt;
      return rightDate.localeCompare(leftDate) || right.createdAt.localeCompare(left.createdAt);
    });
}

export function initialInvoiceChoice(movement: BankMovement): string {
  if (!movement.suggestion.confirmable) return '';
  if (movement.suggestion.kind !== 'automatic_exact' && movement.suggestion.kind !== 'automatic_partial') return '';
  return movement.suggestion.invoiceId ?? '';
}

export function candidateForInvoice(movement: BankMovement, invoiceId: string): BankReconciliationCandidate | undefined {
  return movement.suggestion.candidates.find((candidate) => candidate.invoiceId === invoiceId);
}

export function canConfirmBankReconciliation(movement: BankMovement, invoiceId: string): boolean {
  if (!invoiceId || movement.reconciliation || movement.status !== 'BOOK' || movement.creditDebit !== 'CRDT' || movement.reversal || !movement.suggestion.confirmable) return false;
  const candidate = candidateForInvoice(movement, invoiceId);
  if (!candidate) return false;
  if (!candidate.confirmable) return false;
  if (candidate.remainingCents < Math.abs(movement.amountCents)) return false;
  return !['overpayment', 'exceeds_balance', 'greater_than_balance', 'too_high'].includes(candidate.amountRelation);
}

export function bankConfirmationPayload(movementId: string, invoiceId: string) {
  return { input: { movement_id: movementId, invoice_id: invoiceId } };
}

export function bankAccountAssociationPayload(accountId: string, currency: string) {
  return { input: { account_id: accountId, currency } };
}

export async function importCamtFromLocalDialog(
  choose: () => Promise<string | null>,
  importFile: (path: string) => Promise<CamtImportResult>,
): Promise<CamtImportResult | null> {
  const selected = await choose();
  if (!selected) return null;
  return importFile(selected);
}
