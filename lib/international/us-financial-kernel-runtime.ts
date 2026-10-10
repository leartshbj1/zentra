import { assertFinancialAuthority, validDate, type FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type { CompanyConfiguration } from './types';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialCreditCandidateV5, UsFinancialCreditInputV5, UsFinancialOperationV5, UsFinancialPaymentInputV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

type CreditCommand = Omit<UsFinancialCreditInputV5, 'idempotencyKey'> & Readonly<{ id: string }>;
type PaymentCommand = Omit<UsFinancialPaymentInputV5, 'idempotencyKey'> & Readonly<{ id: string }>;
/** Internal test runtime request. In particular, no caller can submit a tax
 * proof, journal, role, total, subscription grant or policy approval. */
export interface UsFinancialRequestV5 {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly command: CreditCommand | PaymentCommand;
}
export interface UsFinancialReceiptV5 {
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly revision: number;
  readonly entityId: string;
  readonly action: UsFinancialOperationV5['type'];
  readonly actorId: string;
}
export interface UsFinancialCommitV5 {
  readonly organizationId: string;
  readonly expectedRevision: number;
  readonly previousFingerprint: string;
  readonly book: UsFinancialBookV5;
  readonly receipt: UsFinancialReceiptV5;
  readonly actor: FinancialAuthority;
}
/** This is deliberately not ErpStore. There is no SQL/HTTP/native adapter
 * for this capability. A future durable adapter must atomically retain the
 * event (including pending fiscal plan) and receipt with the CAS. */
export interface UsFinancialKernelStoreV5 {
  readonly capability: 'memory-test-v5';
  read(this: void, organizationId: string): Promise<unknown>;
  receipt(this: void, organizationId: string, key: string): Promise<unknown>;
  commit(this: void, input: UsFinancialCommitV5): Promise<UsFinancialReceiptV5>;
}
export interface UsFinancialRuntimeDependenciesV5 {
  readonly configuration: CompanyConfiguration;
  readonly actor: FinancialAuthority;
  readonly policy: UsFinancialPolicyV5;
  readonly store: UsFinancialKernelStoreV5;
  revalidate(this: void): Promise<Readonly<{ configuration: CompanyConfiguration; actor: FinancialAuthority; policy: UsFinancialPolicyV5 }>>;
  /** Trusted server adapter, not browser JSON. It authorizes a durable plan;
   * it must never execute an external reversal before the ERP CAS. */
  resolveTax(this: void, input: Readonly<{ organizationId: string; actor: FinancialAuthority; idempotencyKey: string; commandHash: string; book: UsFinancialBookV5; candidate: UsFinancialCreditCandidateV5 }>): Promise<UsFinancialTaxProofV5>;
}
const fail = (code: string, status = 422): never => { throw new ErpError(code, status); };
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
function snapshot(value: unknown, code = 'invalid_financial_request', status = 422): unknown {
  try { return snapshotPrivateJson(value); } catch { return fail(code, status); }
}
function exact(value: unknown, fields: readonly string[], code = 'invalid_financial_request', status = 422): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return fail(code, status);
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail('invalid_financial_request');
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || value.startsWith('0000-') || !validDate(value)) return fail('invalid_financial_date');
  return value;
}
export function validateUsFinancialRequestV5(value: unknown): UsFinancialRequestV5 {
  const input = exact(snapshot(value), ['idempotencyKey', 'expectedRevision', 'command']);
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.idempotencyKey)) return fail('invalid_financial_request');
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 || (input.expectedRevision as number) >= Number.MAX_SAFE_INTEGER) return fail('invalid_financial_request');
  const raw = input.command as Record<string, unknown>;
  let command: CreditCommand | PaymentCommand;
  if (raw?.type === 'customer_credit') {
    const c = exact(raw, ['type', 'id', 'invoiceId', 'transactionDate', 'accountingDate', 'periodId', 'reason', 'selections']);
    if (!Array.isArray(c.selections) || c.selections.length < 1 || c.selections.length > 1000) return fail('invalid_financial_request');
    const ids = new Set<string>();
    const selections = c.selections.map(value => {
      const row = exact(value, ['lineId', 'quantityUnits']), lineId = text(row.lineId);
      if (ids.has(lineId) || typeof row.quantityUnits !== 'string' || !/^[1-9][0-9]{0,35}$/.test(row.quantityUnits)) return fail('invalid_financial_request');
      ids.add(lineId); return Object.freeze({ lineId, quantityUnits: row.quantityUnits });
    });
    command = { type: 'customer_credit', id: text(c.id), invoiceId: text(c.invoiceId), transactionDate: date(c.transactionDate), accountingDate: date(c.accountingDate), periodId: text(c.periodId), reason: text(c.reason, 500), selections: Object.freeze(selections) };
  } else if (raw?.type === 'customer_payment') {
    const c = exact(raw, ['type', 'id', 'invoiceId', 'amountMinor', 'paymentDate', 'accountingDate', 'periodId', 'reference']);
    if (typeof c.amountMinor !== 'string' || !/^[1-9][0-9]{0,35}$/.test(c.amountMinor)) return fail('invalid_financial_request');
    command = { type: 'customer_payment', id: text(c.id), invoiceId: text(c.invoiceId), amountMinor: c.amountMinor, paymentDate: date(c.paymentDate), accountingDate: date(c.accountingDate), periodId: text(c.periodId), reference: text(c.reference, 500) };
  } else return fail('invalid_financial_request');
  return Object.freeze({ idempotencyKey: text(input.idempotencyKey, 200), expectedRevision: input.expectedRevision as number, command: Object.freeze(command) });
}
function authority(value: unknown, organizationId: string): FinancialAuthority {
  const actor = exact(snapshot(value, 'service_unavailable', 503), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp'], 'service_unavailable', 503) as unknown as FinancialAuthority;
  if (actor.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (actor.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(actor.role)) return fail('financial_permission_required', 403);
  try { assertFinancialAuthority({ organizationId } as Parameters<typeof assertFinancialAuthority>[0], actor); } catch { return fail('service_unavailable', 503); }
  return actor;
}
function configuration(value: unknown, organizationId: string): CompanyConfiguration {
  let result: CompanyConfiguration;
  try { result = validateCompanyConfiguration(snapshot(value, 'service_unavailable', 503)); } catch { return fail('service_unavailable', 503); }
  if (result.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (result.country !== 'US' || result.currency !== 'USD' || result.accountingBasis !== 'accrual') return fail('financial_policy_unavailable', 409);
  return result;
}
function validateReceipt(value: unknown): UsFinancialReceiptV5 {
  const receipt = exact(snapshot(value, 'invalid_financial_receipt', 503), ['idempotencyKey', 'commandHash', 'revision', 'entityId', 'action', 'actorId'], 'invalid_financial_receipt', 503);
  if (!Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 1 || typeof receipt.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.commandHash) || !['customer_credit', 'customer_payment'].includes(receipt.action as string)) return fail('invalid_financial_receipt', 503);
  try { text(receipt.idempotencyKey, 200); text(receipt.entityId); text(receipt.actorId); } catch { return fail('invalid_financial_receipt', 503); }
  return receipt as unknown as UsFinancialReceiptV5;
}
async function requestHash(organizationId: string, actorId: string, request: UsFinancialRequestV5): Promise<string> {
  return sha256Hex(canonicalErpJson([organizationId, actorId, request]));
}
function eventRequest(book: UsFinancialBookV5): UsFinancialRequestV5 {
  const event = book.events.at(-1)!;
  const operation = event.operation;
  const { idempotencyKey, ...rest } = operation;
  const command = rest.type === 'customer_credit' ? (() => { const { taxProof: _proof, ...publicFields } = rest; return { ...publicFields, id: event.id }; })() : { ...rest, id: event.id };
  return validateUsFinancialRequestV5({ idempotencyKey, expectedRevision: event.revision - 1, command });
}
/** Real financial transitions, locally in TEST memory only. There is no
 * production gate, browser route, provider write or legacy store invocation. */
export async function executeUsFinancialKernelV5(deps: UsFinancialRuntimeDependenciesV5, input: unknown): Promise<UsFinancialReceiptV5> {
  const request = validateUsFinancialRequestV5(input);
  const rawActor = snapshot(deps.actor, 'service_unavailable', 503) as FinancialAuthority;
  const actor = authority(rawActor, rawActor?.organizationId);
  const config = configuration(deps.configuration, actor.organizationId);
  const policy = snapshot(deps.policy, 'service_unavailable', 503) as UsFinancialPolicyV5;
  if (deps.store.capability !== 'memory-test-v5') return fail('financial_capability_unavailable', 503);
  let lastActor = actor;
  async function current() {
    let raw: unknown;
    try { raw = await deps.revalidate(); } catch (error) { if (error instanceof ErpError) throw error; return fail('financial_service_unavailable', 503); }
    const fresh = exact(snapshot(raw, 'service_unavailable', 503), ['configuration', 'actor', 'policy'], 'service_unavailable', 503);
    const next = authority(fresh.actor, actor.organizationId);
    if (next.userId !== actor.userId) return fail('session_changed', 401);
    if (next.role !== actor.role) return fail('financial_authority_changed', 403);
    if (Date.parse(next.timestamp) < Date.parse(lastActor.timestamp)) return fail('financial_clock_reversed', 409);
    if (!same(configuration(fresh.configuration, actor.organizationId), config) || !same(fresh.policy, policy)) return fail('financial_configuration_changed', 409);
    if (deps.store.capability !== 'memory-test-v5') return fail('financial_capability_unavailable', 503);
    lastActor = next; return next;
  }
  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    await current();
    let value: T | undefined, error: unknown, failed = false;
    try { value = snapshot(await read(), 'invalid_financial_private_data', 503) as T; } catch (caught) { error = caught; failed = true; }
    await current();
    if (failed) { if (error instanceof ErpError) throw error; return fail('financial_service_unavailable', 503); }
    return value as T;
  }
  async function computed<T>(read: () => Promise<T>): Promise<T> {
    let value: T | undefined, error: unknown, failed = false;
    try { value = await read(); } catch (caught) { error = caught; failed = true; }
    // A revoked grant wins over source/business errors even when asynchronous
    // hashing or replay failed; do not reveal stale private facts on failure.
    await current();
    if (failed) throw error;
    return value as T;
  }
  async function readBook() {
    const raw = await guarded(() => deps.store.read(actor.organizationId));
    const book = await computed(() => validateUsFinancialBookV5(snapshot(raw, 'invalid_financial_book', 503), actor.organizationId, policy));
    if (!same(book.baseline.configuration, config)) return fail('financial_configuration_changed', 409);
    return book;
  }
  const commandHash = await requestHash(actor.organizationId, actor.userId, request);
  const previous = await guarded(() => deps.store.receipt(actor.organizationId, request.idempotencyKey));
  if (previous !== null) {
    const receipt = validateReceipt(previous);
    if (receipt.idempotencyKey !== request.idempotencyKey || receipt.commandHash !== commandHash || receipt.actorId !== actor.userId) return fail('idempotency_conflict', 409);
    const book = await readBook(), event = book.events.find(event => event.revision === receipt.revision);
    if (!event || event.id !== receipt.entityId || event.operation.type !== receipt.action || event.operation.idempotencyKey !== request.idempotencyKey || event.actor.userId !== receipt.actorId) return fail('invalid_financial_receipt', 503);
    const prefix = { ...book, revision: event.revision, events: book.events.filter(candidate => candidate.revision <= event.revision) };
    if (await requestHash(actor.organizationId, receipt.actorId, eventRequest(prefix)) !== commandHash) return fail('invalid_financial_receipt', 503);
    await current(); return receipt;
  }
  const book = await readBook();
  if (book.revision !== request.expectedRevision) return fail('revision_conflict', 409);
  const { id, ...command } = request.command;
  let operation: UsFinancialOperationV5;
  if (command.type === 'customer_credit') {
    const credit = { ...command, idempotencyKey: request.idempotencyKey };
    const candidate = await computed(() => buildUsFinancialCreditCandidateV5(book, credit));
    const taxProof = snapshot(await guarded(() => deps.resolveTax({ organizationId: actor.organizationId, actor: lastActor, idempotencyKey: request.idempotencyKey, commandHash, book, candidate })), 'invalid_financial_tax_proof', 503) as UsFinancialTaxProofV5;
    operation = { ...credit, taxProof };
  } else operation = { ...command, idempotencyKey: request.idempotencyKey };
  const freshBook = await readBook();
  if (!same(freshBook, book)) return fail('financial_source_changed', 409);
  const executionActor = await current();
  const result = await computed(() => applyUsFinancialOperationV5(book, operation, executionActor, id));
  const receipt: UsFinancialReceiptV5 = Object.freeze({ idempotencyKey: request.idempotencyKey, commandHash, revision: result.book.revision, entityId: id, action: operation.type, actorId: actor.userId });
  const previousFingerprint = await sha256Hex(canonicalErpJson(book));
  await current();
  // Commit adapters are responsible for authoritative permission/CAS checks
  // inside their transaction. This local adapter performs no external IO.
  const committed = validateReceipt(await guarded(() => deps.store.commit({ organizationId: actor.organizationId, expectedRevision: book.revision, previousFingerprint, book: result.book, receipt, actor: executionActor })));
  if (!same(committed, receipt)) return fail('invalid_financial_receipt', 503);
  return committed;
}

/** Reference atomic in-memory adapter for deterministic tests and pilots.
 * Process restart loses this book. It is not a production persistence layer. */
export async function createInMemoryUsFinancialKernelStoreV5(initial: UsFinancialBookV5, expectedPolicy: UsFinancialPolicyV5, authorizeCommit: (this: void, actor: FinancialAuthority) => FinancialAuthority): Promise<UsFinancialKernelStoreV5> {
  const capturedInitial = snapshot(initial, 'invalid_financial_book', 503) as UsFinancialBookV5;
  const capturedPolicy = snapshot(expectedPolicy, 'invalid_financial_book', 503) as UsFinancialPolicyV5;
  let current = await validateUsFinancialBookV5(capturedInitial, capturedInitial.baseline?.configuration?.organizationId, capturedPolicy);
  const organizationId = current.baseline.configuration.organizationId;
  const receipts = new Map<string, UsFinancialReceiptV5>();
  function admitCommit(actor: FinancialAuthority) {
    let fresh: FinancialAuthority;
    try { fresh = authority(authorizeCommit(actor), organizationId); } catch (error) { if (error instanceof ErpError) throw error; return fail('financial_service_unavailable', 503); }
    if (fresh.userId !== actor.userId || fresh.role !== actor.role) return fail('financial_authority_changed', 403);
    if (Date.parse(fresh.timestamp) < Date.parse(actor.timestamp)) return fail('financial_clock_reversed', 409);
  }
  // Seed receipts from actual validated events so restored TEST books retain
  // retry semantics instead of treating old keys as fresh operations.
  for (let index = 0; index < current.events.length; index++) {
    const event = current.events[index], prefix = { ...current, revision: event.revision, events: current.events.slice(0, index + 1) };
    receipts.set(event.operation.idempotencyKey, Object.freeze({ idempotencyKey: event.operation.idempotencyKey, commandHash: await requestHash(organizationId, event.actor.userId, eventRequest(prefix)), revision: event.revision, entityId: event.id, action: event.operation.type, actorId: event.actor.userId }));
  }
  return {
    capability: 'memory-test-v5',
    async read(org) { if (org !== organizationId) return fail('tenant_mismatch', 403); return current; },
    async receipt(org, key) { if (org !== organizationId) return fail('tenant_mismatch', 403); return receipts.get(key) ?? null; },
    async commit(input) {
      const captured = exact(snapshot(input, 'invalid_financial_commit', 503), ['organizationId', 'expectedRevision', 'previousFingerprint', 'book', 'receipt', 'actor'], 'invalid_financial_commit', 503) as unknown as UsFinancialCommitV5;
      if (!Number.isSafeInteger(captured.expectedRevision) || captured.expectedRevision < 1 || typeof captured.previousFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(captured.previousFingerprint)) return fail('invalid_financial_commit', 503);
      if (captured.organizationId !== organizationId) return fail('tenant_mismatch', 403);
      const actor = authority(captured.actor, organizationId), receipt = validateReceipt(captured.receipt);
      if (receipt.actorId !== actor.userId) return fail('financial_actor_mismatch', 403);
      admitCommit(actor);
      const previous = receipts.get(receipt.idempotencyKey);
      if (previous) { if (!same(previous, receipt)) return fail('idempotency_conflict', 409); return previous; }
      const before = current;
      if (before.revision !== captured.expectedRevision) return fail('revision_conflict', 409);
      if (await sha256Hex(canonicalErpJson(before)) !== captured.previousFingerprint) return fail('financial_source_changed', 409);
      const next = await validateUsFinancialBookV5(captured.book, organizationId, capturedPolicy);
      if (next.revision !== before.revision + 1 || next.events.length !== before.events.length + 1 || !same(next.baseline, before.baseline) || !same(next.policy, before.policy) || !same(next.promotion, before.promotion) || !same(next.events.slice(0, -1), before.events)) return fail('invalid_financial_commit', 503);
      const event = next.events.at(-1)!;
      if (receipt.revision !== next.revision || receipt.entityId !== event.id || receipt.action !== event.operation.type || receipt.idempotencyKey !== event.operation.idempotencyKey || receipt.actorId !== actor.userId || !same(event.actor, actor) || receipt.commandHash !== await requestHash(organizationId, actor.userId, eventRequest(next))) return fail('invalid_financial_commit', 503);
      // The critical CAS and both writes have no intervening await. A second
      // concurrent operation can never overwrite a previously admitted event.
      // TEST authority is observed synchronously at that same boundary; this
      // does not replace transaction-local checks in a future durable store.
      admitCommit(actor);
      if (current !== before || current.revision !== captured.expectedRevision) return fail('revision_conflict', 409);
      const concurrent = receipts.get(receipt.idempotencyKey);
      if (concurrent) { if (!same(concurrent, receipt)) return fail('idempotency_conflict', 409); return concurrent; }
      current = next; receipts.set(receipt.idempotencyKey, receipt); return receipt;
    },
  };
}
