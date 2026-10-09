import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { erpClientSchemaVersion, requireErpClientSchema, type ErpSchemaVersion } from './erp-schema-capability';
import { parseInstant } from './localization';
import type { Estimate } from './invoicing';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { ErpRequest, ErpStore } from './runtime-types';
import { prepareStripeTaxResolvedRequest, StripeTaxResolvedRequestError } from './stripe-tax-resolved-request';
import type { StripeTaxCatalogCode, StripeTaxCatalogPage } from './stripe-tax-test-gateway';
import type { CompanyConfiguration } from './types';
import { validateUsTaxInvoicePreparation, type UsTaxInvoicePreparation, type UsTaxInvoicePreparationStore, type UsTaxPreparationClassification } from './us-tax-invoice-preparation-store';
import { createUsTaxInvoicePrivateScope, usTaxInvoiceContextFacts, type UsTaxInvoicePrivateDependencies } from './us-tax-invoice-test-runtime';
import { validateUsTaxInvoiceTime } from './us-tax-invoice-time';

export type UsTaxInvoicePreparationServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'freshSupportedSchemaVersion' | 'rateLimit' | 'diagnostic'> & UsTaxInvoicePrivateDependencies & {
  preparations(capability: ErpSchemaVersion): UsTaxInvoicePreparationStore | Promise<UsTaxInvoicePreparationStore>;
  erpStore(capability: ErpSchemaVersion): ErpStore | Promise<ErpStore>;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
// Reject control characters in identities and public catalogue text. This is
// deliberately non-global so repeated validations cannot retain regex state.
// oxlint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f]/;
const errors: Readonly<Record<string, number>> = Object.freeze({
  invalid_request: 422, invalid_tax_date: 422, unsupported_tax_request: 422,
  unauthorized: 401, session_changed: 401, management_entitlement_required: 402, forbidden: 403,
  financial_permission_required: 403, financial_authority_changed: 403, tenant_mismatch: 403,
  feature_unavailable: 404, edition_unavailable: 409, client_upgrade_required: 409, country_configuration_required: 409,
  configuration_changed: 409, tax_configuration_changed: 409, seller_configuration_required: 409, tax_details_required: 409,
  binding_unavailable: 409, tax_binding_changed: 409, tax_binding_unavailable: 409,
  tax_preparation_required: 409, tax_preparation_changed: 409, tax_preparation_conflict: 409, tax_preparation_expired: 409, idempotency_conflict: 409,
  invalid_tax_preparation: 422, invalid_stored_tax_preparation: 503, revision_conflict: 409,
  estimate_revision_conflict: 409, estimate_not_found: 404, estimate_acceptance_required: 409,
  invoice_already_issued: 409,
  workspace_not_initialized: 409, rate_limited: 429, service_unavailable: 503, server_clock_unavailable: 503,
});
function normalized(error: unknown): { error: string; status: number } {
  try {
    const codeDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const statusDescriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const code = codeDescriptor && 'value' in codeDescriptor && typeof codeDescriptor.value === 'string' ? codeDescriptor.value : '';
    const status = statusDescriptor && 'value' in statusDescriptor ? statusDescriptor.value : 503;
    if ((error instanceof ErpError || error instanceof StripeTaxResolvedRequestError) && Object.hasOwn(errors, code)) return { error: code, status: errors[code] };
    if (error instanceof RequestBodyError) return { error: 'invalid_request', status: [400, 413, 415].includes(status) ? status : 422 };
    if (error instanceof AccountPublicError || error instanceof ErpError) {
      if (status === 401) return { error: 'unauthorized', status };
      if (status === 402) return { error: 'management_entitlement_required', status };
      if (status === 403) return { error: 'forbidden', status };
      if (error instanceof AccountPublicError && status === 429) return { error: 'rate_limited', status };
    }
  } catch { /* Foreign getters, messages and payloads remain private. */ }
  return { error: 'service_unavailable', status: 503 };
}
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new ErpError('invalid_request', 422);
  return input as Record<string, unknown>;
}
function admission(input: unknown, organizationId: string): ErpReadAdmission {
  const admitted = exact(snapshotPrivateJson(input), ['mode', 'actor']) as unknown as ErpReadAdmission;
  if (!['browser', 'device'].includes(admitted.mode)) throw new ErpError('service_unavailable', 503);
  const actor = exact(admitted.actor, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']) as unknown as FinancialAuthority;
  if (actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (typeof actor.userId !== 'string' || !actor.userId || actor.userId !== actor.userId.trim() || actor.userId.length > 256 || controlCharacters.test(actor.userId)) throw new ErpError('service_unavailable', 503);
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) throw new ErpError('financial_permission_required', 403);
  try { parseInstant(actor.timestamp); } catch { throw new ErpError('service_unavailable', 503); }
  return admitted;
}
interface Choices { classifications: readonly UsTaxPreparationClassification[]; taxDateInstant: string; addressSource: 'billing' | 'shipping'; }
function choices(input: unknown): Choices {
  const value = exact(snapshotPrivateJson(input), ['classifications', 'taxDateInstant', 'addressSource']);
  if (!Array.isArray(value.classifications) || value.classifications.length < 1 || value.classifications.length > 100 || !['billing', 'shipping'].includes(value.addressSource as string)) throw new ErpError('invalid_request', 422);
  const ids = new Set<string>(), classifications = value.classifications.map(input => {
    const row = exact(input, ['lineId', 'taxCode', 'confirmedService']);
    if (typeof row.lineId !== 'string' || !row.lineId || row.lineId.length > 160 || row.lineId !== row.lineId.trim() || controlCharacters.test(row.lineId) || ids.has(row.lineId) || typeof row.taxCode !== 'string' || !/^txcd_[0-9]{8}$/.test(row.taxCode) || row.confirmedService !== true) throw new ErpError('invalid_request', 422);
    ids.add(row.lineId);
    return Object.freeze({ lineId: row.lineId, taxCode: row.taxCode, kind: 'service' as const, taxBehavior: 'exclusive' as const });
  });
  let instant: Date;
  try { instant = parseInstant(value.taxDateInstant as string); } catch { throw new ErpError('invalid_tax_date', 422); }
  if (instant.getTime() % 1000 !== 0) throw new ErpError('invalid_tax_date', 422);
  return { classifications, taxDateInstant: instant.toISOString(), addressSource: value.addressSource as Choices['addressSource'] };
}
function sameChoices(saved: UsTaxInvoicePreparation, selected: Choices): boolean {
  const classifications = saved.classifications.map(({ lineId, taxCode, kind, taxBehavior }) => ({ lineId, taxCode, kind, taxBehavior }));
  return same(classifications, selected.classifications) && saved.taxDateInstant === selected.taxDateInstant && saved.addressSource === selected.addressSource;
}
function code(input: unknown): StripeTaxCatalogCode {
  const value = exact(snapshotPrivateJson(input), ['id', 'name', 'description']);
  if (typeof value.id !== 'string' || !/^txcd_[0-9]{8}$/.test(value.id)) throw new ErpError('service_unavailable', 503);
  for (const [key, limit] of [['name', 2000], ['description', 16_000]] as const) if (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).length > limit || controlCharacters.test(value[key] as string)) throw new ErpError('service_unavailable', 503);
  return value as unknown as StripeTaxCatalogCode;
}
/** Minimal confirmation response only; no account, private facts or reusable
 * provider permission is projected. GET performs bounded read-only lookup. */
