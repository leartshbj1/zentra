import type { SiteLanguage } from '../site-language';
import { countryConfiguration, validateCompanyConfiguration } from './country-config';
import { countrySubdivisions } from './addresses';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { canonicalCreationJson, creationUuid, validateWorkspaceCreationRequest, type WorkspaceCreationRequest } from './workspace-creation';
import type { UsTestPublicOffer, UsTestPublicState } from './us-saas-test-public';

export const US_TEST_ONBOARDING_STORAGE_KEY = 'zentra-us-test-onboarding-request-v1';
export interface UsTestOnboardingDraft { companyName: string; line1: string; city: string; subdivision: string; postalCode: string; timeZone: string; accountingBasis: string; language: SiteLanguage }
export const emptyUsTestOnboardingDraft = (language: SiteLanguage): UsTestOnboardingDraft => ({ companyName: '', line1: '', city: '', subdivision: '', postalCode: '', timeZone: '', accountingBasis: '', language });
export type UsTestOnboardingField = Exclude<keyof UsTestOnboardingDraft, 'language'>;
export function usTestOnboardingFieldErrors(draft: UsTestOnboardingDraft): readonly UsTestOnboardingField[] {
  const invalid: UsTestOnboardingField[] = [];
  const text = (value: string, maximum: number) => !!value.trim() && value.length <= maximum && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!text(draft.companyName, 160)) invalid.push('companyName'); if (!text(draft.line1, 200)) invalid.push('line1'); if (!text(draft.city, 120)) invalid.push('city');
  if (!countrySubdivisions.US.includes(draft.subdivision)) invalid.push('subdivision');
  if (!/^[0-9]{5}(?:-[0-9]{4})?$/.test(draft.postalCode.trim())) invalid.push('postalCode');
  if (!countryConfiguration('US').timeZones.includes(draft.timeZone)) invalid.push('timeZone');
  if (!['cash', 'accrual'].includes(draft.accountingBasis)) invalid.push('accountingBasis');
  return invalid;
}
export function buildUsTestWorkspaceCreation(draft: UsTestOnboardingDraft, requestId: string): WorkspaceCreationRequest {
  if (usTestOnboardingFieldErrors(draft).length) throw new UsTestOnboardingError('invalid_request', 422, 'rejected');
  return validateWorkspaceCreationRequest({ requestId, confirmationVersion: 1, companyName: draft.companyName.trim(), configuration: { schemaVersion: 1, country: 'US', currency: 'USD', language: draft.language, timeZone: draft.timeZone, address: { country: 'US', line1: draft.line1.trim(), city: draft.city.trim(), subdivision: draft.subdivision, postalCode: draft.postalCode.trim() }, accountingBasis: draft.accountingBasis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } } });
}
export class UsTestOnboardingError extends Error {
  constructor(readonly code: string, readonly status: number, readonly outcome: 'rejected' | 'uncertain' | 'unauthorized') { super(code); this.name = 'UsTestOnboardingError'; }
}
function exact(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = snapshotPrivateJson(input); if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid public shape'); return value as Record<string, unknown>;
}
export function validateUsTestCheckoutUrl(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || input.length > 4096 || Array.from(input).some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)) throw new UsTestOnboardingError('invalid_response', 200, 'uncertain');
  let url: URL; try { url = new URL(input); } catch { throw new UsTestOnboardingError('invalid_response', 200, 'uncertain'); } if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password || !/^\/(?:c\/)?pay\/cs_test_[A-Za-z0-9_]+$/.test(url.pathname)) throw new UsTestOnboardingError('invalid_response', 200, 'uncertain'); return input;
}
export function validateUsTestPublicWorkspace(input: unknown, requestId: string): UsTestPublicState['workspace'] {
  try {
    const value = exact(input, ['creationId', 'organizationId', 'requestId', 'companyName', 'country', 'currency', 'state', 'configuration', 'setupStatus', 'createdAt', 'updatedAt']);
    creationUuid(value.creationId); creationUuid(value.organizationId); if (value.requestId !== creationUuid(requestId) || value.country !== 'US' || value.currency !== 'USD' || typeof value.companyName !== 'string' || !value.companyName.trim() || value.companyName.length > 160 || !['reserved', 'postgres_confirmed', 'ready'].includes(value.state as string)) throw new Error('Workspace');
    const raw = exact(value.configuration, ['schemaVersion', 'organizationId', 'country', 'currency', 'language', 'timeZone', 'address', 'accountingBasis', 'invoiceNumberPrefix', 'taxConfiguration']), configuration = validateCompanyConfiguration(raw);
    if (configuration.organizationId !== value.organizationId || configuration.country !== 'US' || configuration.currency !== 'USD') throw new Error('Scope');
    if (value.setupStatus !== ({ reserved: 'confirmation_pending', postgres_confirmed: 'us_subscription_required', ready: 'ready' } as Record<string, string>)[value.state as string]) throw new Error('State');
    parseInstant(value.createdAt as string); parseInstant(value.updatedAt as string); return Object.freeze({ ...value, configuration }) as unknown as UsTestPublicState['workspace'];
  } catch { throw new UsTestOnboardingError('invalid_response', 200, 'rejected'); }
}
export function validateUsTestPublicState(input: unknown, requestId: string): UsTestPublicState {
  try {
    const value = exact(input, ['workspace', 'offers', 'purchase'], ['checkoutUrl']), workspace = validateUsTestPublicWorkspace(value.workspace, requestId), purchase = exact(value.purchase, ['state'], ['expiresAt', 'module', 'plan']);
    if (!['not_started', 'checkout_pending', 'ready'].includes(purchase.state as string) || Object.hasOwn(purchase, 'expiresAt') && (!Number.isSafeInteger(purchase.expiresAt) || (purchase.expiresAt as number) <= 0 || (purchase.expiresAt as number) > 253402300799) || !Array.isArray(value.offers) || value.offers.length > 20) throw new Error('Purchase');
    if (Object.hasOwn(purchase, 'module') !== Object.hasOwn(purchase, 'plan') || Object.hasOwn(purchase, 'module') && (!['gestion', 'complet'].includes(purchase.module as string) || typeof purchase.plan !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(purchase.plan))) throw new Error('Purchase offer');
    const seen = new Set<string>(), offers = value.offers.map(inputOffer => {
      const offer = exact(inputOffer, ['module', 'plan', 'catalogVersion', 'amountMinor', 'currency', 'interval', 'intervalCount', 'seatLimit']), identifier = String(offer.module) + ':' + String(offer.plan);
      if (!['gestion', 'complet'].includes(offer.module as string) || typeof offer.plan !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(offer.plan) || typeof offer.catalogVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(offer.catalogVersion) || typeof offer.amountMinor !== 'string' || !/^[1-9][0-9]{0,15}$/.test(offer.amountMinor) || BigInt(offer.amountMinor) > BigInt(Number.MAX_SAFE_INTEGER) || offer.currency !== 'USD' || !['month', 'year'].includes(offer.interval as string) || !Number.isSafeInteger(offer.intervalCount) || (offer.intervalCount as number) < 1 || !Number.isSafeInteger(offer.seatLimit) || (offer.seatLimit as number) < 1 || (offer.seatLimit as number) > 1000 || seen.has(identifier)) throw new Error('Offer');
      seen.add(identifier); return Object.freeze(offer) as unknown as UsTestPublicOffer;
    });
    return Object.freeze({ workspace, offers: Object.freeze(offers), purchase: Object.freeze(purchase) as UsTestPublicState['purchase'], ...(Object.hasOwn(value, 'checkoutUrl') ? { checkoutUrl: validateUsTestCheckoutUrl(value.checkoutUrl) } : {}) });
  } catch { throw new UsTestOnboardingError('invalid_response', 200, 'rejected'); }
}
export interface BrowserUsTestOnboardingSession {
  requestId(this: void): string | null; hasPendingCreation(this: void): boolean; hasPendingCheckout(this: void): boolean;
  create(this: void, draft: UsTestOnboardingDraft): Promise<UsTestPublicState>; retryCreation(this: void): Promise<UsTestPublicState>;
  load(this: void): Promise<UsTestPublicState>; checkout(this: void, offer: UsTestPublicOffer): Promise<UsTestPublicState>; reopenCheckout(this: void): Promise<UsTestPublicState>; retryCheckout(this: void): Promise<UsTestPublicState>; recover(this: void): Promise<UsTestPublicState>; dispose(this: void): void;
}
const known = new Set(['not_found', 'invalid_request', 'request_id_conflict', 'workspace_not_new', 'feature_unavailable', 'offer_unavailable', 'price_mismatch', 'purchase_pending', 'payment_unconfirmed', 'checkout_recovery_required', 'checkout_expired', 'workspace_confirmation_required', 'purchase_conflict', 'session_conflict', 'creation_changed', 'provider_mismatch', 'provider_unavailable', 'unsupported_payment', 'configuration_changed', 'binding_pending', 'rate_limited', 'admission_conflict', 'checkout_unavailable', 'service_unavailable']);
/** A single explicit operation at a time. Only the opaque request ID is passed
 * to the storage callback; original POST envelopes stay immutable in RAM. */
