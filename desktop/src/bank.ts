import type {
  BankImport,
  BankMovement,
  BankRefundMatch,
  BankReconciliation,
  BankReconciliationCandidate,
  BankReconciliationSuggestion,
  BankReconciliationResult,
  BankSupplierReconciliation,
  BankSupplierReconciliationCandidate,
  BankSupplierReconciliationResult,
  BankSupplierReconciliationSuggestion,
  BankSupplierSuggestionKind,
  BankSuggestionKind,
  BankWorkspace,
  CamtImportResult,
  Client,
  Invoice,
  Supplier,
  SupplierInvoice,
} from './types';

export type BankMovementFilter = 'unreconciled' | 'pending' | 'reconciled' | 'all';
export type BankCandidateMatch = {
  candidate: BankReconciliationCandidate;
  invoiceNumber: string;
  invoiceTitle: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
};
export type BankSupplierCandidateMatch = {
  candidate: BankSupplierReconciliationCandidate;
  supplierName: string;
  supplierIban: string;
  invoiceReference: string;
  documentDate: string;
  dueDate: string;
};
type RawRecord = Record<string, unknown>;

const record = (value: unknown): RawRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {};
const array = (value: unknown): RawRecord[] => Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1';

function refundMatchFromRaw(row: RawRecord): BankRefundMatch {
  return { id: text(row.id), refundId: text(row.refund_id), expenseId: text(row.expense_id), reference: text(row.reference), supplier: text(row.supplier), amountCents: integer(row.amount_cents), paymentDate: text(row.payment_date), paymentJournalId: text(row.payment_journal_id), confirmedAt: text(row.confirmed_at), dateDifferenceReason: text(row.date_difference_reason) || undefined };
}

const suggestionKinds = new Set<BankSuggestionKind>(['automatic_exact', 'automatic_partial', 'manual', 'review', 'none']);
const supplierSuggestionKinds = new Set<BankSupplierSuggestionKind>(['supplier_match', 'supplier_manual', 'review', 'none']);

const emptyCustomerSuggestion = (): BankReconciliationSuggestion => ({
  kind: 'none',
  invoiceId: null,
  invoiceNumber: null,
  reason: '',
  confirmable: false,
  candidates: [],
});

const emptySupplierSuggestion = (): BankSupplierReconciliationSuggestion => ({
  entityType: 'supplier_invoice',
  kind: 'none',
  supplierInvoiceId: null,
  reason: '',
  confirmable: false,
  requiresConfirmation: true,
  candidates: [],
});

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

