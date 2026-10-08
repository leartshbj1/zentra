import { AccountPublicError, requireAccountSameOrigin, sha256Hex } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { ErpState } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { applyUsBankCommand, validateUsBankRecord, validateUsBankRequest } from './us-bank-reconciliation';
import type { UsBankReadResponse, UsBankReceipt, UsBankRecord, UsBankRequest, UsBankStore, UsBankWriteResponse } from './us-bank-contract';

export type UsBankServerDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion'> & {
  bankStore(clientSchemaVersion: ErpSchemaVersion): UsBankStore | Promise<UsBankStore>;
  rateLimit?: ErpServerDependencies['rateLimit'];
  diagnostic?: ErpServerDependencies['diagnostic'];
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const bodyLimit = 1_048_576, readLimit = 2_621_440;
const publicErrors: Readonly<Record<string, number>> = Object.freeze({
  invalid_request: 422, invalid_bank_request: 422, invalid_bank_record: 503, invalid_bank_statement: 422,
  bank_revision_conflict: 409, bank_idempotency_conflict: 409, bank_statement_overlap: 409,
  bank_statement_duplicate: 409, bank_entry_already_matched: 409, bank_statement_limit_reached: 409,
  bank_clock_reversed: 409, bank_erp_revision_conflict: 409, bank_permission_required: 403,
  bank_upgrade_required: 409, bank_limit_reached: 409, bank_statement_closed: 409, bank_store_limit: 503,
  tenant_mismatch: 403, session_changed: 401, unauthorized: 401, forbidden: 403,
  management_entitlement_required: 402, financial_permission_required: 403, edition_unavailable: 409,
  configuration_changed: 409, client_upgrade_required: 409, feature_unavailable: 404,
  rate_limited: 429, service_unavailable: 503,
  reconciliation_closed: 409, reconciliation_already_matched: 409, reconciliation_ledger_changed: 409,
  reconciliation_incomplete: 409, reconciliation_amount_mismatch: 422, reconciliation_not_found: 404,
  reconciliation_voided: 409, statement_not_voidable: 409, idempotency_conflict: 409,
  invalid_reconciliation_match: 422, statement_line_required: 422, ledger_entry_required: 422,
  cash_movement_required: 422, cash_account_required: 422, invalid_statement_date: 422,
  invalid_statement_period: 422, invalid_statement_amount: 422, statement_balance_mismatch: 422,
  invalid_bank_reference: 422, duplicate_statement_line: 422, statement_too_large: 422, currency_mismatch: 422,
});
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function financial(actor: FinancialAuthority): void {
  if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) throw new ErpError('financial_permission_required', 403);
}
function ceiling(value: unknown): void { if (value !== 4) throw new ErpError('bank_upgrade_required', 409); }
function book(input: ErpState | null, organizationId: string): ErpState {
  if (!input || input.schemaVersion !== 4) throw new ErpError('bank_upgrade_required', 409);
  if (input.configuration.organizationId !== organizationId || input.ledger.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
  if (input.configuration.country !== 'US' || input.configuration.currency !== 'USD' || input.ledger.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !Number.isSafeInteger(input.ledger.revision) || input.ledger.revision < 0 || input.ledger.revision > input.revision) throw new ErpError('invalid_bank_record', 503);
  return input;
}
function records(input: readonly UsBankRecord[], organizationId: string): readonly UsBankRecord[] {
  if (!Array.isArray(input) || input.length > 100) throw new ErpError('bank_store_limit', 503);
  const result = input.map(record => validateUsBankRecord(record, organizationId));
  if (new Set(result.map(record => record.reconciliation.statement.id)).size !== result.length) throw new ErpError('invalid_bank_record', 503);
  return Object.freeze(result);
}
function expectedReceipt(input: UsBankRequest, organizationId: string, actorId: string, commandHash: string): UsBankReceipt {
  return Object.freeze({ schemaVersion: 1, organizationId, actorId, commandHash,
    idempotencyKey: input.idempotencyKey, reconciliationId: input.reconciliationId, action: input.command.type,
    revision: input.command.type === 'create_statement' ? 0 : input.expectedReconciliationRevision! + 1,
    erpRevision: input.expectedErpRevision });
}
function receipt(input: unknown, expected: UsBankReceipt, replay: boolean): UsBankReceipt {
  let captured: unknown;
  try { captured = snapshotPrivateJson(input); } catch { throw new ErpError('invalid_bank_record', 503); }
  if (replay && captured && typeof captured === 'object' && !Array.isArray(captured)) {
    const identity = captured as Record<string, unknown>;
    if (identity.commandHash !== expected.commandHash || identity.actorId !== expected.actorId) throw new ErpError('bank_idempotency_conflict', 409);
  }
  if (canonicalErpJson(captured) !== canonicalErpJson(expected)) throw new ErpError('invalid_bank_record', 503);
  return expected;
}

/** Read/review only: one existing US ledger, no bank provider or journal mutation. */
export function createUsBankHandlers(dependencies: UsBankServerDependencies) {
  function failure(error: unknown, operation: 'read' | 'write'): Response {
    let code = 'service_unavailable', status = 503;
    if (error instanceof ErpError && publicErrors[error.code] === error.status) { code = error.code; status = error.status; }
    else if (error instanceof AccountPublicError && [401, 402, 403, 429].includes(error.status)) {
      status = error.status; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden';
    } else if (error instanceof RequestBodyError) { status = error.status; code = 'invalid_bank_request'; }
    else if (error instanceof LedgerError) {
      const candidate = error.message.toLowerCase();
      if (publicErrors[candidate] !== undefined) { code = candidate; status = publicErrors[candidate]; }
    }
    try { dependencies.diagnostic?.({ operation, code, status }); } catch { /* Optional telemetry never changes an operation. */ }
    return json({ error: code }, status);
  }
  async function handle(request: Request, organizationId: string, operation: 'read' | 'write'): Promise<Response> {
    let trusted: ErpReadAdmission | undefined, configuration: CompanyConfiguration | undefined, clientCapability: ErpSchemaVersion | undefined;
    async function revalidate(): Promise<FinancialAuthority> {
      if (!trusted) throw new ErpError('unauthorized', 401);
      // Configuration/capability failures cannot mask a concurrent revoked Auth,
      // tenant, actor, mode, role or entitlement. Authority is always read last.
      let pendingError: unknown;
      try {
        const current = await dependencies.configuration(trusted.actor);
        if (configuration && canonicalErpJson(current) !== canonicalErpJson(configuration)) throw new ErpError('configuration_changed', 409);
        if (clientCapability !== undefined) {
          if (dependencies.freshSupportedSchemaVersion) ceiling(await dependencies.freshSupportedSchemaVersion(clientCapability));
          else {
            ceiling((await dependencies.store(clientCapability)).supportedSchemaVersion ?? 1);
            ceiling((await dependencies.bankStore(clientCapability)).supportedSchemaVersion);
          }
        }
      } catch (error) { pendingError = error; }
      let available: boolean | undefined;
      try { available = await dependencies.enabled(); } catch (error) { pendingError ??= error; }
      const fresh = await dependencies.authority(request, organizationId);
      confirmErpExpectedUser(request, fresh); confirmErpReadAdmission(trusted, fresh); financial(fresh.actor);
      if (available === false) throw new ErpError('feature_unavailable', 404);
      if (pendingError !== undefined) throw pendingError;
      if (available !== true) throw new ErpError('service_unavailable', 503);
      return fresh.actor;
    }
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || new URL(request.url).search) throw new ErpError('invalid_request', 422);
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      const admitted = await dependencies.authority(request, organizationId);
      if (!['browser', 'device'].includes(admitted.mode)) throw new ErpError('unauthorized', 401);
      confirmErpExpectedUser(request, admitted);
      if (admitted.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      financial(admitted.actor);
      trusted = { mode: admitted.mode, actor: Object.freeze({ ...admitted.actor }) };
      if (operation === 'write' && trusted.mode === 'browser') requireAccountSameOrigin(request);
      await dependencies.rateLimit?.(request, trusted.actor, operation);
      configuration = snapshotPrivateJson(await dependencies.configuration(trusted.actor)) as CompanyConfiguration;
      if (configuration.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (configuration.country !== 'US' || configuration.currency !== 'USD') throw new ErpError('edition_unavailable', 409);
      clientCapability = erpClientSchemaVersion(request); ceiling(clientCapability);
      const erpStore = await dependencies.store(clientCapability); ceiling(erpStore.supportedSchemaVersion ?? 1);
      const bankStore = await dependencies.bankStore(clientCapability); ceiling(bankStore.supportedSchemaVersion);
      const state = book(await erpStore.read(organizationId), organizationId);
      if (operation === 'read') {
        const erpRevision = state.revision, ledgerRevision = state.ledger.revision;
        const currentRecords = records(await bankStore.list(trusted.actor), organizationId);
        const latest = book(await erpStore.read(organizationId), organizationId);
        if (latest.revision !== erpRevision || latest.ledger.revision !== ledgerRevision) throw new ErpError('bank_erp_revision_conflict', 409);
        const body: UsBankReadResponse = { schemaVersion: 1, organizationId, erpRevision, ledgerRevision, records: currentRecords };
        const encoded = JSON.stringify(body);
        if (new TextEncoder().encode(encoded).byteLength > readLimit) throw new ErpError('bank_store_limit', 503);
        await revalidate();
        return new Response(encoded, { headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      const input = validateUsBankRequest(await readJsonObjectWithinLimit(request, bodyLimit), organizationId);
      const commandHash = await sha256Hex(canonicalErpJson([organizationId, trusted.actor.userId, input]));
      const expected = expectedReceipt(input, organizationId, trusted.actor.userId, commandHash);
      // A receipt is recoverable after later ERP edits, but only after current
      // book4/captured capability and financial identity admission above.
      const previous = await bankStore.receipt(trusted.actor, input.idempotencyKey);
      if (previous !== null) {
        const result: UsBankWriteResponse = { receipt: receipt(previous, expected, true), replayed: true };
        await revalidate(); return json(result);
      }
      if (state.revision !== input.expectedErpRevision) throw new ErpError('bank_erp_revision_conflict', 409);
      const current = await bankStore.read(trusted.actor, input.reconciliationId);
      const captured = current === null ? null : validateUsBankRecord(current, organizationId);
      const siblings = records(await bankStore.list(trusted.actor), organizationId);
      const actor = await revalidate();
      const updated = applyUsBankCommand(captured, input, state.ledger, actor, siblings);
      const saved = await bankStore.commit({ actor, expectedErpRevision: input.expectedErpRevision,
        expectedReconciliationRevision: input.expectedReconciliationRevision, record: updated, receipt: expected });
      const result: UsBankWriteResponse = { receipt: receipt(saved, expected, false), replayed: false };
      // A late revocation or changed capability withholds an already committed
      // receipt; it cannot roll back a durable review. Preserve exact retries.
      await revalidate(); return json(result);
    } catch (error) {
      if (trusted) { try { await revalidate(); } catch (freshError) { return failure(freshError, operation); } }
      return failure(error, operation);
    }
  }
  return {
    GET: (request: Request, organizationId: string) => handle(request, organizationId, 'read'),
    POST: (request: Request, organizationId: string) => handle(request, organizationId, 'write'),
  };
}
