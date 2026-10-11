import { createHash } from 'node:crypto';
import type { QuoteConfirmationInput } from './device-confirmation';
import type { DeviceQuoteReservationResult } from './device-reservation';
import { QuoteLedgerError } from './ledger-types';
import {
  bindingExact,
  bindingHash,
  bindingInteger,
  bindingRecord,
  bindingUuid,
  captureQuoteReservationBinding,
} from './reservation-binding';
import type { ActionActor, ActionSource, DraftQuoteReceipt } from './types';
import {
  actionIdentifier,
  captureActor,
  captureProposal,
  validatePlanningContext,
} from './validation';

export type DeviceExecutionReserveRequest = Readonly<{
  schemaVersion: 1;
  operation: 'reserve';
  sourceId: string;
  proposalId: string;
}>;
export type DeviceExecutionConfirmRequest = Readonly<
  QuoteConfirmationInput & { schemaVersion: 1; operation: 'confirm' }
>;
export type DeviceExecutionRequest =
  | DeviceExecutionReserveRequest
  | DeviceExecutionConfirmRequest;
export type DeviceExecutionReservedResponse = Readonly<{
  schemaVersion: 1;
  state: 'reserved';
  canonicalPlanJson: string;
  proposalId: string;
  fingerprint: string;
  reservationId: string;
  source: ActionSource;
  actor: ActionActor;
  installationId: string;
  expectedResourcesHash: string;
  expectedContextRevision: string;
  customerId: string;
  quoteId: string;
  authorizationRevision: string;
}>;
export type DeviceExecutionReservationResponse =
  | DeviceExecutionReservedResponse
  | Readonly<{ schemaVersion: 1; state: 'held'; proposalId: string }>
  | Readonly<{
      schemaVersion: 1;
      state: 'recovery_required';
      proposalId: string;
      reservationId: string;
      fingerprint: string;
    }>
  // A8 historical confirmation has no publication/reservation selectors.
  // Rust must recover its local candidate and call A7 before local ACK.
  | Readonly<{
      schemaVersion: 1;
      state: 'confirmed';
      receipt: DraftQuoteReceipt;
    }>;
export type DeviceExecutionConfirmationResponse = Readonly<
  QuoteConfirmationInput & {
    schemaVersion: 1;
    state: 'confirmed';
    receipt: DraftQuoteReceipt;
  }
>;

const sourceKeys = [
  'id',
  'revision',
  'organizationId',
  'senderEmail',
  'senderName',
  'subject',
  'body',
] as const;
const confirmationKeys = [
  'sourceId',
  'proposalId',
  'reservationId',
  'publicationSnapshotId',
] as const;
const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** No caller-controlled getter/coercion error or source content escapes this codec. */
function bounded<T>(capture: () => T): T {
  try {
    return capture();
  } catch {
    return invalid();
  }
}
function serializable(value: string): void {
  for (const point of value) {
    const code = point.charCodeAt(0);
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff)
      return invalid();
  }
}
function captureConfirmation(raw: unknown): QuoteConfirmationInput {
  const v = bindingExact(raw, confirmationKeys);
  return Object.freeze({
    sourceId: actionIdentifier(v.sourceId),
    proposalId: actionIdentifier(v.proposalId),
    reservationId: bindingUuid(v.reservationId),
    publicationSnapshotId: bindingUuid(v.publicationSnapshotId),
  });
}
function captureWireReceipt(raw: unknown): DraftQuoteReceipt {
  const v = bindingExact(raw, [
    'organizationId',
    'proposalId',
    'fingerprint',
    'customerId',
    'quoteId',
    'quoteNumber',
    'status',
    'requiresHumanValidation',
  ]);
  if (
    v.quoteNumber !== null ||
    v.status !== 'draft' ||
    v.requiresHumanValidation !== true
  )
    return invalid();
  return Object.freeze({
    organizationId: actionIdentifier(v.organizationId),
    proposalId: actionIdentifier(v.proposalId),
    fingerprint: bindingHash(v.fingerprint),
    customerId: actionIdentifier(v.customerId),
    quoteId: bindingUuid(v.quoteId),
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  });
}

/** Private wire DTO only. Authentication/permissions never come from this body.
 * The caller separately bounds/parses raw JSON (including duplicate-key checks).
 */
export function captureRequest(raw: unknown): DeviceExecutionRequest {
  return bounded(() => {
    const v = bindingRecord(raw);
    if (v.schemaVersion !== 1) return invalid();
    if (v.operation === 'reserve') {
      bindingExact(v, ['schemaVersion', 'operation', 'sourceId', 'proposalId']);
      return Object.freeze({
        schemaVersion: 1,
        operation: 'reserve',
        sourceId: actionIdentifier(v.sourceId),
        proposalId: actionIdentifier(v.proposalId),
      });
    }
    if (v.operation === 'confirm') {
      bindingExact(v, ['schemaVersion', 'operation', ...confirmationKeys]);
      const confirmation = captureConfirmation({
        sourceId: v.sourceId,
        proposalId: v.proposalId,
        reservationId: v.reservationId,
        publicationSnapshotId: v.publicationSnapshotId,
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: 'confirm',
        ...confirmation,
      });
    }
    return invalid();
  });
}

/** Pure synchronous projection of the real A8 result, after its final SQL fence.
 * SHA checks add no asynchronous interval and confer no authority. The physical
 * workspace scope/member nonce are captured locally by Rust, never by this DTO.
 */
