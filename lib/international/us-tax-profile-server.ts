import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { confirmErpExpectedUser, confirmErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import { getUsTaxProfile, putUsTaxProfile, validateUsTaxProfileWrite, UsTaxProfileError, type TaxProfileStore } from './us-tax-profile';

export type UsTaxProfileServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'rateLimit' | 'diagnostic'> & {
  store: () => TaxProfileStore | Promise<TaxProfileStore>;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

/** Owner-only declared facts. This endpoint cannot install or confirm a tax provider. */
export function createUsTaxProfileHandlers(dependencies: UsTaxProfileServerDependencies) {
  function failure(error: unknown, operation: 'read' | 'write') {
    let code = 'service_unavailable', status = 503;
    if (error instanceof UsTaxProfileError || error instanceof ErpError) { code = error.code; status = error.status; }
    else if (error instanceof AccountPublicError) { status = error.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if (error instanceof RequestBodyError) { code = 'invalid_request'; status = error.status; }
    try { dependencies.diagnostic({ operation, code, status }); } catch { /* No private payload, including in telemetry failures. */ }
    return json({ error: code }, status);
  }
  async function context(request: Request, organizationId: string, operation: 'read' | 'write') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) throw new ErpError('invalid_request', 422);
    const authority = await dependencies.authority(request, organizationId);
    const admitted = { mode: authority.mode, actor: Object.freeze({ ...authority.actor }) };
    confirmErpExpectedUser(request, admitted);
    if (admitted.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
    if (admitted.actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
    // These are private setup details; ERP read or accountant rights are insufficient.
    if (admitted.actor.role !== 'owner') throw new ErpError('forbidden', 403);
    if (operation === 'write' && admitted.mode === 'browser') requireAccountSameOrigin(request);
    await dependencies.rateLimit(request, admitted.actor, operation);
    const configuration = validateCompanyConfiguration(await dependencies.configuration(admitted.actor));
    if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
    if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
    return { ...admitted, configuration };
  }
  async function revalidate(request: Request, organizationId: string, trusted: Awaited<ReturnType<typeof context>>) {
    const configuration = validateCompanyConfiguration(await dependencies.configuration(trusted.actor));
    if (canonicalErpJson(configuration) !== canonicalErpJson(trusted.configuration)) throw new ErpError('configuration_changed', 409);
    confirmErpReadAdmission(trusted, await dependencies.authority(request, organizationId));
    if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
  }
  return {
    async GET(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
        const trusted = await context(request, organizationId, 'read');
        const result = await getUsTaxProfile(await dependencies.store(), trusted.actor);
        await revalidate(request, organizationId, trusted);
        return json(result);
      } catch (error) { return failure(error, 'read'); }
    },
    async PUT(request: Request, organizationId: string): Promise<Response> {
      try {
        if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
        if (!request.headers.has('Authorization')) requireAccountSameOrigin(request);
        const trusted = await context(request, organizationId, 'write');
        const input = validateUsTaxProfileWrite(await readJsonObjectWithinLimit(request, 4_096));
        const result = await putUsTaxProfile(await dependencies.store(), trusted.actor, input, () => revalidate(request, organizationId, trusted));
        // A commit survives a late revocation, but its private receipt is withheld.
        await revalidate(request, organizationId, trusted);
        return json(result);
      } catch (error) { return failure(error, 'write'); }
    },
  };
}
