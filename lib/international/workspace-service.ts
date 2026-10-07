import type { AccountRole } from '@/lib/account-security';
import { SupabaseServerError, type SupabaseServerClient } from '@/lib/supabase-server';
import { resolveLegacyCompany, validateCompanyConfiguration } from './country-config';
import type { CompanyConfiguration, LegacyCompanyResolution } from './types';

export type WorkspaceCountryStore = Pick<SupabaseServerClient, 'select' | 'rpc'>;
/** Obtained from the authenticated user and D1 membership, never the request body. */
export interface WorkspaceCountryActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: AccountRole;
}
export interface WorkspaceCountryConfigured {
  readonly status: 'configured';
  readonly organizationId: string;
  readonly revision: number;
  readonly configuration: CompanyConfiguration;
  readonly updatedBy: string;
  readonly updatedAt: string;
}
export type WorkspaceCountryState = WorkspaceCountryConfigured | (LegacyCompanyResolution & {
  readonly status: 'unconfigured';
  readonly revision: 0;
});
export interface WorkspaceCountryWrite {
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly configuration: CompanyConfiguration;
}
export interface WorkspaceCountryReceipt extends WorkspaceCountryConfigured {
  readonly requestId: string;
  readonly replayed: boolean;
}
export class WorkspaceCountryError extends Error {
  constructor(public readonly code: 'invalid_request' | 'forbidden' | 'revision_conflict' | 'request_id_conflict' | 'jurisdiction_locked' | 'workspace_unavailable' | 'service_unavailable', public readonly status: number) {
    super(code);
    this.name = 'WorkspaceCountryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertActor(actor: WorkspaceCountryActor, owner = false): void {
  resolveLegacyCompany(actor.organizationId);
  if (!actor.userId || actor.userId.length > 256 || !['owner','admin','accountant','member','read_only'].includes(actor.role) || (owner && actor.role !== 'owner')) {
    throw new WorkspaceCountryError('forbidden', 403);
  }
}

/** Exact allowlist: user, role, entitlement and alternate tenant fields are refused. */
export function validateWorkspaceCountryWrite(input: unknown, organizationId: string): WorkspaceCountryWrite {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkspaceCountryError('invalid_request', 422);
  const fields = input as Record<string, unknown>;
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !['expectedRevision','requestId','configuration'].includes(key))) throw new WorkspaceCountryError('invalid_request', 422);
  if (!Number.isSafeInteger(fields.expectedRevision) || (fields.expectedRevision as number) < 0 || (fields.expectedRevision as number) >= Number.MAX_SAFE_INTEGER || typeof fields.requestId !== 'string' || !UUID.test(fields.requestId)) throw new WorkspaceCountryError('invalid_request', 422);
  let configuration: CompanyConfiguration;
  try { configuration = validateCompanyConfiguration(fields.configuration); }
  catch { throw new WorkspaceCountryError('invalid_request', 422); }
  if (configuration.organizationId !== organizationId) throw new WorkspaceCountryError('forbidden', 403);
  return Object.freeze({ expectedRevision: fields.expectedRevision as number, requestId: fields.requestId.toLowerCase(), configuration });
}

interface StoredConfiguration {
  organization_id: string;
  schema_version: number;
  config: unknown;
  country: unknown;
  currency: unknown;
  revision: unknown;
  updated_by: unknown;
  updated_at: unknown;
}
function configured(organizationId: string, revision: unknown, config: unknown, updatedBy: unknown, updatedAt: unknown): WorkspaceCountryConfigured {
  // Treat a malformed privileged upstream response as an unavailable service,
  // never reinterpret it as legacy CH or expose its raw content.
  const configuration = validateCompanyConfiguration(config);
  if (configuration.organizationId !== organizationId || !Number.isSafeInteger(revision) || (revision as number) < 1 || typeof updatedBy !== 'string' || !updatedBy || updatedBy.length > 256 || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid stored country configuration');
  return { status: 'configured', organizationId, revision: revision as number, configuration, updatedBy, updatedAt };
}
function storageError(error: unknown): WorkspaceCountryError {
  if (error instanceof WorkspaceCountryError) return error;
  if (error instanceof SupabaseServerError) {
    const codes = {
      PZ001: ['revision_conflict', 409],
      PZ002: ['request_id_conflict', 409],
      PZ003: ['jurisdiction_locked', 409],
      PZ004: ['workspace_unavailable', 409],
    } as const;
    const mapped = codes[error.code as keyof typeof codes];
    if (mapped) return new WorkspaceCountryError(mapped[0], mapped[1]);
  }
  return new WorkspaceCountryError('service_unavailable', 503);
}

export async function getWorkspaceCountry(store: WorkspaceCountryStore, actor: WorkspaceCountryActor): Promise<WorkspaceCountryState> {
  assertActor(actor);
  try {
    const workspaces = await store.select<{ organization_id: string }>('zentra_workspaces', { select: 'organization_id', organization_id: 'eq.' + actor.organizationId, limit: 1 });
    if (workspaces.length !== 1 || workspaces[0].organization_id !== actor.organizationId) throw new WorkspaceCountryError('workspace_unavailable', 409);
    const rows = await store.select<StoredConfiguration>('zentra_workspace_country_configs', { select: 'organization_id,schema_version,config,country,currency,revision,updated_by,updated_at', organization_id: 'eq.' + actor.organizationId, limit: 1 });
    if (rows.length === 0) return { ...resolveLegacyCompany(actor.organizationId), status: 'unconfigured', revision: 0 };
    const row = rows[0];
    if (rows.length !== 1 || row.organization_id !== actor.organizationId || row.schema_version !== 1) throw new Error('Invalid stored country configuration');
    const result = configured(actor.organizationId, row.revision, row.config, row.updated_by, row.updated_at);
    if (row.country !== result.configuration.country || row.currency !== result.configuration.currency) throw new Error('Invalid stored country configuration');
    return result;
  } catch (error) { throw storageError(error); }
}

export async function putWorkspaceCountry(store: WorkspaceCountryStore, actor: WorkspaceCountryActor, input: unknown): Promise<WorkspaceCountryReceipt> {
  assertActor(actor, true);
  const write = validateWorkspaceCountryWrite(input, actor.organizationId);
  try {
    const result = await store.rpc<Record<string, unknown>>('zentra_put_workspace_country_config', {
      p_organization: actor.organizationId, p_actor: actor.userId, p_expected_revision: write.expectedRevision, p_request_id: write.requestId, p_config: write.configuration,
    });
    if (!result || result.organizationId !== actor.organizationId || result.updatedBy !== actor.userId || result.revision !== write.expectedRevision + 1 || typeof result.replayed !== 'boolean') throw new Error('Invalid country configuration receipt');
    const receipt = configured(actor.organizationId, result.revision, result.configuration, result.updatedBy, result.updatedAt);
    // The RPC may return an earlier durable receipt on a retry after newer writes.
    // It must still represent this exact validated request.
    if (JSON.stringify(receipt.configuration) !== JSON.stringify(write.configuration)) throw new Error('Invalid country configuration receipt');
    return { ...receipt, requestId: write.requestId, replayed: result.replayed };
  } catch (error) { throw storageError(error); }
}