export function createUsTaxInvoicePreparationHandlers(dependencies: UsTaxInvoicePreparationServerDependencies) {
  async function handle(request: Request, organizationId: string, operation: 'read' | 'write'): Promise<Response> {
    let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined;
    let capability: ErpSchemaVersion | undefined, previousClock = -Infinity, previousAuthority = -Infinity;
    let clientCapability: ErpSchemaVersion = 1;
    function clock(): string {
      const now = dependencies.now(); let timestamp: number;
      try { timestamp = parseInstant(now).getTime(); } catch { throw new ErpError('server_clock_unavailable', 503); }
      if (timestamp < previousClock) throw new ErpError('server_clock_unavailable', 503);
      previousClock = timestamp; return now;
    }
    function actorTime(actor: FinancialAuthority) {
      const timestamp = parseInstant(actor.timestamp).getTime();
      if (timestamp < previousAuthority || timestamp > parseInstant(clock()).getTime()) throw new ErpError('server_clock_unavailable', 503);
      previousAuthority = timestamp;
    }
    async function revalidate(): Promise<FinancialAuthority> {
      if (!trusted) throw new ErpError('service_unavailable', 503);
      let failure: unknown, authorityFailure: unknown, fresh: ErpReadAdmission | undefined;
      try {
        if (configuration && !same(validateCompanyConfiguration(snapshotPrivateJson(await dependencies.configuration(trusted.actor))), configuration)) throw new ErpError('configuration_changed', 409);
        if (capability !== undefined && dependencies.freshSupportedSchemaVersion) requireErpClientSchema(capability, await dependencies.freshSupportedSchemaVersion(clientCapability));
      } catch (error) { failure = error; }
      try { fresh = admission(await dependencies.authority(request, organizationId), organizationId); confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh); actorTime(fresh.actor); } catch (error) { failure = error; authorityFailure = error; }
      try { if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404); clock(); } catch (error) { failure = error; }
      if (authorityFailure && [401, 402, 403].includes(normalized(authorityFailure).status)) throw authorityFailure;
      if (failure) throw failure;
      return fresh!.actor;
    }
    async function checked<T>(work: (actor: FinancialAuthority) => T | Promise<T>): Promise<T> {
      const actor = await revalidate(); let result: T | undefined, failure: unknown, failed = false;
      try { result = await work(actor); } catch (error) { failed = true; failure = error; }
      await revalidate(); if (failed) throw failure; return result as T;
    }
    try {
      clientCapability = erpClientSchemaVersion(request);
      if (!await dependencies.enabled()) return json({ error: 'feature_unavailable' }, 404);
      if (request.method !== (operation === 'read' ? 'GET' : 'POST') || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) throw new ErpError('invalid_request', 422);
      const params = new URL(request.url).searchParams;
      if (operation === 'write' && [...params].length || operation === 'read' && ([...params].length > 1 || [...params.keys()].some(key => !['code', 'cursor'].includes(key)))) throw new ErpError('invalid_request', 422);
      if (operation === 'write' && !request.headers.has('Authorization')) requireAccountSameOrigin(request);
      trusted = admission(await dependencies.authority(request, organizationId), organizationId); confirmErpExpectedUser(request, trusted); actorTime(trusted.actor);
      if (operation === 'write' && trusted.mode === 'browser') requireAccountSameOrigin(request);
      await checked(actor => dependencies.rateLimit(request, actor, operation));
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await checked(actor => dependencies.configuration(actor))));
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      const erp = await checked(() => dependencies.erpStore(clientCapability)); capability = erp.supportedSchemaVersion ?? 1; requireErpClientSchema(capability, clientCapability);
      await revalidate();
      let invoiceRequest: ErpRequest | undefined, selected: Choices | undefined, preparations: UsTaxInvoicePreparationStore | undefined;
      if (operation === 'write') {
        const input = exact(await checked(() => readJsonObjectWithinLimit(request, 262_144)), ['request', 'choices']);
        if (!input.request || typeof input.request !== 'object' || !('command' in input.request) || !input.request.command || typeof input.request.command !== 'object' || !('type' in input.request.command) || input.request.command.type !== 'issue_invoice') throw new ErpError('invalid_request', 422);
        invoiceRequest = validateErpRequest(input.request, organizationId); if (invoiceRequest.command.type !== 'issue_invoice') throw new ErpError('invalid_request', 422);
        selected = choices(input.choices);
        preparations = await checked(() => dependencies.preparations(capability!));
        const earlier = await checked(actor => preparations!.read(actor, invoiceRequest!));
        if (earlier) {
          const saved = await checked(actor => validateUsTaxInvoicePreparation(earlier, actor, invoiceRequest!));
          if (!sameChoices(saved, selected)) throw new ErpError('tax_preparation_conflict', 409);
          await revalidate();
          return json({ schemaVersion: 1, organizationId, status: 'prepared_test', idempotencyKey: invoiceRequest.idempotencyKey, replayed: true });
        }
      }
      const scope = createUsTaxInvoicePrivateScope(dependencies, trusted.actor, revalidate);
      const context = await scope.readContext();
      if (!same(context.configuration, configuration)) throw new ErpError('configuration_changed', 409);
      const merchant = scope.merchant(), catalogue = merchant.catalogue;
      if (!catalogue) throw new ErpError('binding_unavailable', 409);
      if (operation === 'read') {
        const codeQuery = params.get('code'), cursor = params.get('cursor');
        if (codeQuery !== null && !/^txcd_[0-9]{8}$/.test(codeQuery) || cursor !== null && !/^txcd_[0-9]{8}$/.test(cursor)) throw new ErpError('invalid_request', 422);
        await scope.verify(context);
        let body: unknown;
        if (codeQuery !== null) {
          const taxCode = code(await scope.checked(() => catalogue.readTaxCode(codeQuery)));
          if (taxCode.id !== codeQuery) throw new ErpError('service_unavailable', 503);
          body = { schemaVersion: 1, organizationId, taxCode };
        } else {
          const page = exact(snapshotPrivateJson(await scope.checked(() => catalogue.listTaxCodes(cursor ?? undefined))), ['taxCodes', 'hasMore', 'nextCursor']) as unknown as StripeTaxCatalogPage;
          if (!Array.isArray(page.taxCodes) || page.taxCodes.length > 20 || typeof page.hasMore !== 'boolean' || page.hasMore && (typeof page.nextCursor !== 'string' || !/^txcd_[0-9]{8}$/.test(page.nextCursor) || page.nextCursor === cursor) || !page.hasMore && page.nextCursor !== null) throw new ErpError('service_unavailable', 503);
          const taxCodes = page.taxCodes.map(code);
          if (new Set(taxCodes.map(row => row.id)).size !== taxCodes.length) throw new ErpError('service_unavailable', 503);
          body = { schemaVersion: 1, organizationId, taxCodes, hasMore: page.hasMore, nextCursor: page.nextCursor };
        }
        if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 512 * 1024) throw new ErpError('service_unavailable', 503);
        await scope.contextStillCurrent(context); await revalidate(); return json(body);
      }
      const currentRequest = invoiceRequest!, currentChoices = selected!, command = currentRequest.command;
      if (command.type !== 'issue_invoice') throw new ErpError('invalid_request', 422);
      const state = await scope.checked(() => erp.read(organizationId));
      if (!state) throw new ErpError('workspace_not_initialized', 409);
      requireErpClientSchema(state.schemaVersion, capability!);
      if (state.revision !== currentRequest.expectedRevision) throw new ErpError('revision_conflict', 409);
      if (!same(state.configuration, configuration)) throw new ErpError('configuration_changed', 409);
      const foundEstimate = state.estimates.find(row => row.id === command.estimateId);
      if (!foundEstimate) throw new ErpError('estimate_not_found', 404);
      const estimate = snapshotPrivateJson(foundEstimate) as Estimate;
      if (estimate.revision !== command.expectedEstimateRevision) throw new ErpError('estimate_revision_conflict', 409);
      if (estimate.status !== 'accepted') throw new ErpError('estimate_acceptance_required', 409);
      if (state.invoices.some(invoice => invoice.id === command.id || invoice.sourceEstimateId === estimate.id)) throw new ErpError('invoice_already_issued', 409);
      if (currentChoices.classifications.length !== estimate.lines.length || currentChoices.classifications.some((row, index) => row.lineId !== estimate.lines[index].id)) throw new ErpError('invalid_request', 422);
      if (command.dueDate < command.date) throw new ErpError('invalid_request', 422);
      const taxDateInstant = validateUsTaxInvoiceTime({ taxDateInstant: currentChoices.taxDateInstant, invoiceDate: command.date, timeZone: context.taxFacts.timeZone, now: clock() });
      // Validate the narrow provider shape before any catalogue network reads.
      await scope.checked(() => prepareStripeTaxResolvedRequest({ organizationId, operationId: '00000000-0000-4000-8000-000000000000', invoiceId: command.id, actorUserId: trusted!.actor.userId, erpIdempotencyKey: currentRequest.idempotencyKey, commandHash: '0'.repeat(64), expectedErpRevision: currentRequest.expectedRevision, countryRevision: context.countryRevision, sellerRevision: context.sellerRevision, taxFactsRevision: context.taxFactsRevision, configuration: configuration!, estimate, taxFacts: context.taxFacts, binding: context.binding, classifications: currentChoices.classifications.map(row => ({ ...row, revision: 1, evidenceReference: 'private-preparation-validation' })), invoiceDate: command.date, taxDateInstant, taxDatePolicy: 'caller_supplied_invoice_instant', now: clock(), addressSource: currentChoices.addressSource }));
      await scope.verify(context);
      for (const taxCode of [...new Set(currentChoices.classifications.map(row => row.taxCode))].sort()) {
        if (code(await scope.checked(() => catalogue.readTaxCode(taxCode))).id !== taxCode) throw new ErpError('service_unavailable', 503);
        await scope.contextStillCurrent(context);
      }
      const latest = await scope.checked(() => erp.read(organizationId));
      if (!latest || latest.revision !== currentRequest.expectedRevision || !same(latest.configuration, configuration) || !same(latest.estimates.find(row => row.id === command.estimateId), estimate)) throw new ErpError('revision_conflict', 409);
      await scope.contextStillCurrent(context);
      const saved = await scope.checked(actor => preparations!.create(actor, { request: currentRequest, context, merchant: { credential: merchant.credential, configurationFingerprint: merchant.configurationFingerprint }, estimate, classifications: currentChoices.classifications, taxDateInstant, addressSource: currentChoices.addressSource }));
      const admitted = await scope.admitted(), confirmed = await scope.checked(() => validateUsTaxInvoicePreparation(saved, admitted, currentRequest));
      if (!sameChoices(confirmed, currentChoices)) throw new ErpError('tax_preparation_conflict', 409);
      if (!same(confirmed.context, usTaxInvoiceContextFacts(context)) || !same(confirmed.estimate, estimate) || !same(confirmed.merchant, { credential: merchant.credential, configurationFingerprint: merchant.configurationFingerprint })) throw new ErpError('tax_preparation_changed', 409);
      await scope.contextStillCurrent(context); await revalidate();
      return json({ schemaVersion: 1, organizationId, status: 'prepared_test', idempotencyKey: currentRequest.idempotencyKey, replayed: false });
    } catch (error) {
      let current = error; if (trusted) try { await revalidate(); } catch (late) { current = late; }
      const failure = normalized(current);
      try { dependencies.diagnostic({ operation, code: failure.error, status: failure.status }); } catch { /* Bounded error only. */ }
      return json({ error: failure.error }, failure.status);
    }
  }
  return { POST: (request: Request, organizationId: string) => handle(request, organizationId, 'write'), CATALOGUE_GET: (request: Request, organizationId: string) => handle(request, organizationId, 'read') };
}
