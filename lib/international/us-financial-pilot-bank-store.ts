import { SupabaseServerError } from '../supabase-server';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { validateUsBankRecord } from './us-bank-reconciliation';
import { validateUsFinancialBookV5 } from './us-financial-kernel';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { usFinancialPilotBankCommandHash, validateUsFinancialPilotBankHead, validateUsFinancialPilotBankHistory, validateUsFinancialPilotBankOperationProof, validateUsFinancialPilotBankRegister, validateUsFinancialPilotBankRequest, type UsFinancialPilotBankCommit, type UsFinancialPilotBankPort, type UsFinancialPilotBankRead } from './us-financial-pilot-bank';

export type UsFinancialPilotBankStore = UsFinancialPilotBankPort;
type Client = { rpc(name: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> };
const capability = 'postgres-test-financial-pilot-dto1';
const fail = (code = 'invalid_bank_record', status = 503): never => { throw new ErpError(code, status); };
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const codes: Readonly<Record<string, readonly [string, number]>> = Object.freeze({
  BQ001: ['bank_revision_conflict', 409], BQ002: ['bank_idempotency_conflict', 409], BQ003: ['bank_statement_overlap', 409],
  BQ004: ['bank_entry_already_matched', 409], BQ005: ['invalid_bank_request', 422], BQ009: ['bank_limit_reached', 409],
  BQ010: ['invalid_bank_record', 503], BQ011: ['bank_statement_closed', 409], BQ012: ['bank_statement_duplicate', 409], BQ013: ['bank_legacy_pending', 409],
  PF001: ['revision_conflict', 409], PF002: ['idempotency_conflict', 409], PF003: ['financial_immutable', 409], PF004: ['invalid_financial_private_data', 503],
  PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409], PF007: ['financial_configuration_changed', 409],
  PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503], PF011: ['financial_policy_unavailable', 409], PF012: ['financial_book_too_large', 413], PF016: ['financial_clock_reversed', 409],
});
function controlled(error: unknown): Error {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const mapped = code && 'value' in code && typeof code.value === 'string' && Object.hasOwn(codes, code.value) ? codes[code.value] : undefined;
    if (mapped) return new ErpError(...mapped);
  }
  return new ErpError('financial_service_unavailable', 503);
}
/** Only capture the envelope here: book and register have independent bounds.
 * Capturing their concatenation would make valid financial growth depend on
 * unrelated bank history size. Neither member can invoke an accessor. */
