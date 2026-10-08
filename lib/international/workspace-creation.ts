import { validateCompanyConfiguration } from './country-config';
import { publicCompanyConfiguration } from './public-projection';
import type { CompanyConfiguration } from './types';

export const creationConfirmationVersion = 1 as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class WorkspaceCreationError extends Error {
  constructor(readonly code: 'invalid_request' | 'request_id_conflict' | 'workspace_not_new' | 'not_found' | 'service_unavailable', readonly status: number) { super(code); }
}
export function creationUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new WorkspaceCreationError('invalid_request', 422);
  return value;
}
/** Only validated JSON objects with ASCII field names enter this serializer. */
export function canonicalCreationJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalCreationJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalCreationJson((value as Record<string, unknown>)[key])).join(',') + '}';
  if (typeof value === 'string' && !value.isWellFormed()) throw new WorkspaceCreationError('invalid_request', 422);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new WorkspaceCreationError('invalid_request', 422);
  return encoded;
}
export interface WorkspaceCreationRequest {
  readonly requestId: string;
  readonly confirmationVersion: 1;
  readonly companyName: string;
  readonly configuration: Omit<CompanyConfiguration, 'organizationId'>;
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new WorkspaceCreationError('invalid_request', 422);
  const fields = value as Record<string, unknown>;
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !keys.includes(key))) throw new WorkspaceCreationError('invalid_request', 422);
  return fields;
}
export function validateWorkspaceCreationRequest(value: unknown): WorkspaceCreationRequest {
  const fields = exactObject(value, ['requestId', 'confirmationVersion', 'companyName', 'configuration']);
  const requestId = creationUuid(fields.requestId);
  if (fields.confirmationVersion !== creationConfirmationVersion || typeof fields.companyName !== 'string' || !fields.companyName || fields.companyName.length > 160 || fields.companyName !== fields.companyName.trim() || Array.from(fields.companyName).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new WorkspaceCreationError('invalid_request', 422);
  const submitted = exactObject(fields.configuration, ['schemaVersion', 'country', 'currency', 'language', 'timeZone', 'address', 'ein', 'accountingBasis', 'invoiceNumberPrefix', 'taxConfiguration']);
  let configuration: CompanyConfiguration;
  try { configuration = validateCompanyConfiguration({ ...submitted, organizationId: 'new-workspace' }); }
  catch { throw new WorkspaceCreationError('invalid_request', 422); }
  if (configuration.country !== 'US' || configuration.currency !== 'USD' || configuration.taxConfiguration.status !== 'unconfigured') throw new WorkspaceCreationError('invalid_request', 422);
  const { organizationId: _reserved, ...withoutId } = configuration;
  const request = { requestId, confirmationVersion: 1 as const, companyName: fields.companyName, configuration: withoutId };
  canonicalCreationJson(request); // Reject malformed UTF-16 before reserving durable state.
  return request;
}
export interface WorkspaceCreationIntent {
  readonly creationId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly confirmationVersion: 1;
  readonly companyName: string;
  readonly fingerprint: string;
  readonly configuration: CompanyConfiguration;
  readonly state: 'reserved' | 'postgres_confirmed';
  readonly receipt: WorkspaceCreationReceipt | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface WorkspaceCreationReceipt {
  readonly creationId: string; readonly organizationId: string; readonly actorUserId: string;
  readonly requestId: string; readonly configurationFingerprint: string;
  readonly configuration: CompanyConfiguration; readonly revision: 1;
  readonly updatedBy: string; readonly updatedAt: string; readonly replayed: boolean;
}
export interface WorkspaceCreationStore {
  find(this: void, actorUserId: string, requestId: string): Promise<WorkspaceCreationIntent | null>;
  reserve(this: void, candidate: WorkspaceCreationIntent): Promise<WorkspaceCreationIntent>;
  confirm(this: void, intent: WorkspaceCreationIntent, receipt: WorkspaceCreationReceipt, timestamp: string): Promise<WorkspaceCreationIntent>;
}
export interface WorkspaceCreationPorts {
  readonly store: WorkspaceCreationStore;
  allocateId(this: void): string;
  now(this: void): string;
  fingerprint(this: void, input: string): Promise<string>;
  admit(this: void, intent: WorkspaceCreationIntent): Promise<unknown>;
  /** Must recheck the feature and the same authenticated creator immediately before writes. */
  revalidate(this: void): Promise<void>;
}
export function validateCreationReceipt(value: unknown, intent: WorkspaceCreationIntent): WorkspaceCreationReceipt {
  try {
    const fields = exactObject(value, ['creationId','organizationId','actorUserId','requestId','configurationFingerprint','configuration','revision','updatedBy','updatedAt','replayed']);
    const configuration = validateCompanyConfiguration(fields.configuration);
    if (fields.creationId !== intent.creationId || fields.organizationId !== intent.organizationId || fields.actorUserId !== intent.actorUserId || fields.requestId !== intent.requestId || fields.configurationFingerprint !== intent.fingerprint || fields.updatedBy !== intent.actorUserId || fields.revision !== 1 || typeof fields.replayed !== 'boolean' || typeof fields.updatedAt !== 'string' || !Number.isFinite(Date.parse(fields.updatedAt)) || canonicalCreationJson(configuration) !== canonicalCreationJson(intent.configuration)) throw new Error('Invalid receipt');
    return { creationId: intent.creationId, organizationId: intent.organizationId, actorUserId: intent.actorUserId, requestId: intent.requestId, configurationFingerprint: intent.fingerprint, configuration, revision: 1, updatedBy: intent.actorUserId, updatedAt: fields.updatedAt, replayed: fields.replayed };
  } catch { throw new WorkspaceCreationError('service_unavailable', 503); }
}
/** No organization, owner membership, subscription or business entitlement is fabricated here. */
export async function createOrResumeUsWorkspace(actorUserId: string, request: WorkspaceCreationRequest, ports: WorkspaceCreationPorts): Promise<WorkspaceCreationIntent> {
  creationUuid(actorUserId);
  request = validateWorkspaceCreationRequest(request);
  const fingerprint = await ports.fingerprint(canonicalCreationJson({ confirmationVersion: request.confirmationVersion, companyName: request.companyName, configuration: request.configuration }));
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new WorkspaceCreationError('service_unavailable', 503);
  let intent = await ports.store.find(actorUserId, request.requestId);
  if (!intent) {
    const organizationId = creationUuid(ports.allocateId());
    const creationId = creationUuid(ports.allocateId());
    const timestamp = ports.now();
    if (!Number.isFinite(Date.parse(timestamp))) throw new WorkspaceCreationError('service_unavailable', 503);
    const configuration = validateCompanyConfiguration({ ...request.configuration, organizationId });
    await ports.revalidate();
    intent = await ports.store.reserve({ creationId, organizationId, actorUserId, requestId: request.requestId, confirmationVersion: 1, companyName: request.companyName, fingerprint, configuration, state: 'reserved', receipt: null, createdAt: timestamp, updatedAt: timestamp });
  }
  if (intent.actorUserId !== actorUserId || intent.requestId !== request.requestId || intent.fingerprint !== fingerprint || intent.companyName !== request.companyName || canonicalCreationJson(intent.configuration) !== canonicalCreationJson({ ...request.configuration, organizationId: intent.organizationId })) throw new WorkspaceCreationError('request_id_conflict', 409);
  if (intent.state === 'reserved') {
    await ports.revalidate();
    const receipt = validateCreationReceipt(await ports.admit(intent), intent);
    await ports.revalidate();
    intent = await ports.store.confirm(intent, receipt, ports.now());
  }
  // A lost response or removed permission cannot turn durable state into unauthorized disclosure.
  await ports.revalidate();
  return intent;
}
export function publicWorkspaceCreation(intent: WorkspaceCreationIntent) {
  return { creationId: intent.creationId, organizationId: intent.organizationId, requestId: intent.requestId, companyName: intent.companyName, country: 'US', currency: 'USD', state: intent.state, configuration: publicCompanyConfiguration(intent.configuration), setupStatus: intent.state === 'reserved' ? 'confirmation_pending' : 'us_subscription_required', createdAt: intent.createdAt, updatedAt: intent.updatedAt };
}