export function encodeReservation(
  raw: DeviceQuoteReservationResult,
): DeviceExecutionReservationResponse {
  return bounded(() => {
    const v = bindingRecord(raw);
    if (v.state === 'held') {
      bindingExact(v, ['state', 'proposalId']);
      return Object.freeze({
        schemaVersion: 1,
        state: 'held',
        proposalId: actionIdentifier(v.proposalId),
      });
    }
    if (v.state === 'recovery_required') {
      bindingExact(v, ['state', 'proposalId', 'reservationId', 'fingerprint']);
      return Object.freeze({
        schemaVersion: 1,
        state: 'recovery_required',
        proposalId: actionIdentifier(v.proposalId),
        reservationId: bindingUuid(v.reservationId),
        fingerprint: bindingHash(v.fingerprint),
      });
    }
    if (v.state === 'confirmed') {
      bindingExact(v, ['state', 'receipt']);
      return Object.freeze({
        schemaVersion: 1,
        state: 'confirmed',
        receipt: captureWireReceipt(v.receipt),
      });
    }
    if (v.state !== 'reserved') return invalid();
    bindingExact(v, [
      'state',
      'actor',
      'installationId',
      'authorizationRevision',
      'proposal',
      'canonicalPlanJson',
      'reservation',
      'binding',
      'source',
    ]);
    const actor = captureActor(v.actor),
      installationId = bindingUuid(v.installationId),
      authorizationRevision = actionIdentifier(v.authorizationRevision),
      proposal = captureProposal(v.proposal, actor),
      plan = proposal.plan,
      binding = captureQuoteReservationBinding(v.binding),
      r = bindingExact(v.reservation, [
        'id',
        'organizationId',
        'proposalId',
        'fingerprint',
        'userId',
        'installationId',
        'customerId',
        'quoteId',
        'createdAt',
        'receipt',
      ]);
    const reservationId = bindingUuid(r.id),
      customerId = actionIdentifier(r.customerId),
      quoteId = bindingUuid(r.quoteId);
    bindingInteger(r.createdAt, 1, 253402300799);
    if (
      r.organizationId !== actor.organizationId ||
      r.proposalId !== proposal.id ||
      r.fingerprint !== proposal.fingerprint ||
      r.userId !== actor.userId ||
      r.installationId !== installationId ||
      r.receipt !== null ||
      binding.planningPublication.organizationId !== actor.organizationId ||
      plan.status !== 'ready' ||
      plan.currency !== 'CHF' ||
      !plan.customer
    )
      return invalid();
    if (plan.customer.kind === 'existing') {
      if (customerId !== plan.customer.id) return invalid();
    } else bindingUuid(customerId);
    if (
      typeof v.canonicalPlanJson !== 'string' ||
      v.canonicalPlanJson.length > 65_536 ||
      new TextEncoder().encode(v.canonicalPlanJson).byteLength > 65_536 ||
      v.canonicalPlanJson !== JSON.stringify(plan) ||
      digest(v.canonicalPlanJson) !== proposal.fingerprint
    )
      return invalid();
    const sourceRaw = bindingExact(v.source, sourceKeys),
      source = validatePlanningContext({
        organizationId: actor.organizationId,
        revision: plan.contextRevision,
        currency: plan.currency,
        source: sourceRaw,
        customers: [],
        articles: [],
      }).source;
    // No normalization of already-bound facts, including email case/whitespace.
    if (
      sourceKeys.some((key) => sourceRaw[key] !== source[key]) ||
      source.body.length > 3000 ||
      source.id !== plan.sourceId ||
      source.revision !== plan.sourceRevision ||
      plan.title !== (source.subject.trim().slice(0, 160) || 'Quote') ||
      digest(JSON.stringify(source)) !== binding.sourceCanonicalSha256 ||
      (plan.customer.kind === 'new' &&
        (plan.customer.name !== source.senderName.trim() ||
          plan.customer.email !== source.senderEmail))
    )
      return invalid();
    const evidence = new Set<string>();
    for (const line of plan.lines) {
      if (
        line.evidence.length > 600 ||
        !source.body.includes(line.evidence) ||
        evidence.has(line.evidence)
      )
        return invalid();
      evidence.add(line.evidence);
      serializable(line.description);
      serializable(line.unit);
      serializable(line.evidence);
    }
    for (const value of Object.values(source)) serializable(value);
    serializable(plan.title);
    serializable(plan.customer.name);
    return Object.freeze({
      schemaVersion: 1,
      state: 'reserved',
      canonicalPlanJson: v.canonicalPlanJson,
      proposalId: proposal.id,
      fingerprint: proposal.fingerprint,
      reservationId,
      source,
      actor,
      installationId,
      expectedResourcesHash: binding.resourcesSha256,
      expectedContextRevision: plan.contextRevision,
      customerId,
      quoteId,
      authorizationRevision,
    });
  });
}

/** Called only after the real A7 confirmation succeeds for these selectors.
 * The receipt itself cannot prove source/reservation/publication identity;
 * echoing the captured selectors is correlation, never a new publication proof.
 */
export function encodeConfirmation(
  rawInput: QuoteConfirmationInput,
  rawReceipt: DraftQuoteReceipt,
): DeviceExecutionConfirmationResponse {
  return bounded(() => {
    const input = captureConfirmation(rawInput),
      receipt = captureWireReceipt(rawReceipt);
    if (receipt.proposalId !== input.proposalId) return invalid();
    return Object.freeze({
      schemaVersion: 1,
      state: 'confirmed',
      ...input,
      receipt,
    });
  });
}
