import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { canonicalErpJson, ErpError } from './erp-contract';
import { confirmErpExpectedUser, confirmErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import { getUsSellerProfile, putUsSellerProfile, validateUsSellerProfileWrite, SellerProfileError, type SellerProfileStore } from './seller-profile';

export type SellerProfileServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'rateLimit' | 'diagnostic'> & {
  store(): SellerProfileStore | Promise<SellerProfileStore>;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

/** Seller edits are scoped US configuration, never legacy CH profile writes or payment authority. */
export function createUsSellerProfileHandlers(dependencies: SellerProfileServerDependencies) {
  function failure(error: unknown, operation: 'read' | 'write') {
    let code = 'service_unavailable', status = 503;
    if (error instanceof SellerProfileError || error instanceof ErpError) { code = error.code; status = error.status; }
    else if (error instanceof AccountPublicError) { status = error.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if (error instanceof RequestBodyError) { code = 'invalid_request'; status = error.status; }
    try { dependencies.diagnostic({ operation, code, status }); } catch { /* Telemetry does not change the result. */ }
    return json({ error: code }, status);
  }
  async function context(request: Request, organizationId: string, operation: 'read' | 'write') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) throw new ErpError('invalid_request', 422);
    const admitted = await dependencies.authority(request, organizationId);
    confirmErpExpectedUser(request, admitted);
    if (admitted.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
    if (admitted.actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
    if (operation === 'write') {
      if (admitted.mode === 'browser') requireAccountSameOrigin(request);
      if (admitted.actor.role !== 'owner') throw new ErpError('forbidden', 403);
    }
    await dependencies.rateLimit(request, admitted.actor, operation);
    const configuration = await dependencies.configuration(admitted.actor);
    if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
    if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
    return { ...admitted, configuration };
  }
  async function revalidate(request: Request, organizationId: string, trusted: Awaited<ReturnType<typeof context>>) {
    // Read the private country configuration with the original actor. Check
    // current authority last, including changes during this slow lookup.
    const configuration = await dependencies.configuration(trusted.actor);
    if (canonicalErpJson(configuration) !== canonicalErpJson(trusted.configuration)) throw new ErpError('configuration_changed', 409);
    confirmErpReadAdmission(trusted, await dependencies.authority(request, organizationId));
    if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
  }
  return {
    async GET(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
        const trusted = await context(request, organizationId, 'read');
        const result = await getUsSellerProfile(await dependencies.store(), trusted.actor);
        await revalidate(request, organizationId, trusted);
        return json(result);
      } catch (error) { return failure(error, 'read'); }
    },
    async PUT(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
        // Refuse browser cross-origin writes before evaluating private auth.
        if (!request.headers.has('Authorization')) requireAccountSameOrigin(request);
        const trusted = await context(request, organizationId, 'write');
        const input = validateUsSellerProfileWrite(await readJsonObjectWithinLimit(request, 4_096));
        const result = await putUsSellerProfile(await dependencies.store(), trusted.actor, input, () => revalidate(request, organizationId, trusted));
        // A committed edit stays committed after a late revocation. Withhold
        // its receipt; reauthentication and the exact request recover it.
        await revalidate(request, organizationId, trusted);
        return json(result);
      } catch (error) { return failure(error, 'write'); }
    },
  };
}
