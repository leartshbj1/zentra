import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import type { UsAutomationGrant } from './us-automation-contract';
import { validateUsAutomationActor, validateUsAutomationGrant } from './us-automation-validation';
import { validateUsWorkspaceSyncHeads, type UsWorkspaceSyncHeads } from './us-workspace-sync-heads';

export interface UsWorkspaceSyncSelection {
  readonly supplierProposals: boolean;
  readonly bankReconciliations: boolean;
  readonly team: boolean;
  readonly supplierAnalysis: boolean;
  readonly analysisConfigurationHash: string | null;
  readonly grant: UsAutomationGrant | null;
}
export interface UsWorkspaceSyncHeadsStore {
  readonly supportedSchemaVersion: ErpSchemaVersion;
  read(actor: FinancialAuthority, selection: UsWorkspaceSyncSelection): Promise<UsWorkspaceSyncHeads>;
}
/** One fixed compact RPC; never fetches a financial/document/profile list. */
export function createSupabaseUsWorkspaceSyncHeadsStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion: ErpSchemaVersion }>): UsWorkspaceSyncHeadsStore {
  const supportedSchemaVersion = options.supportedSchemaVersion;
  if (![1, 2, 3, 4].includes(supportedSchemaVersion)) throw new ErpError('service_unavailable', 503);
  return {
    supportedSchemaVersion,
    async read(actor, selection) {
      try {
        // The compact reader accepts every currently admitted workspace role.
        // The supplier/analysis actor validator intentionally admits financial
        // roles only, so validate its shape separately for read-only members.
        const safe = snapshotPrivateJson(actor) as FinancialAuthority;
        if (!safe || Object.keys(safe).sort().join(',') !== 'managementEntitled,organizationId,role,timestamp,userId' || !safe.managementEntitled || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(safe.role) || !/^[0-9a-f-]{36}$/.test(safe.organizationId) || typeof safe.userId !== 'string' || !safe.userId || typeof safe.timestamp !== 'string' || !Number.isFinite(Date.parse(safe.timestamp))) throw new ErpError('invalid_sync_state', 503);
        if (['owner', 'admin', 'accountant'].includes(safe.role)) validateUsAutomationActor(safe);
        if ([selection.supplierProposals, selection.bankReconciliations, selection.team, selection.supplierAnalysis].some(v => typeof v !== 'boolean') || selection.analysisConfigurationHash !== null && !/^[a-f0-9]{64}$/.test(selection.analysisConfigurationHash)) throw new ErpError('invalid_sync_state', 503);
        const grant = selection.grant === null ? null : validateUsAutomationGrant(selection.grant, safe.organizationId);
        const result = await client.rpc<unknown>('zentra_us_workspace_sync_heads', {
          p_organization: safe.organizationId, p_actor: safe, p_supported_schema_version: supportedSchemaVersion,
          p_supplier: selection.supplierProposals, p_bank: selection.bankReconciliations,
          p_analysis: selection.supplierAnalysis, p_analysis_configuration_hash: selection.analysisConfigurationHash, p_grant: grant,
        });
        const heads = validateUsWorkspaceSyncHeads(result, safe.organizationId, supportedSchemaVersion);
        if (heads.role !== safe.role || heads.channels.team !== null || !selection.supplierProposals && heads.channels.supplierProposals !== null || !selection.bankReconciliations && heads.channels.bankReconciliations !== null || !selection.supplierAnalysis && heads.channels.supplierAnalysis !== null) throw new ErpError('invalid_sync_state', 503);
        return heads;
      } catch (error) {
        if (error instanceof ErpError) throw error;
        if (error instanceof SupabaseServerError && error.code === 'PW008') throw new ErpError('client_upgrade_required', 409);
        throw new ErpError('service_unavailable', 503);
      }
    },
  };
}

/** The existing team head is durable. Expiration changes the visible reserved
 * invitations without a command; count only live reservations in the same SQL
 * snapshot. Never load invitations, profiles, e-mails or credential secrets. */
export function createD1UsWorkspaceTeamHeadStore(database: Pick<D1Database, 'prepare'>, now = () => Math.floor(Date.now() / 1000)) {
  return {
    async read(organizationId: string): Promise<string> {
      const checkedAt = now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt <= 0) throw new ErpError('service_unavailable', 503);
      const saved = await database.prepare(`SELECT a.organization_id AS organizationId,a.seat_limit AS seatLimit,
        COALESCE(h.revision,0) AS revision,
        (SELECT count(*) FROM international_us_team_invitations i WHERE i.organization_id=a.organization_id AND i.status='pending' AND i.expires_at>?) AS reservedInvitations
        FROM international_saas_authorities a LEFT JOIN international_us_team_heads h ON h.organization_id=a.organization_id
        WHERE a.organization_id=? AND a.revoked_at IS NULL`).bind(checkedAt, organizationId).first();
      const value = snapshotPrivateJson(saved) as { organizationId: string; seatLimit: number; revision: number; reservedInvitations: number } | null;
      if (!value || Object.keys(value).length !== 4 || value.organizationId !== organizationId || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(value.seatLimit) || value.seatLimit < 1 || value.seatLimit > 1000 || !Number.isSafeInteger(value.reservedInvitations) || value.reservedInvitations < 0 || value.reservedInvitations > 1000) throw new ErpError('invalid_sync_state', 503);
      return sha256Hex(canonicalErpJson(['us-team-head-v1', organizationId, value.revision, value.seatLimit, value.reservedInvitations]));
    },
  };
}
