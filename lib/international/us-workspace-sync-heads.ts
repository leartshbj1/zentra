import type { AccountRole } from '../account-security';
import { ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { validateErpRevision, type ErpRevision } from './runtime-sync';

export const US_WORKSPACE_SYNC_CHANNELS = ['supplierProposals', 'bankReconciliations', 'sellerProfile', 'taxProfile', 'team', 'supplierAnalysis'] as const;
export type UsWorkspaceSyncChannel = typeof US_WORKSPACE_SYNC_CHANNELS[number];
/** Change hints only. No head grants access to a channel or authorizes a write. */
export interface UsWorkspaceSyncHeads {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly role: AccountRole;
  readonly erp: ErpRevision | null;
  readonly channels: Readonly<Record<UsWorkspaceSyncChannel, string | null>>;
}
function invalid(): never { throw new ErpError('invalid_sync_state', 503); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k) || !Object.hasOwn(descriptors[k], 'value'))) return invalid();
  return value as Record<string, unknown>;
}
export function validateUsWorkspaceSyncHeads(input: unknown, organizationId: string, supportedSchemaVersion: ErpSchemaVersion = 4): UsWorkspaceSyncHeads {
  let detached: unknown;
  try { detached = snapshotPrivateJson(input); } catch { return invalid(); }
  const value = exact(detached, ['schemaVersion', 'organizationId', 'role', 'erp', 'channels']);
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(String(value.role))) return invalid();
  const channels = exact(value.channels, US_WORKSPACE_SYNC_CHANNELS);
  for (const channel of US_WORKSPACE_SYNC_CHANNELS) if (channels[channel] !== null && (typeof channels[channel] !== 'string' || !/^[a-f0-9]{64}$/.test(channels[channel] as string))) return invalid();
  if (value.role !== 'owner' && (channels.sellerProfile !== null || channels.taxProfile !== null)) return invalid();
  if (value.erp !== null) exact(value.erp, ['schemaVersion', 'organizationId', 'revision']);
  const erp = value.erp === null ? null : validateErpRevision(value.erp, organizationId, supportedSchemaVersion);
  return Object.freeze({ schemaVersion: 1, organizationId, role: value.role as AccountRole, erp, channels: Object.freeze(channels as unknown as UsWorkspaceSyncHeads['channels']) });
}
