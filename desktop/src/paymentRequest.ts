import type { Workspace } from './types';
import type { PaymentDraft, PaymentIntent, PaymentReview } from './paymentWorkflow';
import { paymentWasRecorded, requirePaymentWorkspace } from './paymentWorkflow';
import { isSalesDate } from './salesFormValidation';
import { recordDiagnostic } from './diagnostics';

export type PaymentRequestScope = { companyId: string; organizationId?: string; memberId: string };
export type PaymentRequestInput = PaymentIntent & { expectedReview: PaymentReview };
type RetainedInput = Readonly<PaymentIntent & { expectedReview: Readonly<PaymentReview> }>;
export type PaymentRequestRecord = Readonly<{
  version: 1; scope: string; invoiceId: string; savedAt: number; variants: readonly RetainedInput[];
}>;
/** The raw snapshot is the comparison token. No variant can be edited or discarded. */
export type PaymentReceipt = Readonly<{ key: string; raw: string; record: PaymentRequestRecord }>;
export type PaymentRequestRead = { kind: 'none' } | { kind: 'pending'; receipt: PaymentReceipt } | { kind: 'blocked'; message: string };
export type PaymentRequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type PaymentRequestProof =
  | { status: 'recorded'; originalRequestId: string; canonicalPaymentId: string; wasAliased: boolean; workspaceScope: string; variantIndex: number; journalEntryId: string }
  | { status: 'absent'; originalRequestId: string; workspaceScope: string }
  | { status: 'conflict'; originalRequestId: string; workspaceScope: string };

const prefix = 'zentra.payment-request.v1.';
const maxVariants = 12;
const maxBytes = 256 * 1024;
const maxCents = 9_000_000_000_000_000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const messages = {
  scope: 'L’entreprise ou le compte ouvert a changé. Rouvrez le paiement dans son espace d’origine.',
  identity: 'L’identité de cette entreprise doit être vérifiée avant de conserver un paiement.',
  invalid: 'La demande conservée ne peut pas être vérifiée. Gardez-la et consultez l’historique avant toute nouvelle saisie.',
  read: 'La demande ne peut pas être lue sur cet appareil. Vérifiez son stockage et réessayez ; aucun paiement ne sera envoyé.',
  retain: 'La demande ne peut pas être conservée pour sa reprise. Vérifiez le stockage local avant de continuer ; aucun paiement ne sera envoyé.',
  conflict: 'La demande conservée a changé. Relisez-la et vérifiez son historique avant toute reprise.',
  occupied: 'Une autre demande est déjà conservée pour cette facture. Vérifiez son historique avant de continuer.',
  sameRequest: 'Une correction doit conserver le même identifiant de paiement et la même facture. La demande précédente reste conservée.',
  limit: 'Les 12 versions de cette demande sont conservées. Vérifiez son historique avant de continuer ; aucune version ne sera supprimée.',
  proof: 'Ce paiement et son écriture comptable ne sont pas confirmés. La demande reste conservée.',
  clear: 'Le paiement est confirmé, mais sa demande locale ne peut pas être effacée. Gardez-la et vérifiez l’historique avant toute nouvelle saisie.',
} as const;
type FailureCode = 'STORAGE' | 'CONFLICT' | 'VALIDATION';
class PaymentRequestError extends Error {
  constructor(message: string, readonly code: FailureCode) { super(message); }
}
function fail(message: string, code: FailureCode = 'CONFLICT'): never { throw new PaymentRequestError(message, code); }
function log(operation: 'read' | 'create' | 'retain' | 'assert' | 'extend' | 'confirm' | 'clear', phase: 'success' | 'failure' | 'info', code?: FailureCode) {
  // Only closed operation names and fixed codes enter diagnostics, never input or caught errors.
  recordDiagnostic({ area: 'draft', operation: `payment.request.${operation}`, phase, ...(code ? { errorCode: code } : {}) });
}
function reportFailure(operation: Parameters<typeof log>[0], cause: unknown, fallback: string): never {
  const known = cause instanceof PaymentRequestError;
  log(operation, 'failure', known ? cause.code : 'STORAGE');
  if (known) throw cause;
  throw new PaymentRequestError(fallback, 'STORAGE');
}
const storage = (provided?: PaymentRequestStorage): PaymentRequestStorage => provided ?? globalThis.localStorage;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
function boundedText(value: unknown, limit: number, required = false): value is string {
  return typeof value === 'string' && !value.includes('\0') && (!required || Boolean(value.trim())) && [...value.trim()].length <= limit;
}
function identifier(value: unknown): value is string {
  return boundedText(value, 512, true) && value === value.trim();
}

