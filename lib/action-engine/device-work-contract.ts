import { createHash } from 'node:crypto';
import {
  bindingExact,
  bindingInteger,
  bindingRecord,
} from './reservation-binding';
import type { ActionActor, ReviewReason } from './types';
import { actionIdentifier, captureActor, captureProposal } from './validation';

export type DeviceWorkRequest =
  | Readonly<{
      schemaVersion: 1;
      operation: 'discover';
      limit: number;
      cursor: string | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'prepare';
      sourceId: string;
    }>;
export type DeviceWorkDiscoveredResponse = Readonly<{
  schemaVersion: 1;
  state: 'discovered';
  sourceIds: readonly string[];
  nextCursor: string | null;
}>;
export type DeviceWorkPreparedResponse = Readonly<{
  schemaVersion: 1;
  state: 'prepared';
  sourceId: string;
  proposalId: string;
  fingerprint: string;
  disposition: 'ready' | 'needs_review';
  reasons: readonly ReviewReason[];
  requiresHumanValidation: true;
}>;

/** Closed synchronous codec failure; internal malformed results are not a
 * missing proposal or an instruction to retry the model. No input is echoed. */
export class DeviceWorkProtocolError extends Error {
  constructor() {
    super('Invalid private Automation work protocol');
  }
}
const invalid = (): never => {
  throw new DeviceWorkProtocolError();
};
function bounded<T>(capture: () => T): T {
  try {
    return capture();
  } catch {
    return invalid();
  }
}
function cursor(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(raw))
    return invalid();
  // Authority/identity and canonical UTF-8 decoding stay in actual discovery.
  return raw;
}
function sourceIds(raw: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return invalid();
  const length = Object.getOwnPropertyDescriptor(raw, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(raw).length !== length + 1
  )
    return invalid();
  const result: string[] = [];
  for (let at = 0; at < length; at++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    result.push(actionIdentifier(descriptor.value));
  }
  if (new Set(result).size !== result.length) return invalid();
  return Object.freeze(result);
}

/** No actor, installation, tenant, plan, price, endpoint or generic operation. */
export function captureWorkRequest(raw: unknown): DeviceWorkRequest {
  return bounded(() => {
    const value = bindingRecord(raw);
    if (value.schemaVersion !== 1) return invalid();
    if (value.operation === 'prepare') {
      bindingExact(value, ['schemaVersion', 'operation', 'sourceId']);
      return Object.freeze({
        schemaVersion: 1,
        operation: 'prepare',
        sourceId: actionIdentifier(value.sourceId),
      });
    }
    if (
      value.operation !== 'discover' ||
      Object.keys(value).some(
        (key) =>
          !['schemaVersion', 'operation', 'limit', 'cursor'].includes(key),
      )
    )
      return invalid();
    return Object.freeze({
      schemaVersion: 1,
      operation: 'discover',
      limit: Object.hasOwn(value, 'limit')
        ? bindingInteger(value.limit, 1, 50)
        : 20,
      cursor: cursor(Object.hasOwn(value, 'cursor') ? value.cursor : null),
    });
  });
}

export function encodeDiscoveredWork(
  raw: unknown,
  limit: number,
): DeviceWorkDiscoveredResponse {
  return bounded(() => {
    const value = bindingExact(raw, ['sourceIds', 'nextCursor']);
    const ids = sourceIds(value.sourceIds, bindingInteger(limit, 1, 50));
    const next = cursor(value.nextCursor);
    if (next !== null && ids.length !== limit) return invalid();
    return Object.freeze({
      schemaVersion: 1,
      state: 'discovered',
      sourceIds: ids,
      nextCursor: next,
    });
  });
}

/** A preparation summary is not an A8 write permission or a business receipt.
 * Synchronous digest/capture avoids a new read-only await after preparation's
 * final access check. No plan, customer, price or source content is disclosed. */
export function encodePreparedWork(
  raw: unknown,
  actor: ActionActor,
  rawSourceId: string,
): DeviceWorkPreparedResponse {
  return bounded(() => {
    const captured = captureActor(actor),
      sourceId = actionIdentifier(rawSourceId);
    const proposal = captureProposal(raw, captured),
      plan = proposal.plan;
    if (
      plan.sourceId !== sourceId ||
      plan.currency !== 'CHF' ||
      createHash('sha256')
        .update(JSON.stringify(plan), 'utf8')
        .digest('hex') !== proposal.fingerprint
    )
      return invalid();
    return Object.freeze({
      schemaVersion: 1,
      state: 'prepared',
      sourceId,
      proposalId: proposal.id,
      fingerprint: proposal.fingerprint,
      disposition: plan.status,
      reasons: Object.freeze([...plan.reasons]),
      requiresHumanValidation: true,
    });
  });
}