export function createBrowserUsTestOnboardingSession(options: { expectedUserId: string; requestId?: string | null; saveRequestId?(id: string): void; onAccessLost?(): void; fetch?: typeof globalThis.fetch; newId?: () => string; timeoutMs?: number }): BrowserUsTestOnboardingSession {
  creationUuid(options.expectedUserId); let id = options.requestId ? creationUuid(options.requestId) : null;
  const timeoutMs = options.timeoutMs ?? 30_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new UsTestOnboardingError('invalid_request', 422, 'rejected');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis), controllers = new Set<AbortController>(), cancelers = new Set<(error: UsTestOnboardingError) => void>();
  let disposed = false, busy = false, pendingCreation: string | null = null, pendingCheckout: string | null = null, latest: UsTestPublicState | null = null;
  const alive = () => { if (disposed) throw new UsTestOnboardingError('session_changed', 0, 'unauthorized'); };
  const remember = () => { if (!id) { id = creationUuid((options.newId ?? (() => crypto.randomUUID()))()); try { options.saveRequestId?.(id); } catch { /* RAM and the checkout return locator remain usable without storage. */ } } return id; };
  function dispose() { disposed = true; pendingCreation = pendingCheckout = null; latest = null; for (const controller of controllers) controller.abort(); controllers.clear(); for (const cancel of cancelers) cancel(new UsTestOnboardingError('session_changed', 0, 'unauthorized')); cancelers.clear(); }
  async function response(path: string, body?: string): Promise<unknown> {
    alive(); const outcome = body === undefined ? 'rejected' : 'uncertain', controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (error: UsTestOnboardingError) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new UsTestOnboardingError('response_timeout', 0, outcome)); }, timeoutMs); }), cancelled = new Promise<never>((_, reject) => { cancel = reject; cancelers.add(cancel); });
    const wait = <T>(task: Promise<T>) => Promise.race([task, deadline, cancelled]);
    try {
      const res = await wait(fetcher('/api/international/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', 'X-Zentra-Expected-User': options.expectedUserId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }), credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })); alive();
      if ([401, 402, 403].includes(res.status)) { dispose(); try { options.onAccessLost?.(); } catch { /* Access remains revoked even if the UI callback fails. */ } throw new UsTestOnboardingError('session_changed', res.status, 'unauthorized'); }
      const maximum = res.ok ? 65_536 : 4096, length = res.headers.get('Content-Length'); if (res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new UsTestOnboardingError('invalid_response', res.status, outcome);
      const reader = res.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
      if (reader) try { for (;;) { const part = await wait(reader.read()); alive(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { void reader.cancel(); throw new UsTestOnboardingError('invalid_response', res.status, outcome); } parts.push(part.value); } } finally { reader.releaseLock(); }
      else { const bytes = new Uint8Array(await wait(res.arrayBuffer())); alive(); if (bytes.length > maximum) throw new UsTestOnboardingError('invalid_response', res.status, outcome); size = bytes.length; parts.push(bytes); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new UsTestOnboardingError('invalid_response', res.status, outcome); } alive();
      if (!res.ok) { let code = 'service_unavailable'; try { const error = exact(raw, ['error']); if (typeof error.error === 'string' && known.has(error.error)) code = error.error; } catch { /* Never project raw provider/server messages. */ } throw new UsTestOnboardingError(code, res.status, outcome); }
      return raw;
    } catch (error) { if (error instanceof UsTestOnboardingError) throw error; alive(); throw new UsTestOnboardingError('response_unavailable', 0, outcome); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); cancelers.delete(cancel); }
  }
  async function operation<T>(work: () => Promise<T>): Promise<T> { alive(); if (busy) throw new UsTestOnboardingError('operation_pending', 409, 'rejected'); busy = true; try { return await work(); } finally { busy = false; } }
  async function load(): Promise<UsTestPublicState> {
    if (!id) throw new UsTestOnboardingError('not_found', 404, 'rejected'); const state = validateUsTestPublicState(await response(`billing/test?requestId=${encodeURIComponent(id)}`), id); alive();
    if (pendingCreation) { const original = JSON.parse(pendingCreation) as WorkspaceCreationRequest, { organizationId: _organizationId, ...configuration } = state.workspace.configuration; if (original.companyName !== state.workspace.companyName || canonicalCreationJson(original.configuration) !== canonicalCreationJson(configuration)) throw new UsTestOnboardingError('request_id_conflict', 409, 'uncertain'); pendingCreation = null; }
    if (state.purchase.state === 'ready' && state.workspace.state === 'ready') pendingCheckout = null; latest = state; return state;
  }
  async function sendCreation(): Promise<UsTestPublicState> {
    if (!pendingCreation || !id) throw new UsTestOnboardingError('no_pending_operation', 409, 'rejected');
    let raw: unknown; try { raw = await response('workspaces', pendingCreation); } catch (error) { if (error instanceof UsTestOnboardingError && error.code === 'invalid_request' && error.status === 422) { pendingCreation = null; throw new UsTestOnboardingError(error.code, error.status, 'rejected'); } throw error; }
    try { validateUsTestPublicWorkspace(raw, id); } catch { throw new UsTestOnboardingError('invalid_response', 200, 'uncertain'); } return load();
  }
  async function sendCheckout(): Promise<UsTestPublicState> {
    if (!pendingCheckout || !id) throw new UsTestOnboardingError('no_pending_operation', 409, 'rejected'); const result = validateUsTestPublicState(await response('billing/test', pendingCheckout), id), fresh = await load(); pendingCheckout = null; return Object.freeze({ ...fresh, checkoutUrl: result.checkoutUrl ?? null });
  }
  return {
    requestId: () => id, hasPendingCreation: () => pendingCreation !== null && !disposed, hasPendingCheckout: () => pendingCheckout !== null && !disposed, dispose,
    load: () => operation(load),
    create: draft => operation(async () => { if (pendingCreation || pendingCheckout || latest) throw new UsTestOnboardingError('operation_pending', 409, 'rejected'); const request = buildUsTestWorkspaceCreation(snapshotPrivateJson(draft) as UsTestOnboardingDraft, remember()); pendingCreation = canonicalCreationJson(request); return sendCreation(); }),
    retryCreation: () => operation(sendCreation),
    checkout: offer => operation(async () => { if (!id || pendingCreation || pendingCheckout || latest?.workspace.state !== 'postgres_confirmed' || latest.purchase.state !== 'not_started' || !latest.offers.some(candidate => canonicalCreationJson(candidate) === canonicalCreationJson(offer))) throw new UsTestOnboardingError('operation_pending', 409, 'rejected'); pendingCheckout = canonicalCreationJson({ requestId: id, module: offer.module, plan: offer.plan, confirmTest: true }); return sendCheckout(); }),
    reopenCheckout: () => operation(async () => { if (!id || pendingCreation || pendingCheckout || latest?.workspace.state !== 'postgres_confirmed' || latest.purchase.state !== 'checkout_pending' || !latest.purchase.module || !latest.purchase.plan) throw new UsTestOnboardingError('operation_pending', 409, 'rejected'); pendingCheckout = canonicalCreationJson({ requestId: id, module: latest.purchase.module, plan: latest.purchase.plan, confirmTest: true }); return sendCheckout(); }),
    retryCheckout: () => operation(sendCheckout),
    recover: () => operation(async () => { if (!id) throw new UsTestOnboardingError('not_found', 404, 'rejected'); validateUsTestPublicState(await response('billing/test/recover', canonicalCreationJson({ requestId: id })), id); pendingCreation = null; return load(); }),
  };
}