/** Verified identity only: there is deliberately no anonymous/local-user fallback. */
export function paymentRequestScopeKey(scope: PaymentRequestScope | null | undefined): string | null {
  try {
    if (!scope || !identifier(scope.companyId) || !identifier(scope.memberId) || (scope.organizationId !== undefined && !identifier(scope.organizationId))) return null;
    return JSON.stringify([scope.companyId, scope.organizationId ?? '', scope.memberId]);
  } catch { return null; }
}
function requestKey(scope: PaymentRequestScope | null | undefined, invoiceId: string): string {
  const origin = paymentRequestScopeKey(scope);
  if (!origin || !identifier(invoiceId)) fail(messages.identity, 'VALIDATION');
  return prefix + encodeURIComponent(JSON.stringify([origin, invoiceId]));
}
/** Incomplete editable drafts remain restorable; only submitted intents need a real date/amount. */
export function validPaymentDraft(value: unknown): value is PaymentDraft {
  try {
    return object(value) && keysAre(value, ['amount', 'date', 'method', 'reference', 'notes']) &&
      boundedText(value.amount, 128) && boundedText(value.date, 10) && boundedText(value.method, 80) &&
      boundedText(value.reference, 160) && boundedText(value.notes, 5000);
  } catch { return false; }
}
export function normalizePaymentRequestInput(value: unknown, invoiceId: string): PaymentRequestInput {
  if (!object(value) || !keysAre(value, ['requestId', 'invoiceId', 'amountCents', 'date', 'method', 'reference', 'notes', 'expectedReview']) ||
      value.invoiceId !== invoiceId || !identifier(invoiceId) || typeof value.requestId !== 'string' || !uuid.test(value.requestId) ||
      !Number.isSafeInteger(value.amountCents) || Number(value.amountCents) <= 0 || Number(value.amountCents) > maxCents ||
      !boundedText(value.date, 10, true) || !isSalesDate(value.date.trim()) || !boundedText(value.method, 80, true) ||
      !boundedText(value.reference, 160) || !boundedText(value.notes, 5000)) fail(messages.invalid, 'VALIDATION');
  const review = value.expectedReview;
  if (!object(review) || !keysAre(review, ['balanceCents', 'bankAccountId']) || !Number.isSafeInteger(review.balanceCents) ||
      Number(review.balanceCents) < Number(value.amountCents) || Number(review.balanceCents) > maxCents || !identifier(review.bankAccountId)) fail(messages.invalid, 'VALIDATION');
  return {
    requestId: value.requestId.toLowerCase(), invoiceId, amountCents: Number(value.amountCents), date: value.date.trim(),
    method: value.method.trim(), reference: value.reference.trim(), notes: value.notes.trim(),
    expectedReview: { balanceCents: Number(review.balanceCents), bankAccountId: review.bankAccountId },
  };
}
function parse(raw: string, key: string, origin: string, invoiceId: string): PaymentReceipt {
  if (typeof raw !== 'string' || raw.length >= maxBytes || new TextEncoder().encode(raw).length >= maxBytes) fail(messages.invalid, 'VALIDATION');
  let row: unknown;
  try { row = JSON.parse(raw); } catch { fail(messages.invalid, 'VALIDATION'); }
  if (!object(row) || !keysAre(row, ['version', 'scope', 'invoiceId', 'savedAt', 'variants']) || row.version !== 1 || row.scope !== origin ||
      row.invoiceId !== invoiceId || !Number.isSafeInteger(row.savedAt) || Number(row.savedAt) < 0 ||
      !Array.isArray(row.variants) || !row.variants.length || row.variants.length > maxVariants) fail(messages.invalid, 'VALIDATION');
  const variants = row.variants.map(value => normalizePaymentRequestInput(value, invoiceId));
  if (variants.some(value => value.requestId !== variants[0].requestId)) fail(messages.invalid, 'VALIDATION');
  for (const variant of variants) { Object.freeze(variant.expectedReview); Object.freeze(variant); }
  const record: PaymentRequestRecord = Object.freeze({ version: 1, scope: origin, invoiceId, savedAt: Number(row.savedAt), variants: Object.freeze(variants) });
  return Object.freeze({ key, raw, record });
}
function requireOrigin(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined): PaymentReceipt {
  const origin = paymentRequestScopeKey(scope);
  if (!origin) fail(messages.scope);
  if (!object(receipt) || !object(receipt.record) || receipt.record.scope !== origin || !identifier(receipt.record.invoiceId) ||
      receipt.key !== requestKey(scope, receipt.record.invoiceId) || typeof receipt.raw !== 'string') fail(messages.scope);
  const verified = parse(receipt.raw, receipt.key, origin, receipt.record.invoiceId);
  if (JSON.stringify(receipt.record) !== JSON.stringify(verified.record)) fail(messages.invalid, 'VALIDATION');
  return verified;
}
function assertSnapshot(receipt: PaymentReceipt, local: PaymentRequestStorage) {
  if (local.getItem(receipt.key) !== receipt.raw) fail(messages.conflict);
}

