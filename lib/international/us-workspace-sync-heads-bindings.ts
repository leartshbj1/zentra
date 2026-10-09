import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { ErpError, canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { UsAuthorityError } from './saas-authority';
import { requireUsWorkspaceAutomationAuthority } from './saas-authority-d1';
import { createUsAutomationGrant, parseUsAutomationBudgetPolicy, UsAutomationPolicyError } from './us-automation-policy';
import { createD1UsWorkspaceTeamHeadStore, createSupabaseUsWorkspaceSyncHeadsStore, type UsWorkspaceSyncSelection } from './us-workspace-sync-heads-store';
import { createUsWorkspaceSyncHeadsHandlers } from './us-workspace-sync-heads-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsAutomationGrant } from './us-automation-contract';

type Flags = Record<string, string | undefined>;
async function flags(): Promise<Flags> { try { return (await import('cloudflare:workers')).env as unknown as Flags; } catch { return {}; } }
/** Separate capability, closed unless Core, US ERP and background sync agree. */
export async function usWorkspaceSyncEnabled(): Promise<boolean> {
  const f = await flags();
  return ['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_ERP_ENABLED', 'INTERNATIONAL_US_BACKGROUND_SYNC_ENABLED'].every(k => f[k] === 'true');
}
async function selection(actor: FinancialAuthority, capability: ErpSchemaVersion): Promise<UsWorkspaceSyncSelection> {
  const f = await flags(), financial = ['owner', 'admin', 'accountant'].includes(actor.role), accounting = capability === 4 && financial;
  const supplierModule = accounting && f.INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED === 'true';
  const bankReconciliations = accounting && f.INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED === 'true';
  const team = f.INTERNATIONAL_US_TEAM_ENABLED === 'true';
  let supplierProposals = false, supplierAnalysis = false, grant: UsAutomationGrant | null = null, analysisConfigurationHash: string | null = null;
  if (supplierModule) {
    try {
      const admitted = await requireUsWorkspaceAutomationAuthority(actor.organizationId, actor.userId);
      if (admitted.organizationId !== actor.organizationId || admitted.userId !== actor.userId || admitted.role !== actor.role) throw new ErpError('forbidden', 403);
      supplierProposals = true; supplierAnalysis = true;
      const policy = f.INTERNATIONAL_US_AUTOMATION_BUDGET_POLICY_JSON ? parseUsAutomationBudgetPolicy(f.INTERNATIONAL_US_AUTOMATION_BUDGET_POLICY_JSON) : null;
      if (policy) try { grant = createUsAutomationGrant(admitted, policy); } catch (error) { if (!(error instanceof UsAutomationPolicyError) || error.code !== 'automation_budget_unavailable') throw error; }
      // Provider configuration is durable D1 state. Read its revision only,
      // never decrypt or transmit a platform credential during polling.
      const runtime = await import('../runtime');
      const provider = f.INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED === 'true'
        ? await runtime.database().prepare("SELECT updated_at FROM support_platform_secrets WHERE id='typesafe'").first<{ updated_at: number }>() : null;
      analysisConfigurationHash = await sha256Hex(canonicalErpJson(['us-analysis-configuration-v1', policy, admitted.environment, admitted.catalogVersion, admitted.priceId, admitted.subscriptionId, admitted.authorityReference, f.INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED === 'true', provider?.updated_at ?? null, Boolean(runtime.runtimeValue('TYPESAFE_API_KEY'))]));
    } catch (error) {
      // A Management seat does not imply an Automation subscription. This
      // channel remains absent; unrelated ERP/team heads continue to work.
      if (!(error instanceof UsAuthorityError) || ![402, 403].includes(error.status)) throw error;
    }
  }
  return Object.freeze({ supplierProposals, bankReconciliations, team, supplierAnalysis, analysisConfigurationHash, grant });
}
export const usWorkspaceSyncHeadsHandlers = createUsWorkspaceSyncHeadsHandlers({
  // ERP browser authority calls Auth getUser + the durable account session
  // policy every time. It does not rotate refresh tokens during a polling GET.
  enabled: usWorkspaceSyncEnabled, authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId), configuration: actor => erpServerDependencies.configuration(actor),
  freshSupportedSchemaVersion: usPurchasingSchemaVersion, selection,
  async headsStore(capability) { return createSupabaseUsWorkspaceSyncHeadsStore((await import('../supabase-server-runtime')).supabaseServerClient(), { supportedSchemaVersion: capability }); },
  async teamHead(organizationId) { return createD1UsWorkspaceTeamHeadStore((await import('../runtime')).database()).read(organizationId); },
  async rateLimit(request, actor) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-workspace-sync-heads', `${actor.organizationId}:${actor.userId}`, 3600); },
  diagnostic(event) { console.warn('zentra.international.us-workspace-sync-heads', event); },
});
