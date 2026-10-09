import { AccountPublicError } from '../account-security';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';
import { validateUsWorkspaceSyncHeads } from './us-workspace-sync-heads';
import type { UsWorkspaceSyncHeadsStore, UsWorkspaceSyncSelection } from './us-workspace-sync-heads-store';

export type UsWorkspaceSyncHeadsDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'rateLimit' | 'diagnostic'> & {
  freshSupportedSchemaVersion(client: ErpSchemaVersion): Promise<ErpSchemaVersion> | ErpSchemaVersion;
  selection(actor: ErpReadAdmission['actor'], capability: ErpSchemaVersion): Promise<UsWorkspaceSyncSelection>;
  headsStore(capability: ErpSchemaVersion): Promise<UsWorkspaceSyncHeadsStore> | UsWorkspaceSyncHeadsStore;
  teamHead(organizationId: string): Promise<string>;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
// checkedAt is refreshed by durable entitlement verification, not a change to
// the budget. Keep polling tokens stable while the same authority stays valid.
function selectionIdentity(value: UsWorkspaceSyncSelection) { return canonicalErpJson({ ...value, grant: value.grant ? { ...value.grant, checkedAt: 0 } : null }); }
/** Entire candidate is kept private until fresh session, role, entitlement,
 * configuration and captured schema admission have all been revalidated. */
export function createUsWorkspaceSyncHeadsHandlers(deps: UsWorkspaceSyncHeadsDependencies) {
  return {
    async GET(request: Request, organizationId: string): Promise<Response> {
      let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined, selection: UsWorkspaceSyncSelection | undefined, capability: ErpSchemaVersion | undefined;
      let authorityAttempted = false;
      let client: ErpSchemaVersion = 1;
      async function revalidate() {
        if (!trusted) throw new ErpError('unauthorized', 401);
        let delayed: unknown;
        try {
          if (configuration && canonicalErpJson(await deps.configuration(trusted.actor)) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
          if (capability !== undefined) {
            const freshCapability = await deps.freshSupportedSchemaVersion(client);
            if (freshCapability !== capability) throw new ErpError('client_upgrade_required', 409);
            if (selection && selectionIdentity(await deps.selection(trusted.actor, freshCapability)) !== selectionIdentity(selection)) throw new ErpError('configuration_changed', 409);
          }
        } catch (error) { delayed = error; }
        // Current auth failure outranks a delayed storage/schema/config error.
        const fresh = await deps.authority(request, organizationId);
        confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh);
        if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
        if (delayed) throw delayed;
      }
      try {
        if (!await deps.enabled()) return json({ error: 'feature_unavailable' }, 404);
        try { creationUuid(organizationId); } catch { throw new ErpError('invalid_request', 422); }
        if (request.method !== 'GET' || new URL(request.url).search) throw new ErpError('invalid_request', 422);
        authorityAttempted = true;
        trusted = snapshotPrivateJson(await deps.authority(request, organizationId)) as ErpReadAdmission;
        if (!['browser', 'device'].includes(trusted.mode)) throw new ErpError('unauthorized', 401);
        confirmErpExpectedUser(request, trusted);
        if (trusted.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
        if (!trusted.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
        client = erpClientSchemaVersion(request);
        capability = await deps.freshSupportedSchemaVersion(client); requireErpClientSchema(capability, client);
        await deps.rateLimit(request, trusted.actor, 'read');
        configuration = snapshotPrivateJson(await deps.configuration(trusted.actor)) as CompanyConfiguration;
        if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
        if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
        selection = snapshotPrivateJson(await deps.selection(trusted.actor, capability)) as UsWorkspaceSyncSelection;
        await revalidate();
        const store = await deps.headsStore(capability);
        if (store.supportedSchemaVersion !== capability) throw new ErpError('client_upgrade_required', 409);
        const heads = validateUsWorkspaceSyncHeads(await store.read(trusted.actor, selection), organizationId, capability);
        if (heads.role !== trusted.actor.role) throw new ErpError('invalid_sync_state', 503);
        if (!selection.supplierProposals && heads.channels.supplierProposals !== null || !selection.bankReconciliations && heads.channels.bankReconciliations !== null || !selection.supplierAnalysis && heads.channels.supplierAnalysis !== null) throw new ErpError('invalid_sync_state', 503);
        const team = selection.team ? await deps.teamHead(organizationId) : null;
        const result = validateUsWorkspaceSyncHeads({ ...heads, channels: { ...heads.channels, team } }, organizationId, capability);
        await revalidate();
        return json(result);
      } catch (error) {
        let latest = error;
        if (trusted) try { await revalidate(); } catch (freshError) { latest = freshError; }
        else if (authorityAttempted) {
          // Initial authority can fail during a slow scope read after Auth was
          // checked. Recheck identity even before an actor was returned, so
          // that storage failure cannot conceal logout/account replacement.
          try {
            const fresh = await deps.authority(request, organizationId);
            confirmErpExpectedUser(request, fresh);
            if (fresh.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
            if (!fresh.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
          } catch (freshError) {
            if ((freshError instanceof ErpError || freshError instanceof AccountPublicError) && [401, 402, 403].includes(freshError.status)) latest = freshError;
          }
        }
        let code = 'service_unavailable', status = 503;
        if (latest instanceof ErpError) { code = latest.code; status = latest.status; }
        else if (latest instanceof AccountPublicError) { status = latest.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
        try { deps.diagnostic({ operation: 'read', code, status }); } catch { /* only bounded codes */ }
        return json({ error: code }, status);
      }
    },
  };
}