export function readPaymentRequest(scope: PaymentRequestScope | null | undefined, invoiceId: string, provided?: PaymentRequestStorage): PaymentRequestRead {
  try {
    const key = requestKey(scope, invoiceId), raw = storage(provided).getItem(key);
    if (raw === null) return { kind: 'none' };
    const receipt = parse(raw, key, paymentRequestScopeKey(scope)!, invoiceId);
    log('read', 'success');
    return { kind: 'pending', receipt };
  } catch (cause) {
    const known = cause instanceof PaymentRequestError;
    log('read', 'failure', known ? cause.code : 'STORAGE');
    return { kind: 'blocked', message: known ? cause.message : messages.read };
  }
}
export function createPaymentReceipt(scope: PaymentRequestScope | null | undefined, input: PaymentRequestInput, now = Date.now()): PaymentReceipt {
  try {
    const key = requestKey(scope, input.invoiceId), origin = paymentRequestScopeKey(scope)!;
    const variant = normalizePaymentRequestInput(input, input.invoiceId);
    return parse(JSON.stringify({ version: 1, scope: origin, invoiceId: input.invoiceId, savedAt: now, variants: [variant] }), key, origin, input.invoiceId);
  } catch (cause) { return reportFailure('create', cause, messages.invalid); }
}
export function retainPaymentRequest(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined, provided?: PaymentRequestStorage): void {
  try {
    const verified = requireOrigin(receipt, scope), local = storage(provided), before = local.getItem(verified.key);
    if (before !== null && before !== verified.raw) fail(messages.occupied);
    if (before === null) {
      if (local.getItem(verified.key) !== null) fail(messages.occupied);
      local.setItem(verified.key, verified.raw);
    }
    assertSnapshot(verified, local);
    log('retain', 'success');
  } catch (cause) { reportFailure('retain', cause, messages.retain); }
}
export function assertPaymentRequestCurrent(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined, provided?: PaymentRequestStorage): void {
  try { assertSnapshot(requireOrigin(receipt, scope), storage(provided)); }
  catch (cause) { reportFailure('assert', cause, messages.read); }
}
/** Append a corrected invocation while preserving the original UUID and every prior payload. */
export function extendPaymentRequest(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined, input: PaymentRequestInput, provided?: PaymentRequestStorage): PaymentReceipt {
  try {
    const verified = requireOrigin(receipt, scope), local = storage(provided);
    assertSnapshot(verified, local);
    if (!input || input.invoiceId !== verified.record.invoiceId) fail(messages.sameRequest);
    const variant = normalizePaymentRequestInput(input, verified.record.invoiceId);
    if (variant.requestId !== verified.record.variants[0].requestId || variant.invoiceId !== verified.record.invoiceId) fail(messages.sameRequest);
    if (verified.record.variants.some(previous => JSON.stringify(previous) === JSON.stringify(variant))) {
      assertSnapshot(verified, local);
      return receipt;
    }
    if (verified.record.variants.length >= maxVariants) fail(messages.limit);
    const raw = JSON.stringify({ ...verified.record, variants: [...verified.record.variants, variant] });
    const next = parse(raw, verified.key, verified.record.scope, verified.record.invoiceId);
    // localStorage has no atomic compare-and-swap. Compare immediately before writing and read back.
    assertSnapshot(verified, local);
    local.setItem(next.key, next.raw);
    assertSnapshot(next, local);
    log('extend', 'success');
    return next;
  } catch (cause) { return reportFailure('extend', cause, messages.retain); }
}
/** Validate the native proof and the freshly loaded, full workspace without removing anything. */
export function confirmPaymentRequest(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined, workspace: Workspace, proof: PaymentRequestProof, provided?: PaymentRequestStorage): boolean {
  try {
    const verified = requireOrigin(receipt, scope), local = storage(provided), originalRequestId = verified.record.variants[0].requestId;
    assertSnapshot(verified, local);
    if (!object(proof) || proof.originalRequestId !== originalRequestId || proof.workspaceScope !== scope!.companyId ||
        workspace.workNotesScope !== scope!.companyId) fail(messages.proof);
    try { requirePaymentWorkspace(workspace); } catch { fail(messages.proof); }
    if (proof.status === 'conflict') fail(messages.proof);
    if (proof.status === 'absent') {
      if (!keysAre(proof, ['status', 'originalRequestId', 'workspaceScope']) || workspace.payments.some(row => row.id === originalRequestId)) fail(messages.proof);
      assertSnapshot(verified, local);
      log('confirm', 'info');
      return false;
    }
    if (proof.status !== 'recorded' || !keysAre(proof, ['status', 'originalRequestId', 'canonicalPaymentId', 'wasAliased', 'workspaceScope', 'variantIndex', 'journalEntryId']) ||
        !identifier(proof.canonicalPaymentId) || typeof proof.wasAliased !== 'boolean' || proof.wasAliased !== (proof.canonicalPaymentId !== originalRequestId) ||
        !Number.isSafeInteger(proof.variantIndex) || proof.variantIndex < 0 || proof.variantIndex >= verified.record.variants.length || !identifier(proof.journalEntryId)) fail(messages.proof);
    const variant = verified.record.variants[proof.variantIndex];
    let recorded = false;
    try { recorded = paymentWasRecorded(workspace, { ...variant, requestId: proof.canonicalPaymentId }); } catch { fail(messages.proof); }
    const row = workspace.payments.find(value => value.id === proof.canonicalPaymentId && value.invoiceId === verified.record.invoiceId);
    if (!recorded || !row || row.journalEntryId !== proof.journalEntryId || row.journalEntryIsActive === false) fail(messages.proof);
    assertSnapshot(verified, local);
    log('confirm', 'success');
    return true;
  } catch (cause) { return reportFailure('confirm', cause, messages.read); }
}
/** Cleanup requires an exact accounting proof, then another exact snapshot comparison. */
export function clearConfirmedPaymentRequest(receipt: PaymentReceipt, scope: PaymentRequestScope | null | undefined, workspace: Workspace, proof: PaymentRequestProof, provided?: PaymentRequestStorage): void {
  try {
    if (!confirmPaymentRequest(receipt, scope, workspace, proof, provided)) fail(messages.proof);
    const verified = requireOrigin(receipt, scope), local = storage(provided);
    assertSnapshot(verified, local);
    local.removeItem(verified.key);
    if (local.getItem(verified.key) !== null) fail(messages.clear, 'STORAGE');
    log('clear', 'success');
  } catch (cause) { reportFailure('clear', cause, messages.clear); }
}