function envelope(value: unknown): { book: unknown; register: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2) return fail();
  const book = Object.getOwnPropertyDescriptor(value, 'book'), register = Object.getOwnPropertyDescriptor(value, 'register');
  if (!book || !register || !book.enumerable || !register.enumerable || !('value' in book) || !('value' in register)) return fail();
  return { book: snapshotPrivateJson(book.value), register: snapshotPrivateJson(register.value) };
}
export function createSupabaseUsFinancialPilotBankStore(client: Client, initialScope: UsFinancialPilotScope, revalidate: (this: void) => Promise<UsFinancialPilotScope>): UsFinancialPilotBankStore {
  const bound = captureUsFinancialPilotScope(initialScope), rpc = client.rpc.bind(client);
  if (typeof revalidate !== 'function') return fail('financial_test_grant_required', 403);
  let observedAt = Date.parse(bound.scope.actor.timestamp);
  async function fresh(): Promise<UsFinancialPilotScope> {
    const current = captureUsFinancialPilotScope(await revalidate()), a = bound.scope, b = current.scope;
    if (a.organizationId !== b.organizationId || a.actor.userId !== b.actor.userId || a.actor.role !== b.actor.role) return fail('financial_authority_changed', 403);
    if (a.grantVersion !== b.grantVersion || bound.optInVersion !== current.optInVersion) return fail('financial_test_grant_changed', 409);
    if (!same(a.policy, b.policy)) return fail('financial_policy_unavailable', 409);
    if (Date.parse(b.actor.timestamp) < observedAt) return fail('financial_clock_reversed', 409);
    observedAt = Date.parse(b.actor.timestamp); return current;
  }
  const parameters = (scope: UsFinancialPilotScope) => ({ p_organization: bound.scope.organizationId, p_actor: scope.scope.actor, p_grant_version: bound.scope.grantVersion, p_opt_in_version: bound.optInVersion, p_capability: capability });
  async function run<T>(name: string, args: Readonly<Record<string, unknown>>, parse: (this: void, value: unknown) => Promise<T> | T, original?: UsFinancialPilotBankCommit): Promise<T> {
    const current = await fresh();
    let outcome: { value: T } | { error: unknown };
    try {
      if (original && (original.proof.actor.organizationId !== current.scope.organizationId || original.proof.actor.userId !== current.scope.actor.userId || original.proof.actor.role !== current.scope.actor.role)) return fail('financial_authority_changed', 403);
      const value = await rpc(name, { ...parameters(current), ...args, ...(original ? { p_actor: original.proof.actor } : {}) });
      outcome = { value: await parse(value) };
    } catch (error) { outcome = { error }; }
    await fresh();
    if ('error' in outcome) throw controlled(outcome.error);
    return outcome.value;
  }
  return Object.freeze({
    read(): Promise<UsFinancialPilotBankRead> {
      return run('zentra_read_us_financial_pilot_bank_test_v1', {}, async value => {
        const captured = envelope(value), book = await validateUsFinancialBookV5(captured.book, bound.scope.organizationId, bound.scope.policy);
        const register = validateUsFinancialPilotBankRegister(captured.register, bound.scope.organizationId);
        await validateUsFinancialPilotBankHistory(book, register);
        return Object.freeze({ book, register });
      });
    },
    head() { return run('zentra_us_financial_pilot_bank_test_head_v1', {}, value => validateUsFinancialPilotBankHead(value, bound.scope.organizationId)); },
    receipt(requestId: string) {
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) return Promise.reject(new ErpError('invalid_bank_request', 422));
      return run('zentra_us_financial_pilot_bank_test_receipt_v1', { p_request_id: requestId }, async value => {
        if (value === null) return null;
        const proof = validateUsFinancialPilotBankOperationProof(value, bound.scope.organizationId);
        if (proof.request.requestId !== requestId || proof.actor.userId !== bound.scope.actor.userId || proof.commandHash !== await usFinancialPilotBankCommandHash(bound.scope.organizationId, proof.actor.userId, proof.request)) return fail();
        return proof;
      });
    },
    commit(input: UsFinancialPilotBankCommit) {
      // Synchronous capture precedes all authority/RPC awaits, including hash.
      let captured: UsFinancialPilotBankCommit;
      try {
        const value = snapshotPrivateJson(input) as UsFinancialPilotBankCommit;
        if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !['request', 'proof', 'record'].every(k => Object.hasOwn(value, k))) return fail('invalid_bank_request', 422);
        const request = validateUsFinancialPilotBankRequest(value.request), proof = validateUsFinancialPilotBankOperationProof(value.proof, bound.scope.organizationId);
        if (!value.record || Object.keys(value.record).length !== 2 || !['origin', 'record'].every(k => Object.hasOwn(value.record, k)) || value.record.origin !== 'financial-v5') return fail('invalid_bank_request', 422);
        const record = validateUsBankRecord(value.record.record, bound.scope.organizationId);
        if (!same(proof.request, request) || record.reconciliation.statement.id !== proof.statementId || record.reconciliation.revision !== proof.statementRevision) return fail('invalid_bank_request', 422);
        captured = Object.freeze({ request, proof, record: Object.freeze({ origin: 'financial-v5', record }) });
      } catch (error) { return Promise.reject(controlled(error)); }
      return run('zentra_commit_us_financial_pilot_bank_test_v1', { p_request: captured.request, p_record: captured.record.record, p_proof: captured.proof }, async value => {
        const proof = validateUsFinancialPilotBankOperationProof(value, bound.scope.organizationId);
        if (!same(proof, captured.proof) || proof.commandHash !== await usFinancialPilotBankCommandHash(bound.scope.organizationId, proof.actor.userId, captured.request)) return fail();
        return proof;
      }, captured);
    },
  });
}
