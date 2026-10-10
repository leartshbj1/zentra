import { SupabaseServerError } from '../supabase-server';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import {
  validateUsFinancialPilotSellerHead, validateUsFinancialPilotSellerProof, validateUsFinancialPilotSellerRead, validateUsFinancialPilotSellerRequest,
  type UsFinancialPilotSellerAppend, type UsFinancialPilotSellerPort,
} from './us-financial-pilot-seller';

export type UsFinancialPilotSellerStore = UsFinancialPilotSellerPort;
type Client = { rpc(name: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> };
const fail = (code = 'invalid_financial_seller_data', status = 503): never => { throw new ErpError(code, status); };
const same = (a: unknown, b: unknown): boolean => canonicalErpJson(a) === canonicalErpJson(b);
const codes: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  SQ001: ['seller_revision_conflict', 409], SQ002: ['seller_idempotency_conflict', 409], SQ003: ['seller_clock_conflict', 409],
  SQ004: ['invalid_financial_seller_data', 503], SQ005: ['seller_limit_reached', 409], SQ006: ['financial_pilot_seller_required', 409], SQ007: ['financial_snapshot_changed', 409],
  PF001: ['financial_snapshot_changed', 409], PF002: ['idempotency_conflict', 409], PF004: ['invalid_financial_private_data', 503],
  PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409], PF007: ['financial_configuration_changed', 409],
  PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503], PF010: ['financial_append_unavailable', 409],
  PF011: ['financial_policy_unavailable', 409], PF016: ['financial_clock_reversed', 409],
});
function controlled(error: unknown): Error {
  try {
    if (error instanceof ErpError) return error;
    if (error instanceof SupabaseServerError) {
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      const mapped = code && 'value' in code && typeof code.value === 'string' && Object.hasOwn(codes, code.value) ? codes[code.value] : undefined;
      if (mapped) return new ErpError(...mapped);
    }
  } catch { /* Hostile exception prototypes/descriptors remain unavailable. */ }
  return new ErpError('financial_service_unavailable', 503);
}
/** Capture a data method without executing an accessor; real Supabase clients
 * put rpc on their prototype. The selected function cannot be swapped later. */
function rpcMethod(client: Client): Client['rpc'] {
  try {
    let current: object | null = client;
    for (let depth = 0; current && depth < 5; depth++, current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'rpc');
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') return fail();
        const method = descriptor.value as Client['rpc'];
        return (name, parameters) => Reflect.apply(method, client, [name, parameters]) as Promise<unknown>;
      }
    }
    return fail();
  } catch { return fail(); }
}
export function createSupabaseUsFinancialPilotSellerStore(client: Client, initialScope: UsFinancialPilotScope, revalidate: (this: void) => Promise<UsFinancialPilotScope>): UsFinancialPilotSellerStore {
  const bound = captureUsFinancialPilotScope(initialScope), rpc = rpcMethod(client);
  if (typeof revalidate !== 'function') return fail();
  let observedAt = Date.parse(bound.scope.actor.timestamp);
  async function fresh(): Promise<UsFinancialPilotScope> {
    const current = captureUsFinancialPilotScope(await revalidate()), a = bound.scope, b = current.scope;
    if (a.organizationId !== b.organizationId || a.actor.userId !== b.actor.userId || a.actor.role !== b.actor.role) return fail('financial_authority_changed', 403);
    if (a.grantVersion !== b.grantVersion || bound.optInVersion !== current.optInVersion) return fail('financial_test_grant_changed', 409);
    if (!same(a.policy, b.policy)) return fail('financial_policy_unavailable', 409);
    const instant = Date.parse(b.actor.timestamp); if (instant < observedAt) return fail('financial_clock_reversed', 409);
    observedAt = instant; return current;
  }
  async function run<T>(name: string, args: Readonly<Record<string, unknown>>, parse: (value: unknown) => Promise<T> | T, original?: UsFinancialPilotSellerAppend): Promise<T> {
    const current = await fresh(); let outcome: { value: T } | { error: unknown };
    try {
      if (original && (current.scope.actor.role !== 'owner' || original.proof.actor.userId !== current.scope.actor.userId || original.proof.actor.organizationId !== current.scope.organizationId)) return fail('financial_authority_changed', 403);
      const raw = snapshotPrivateJson(await rpc(name, { p_organization: bound.scope.organizationId, p_actor: original?.proof.actor ?? current.scope.actor,
        p_grant_version: bound.scope.grantVersion, p_opt_in_version: bound.optInVersion, p_capability: 'postgres-test-financial-pilot-dto1', ...args }));
      outcome = { value: await parse(raw) };
    } catch (error) { outcome = { error }; }
    await fresh(); if ('error' in outcome) throw controlled(outcome.error); return outcome.value;
  }
  return Object.freeze({
    read() { return run('zentra_read_us_financial_pilot_seller_test_v1', {}, raw => validateUsFinancialPilotSellerRead(raw, bound.scope.organizationId)); },
    head() { return run('zentra_us_financial_pilot_seller_test_head_v1', {}, raw => validateUsFinancialPilotSellerHead(raw, bound.scope.organizationId)); },
    receipt(requestId: string) {
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) return Promise.reject(new ErpError('invalid_financial_pilot_request', 422));
      return run('zentra_us_financial_pilot_seller_test_receipt_v1', { p_request_id: requestId }, async raw => {
        if (raw === null) return null;
        const proof = await validateUsFinancialPilotSellerProof(raw, bound.scope.organizationId);
        if (proof.request.requestId !== requestId || proof.actor.userId !== bound.scope.actor.userId) return fail();
        return proof;
      });
    },
    async append(value: UsFinancialPilotSellerAppend) {
      let captured: UsFinancialPilotSellerAppend;
      try {
        const raw = snapshotPrivateJson(value) as UsFinancialPilotSellerAppend;
        if (!raw || typeof raw !== 'object' || Reflect.ownKeys(raw).length !== 2 || !Object.hasOwn(raw, 'request') || !Object.hasOwn(raw, 'proof')) return fail();
        const request = validateUsFinancialPilotSellerRequest(raw.request), proof = await validateUsFinancialPilotSellerProof(raw.proof, bound.scope.organizationId, { request, actor: bound.scope.actor });
        captured = Object.freeze({ request, proof });
      } catch (error) { throw controlled(error); }
      return run('zentra_append_us_financial_pilot_seller_test_v1', { p_request: captured.request, p_proof: captured.proof }, async raw => {
        // A concurrent identical UUID may return its original historic actor
        // time. Compare identity/request, not this attempt's proposed clock.
        return validateUsFinancialPilotSellerProof(raw, bound.scope.organizationId, { request: captured.request, actor: captured.proof.actor });
      }, captured);
    },
  });
}
