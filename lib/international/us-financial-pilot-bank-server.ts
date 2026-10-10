import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration } from './types';
import { executeUsFinancialPilotBank, US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES, US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES, validateUsFinancialPilotBankHead, validateUsFinancialPilotBankReceipt, validateUsFinancialPilotBankRequest, type UsFinancialPilotBankPort, type UsFinancialPilotBankRead } from './us-financial-pilot-bank';
import { projectUsFinancialPilotBankContext, projectUsFinancialPilotBankList, projectUsFinancialPilotBankStatement, projectUsFinancialPilotBankMovements, validateUsFinancialPilotBankQuery, validateUsFinancialPilotBankListQuery, validateUsFinancialPilotBankDetailQuery, validateUsFinancialPilotBankMovementQuery, validateUsFinancialPilotBankContext, validateUsFinancialPilotBankStatementsPage, validateUsFinancialPilotBankStatementDetail, validateUsFinancialPilotBankMovementsPage } from './us-financial-pilot-bank-projection';
import { UsFinancialPilotError } from './us-financial-pilot-contract';
import type { UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { creationUuid } from './workspace-creation';

export type UsFinancialPilotBankDependencies = Omit<UsFinancialPilotDependencies, 'store'> & {
  store(this: void, scope: UsFinancialPilotScope, revalidate: () => Promise<UsFinancialPilotScope>): Promise<UsFinancialPilotBankPort> | UsFinancialPilotBankPort;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot' };
const unavailable = (): never => { throw new ErpError('financial_service_unavailable', 503); };
const codes: Readonly<Record<string, readonly number[]>> = {
  unauthorized: [401], session_changed: [401], forbidden: [403], tenant_mismatch: [403], management_entitlement_required: [402], financial_permission_required: [403],
  feature_unavailable: [404], financial_pilot_unavailable: [404], financial_pilot_opt_in_required: [403], financial_pilot_opt_in_changed: [409], financial_test_grant_required: [403], financial_test_grant_changed: [409], financial_authority_changed: [403], financial_configuration_changed: [409], financial_policy_unavailable: [409], financial_upgrade_required: [409], financial_capability_unavailable: [409, 503], financial_book_too_large: [413], financial_snapshot_changed: [409], financial_book_required: [409], financial_source_changed: [409], financial_clock_reversed: [409], financial_immutable: [409], financial_append_unavailable: [409],
  invalid_financial_pilot_request: [422], invalid_financial_pilot_query: [422], invalid_financial_pilot_cursor: [422], invalid_financial_request: [422], invalid_financial_date: [422],
  invalid_financial_pilot_bank_request: [422], invalid_financial_pilot_bank_query: [422], invalid_financial_pilot_bank_cursor: [422], bank_snapshot_changed: [409], bank_record_not_found: [404], bank_legacy_frozen: [409], bank_legacy_pending: [409], bank_capacity_exceeded: [413], bank_duplicate_statement: [409], bank_overlap: [409], bank_entry_claimed: [409], bank_statement_closed: [409],
  bank_revision_conflict: [409], bank_idempotency_conflict: [409], bank_statement_overlap: [409], bank_entry_already_matched: [409], invalid_bank_request: [422], bank_limit_reached: [409], bank_statement_duplicate: [409], bank_operation_limit_reached: [409], bank_legacy_immutable: [409], bank_clock_reversed: [409], bank_statement_limit_reached: [409], reconciliation_not_found: [404], reconciliation_voided: [409], reconciliation_closed: [409], statement_not_voidable: [409],
  cash_account_required: [422], reconciliation_ledger_changed: [409], reconciliation_incomplete: [409], reconciliation_already_matched: [409], reconciliation_amount_mismatch: [422], statement_line_required: [422], ledger_entry_required: [422], cash_movement_required: [422], invalid_bank_statement: [422],
  revision_conflict: [409], idempotency_conflict: [409], rate_limited: [429], invalid_request: [400, 413, 415, 422], edition_unavailable: [409], configuration_changed: [409], method_not_allowed: [405],
};
const ledgerCodes: Readonly<Record<string, readonly [string, number]>> = {
  INVALID_MINOR_AMOUNT: ['invalid_amount', 422], INVALID_DATE: ['invalid_date', 422], INVALID_BANK_REFERENCE: ['invalid_bank_reference', 422], INVALID_STATEMENT_AMOUNT: ['invalid_statement_amount', 422], INVALID_STATEMENT_PERIOD: ['invalid_statement_period', 422], INVALID_STATEMENT_DATE: ['invalid_statement_date', 422], STATEMENT_TOO_LARGE: ['bank_capacity_exceeded', 413], DUPLICATE_STATEMENT_LINE: ['duplicate_statement_line', 422], STATEMENT_BALANCE_MISMATCH: ['statement_balance_mismatch', 422], CASH_ACCOUNT_REQUIRED: ['cash_account_required', 422], CURRENCY_MISMATCH: ['currency_mismatch', 422], TENANT_MISMATCH: ['tenant_mismatch', 403],
  REVISION_CONFLICT: ['revision_conflict', 409], IDEMPOTENCY_CONFLICT: ['idempotency_conflict', 409], INVALID_RECONCILIATION_MATCH: ['invalid_reconciliation_match', 422], RECONCILIATION_CLOSED: ['bank_statement_closed', 409], RECONCILIATION_ALREADY_MATCHED: ['bank_entry_claimed', 409], STATEMENT_LINE_REQUIRED: ['statement_line_required', 422], LEDGER_ENTRY_REQUIRED: ['ledger_entry_required', 422], CASH_MOVEMENT_REQUIRED: ['cash_movement_required', 422], RECONCILIATION_AMOUNT_MISMATCH: ['reconciliation_amount_mismatch', 422], RECONCILIATION_INCOMPLETE: ['reconciliation_incomplete', 409], RECONCILIATION_LEDGER_CHANGED: ['bank_snapshot_changed', 409],
};
function failure(error: unknown, operation: 'read' | 'write', diagnostic: UsFinancialPilotDependencies['diagnostic']): Response {
  let status = 503, code = 'financial_service_unavailable';
  try {
    const s = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status') : undefined;
    const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (error instanceof AccountPublicError && s && 'value' in s && [401, 402, 403, 429].includes(s.value as number)) { status = s.value as number; code = status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : status === 429 ? 'rate_limited' : 'forbidden'; }
    else if (error instanceof RequestBodyError && s && 'value' in s && [400, 413, 415].includes(s.value as number)) { status = s.value as number; code = 'invalid_request'; }
    else if ((error instanceof ErpError || error instanceof UsFinancialPilotError) && c && s && 'value' in c && 'value' in s && typeof c.value === 'string' && Object.hasOwn(codes, c.value) && codes[c.value].includes(s.value as number)) { code = c.value; status = s.value as number; }
    else if (error instanceof LedgerError && c && 'value' in c && typeof c.value === 'string' && Object.hasOwn(ledgerCodes, c.value)) [code, status] = ledgerCodes[c.value];
  } catch { /* Never execute exception accessors or expose private text. */ }
  try { diagnostic({ operation, code, status }); } catch { /* Telemetry is not authority. */ }
  return Response.json({ error: code }, { status, headers: { ...headers, ...(status === 405 ? { Allow: operation === 'write' ? 'POST' : 'GET' } : {}) } });
}
function admissionSnapshot(value: unknown): ErpReadAdmission {
  const a = snapshotPrivateJson(value) as ErpReadAdmission;
  if (!a || Reflect.ownKeys(a).length !== 2 || !Object.hasOwn(a, 'mode') || !Object.hasOwn(a, 'actor') || !['browser', 'device'].includes(a.mode) || !a.actor || Reflect.ownKeys(a.actor).length !== 5 || !['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'].every(k => Object.hasOwn(a.actor, k))) return unavailable();
  if (typeof a.actor.organizationId !== 'string' || typeof a.actor.userId !== 'string' || !a.actor.userId || a.actor.userId !== a.actor.userId.trim() || a.actor.userId.length > 256 || Array.from(a.actor.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || typeof a.actor.managementEntitled !== 'boolean' || typeof a.actor.timestamp !== 'string' || !Number.isFinite(Date.parse(a.actor.timestamp)) || !['owner', 'admin', 'accountant', 'member', 'read_only'].includes(a.actor.role)) return unavailable();
  return a;
}
function capturedStore(input: UsFinancialPilotBankPort): UsFinancialPilotBankPort {
  const method = <K extends keyof UsFinancialPilotBankPort>(key: K): UsFinancialPilotBankPort[K] => { const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable(); return d.value.bind(undefined) as UsFinancialPilotBankPort[K]; };
  return Object.freeze({ read: method('read'), receipt: method('receipt'), commit: method('commit'), head: method('head') });
}
/** Capture the two independently bounded snapshots, never double their budget
 * by feeding a book+register envelope through one JSON capture. */
function capturedRead(input: unknown): UsFinancialPilotBankRead {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) return unavailable();
  const b = Object.getOwnPropertyDescriptor(input, 'book'), r = Object.getOwnPropertyDescriptor(input, 'register');
  if (!b || !r || !b.enumerable || !r.enumerable || !('value' in b) || !('value' in r)) return unavailable();
  return Object.freeze({ book: snapshotPrivateJson(b.value) as UsFinancialPilotBankRead['book'], register: snapshotPrivateJson(r.value) as UsFinancialPilotBankRead['register'] });
}
type Kind = 'head' | 'context' | 'list' | 'statement' | 'movements';
function query(request: Request, kind: Kind | 'operation', statementId?: string) {
  const write = kind === 'operation';
  if (request.method !== (write ? 'POST' : 'GET')) throw new ErpError('method_not_allowed', 405);
  if (request.url.length > 4096) throw new ErpError('invalid_financial_pilot_bank_request', 422);
  const allowed = write || kind === 'head' ? [] : kind === 'context' ? ['revision', 'bankRevision'] : kind === 'list' ? ['revision', 'bankRevision', 'cursor'] : kind === 'statement' ? ['revision', 'bankRevision', 'origin', 'lineCursor', 'matchCursor'] : ['revision', 'bankRevision', 'origin', 'cursor'];
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ErpError('invalid_financial_pilot_bank_query', 422);
  if (write || kind === 'head') return undefined;
  const number = (name: string, minimum: number) => { const raw = params.get(name); if (raw === null || !(minimum === 0 ? /^(0|[1-9][0-9]{0,15})$/ : /^[1-9][0-9]{0,15}$/).test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) >= Number.MAX_SAFE_INTEGER) throw new ErpError('invalid_financial_pilot_bank_query', 422); return Number(raw); };
  const common = { revision: number('revision', 1), bankRevision: number('bankRevision', 0) };
  const optional = (name: string) => params.has(name) ? { [name]: params.get(name) } : {};
  if (kind === 'context') return validateUsFinancialPilotBankQuery(common);
  if (kind === 'list') return validateUsFinancialPilotBankListQuery({ ...common, ...optional('cursor') });
  if (kind === 'statement') return validateUsFinancialPilotBankDetailQuery({ ...common, statementId, origin: params.get('origin'), ...optional('lineCursor'), ...optional('matchCursor') });
  return validateUsFinancialPilotBankMovementQuery({ ...common, statementId, origin: params.get('origin'), ...optional('cursor') });
}

/** Directly testable private handlers. No route or public/native dispatcher is
 * installed by this phase. Every success and source-dependent error is fenced. */
export function createUsFinancialPilotBankHandlers(input: UsFinancialPilotBankDependencies) {
  const bind = <K extends keyof UsFinancialPilotBankDependencies>(key: K): UsFinancialPilotBankDependencies[K] => { const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !('value' in d) || typeof d.value !== 'function') return unavailable(); return d.value.bind(undefined) as UsFinancialPilotBankDependencies[K]; };
  const deps = Object.freeze({ enabled: bind('enabled'), authority: bind('authority'), configuration: bind('configuration'), scope: bind('scope'), store: bind('store'), rateLimit: bind('rateLimit'), diagnostic: bind('diagnostic') });
  async function run(supplied: Request, organizationId: string, kind: Kind | 'operation', statementId?: string): Promise<Response> {
    const request = new Request(supplied), operation = kind === 'operation' ? 'write' : 'read';
    let trusted: ErpReadAdmission | undefined, scope: UsFinancialPilotScope | undefined, configuration: CompanyConfiguration | undefined;
    async function authority() {
      const fresh = admissionSnapshot(await deps.authority(request, organizationId)); confirmErpExpectedUser(request, fresh);
      if (fresh.mode !== 'browser') throw new ErpError('forbidden', 403);
      if (fresh.actor.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
      if (!fresh.actor.managementEntitled) throw new ErpError('management_entitlement_required', 402);
      if (!['owner', 'admin', 'accountant'].includes(fresh.actor.role)) throw new ErpError('financial_permission_required', 403);
      if (trusted) confirmErpReadAdmission(trusted, fresh); return fresh;
    }
    async function admission(): Promise<UsFinancialPilotScope> {
      const fresh = await authority(); if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      const config = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(fresh.actor)));
      if (config.organizationId !== organizationId || config.country !== 'US' || config.currency !== 'USD' || config.accountingBasis !== 'accrual') throw new ErpError('edition_unavailable', 409);
      if (configuration && canonicalErpJson(configuration) !== canonicalErpJson(config)) throw new ErpError('financial_configuration_changed', 409);
      const current = captureUsFinancialPilotScope(await deps.scope(fresh.actor, scope));
      if (current.scope.organizationId !== organizationId || current.scope.actor.userId !== fresh.actor.userId || current.scope.actor.role !== fresh.actor.role) throw new ErpError('financial_authority_changed', 403);
      if (scope && current.optInVersion !== scope.optInVersion) throw new ErpError('financial_pilot_opt_in_changed', 409);
      if (scope && current.scope.grantVersion !== scope.scope.grantVersion) throw new ErpError('financial_test_grant_changed', 409);
      if (scope && canonicalErpJson(current.scope.policy) !== canonicalErpJson(scope.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
      await authority(); if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      if (request.signal.aborted) return unavailable(); return current;
    }
    try {
      if (request.headers.has('Authorization')) throw new ErpError('forbidden', 403);
      if (request.headers.get('X-Zentra-Financial-Pilot') !== '1' || !request.headers.get('X-Zentra-Expected-User')) throw new ErpError('invalid_financial_pilot_bank_request', 422);
      try { creationUuid(organizationId); } catch { throw new ErpError('invalid_financial_pilot_bank_request', 422); }
      const parsed = query(request, kind, statementId), pathname = new URL(request.url).pathname;
      const path = kind === 'operation' ? 'operations' : kind === 'list' ? 'statements' : kind === 'statement' || kind === 'movements' ? `statements/${encodeURIComponent(statementId ?? '')}${kind === 'movements' ? '/movements' : ''}` : kind;
      if (pathname !== `/api/international/workspaces/${organizationId}/financial-pilot/bank/${path}`) throw new ErpError('invalid_financial_pilot_bank_request', 422);
      if (operation === 'write') requireAccountSameOrigin(request);
      const site = request.headers.get('Sec-Fetch-Site'), suppliedOrigin = request.headers.get('Origin');
      if (suppliedOrigin ? suppliedOrigin !== new URL(request.url).origin : !['same-origin', 'none'].includes(site ?? '')) throw new ErpError('forbidden', 403);
      if (site && !['same-origin', 'none'].includes(site)) throw new ErpError('forbidden', 403);
      if (!await deps.enabled()) throw new ErpError('feature_unavailable', 404);
      trusted = await authority(); await deps.rateLimit(request, trusted.actor, operation);
      configuration = validateCompanyConfiguration(snapshotPrivateJson(await deps.configuration(trusted.actor)));
      scope = await admission(); const store = capturedStore(await deps.store(scope, admission)); await admission();
      let result: unknown;
      if (kind === 'operation') {
        const inputRequest = validateUsFinancialPilotBankRequest(await readJsonObjectWithinLimit(request, US_FINANCIAL_PILOT_BANK_MAX_BODY_BYTES)); await admission();
        const output = await executeUsFinancialPilotBank({ organizationId, actor: scope.scope.actor, policy: scope.scope.policy, store, revalidate: async () => { const current = await admission(); return { actor: current.scope.actor, policy: current.scope.policy }; } }, inputRequest);
        result = validateUsFinancialPilotBankReceipt(output.receipt, organizationId, inputRequest);
      } else if (kind === 'head') result = validateUsFinancialPilotBankHead(await store.head(), organizationId);
      else {
        const read = capturedRead(await store.read()); await admission();
        if (kind === 'context') { const q = validateUsFinancialPilotBankQuery(parsed); result = validateUsFinancialPilotBankContext(await projectUsFinancialPilotBankContext(read.book, read.register, q), organizationId, q); }
        else if (kind === 'list') { const q = validateUsFinancialPilotBankListQuery(parsed); result = validateUsFinancialPilotBankStatementsPage(await projectUsFinancialPilotBankList(read.book, read.register, q), organizationId, q); }
        else if (kind === 'statement') { const q = validateUsFinancialPilotBankDetailQuery(parsed); result = validateUsFinancialPilotBankStatementDetail(await projectUsFinancialPilotBankStatement(read.book, read.register, q), organizationId, q); }
        else { const q = validateUsFinancialPilotBankMovementQuery(parsed); result = validateUsFinancialPilotBankMovementsPage(await projectUsFinancialPilotBankMovements(read.book, read.register, q), organizationId, q); }
        await admission(); const head = validateUsFinancialPilotBankHead(await store.head(), organizationId);
        if (head.revision !== parsed!.revision || head.bankRevision !== parsed!.bankRevision) throw new ErpError('financial_snapshot_changed', 409);
      }
      const body = JSON.stringify(result); if (new TextEncoder().encode(body).byteLength > US_FINANCIAL_PILOT_BANK_MAX_RESPONSE_BYTES) throw new ErpError('financial_book_too_large', 413);
      await admission(); return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch (error) {
      let latest = error;
      if (trusted) try { await admission(); } catch (fresh) { latest = fresh; }
      return failure(latest, operation, deps.diagnostic);
    }
  }
  return Object.freeze({
    HEAD: (request: Request, organizationId: string) => run(request, organizationId, 'head'),
    CONTEXT: (request: Request, organizationId: string) => run(request, organizationId, 'context'),
    STATEMENTS: (request: Request, organizationId: string) => run(request, organizationId, 'list'),
    STATEMENT: (request: Request, organizationId: string, statementId: string) => run(request, organizationId, 'statement', statementId),
    MOVEMENTS: (request: Request, organizationId: string, statementId: string) => run(request, organizationId, 'movements', statementId),
    POST: (request: Request, organizationId: string) => run(request, organizationId, 'operation'),
  });
}