export function bankSupplierReconciliationFromRaw(value: unknown): BankSupplierReconciliation {
  const row = record(value);
  return {
    id: text(row.id),
    movementId: text(row.movement_id),
    supplierInvoiceId: text(row.supplier_invoice_id),
    supplierPaymentId: text(row.supplier_payment_id),
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

function supplierCandidateFromRaw(value: unknown): BankSupplierReconciliationCandidate {
  const row = record(value);
  return {
    supplierInvoiceId: text(row.supplier_invoice_id),
    supplierId: text(row.supplier_id),
    supplierName: text(row.supplier_name),
    supplierIban: text(row.supplier_iban),
    reference: text(row.reference),
    documentDate: text(row.document_date),
    remainingCents: integer(row.remaining_cents),
    amountRelation: text(row.amount_relation),
    matchKind: text(row.match_kind),
    reason: text(row.reason),
    confirmable: bool(row.confirmable),
  };
}

function supplierSuggestionFromRaw(value: unknown): BankSupplierReconciliationSuggestion {
  const row = record(value);
  const candidateKind = text(row.kind) as BankSupplierSuggestionKind;
  return {
    entityType: 'supplier_invoice',
    kind: supplierSuggestionKinds.has(candidateKind) ? candidateKind : 'none',
    supplierInvoiceId: text(row.supplier_invoice_id) || null,
    reason: text(row.reason),
    confirmable: bool(row.confirmable),
    requiresConfirmation: row.requires_confirmation === undefined ? true : bool(row.requires_confirmation),
    candidates: array(row.candidates).map(supplierCandidateFromRaw).filter((item) => item.supplierInvoiceId),
  };
}

export function bankMovementFromRaw(value: unknown): BankMovement {
  const row = record(value);
  const reconciliation = record(row.reconciliation);
  const supplierReconciliation = record(row.supplier_reconciliation);
  const creditDebit = text(row.credit_debit);
  const customerRawSuggestion = row.customer_suggestion ?? (creditDebit === 'DBIT' ? undefined : row.suggestion);
  const supplierRawSuggestion = row.supplier_suggestion ?? (creditDebit === 'DBIT' ? row.suggestion : undefined);
  return {
    id: text(row.id),
    importId: text(row.import_id),
    accountId: text(row.account_id),
    accountCurrency: text(row.account_currency),
    amountCents: integer(row.amount_cents),
    currency: text(row.currency) || text(row.account_currency) || 'CHF',
    creditDebit,
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
    counterpartyName: text(row.counterparty_name) || text(row.debtor_name) || text(row.creditor_name),
    counterpartyIban: text(row.counterparty_iban) || text(row.creditor_iban),
    strongKey: text(row.strong_key),
    createdAt: text(row.created_at),
    reconciliation: Object.keys(reconciliation).length ? bankReconciliationFromRaw(reconciliation) : null,
    supplierReconciliation: Object.keys(supplierReconciliation).length ? bankSupplierReconciliationFromRaw(supplierReconciliation) : null,
    expenseReconciliation: Object.keys(record(row.expense_reconciliation)).length ? {
      id: text(record(row.expense_reconciliation).id), expenseId: text(record(row.expense_reconciliation).expense_id),
      ...(text(record(row.expense_reconciliation).reference) ? {reference: text(record(row.expense_reconciliation).reference)} : {}),
      ...(text(record(row.expense_reconciliation).supplier) ? {supplier: text(record(row.expense_reconciliation).supplier)} : {}),
      journalEntryId: text(record(row.expense_reconciliation).journal_entry_id), confirmedAt: text(record(row.expense_reconciliation).confirmed_at),
      ...(text(record(row.expense_reconciliation).date_difference_reason) ? { dateDifferenceReason: text(record(row.expense_reconciliation).date_difference_reason) } : {}),
    } : null,
    refundMatch: Object.keys(record(row.refund_match)).length ? refundMatchFromRaw(record(row.refund_match)) : null,
    refundHistory: array(row.refund_history).map((entry) => ({ ...refundMatchFromRaw(entry), reason: text(entry.reason), unlinkedAt: text(entry.unlinked_at) })),
    refundSuggestion: { canCreate: bool(record(row.refund_suggestion).can_create), reason: text(record(row.refund_suggestion).reason), candidates: array(record(row.refund_suggestion).candidates).map((candidate) => ({ refundId: text(candidate.refund_id), expenseId: text(candidate.expense_id), reference: text(candidate.reference), expenseReference: text(candidate.expense_reference), supplier: text(candidate.supplier), paymentDate: text(candidate.payment_date), totalCents: integer(candidate.total_cents), requiresDateReason: bool(candidate.requires_date_reason), confirmable: bool(candidate.confirmable), reason: text(candidate.reason) })) },
    expenseSuggestion: {
      canCreate: record(row.expense_suggestion).can_create === true,
      reason: text(record(row.expense_suggestion).reason),
      candidates: array(record(row.expense_suggestion).candidates).map((candidate) => ({
        expenseId: text(candidate.expense_id), supplier: text(candidate.supplier), reference: text(candidate.reference), category: text(candidate.category),
        date: text(candidate.date), paymentStatus: text(candidate.payment_status) === 'paid' ? 'paid' : 'pending',
        paidAt: text(candidate.paid_at), requiresDateReason: bool(candidate.requires_date_reason),
        totalCents: integer(candidate.total_cents), confirmable: bool(candidate.confirmable), reason: text(candidate.reason),
      })),
    },
    expenseHistory: array(row.expense_history).map((entry) => ({dateDifferenceReason:text(entry.date_difference_reason),id:text(entry.id),expenseId:text(entry.expense_id),reference:text(entry.reference),supplier:text(entry.supplier),amountCents:integer(entry.amount_cents),confirmedAt:text(entry.confirmed_at),unlinkedAt:text(entry.unlinked_at),reason:text(entry.reason)})),
    suggestion: customerRawSuggestion === undefined ? emptyCustomerSuggestion() : suggestionFromRaw(customerRawSuggestion),
    supplierSuggestion: supplierRawSuggestion === undefined ? emptySupplierSuggestion() : supplierSuggestionFromRaw(supplierRawSuggestion),
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
    importedCount: integer(row.imported_count),
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
      unreconciledSupplierCount: integer(summary.unreconciled_supplier_count),
      pendingCount: integer(summary.pending_count),
      bookedCreditCount: integer(summary.booked_credit_count),
      bookedDebitCount: integer(summary.booked_debit_count),
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
    supplierReconciliations: array(row.supplier_reconciliations).map(bankSupplierReconciliationFromRaw),
  };
}

export function camtImportResultFromRaw(value: unknown): CamtImportResult {
  const row = record(value);
  const automatic = record(row.automatic_reconciliation);
  return {
    duplicate: bool(row.duplicate),
    import: bankImportFromRaw(row.import),
    importedCount: integer(row.imported_count),
    skippedDuplicateCount: integer(row.skipped_duplicate_count),
    ignoredCount: integer(row.ignored_count),
    warnings: Array.isArray(row.warnings) ? row.warnings.map(text).filter(Boolean) : [],
    automaticReconciliation: {
      enabled: bool(automatic.enabled), paidCount: integer(automatic.paid_count),
      partialCount: integer(automatic.partial_count), reviewCount: integer(automatic.review_count),
      failures: Array.isArray(automatic.failures) ? automatic.failures.map(text).filter(Boolean) : [],
    },
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

export function bankSupplierReconciliationResultFromRaw(value: unknown): BankSupplierReconciliationResult {
  const row = record(value);
  const payment = record(row.payment);
  const invoice = record(row.supplier_invoice);
  const totalCents = integer(invoice.total_cents);
  const paidCents = Math.max(0, Math.min(totalCents, integer(invoice.paid_cents)));
  const creditedCents = Math.max(0, Math.min(totalCents, integer(invoice.credited_cents)));
  const supplierReconciliation = bankSupplierReconciliationFromRaw(row.supplier_reconciliation);
  const movement = bankMovementFromRaw(row.movement);
  movement.supplierReconciliation = supplierReconciliation.id ? supplierReconciliation : null;
  return {
    movement,
    supplierReconciliation,
    payment: {
      id: text(payment.id),
      supplierInvoiceId: text(payment.supplier_invoice_id),
      requestId: text(payment.request_id),
      date: text(payment.date),
      amountCents: integer(payment.amount_cents),
      method: text(payment.method),
      reference: text(payment.reference),
      notes: text(payment.notes),
      journalEntryId: text(payment.journal_entry_id),
      createdAt: text(payment.created_at),
    },
    supplierInvoice: {
      id: text(invoice.id),
      supplierId: text(invoice.supplier_id),
      reference: text(invoice.reference),
      documentStatus: text(invoice.status) === 'validated' ? 'validated' : 'draft',
      totalCents,
      paidCents,
      creditedCents,
      balanceCents: Math.max(0, totalCents - paidCents - creditedCents),
    },
    idempotent: bool(row.idempotent),
  };
}

export function movementHasReconciliation(movement: BankMovement): boolean {
  return Boolean(movement.reconciliation || movement.supplierReconciliation || movement.expenseReconciliation || movement.refundMatch);
}

export function filterBankMovements(movements: BankMovement[], filter: BankMovementFilter, query = ''): BankMovement[] {
  const needle = normalizedCandidateQuery(query);
  const compactNeedle = needle.replace(/[\s\p{P}]/gu, '');
  return movements
    .filter((movement) => {
      if (!needle) return true;
      const amount = (Math.abs(movement.amountCents) / 100).toFixed(2);
      const searchable = normalizedCandidateQuery([movement.counterpartyName, movement.unstructured, movement.reference, movement.accountId, movement.counterpartyIban, movement.bookingDate, movement.valueDate, amount, amount.replace('.', ','), movement.currency, movement.expenseReconciliation?.reference, movement.expenseReconciliation?.supplier, movement.refundMatch?.reference, movement.refundMatch?.supplier, ...(movement.refundHistory ?? []).flatMap((entry) => [entry.reference,entry.supplier,entry.reason]), ...(movement.expenseHistory ?? []).flatMap((entry) => [entry.reference,entry.supplier,entry.reason])].join(' '));
      const identifiers = [movement.reference, movement.accountId, movement.counterpartyIban, movement.expenseReconciliation?.reference, movement.refundMatch?.reference, ...(movement.refundHistory ?? []).map((entry) => entry.reference), ...(movement.expenseHistory ?? []).map((entry) => entry.reference)];
      return searchable.includes(needle) || (Boolean(compactNeedle) && identifiers.some((value) => normalizedCandidateQuery(value || '').replace(/[\s\p{P}]/gu, '').includes(compactNeedle)));
    })
    .filter((movement) => {
      if (filter === 'pending') return movement.status === 'PDNG' && !movementHasReconciliation(movement);
      if (filter === 'reconciled') return movementHasReconciliation(movement);
      if (filter === 'unreconciled') return movement.status === 'BOOK' && ['CRDT', 'DBIT'].includes(movement.creditDebit) && !movement.reversal && !movementHasReconciliation(movement);
      return true;
    })
    .sort((left, right) => {
      const leftDate = left.bookingDate || left.valueDate || left.createdAt;
      const rightDate = right.bookingDate || right.valueDate || right.createdAt;
      return rightDate.localeCompare(leftDate) || right.createdAt.localeCompare(left.createdAt);
    });
}

export function initialInvoiceChoice(movement: BankMovement): string {
  if (movement.creditDebit !== 'CRDT' || movementHasReconciliation(movement)) return '';
  if (!movement.suggestion.confirmable) return '';
  if (movement.suggestion.kind !== 'automatic_exact' && movement.suggestion.kind !== 'automatic_partial') return '';
  return movement.suggestion.invoiceId ?? '';
}

export function initialSupplierInvoiceChoice(movement: BankMovement): string {
  if (movement.creditDebit !== 'DBIT' || movementHasReconciliation(movement)) return '';
  if (!movement.supplierSuggestion.confirmable || !movement.supplierSuggestion.requiresConfirmation) return '';
  if (movement.supplierSuggestion.kind !== 'supplier_match') return '';
  return movement.supplierSuggestion.supplierInvoiceId ?? '';
}

export function candidateForInvoice(movement: BankMovement, invoiceId: string): BankReconciliationCandidate | undefined {
  return movement.suggestion.candidates.find((candidate) => candidate.invoiceId === invoiceId);
}

export function candidateForSupplierInvoice(movement: BankMovement, supplierInvoiceId: string): BankSupplierReconciliationCandidate | undefined {
  return movement.supplierSuggestion.candidates.find((candidate) => candidate.supplierInvoiceId === supplierInvoiceId);
}

function normalizedCandidateQuery(value: string): string {
  return value.trim().toLocaleLowerCase('fr-CH').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/\s+/g, ' ');
}

export function filterBankCandidates(
  movement: BankMovement,
  invoices: Invoice[],
  clients: Client[],
  query: string,
): BankCandidateMatch[] {
  const normalizedQuery = normalizedCandidateQuery(query);
  return movement.suggestion.candidates.map((candidate) => {
    const invoice = invoices.find((item) => item.id === candidate.invoiceId);
    const client = invoice ? clients.find((item) => item.id === invoice.clientId) : undefined;
    return {
      candidate,
      invoiceNumber: candidate.invoiceNumber || invoice?.number || candidate.invoiceId,
      invoiceTitle: invoice?.title || '',
      clientName: client?.company || client?.name || 'Client non renseigné',
      issueDate: invoice?.issueDate || '',
      dueDate: invoice?.dueDate || '',
    };
  }).filter((item) => {
    if (!normalizedQuery) return true;
    const decimal = (item.candidate.remainingCents / 100).toFixed(2);
    const searchable = normalizedCandidateQuery([
      item.invoiceNumber,
      item.invoiceTitle,
      item.clientName,
      item.candidate.remainingCents,
      decimal,
      decimal.replace('.', ','),
      `${decimal} ${movement.currency}`,
    ].join(' '));
    return searchable.includes(normalizedQuery);
  });
}

export function filterBankSupplierCandidates(
  movement: BankMovement,
  invoices: SupplierInvoice[],
  suppliers: Supplier[],
  query: string,
): BankSupplierCandidateMatch[] {
  const normalizedQuery = normalizedCandidateQuery(query);
  return movement.supplierSuggestion.candidates.map((candidate) => {
    const invoice = invoices.find((item) => item.id === candidate.supplierInvoiceId);
    const supplier = suppliers.find((item) => item.id === (candidate.supplierId || invoice?.supplierId));
    return {
      candidate,
      supplierName: candidate.supplierName || invoice?.supplierName || supplier?.name || 'Fournisseur non renseigné',
      supplierIban: candidate.supplierIban || supplier?.iban || '',
      invoiceReference: candidate.reference || invoice?.reference || candidate.supplierInvoiceId,
      documentDate: candidate.documentDate || invoice?.documentDate || '',
      dueDate: invoice?.dueDate || '',
    };
  }).filter((item) => {
    if (!normalizedQuery) return true;
    const decimal = (item.candidate.remainingCents / 100).toFixed(2);
    const searchable = normalizedCandidateQuery([
      item.invoiceReference,
      item.supplierName,
      item.supplierIban,
      item.documentDate,
      item.dueDate,
      item.candidate.matchKind,
      item.candidate.remainingCents,
      decimal,
      decimal.replace('.', ','),
      `${decimal} ${movement.currency}`,
    ].join(' '));
    return searchable.includes(normalizedQuery);
  });
}

export function canConfirmBankReconciliation(movement: BankMovement, invoiceId: string): boolean {
  if (!invoiceId || movementHasReconciliation(movement) || movement.status !== 'BOOK' || movement.creditDebit !== 'CRDT' || movement.reversal || !movement.suggestion.confirmable) return false;
  const candidate = candidateForInvoice(movement, invoiceId);
  if (!candidate) return false;
  if (!candidate.confirmable) return false;
  if (candidate.remainingCents < Math.abs(movement.amountCents)) return false;
  return !['overpayment', 'exceeds_balance', 'greater_than_balance', 'too_high'].includes(candidate.amountRelation);
}

export function canConfirmSupplierBankReconciliation(movement: BankMovement, supplierInvoiceId: string): boolean {
  if (!supplierInvoiceId || movementHasReconciliation(movement) || movement.status !== 'BOOK' || movement.creditDebit !== 'DBIT' || movement.reversal || !movement.supplierSuggestion.confirmable || !movement.supplierSuggestion.requiresConfirmation) return false;
  const candidate = candidateForSupplierInvoice(movement, supplierInvoiceId);
  if (!candidate?.confirmable || candidate.remainingCents < Math.abs(movement.amountCents)) return false;
  return !['overpayment', 'exceeds_balance', 'greater_than_balance', 'too_high', 'already_paid', 'currency_mismatch'].includes(candidate.amountRelation);
}

export function bankConfirmationPayload(movementId: string, invoiceId: string) {
  return { input: { movement_id: movementId, invoice_id: invoiceId } };
}

export function supplierBankConfirmationPayload(movementId: string, supplierInvoiceId: string) {
  return { input: { movement_id: movementId, supplier_invoice_id: supplierInvoiceId } };
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
