import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { UsTaxFinancialContext, UsTaxFinancialContextReader } from './us-tax-financial-context';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import type { UsTaxMerchantStore } from './us-tax-merchant-store';
import { blockedUsTaxReadiness, createUsTaxReadinessEvaluator, type UsTaxReadinessEvaluator } from './us-tax-readiness';

export interface UsTaxMerchantReadinessDependencies {
  enabled(): boolean | Promise<boolean>;
  merchant(organizationId: string): Promise<ResolvedUsTaxTestMerchant | null>;
  contexts(revalidate: () => Promise<FinancialAuthority>): UsTaxFinancialContextReader | Promise<UsTaxFinancialContextReader>;
  store(): UsTaxMerchantStore | Promise<UsTaxMerchantStore>;
  now(): string;
}

/** A dedicated observed TEST merchant is required even for informative readiness.
 * No bootstrap-owner impersonation, generic provider, SaaS client or invoice grant.
 * Per-request gateway instances keep their private verified context isolated. */
export function createUsTaxMerchantReadinessEvaluator(dependencies: UsTaxMerchantReadinessDependencies): UsTaxReadinessEvaluator {
  return async input => {
    const original = snapshotPrivateJson(input.actor) as FinancialAuthority;
    if (original.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
    if (!['owner', 'admin', 'accountant'].includes(original.role)) return blockedUsTaxReadiness('financial_role_required');
    let previous = 0, initial: ResolvedUsTaxTestMerchant | null | undefined;
    let previousAuthority = parseInstant(original.timestamp).getTime();
    const started = clock();
    function clock(): number {
      let current: number;
      try { current = parseInstant(dependencies.now()).getTime(); } catch { throw new ErpError('server_clock_unavailable', 503); }
      if (!Number.isFinite(current) || current < previous) throw new ErpError('server_clock_unavailable', 503);
      previous = current; return current;
    }
    function withinDeadline(): void {
      if (clock() - started >= 30_000) throw new ErpError('provider_test_unavailable', 409);
    }
    async function authority(): Promise<FinancialAuthority> {
      const fresh = snapshotPrivateJson(await input.revalidate()) as FinancialAuthority;
      if (fresh.organizationId !== original.organizationId || fresh.userId !== original.userId) throw new ErpError('session_changed', 401);
      if (fresh.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
      if (fresh.role !== original.role) throw new ErpError('forbidden', 403);
      const time = parseInstant(fresh.timestamp).getTime();
      if (time < previousAuthority || time > clock()) throw new ErpError('server_clock_unavailable', 503);
      previousAuthority = time; return fresh;
    }
    async function revalidate(): Promise<FinancialAuthority> {
      // Check authority again even when configuration/flags/resolution fail. A
      // revoked session must take priority over a provider availability error.
      let pending: unknown, selected: ResolvedUsTaxTestMerchant | null | undefined;
      let fresh = await authority();
      try {
        if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
        selected = await dependencies.merchant(original.organizationId);
        if (initial !== undefined && (!selected || !initial || selected.configurationFingerprint !== initial.configurationFingerprint || canonicalErpJson(selected.credential) !== canonicalErpJson(initial.credential))) throw new ErpError('binding_unavailable', 409);
      } catch (error) { pending = error; }
      fresh = await authority();
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      withinDeadline();
      if (pending) throw pending;
      if (initial === undefined) initial = selected ?? null;
      return fresh;
    }
    async function guarded<T>(call: () => Promise<T>): Promise<T> {
      await revalidate();
      let result: T;
      try { result = await call(); } catch (error) { await revalidate(); throw error; }
      await revalidate(); return result;
    }
    try {
      await revalidate();
      if (!initial) return blockedUsTaxReadiness('provider_test_unavailable');
      const merchant: ResolvedUsTaxTestMerchant = initial;
      const contexts = await guarded(async () => dependencies.contexts(revalidate));
      const store = await guarded(async () => dependencies.store());
      async function readProvenanced(actor: FinancialAuthority) {
        const context = snapshotPrivateJson(await guarded(() => contexts.read(actor))) as UsTaxFinancialContext;
        const credential = await guarded(() => store.readCredential(actor, context.binding.revision));
        if (!credential || credential.configurationFingerprint !== merchant.configurationFingerprint || canonicalErpJson(credential.credential) !== canonicalErpJson(merchant.credential) || context.binding.accountId !== credential.credential.accountId) throw new ErpError('binding_unavailable', 409);
        return context;
      }
      function contextFacts(context: Awaited<ReturnType<typeof readProvenanced>>): string {
        // The real authority and read timestamp are renewed on each read. All
        // durable configuration, identities, revisions and provider evidence
        // must still match after the slow external observation.
        const { actor: _actor, recordedAt: _recordedAt, ...facts } = context;
        return canonicalErpJson(facts);
      }
      return await createUsTaxReadinessEvaluator({
        now: () => Math.floor(clock() / 1000),
        contexts: { read: readProvenanced },
        gateway: { async verify(context) {
          await guarded(() => merchant.gateway.verify(context));
          const fresh = await readProvenanced(await revalidate());
          if (contextFacts(fresh) !== contextFacts(context)) throw new ErpError('tax_configuration_changed', 409);
        } },
      })({ ...input, revalidate });
    } catch (error) {
      if (error instanceof ErpError && ['binding_unavailable', 'tax_binding_unavailable', 'provider_test_unavailable'].includes(error.code)) return blockedUsTaxReadiness('provider_test_unavailable');
      throw error;
    }
  };
}
