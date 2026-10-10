import { assertFinancialAuthority, postJournal, validDate, type FinancialAuthority } from './accounting/ledger';
import { postCustomerPayment } from './accounting/postings';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { lineTotals, recordCustomerPayment, type IssuedInvoice } from './invoicing';
import { parseInstant } from './localization';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import { validateStoredErp } from './runtime-validation';
import type { ErpState } from './runtime-types';
import { transitionUsFinancialErpV5, validateUsFinancialErpOperationV5 } from './us-financial-kernel-erp';
import { prepareUsCustomerCreditAllocation, validateUsCustomerCreditSource } from './us-customer-credit-allocation';
import type { UsFinancialBookV5, UsFinancialBookViewV5, UsFinancialCreditCandidateV5, UsFinancialCreditInputV5, UsFinancialCreditRecordV5, UsFinancialEventV5, UsFinancialPostingEventV5, UsFinancialInvoiceSettlementV5, UsFinancialOperationV5, UsFinancialPaymentInputV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

export type { UsFinancialBookV5, UsFinancialBookViewV5, UsFinancialCreditCandidateV5, UsFinancialCreditInputV5, UsFinancialCreditRecordV5, UsFinancialOperationV5, UsFinancialPaymentInputV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
const fail = (code = 'invalid_financial_operation', status = 422): never => { throw new ErpError(code, status); };
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
function detached(input: unknown): unknown { try { return snapshotPrivateJson(input); } catch { return fail(); } }
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return fail();
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum = 160): string {
  if (typeof input !== 'string' || !input.trim() || input !== input.trim() || input.length > maximum || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function integer(input: unknown, positive = false): string {
  if (typeof input !== 'string' || !(positive ? /^[1-9][0-9]{0,35}$/ : /^(0|[1-9][0-9]{0,35})$/).test(input)) return fail();
  return input;
}
function date(input: unknown): string {
  if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail('invalid_financial_date');
  return input;
}
function instant(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input)) return fail('invalid_financial_timestamp');
  try { parseInstant(input); } catch { return fail('invalid_financial_timestamp'); }
  return input;
}
function hash(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) return fail('invalid_financial_proof');
  return input;
}
function idempotency(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input)) return fail();
  return input;
}
function policy(input: unknown): UsFinancialPolicyV5 {
  const p = exact(detached(input), ['version', 'environment', 'approval']), a = exact(p.approval, ['reference', 'reviewedBy', 'reviewedAt']);
  if (p.version !== 'us-accrual-receivable-credit-v1' || p.environment !== 'test') return fail('financial_policy_unavailable', 409);
  return Object.freeze({ version: p.version, environment: p.environment, approval: Object.freeze({ reference: text(a.reference, 500), reviewedBy: text(a.reviewedBy, 256), reviewedAt: instant(a.reviewedAt) }) });
}
function authority(input: unknown, organizationId: string, financial=true): FinancialAuthority {
  const a = exact(detached(input), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (a.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (a.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!(financial?['owner', 'admin', 'accountant']:['owner','admin','accountant','member']).includes(String(a.role))) return fail('financial_permission_required', 403);
  return Object.freeze({ organizationId, userId: text(a.userId, 256), role: a.role as FinancialAuthority['role'], managementEntitled: true, timestamp: instant(a.timestamp) });
}
const creditKeys = ['type', 'idempotencyKey', 'invoiceId', 'transactionDate', 'accountingDate', 'periodId', 'reason', 'selections'];
function creditInput(input: unknown, withProof: boolean): UsFinancialCreditInputV5 {
  const c = exact(input, withProof ? [...creditKeys, 'taxProof'] : creditKeys);
  if (c.type !== 'customer_credit' || !Array.isArray(c.selections) || !c.selections.length || c.selections.length > 1000) return fail();
  const ids = new Set<string>();
  const selections = c.selections.map(raw => {
    const row = exact(raw, ['lineId', 'quantityUnits']), lineId = text(row.lineId);
    if (ids.has(lineId)) return fail('invalid_credit_selection'); ids.add(lineId);
    return Object.freeze({ lineId, quantityUnits: integer(row.quantityUnits, true) });
  });
  return Object.freeze({ type: 'customer_credit', idempotencyKey: idempotency(c.idempotencyKey), invoiceId: text(c.invoiceId), transactionDate: date(c.transactionDate), accountingDate: date(c.accountingDate), periodId: text(c.periodId), reason: text(c.reason, 500), selections: Object.freeze(selections) });
}
function paymentInput(input: unknown): UsFinancialPaymentInputV5 {
  const p = exact(input, ['type', 'idempotencyKey', 'invoiceId', 'amountMinor', 'paymentDate', 'accountingDate', 'periodId', 'reference']);
  if (p.type !== 'customer_payment') return fail();
  return Object.freeze({ type: 'customer_payment', idempotencyKey: idempotency(p.idempotencyKey), invoiceId: text(p.invoiceId), amountMinor: integer(p.amountMinor, true), paymentDate: date(p.paymentDate), accountingDate: date(p.accountingDate), periodId: text(p.periodId), reference: text(p.reference, 500) });
}
function proof(input: unknown): UsFinancialTaxProofV5 {
  const raw = input as Record<string, unknown>, common = ['schemaVersion', 'environment', 'invoiceFingerprint', 'allocationSha256', 'reference', 'verifiedBy', 'verifiedAt', 'kind'];
  const p = exact(input, raw?.kind === 'test_adjustment_authorization' ? [...common, 'providerAccountReference', 'originalTaxTransactionReference', 'adjustmentPlanReference', 'authorizedTaxMinor'] : common);
  if (p.schemaVersion !== 1 || p.environment !== 'test' || !['historical_zero_tax', 'test_adjustment_authorization'].includes(String(p.kind))) return fail('invalid_financial_proof');
  const base = { schemaVersion: 1 as const, environment: 'test' as const, invoiceFingerprint: hash(p.invoiceFingerprint), allocationSha256: hash(p.allocationSha256), reference: text(p.reference, 500), verifiedBy: text(p.verifiedBy, 256), verifiedAt: instant(p.verifiedAt) };
  if (p.kind === 'historical_zero_tax') return Object.freeze({ ...base, kind: 'historical_zero_tax' });
  const originalTaxTransactionReference = text(p.originalTaxTransactionReference, 256);
  // A calculation is not a transaction. Synthetic transaction references are
  // explicit; this memory-only TEST book makes no claim of live reversal.
  if (!/^(tax_[A-Za-z0-9]+|testtxn_[A-Za-z0-9._:-]+)$/.test(originalTaxTransactionReference)) return fail('tax_transaction_required', 409);
  return Object.freeze({ ...base, kind: 'test_adjustment_authorization', providerAccountReference: text(p.providerAccountReference, 256), originalTaxTransactionReference, adjustmentPlanReference: text(p.adjustmentPlanReference, 256), authorizedTaxMinor: integer(p.authorizedTaxMinor) });
}
function operation(input: unknown, organizationId:string): UsFinancialOperationV5 {
  const raw = detached(input) as Record<string, unknown>;
  if(raw?.type==='erp_command')return validateUsFinancialErpOperationV5(raw,organizationId);
  if (raw?.type === 'customer_credit') return Object.freeze({ ...creditInput(raw, true), taxProof: proof(raw.taxProof) });
  return paymentInput(raw);
}
function financialOperation(op:UsFinancialOperationV5):boolean{
  return op.type!=='erp_command'||!['save_customer','save_estimate','accept_estimate'].includes(op.command.type);
}
function settlement(invoice: IssuedInvoice, credits: readonly UsFinancialCreditRecordV5[]): UsFinancialInvoiceSettlementV5 {
  const total = BigInt(invoice.total.minorUnits), received = invoice.payments.reduce((n, p) => n + BigInt(p.amount.minorUnits), BigInt(0));
  const credited = credits.filter(c => c.invoiceId === invoice.id).reduce((n, c) => n + BigInt(c.allocation.totalMinor), BigInt(0)), outstanding = total - received - credited;
  if (outstanding < BigInt(0)) return fail('financial_settlement_conflict', 409);
  const status = outstanding === BigInt(0) ? credited === BigInt(0) ? 'paid' : received === BigInt(0) ? 'credited' : 'settled_with_credit' : received + credited === BigInt(0) ? 'open' : 'partially_settled';
  return Object.freeze({ invoiceId: invoice.id, currency: 'USD', totalMinor: total.toString(), receivedMinor: received.toString(), creditedMinor: credited.toString(), outstandingMinor: outstanding.toString(), status });
}
function view(book: UsFinancialBookV5, invoices: readonly IssuedInvoice[], ledger: UsFinancialBookViewV5['ledger'], credits: readonly UsFinancialCreditRecordV5[], shared:ErpState|UsFinancialBookViewV5=book.baseline): UsFinancialBookViewV5 {
  return Object.freeze({ schemaVersion: 5, revision: book.revision, organizationId: book.baseline.configuration.organizationId, policyVersion: book.policy.version,
    configuration:shared.configuration,counters:shared.counters,customers:shared.customers,estimates:shared.estimates,vendors:shared.vendors??[],vendorBills:shared.vendorBills??[],vendorPayments:shared.vendorPayments??[],projects:shared.projects??[],
    ledger, invoices: Object.freeze([...invoices]), credits: Object.freeze([...credits]), settlements: Object.freeze(invoices.map(i => settlement(i, credits))) });
}
export async function fingerprintUsFinancialInvoiceV5(invoice: IssuedInvoice): Promise<string> {
  const { payments: _payments, ...immutable } = detached(invoice) as IssuedInvoice;
  return sha256Hex(canonicalErpJson(immutable));
}
function invoiceFor(view: UsFinancialBookViewV5, id: string): IssuedInvoice {
  const invoice = view.invoices.find(i => i.id === id);
  if (!invoice) return fail('invoice_not_found', 404);
  const posting = view.ledger.entries.find(e => e.source.type === 'customer_invoice' && e.source.id === id);
  if (!posting || view.ledger.entries.some(e => e.reversesEntryId === posting.id)) return fail('invoice_posting_required', 409);
  return invoice;
}
function periodOpen(view: UsFinancialBookViewV5, periodId: string, accountingDate: string): void {
  const p = view.ledger.periods.find(p => p.id === periodId);
  if (!p || p.status !== 'open' || accountingDate < p.start || accountingDate > p.end || view.ledger.periods.some(p => p.status === 'closed' && accountingDate <= p.end)) return fail('accounting_period_not_open', 409);
}
async function candidate(current: UsFinancialBookViewV5, input: UsFinancialCreditInputV5): Promise<UsFinancialCreditCandidateV5> {
  const invoice = invoiceFor(current, input.invoiceId);
  if (input.transactionDate < invoice.date) return fail('credit_precedes_invoice', 422);
  periodOpen(current, input.periodId, input.accountingDate);
  const invoiceFingerprint = await fingerprintUsFinancialInvoiceV5(invoice);
  const source = validateUsCustomerCreditSource({ schemaVersion: 1, organizationId: invoice.organizationId, invoiceId: invoice.id, invoiceNumber: invoice.number, customerId: invoice.customer.id, currency: 'USD', invoiceFingerprint,
    lines: await Promise.all(invoice.lines.map(async line => {
      const tax = invoice.taxAssessment.lines.find(t => t.id === line.id); if (!tax) return fail('invalid_financial_book', 503);
      return { lineId: line.id, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, netMinor: lineTotals(line, invoice.currency).net.minorUnits, taxMinor: tax.taxMinor, jurisdiction: tax.jurisdiction, evidenceReference: `sha256:${await sha256Hex(tax.evidenceReference)}` };
    })),
  });
  const history = current.credits.filter(c => c.invoiceId === invoice.id).map(c => ({ id: c.id, allocation: c.allocation }));
  const allocation = prepareUsCustomerCreditAllocation(source, input.selections, history);
  if (BigInt(allocation.totalMinor) > BigInt(settlement(invoice, current.credits).outstandingMinor)) return fail('credit_exceeds_outstanding', 409);
  return Object.freeze({ source, invoiceFingerprint, allocation, allocationSha256: await sha256Hex(canonicalErpJson(allocation)) });
}
function chronology(book: UsFinancialBookV5, actor: FinancialAuthority, current: UsFinancialBookViewV5): void {
  const times = [book.policy.approval.reviewedAt, book.promotion.actor.timestamp, ...book.baseline.invoices.map(i => i.issuedAt), ...current.ledger.audit.map(a => a.timestamp), ...book.events.map(e => e.actor.timestamp)];
  if (times.some(t => Date.parse(t) > Date.parse(actor.timestamp))) return fail('financial_clock_reversed', 409);
}
async function transition(book: UsFinancialBookV5, current: UsFinancialBookViewV5, op: UsFinancialOperationV5, actor: FinancialAuthority, id: string): Promise<{ event: UsFinancialEventV5; view: UsFinancialBookViewV5 }> {
  chronology(book, actor, current);
  if (book.events.some(e => e.operation.idempotencyKey === op.idempotencyKey) || book.baseline.invoices.some(i => i.payments.some(p => p.idempotencyKey === op.idempotencyKey)) || book.baseline.vendorPayments?.some(p=>p.idempotencyKey===op.idempotencyKey) || book.baseline.ledger.entries.some(e=>e.idempotencyKey===op.idempotencyKey)) return fail('idempotency_conflict', 409);
  if (!Number.isSafeInteger(book.revision) || book.revision >= Number.MAX_SAFE_INTEGER - 1) return fail('number_sequence_exhausted', 409);
  if(op.type==='erp_command'){
    const result=await transitionUsFinancialErpV5(current,op,actor,id);
    const after=Object.freeze({...book,revision:result.event.revision,events:Object.freeze([...book.events,result.event])});
    return {event:result.event,view:view(after,result.state.invoices,result.ledger,current.credits,result.state)};
  }
  assertFinancialAuthority(current.ledger, actor);
  if (book.events.some(e => e.id === id) || book.baseline.invoices.some(i => i.payments.some(p => p.id === id))) return fail('financial_entity_conflict', 409);
  const invoice = invoiceFor(current, op.invoiceId), revision = book.revision + 1;
  let ledger = current.ledger, invoices = current.invoices, credits = current.credits, record: UsFinancialPostingEventV5['record'];
  if (op.type === 'customer_credit') {
    const c = await candidate(current, op), p = op.taxProof;
    if (p.invoiceFingerprint !== c.invoiceFingerprint || p.allocationSha256 !== c.allocationSha256 || Date.parse(p.verifiedAt) > Date.parse(actor.timestamp) || Date.parse(p.verifiedAt) < Date.parse(invoice.issuedAt)) return fail('financial_proof_mismatch', 409);
    if (!['external-provider', 'documented-exemption'].includes(invoice.taxAssessment.source)) return fail('historical_tax_assessment_required', 409);
    if (p.kind === 'historical_zero_tax') {
      if (c.allocation.taxMinor !== '0' || c.allocation.lines.some(l => c.source.lines.find(s => s.lineId === l.lineId)?.taxMinor !== '0')) return fail('tax_adjustment_required', 409);
    } else {
      if (p.authorizedTaxMinor !== c.allocation.taxMinor) return fail('financial_proof_mismatch', 409);
      if (book.events.some(e => e.operation.type === 'customer_credit' && e.operation.taxProof.kind === 'test_adjustment_authorization' && e.operation.taxProof.providerAccountReference === p.providerAccountReference && e.operation.taxProof.adjustmentPlanReference === p.adjustmentPlanReference)) return fail('tax_adjustment_plan_conflict', 409);
      if (book.events.some(e => e.operation.type === 'customer_credit' && e.operation.taxProof.kind === 'test_adjustment_authorization' && e.operation.taxProof.providerAccountReference === p.providerAccountReference && e.operation.taxProof.originalTaxTransactionReference === p.originalTaxTransactionReference && e.operation.invoiceId !== op.invoiceId)) return fail('tax_transaction_invoice_conflict', 409);
    }
    const number = `CR-${op.transactionDate.slice(0, 4)}-${String(current.credits.length + 1).padStart(6, '0')}`;
    const credit: UsFinancialCreditRecordV5 = Object.freeze({ id, organizationId: actor.organizationId, number, invoiceId: invoice.id, invoiceNumber: invoice.number, invoiceFingerprint: c.invoiceFingerprint, customerId: invoice.customer.id, currency: 'USD', transactionDate: op.transactionDate, accountingDate: op.accountingDate, periodId: op.periodId, reason: op.reason, allocation: c.allocation, taxDisposition: p.kind === 'historical_zero_tax' ? 'historical_zero_tax' : 'adjustment_pending', issuedBy: actor.userId, issuedAt: actor.timestamp, recordedRevision: revision });
    const key = `credit:${op.idempotencyKey}`;
    ledger = postJournal(ledger, { id: `entry:${key}`, idempotencyKey: key, organizationId: actor.organizationId, currency: 'USD', basis: 'accrual', transactionDate: op.transactionDate, accountingDate: op.accountingDate, periodId: op.periodId, description: `Credit ${number}`, source: { type: 'customer_credit', id }, lines: [
      ...(c.allocation.netMinor !== '0' ? [{ accountId: 'sales', debitMinor: c.allocation.netMinor, creditMinor: '0' }] : []),
      ...(c.allocation.taxMinor !== '0' ? [{ accountId: 'tax-payable', debitMinor: c.allocation.taxMinor, creditMinor: '0' }] : []),
      { accountId: 'receivables', debitMinor: '0', creditMinor: c.allocation.totalMinor },
    ] }, actor, ledger.revision);
    credits = Object.freeze([...credits, credit]); record = credit;
  } else {
    if (op.paymentDate < invoice.date) return fail('payment_precedes_invoice', 422);
    periodOpen(current, op.periodId, op.accountingDate);
    if (BigInt(op.amountMinor) > BigInt(settlement(invoice, current.credits).outstandingMinor)) return fail('payment_exceeds_outstanding', 409);
    const updated = recordCustomerPayment(book.baseline.configuration, invoice, { id, idempotencyKey: op.idempotencyKey, organizationId: actor.organizationId, invoiceId: invoice.id, amount: money('USD', op.amountMinor), paymentDate: op.paymentDate, accountingDate: op.accountingDate, reference: op.reference }, { organizationId: actor.organizationId, userId: actor.userId, canIssue: true, managementEntitled: true, timestamp: actor.timestamp });
    const payment = updated.payments[updated.payments.length - 1];
    ledger = postCustomerPayment(book.baseline.configuration, ledger, invoice, payment, op.periodId, actor);
    invoices = Object.freeze(invoices.map(i => i.id === invoice.id ? updated : i)); record = payment;
  }
  const posting = ledger.entries[ledger.entries.length - 1];
  if (!posting || ledger.revision !== current.ledger.revision + 1) return fail('financial_posting_required', 409);
  const event = Object.freeze({ revision, id, operation: op, actor, record, posting });
  const after = Object.freeze({ ...book, revision, events: Object.freeze([...book.events, event]) });
  return { event, view: view(after, invoices, ledger, credits,current) };
}
async function replay(value: unknown, organizationId?: string, expectedPolicy?: UsFinancialPolicyV5): Promise<{ book: UsFinancialBookV5; view: UsFinancialBookViewV5 }> {
  const raw = exact(detached(value), ['schemaVersion', 'revision', 'baseline', 'policy', 'promotion', 'events']);
  if (raw.schemaVersion !== 5 || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision >= Number.MAX_SAFE_INTEGER || !Array.isArray(raw.events)) return fail('invalid_financial_book', 503);
  const baselineRaw = raw.baseline as UsFinancialBookV5['baseline'], org = organizationId ?? baselineRaw?.configuration?.organizationId;
  if (typeof org !== 'string') return fail('invalid_financial_book', 503);
  const baseline = validateStoredErp(baselineRaw, org);
  if (baseline.schemaVersion !== 4 || baseline.configuration.accountingBasis !== 'accrual' || baseline.ledger.basis !== 'accrual' || baseline.configuration.country !== 'US' || baseline.configuration.currency !== 'USD') return fail('financial_baseline_required', 409);
  const approved = policy(raw.policy);
  if (expectedPolicy && !same(approved, policy(expectedPolicy))) return fail('financial_policy_changed', 409);
  if (raw.revision !== baseline.revision + 1 + raw.events.length) return fail('invalid_financial_book', 503);
  const p = exact(raw.promotion, ['actor', 'baselineSha256']), promotionActor = authority(p.actor, org);
  if (promotionActor.role !== 'owner') return fail('owner_required', 403);
  const baselineSha256 = hash(p.baselineSha256);
  if (baselineSha256 !== await sha256Hex(canonicalErpJson(baseline))) return fail('financial_baseline_changed', 409);
  let book: UsFinancialBookV5 = Object.freeze({ schemaVersion: 5, revision: baseline.revision + 1, baseline, policy: approved, promotion: Object.freeze({ actor: promotionActor, baselineSha256 }), events: Object.freeze([]) });
  let current = view(book, baseline.invoices, baseline.ledger, []);
  chronology(book, promotionActor, current);
  for (const rawEvent of raw.events) {
    const erp=(rawEvent as {operation?:{type?:unknown}})?.operation?.type==='erp_command';
    const e = exact(rawEvent, erp?['revision','id','operation','actor','commit','effects']:['revision', 'id', 'operation', 'actor', 'record', 'posting']), op = operation(e.operation,org), actor = authority(e.actor, org,financialOperation(op)), id = text(e.id);
    const rebuilt = await transition(book, current, op, actor, id);
    if (!same(rawEvent, rebuilt.event)) return fail('invalid_financial_book', 503);
    book = Object.freeze({ ...book, revision: rebuilt.event.revision, events: Object.freeze([...book.events, rebuilt.event]) }); current = rebuilt.view;
  }
  return { book, view: current };
}
/** A trusted policy is required separately from the book. Approval data is not
 * a certification; this factory deliberately permits only the TEST policy. */
export async function promoteUsFinancialBookV5(baseline: UsFinancialBookV5['baseline'], trustedPolicy: UsFinancialPolicyV5, suppliedActor: FinancialAuthority): Promise<UsFinancialBookV5> {
  const captured = detached(baseline) as UsFinancialBookV5['baseline'], approved = policy(trustedPolicy), actor = authority(suppliedActor, captured?.configuration?.organizationId);
  if (actor.role !== 'owner') return fail('owner_required', 403);
  if (captured?.revision >= Number.MAX_SAFE_INTEGER - 1) return fail('number_sequence_exhausted', 409);
  const baselineSha256 = await sha256Hex(canonicalErpJson(captured));
  const result = await replay({ schemaVersion: 5, revision: captured.revision + 1, baseline: captured, policy: approved, promotion: { actor, baselineSha256 }, events: [] }, actor.organizationId, approved);
  assertFinancialAuthority(result.view.ledger, actor); chronology(result.book, actor, result.view);
  return result.book;
}
export async function validateUsFinancialBookV5(value: unknown, organizationId: string, expectedPolicy?: UsFinancialPolicyV5): Promise<UsFinancialBookV5> {
  return (await replay(value, organizationId, expectedPolicy)).book;
}
export async function projectUsFinancialBookV5(book: UsFinancialBookV5): Promise<UsFinancialBookViewV5> { return (await replay(book)).view; }
export async function buildUsFinancialCreditCandidateV5(book: UsFinancialBookV5, inputWithoutProof: UsFinancialCreditInputV5): Promise<UsFinancialCreditCandidateV5> {
  const input = creditInput(detached(inputWithoutProof), false), current = await replay(book);
  return candidate(current.view, input);
}
/** Internal transition only. A trusted runtime must revalidate authorization,
 * resolve the proof privately and CAS this book with its receipt atomically. */
export async function applyUsFinancialOperationV5(book: UsFinancialBookV5, input: UsFinancialOperationV5, suppliedActor: FinancialAuthority, suppliedId: string): Promise<{ book: UsFinancialBookV5; view: UsFinancialBookViewV5 }> {
  // Capture all caller-owned input before awaiting replay/hashing.
  const capturedActor = detached(suppliedActor) as FinancialAuthority, op = operation(input,capturedActor?.organizationId), id = text(suppliedId), current = await replay(book);
  const actor = authority(capturedActor, current.book.baseline.configuration.organizationId,financialOperation(op));
  const previous = current.book.events.find(e => e.operation.idempotencyKey === op.idempotencyKey);
  if (previous) {
    if (previous.id !== id || previous.actor.userId !== actor.userId || !same(previous.operation, op)) return fail('idempotency_conflict', 409);
    chronology(current.book, actor, current.view);
    return current;
  }
  const result = await transition(current.book, current.view, op, actor, id);
  return Object.freeze({ book: Object.freeze({ ...current.book, revision: result.event.revision, events: Object.freeze([...current.book.events, result.event]) }), view: result.view });
}
