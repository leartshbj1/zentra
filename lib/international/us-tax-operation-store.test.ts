import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpCommit, ErpReceipt } from './runtime-types';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';
import { validateStripeTaxCalculation, type ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { createSupabaseUsTaxOperationStore, type StoredUsTaxOperation } from './us-tax-operation-store';

const now = '2026-10-08T12:00:00.000Z', retryUntil = '2026-10-09T11:00:00.000Z';
const secret = 'PRIVATE_FICTITIOUS_RPC_DETAIL';
const actor: FinancialAuthority = { organizationId: 'fictitious-tax-store', userId: 'fictitious-accountant', role: 'accountant', managementEntitled: true, timestamp: now };
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const invalid = { code: 'invalid_stored_tax_operation', status: 503 };
let resolved: ResolvedStripeTaxRequest, calculated: ValidatedStripeTaxCalculation;

function mapperInput(): StripeTaxResolvedRequestInput {
  const address = { country: 'US' as const, line1: '123 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
  return {
    organizationId: actor.organizationId, operationId: 'a3000000-0000-4000-8000-000000000001', invoiceId: 'fictitious-invoice', actorUserId: actor.userId, erpIdempotencyKey: 'fictitious-erp-key', commandHash: 'a'.repeat(64),
    expectedErpRevision: 4, countryRevision: 1, sellerRevision: 1, taxFactsRevision: 1,
    configuration: { schemaVersion: 1, organizationId: actor.organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } },
    taxFacts: { schemaVersion: 1, legalName: 'Fictitious private TEST entity', taxOrigin: { ...address, line1: 'Private Fictitious Tax Origin' }, timeZone: 'America/New_York' },
    binding: { organizationId: actor.organizationId, accountId: 'acct_FictitiousStore', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: '2026-10-08T11:00:00.000Z', validUntil: '2026-10-08T14:00:00.000Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' },
    estimate: { id: 'fictitious-estimate', organizationId: actor.organizationId, revision: 2, currency: 'USD', number: 'EST-000001', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes: 'Fictitious only', status: 'accepted', customer: { id: 'fictitious-customer', organizationId: actor.organizationId, kind: 'business', name: 'Fictitious Customer', billingAddress: address, paymentTermsDays: 30 }, lines: [{ id: 'fictitious-line', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }] },
    classifications: [{ lineId: 'fictitious-line', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'fictitious-test-code-not-a-provider-claim' }],
    invoiceDate: '2026-10-08', taxDateInstant: now, taxDatePolicy: 'caller_supplied_invoice_instant', now, addressSource: 'billing',
  };
}

beforeAll(async () => {
  resolved = await prepareStripeTaxResolvedRequest(mapperInput());
  const breakdown = { amount: 160, taxable_amount: 2000, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious tax', percentage_decimal: '8.0' } };
  calculated = await validateStripeTaxCalculation(resolved, {
    accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: {
      id: 'taxcalc_FictitiousStore', object: 'tax.calculation', amount_total: 2160, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: 'billing', ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Date.parse('2026-10-08T13:00:00.000Z') / 1000, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: 160, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, data: [{ id: 'tax_li_FictitiousStore', object: 'tax.calculation_line_item', amount: 2000, amount_tax: 160, quantity: 2, reference: 'fictitious-line', tax_code: 'txcd_99999999', tax_behavior: 'exclusive', livemode: false, product: null, tax_breakdown: [breakdown] }], url: '/v1/tax/calculations/taxcalc_FictitiousStore/line_items' },
      tax_breakdown: [{ amount: 160, taxable_amount: 2000, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    },
  }, now);
});

function receipt(): ErpReceipt { return { idempotencyKey: resolved.erpIdempotencyKey, commandHash: resolved.commandHash, revision: 5, entityId: resolved.invoiceId, action: 'issue_invoice' }; }
function commit(): ErpCommit {
  return {
    organizationId: actor.organizationId, expectedRevision: 4,
    header: { schemaVersion: 1, revision: 5, configuration: resolved.snapshots.configuration, counters: { estimate: 1, invoice: 1 }, ledger: { organizationId: actor.organizationId, currency: 'USD', basis: 'accrual', revision: 1, accounts: [{ id: 'receivables', code: '1100', name: 'Receivables', type: 'asset' }, { id: 'revenue', code: '4000', name: 'Revenue', type: 'income' }], periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } },
    changes: [], ledgerAudit: [], receipt: receipt(), actor,
  };
}
type RawOperation = {
  status: StoredUsTaxOperation['status']; organizationId: string; operationId: string; actorUserId: string; erpIdempotencyKey: string; commandHash: string;
  reservedAt: string; retryUntil: string; resolvedBody: string; resolvedSha256: string; paramsBody: string; paramsSha256: string; providerKey: string;
  proofBody: string | null; proofSha256: string | null; assessment: unknown; receipt: unknown;
};
function raw(status: StoredUsTaxOperation['status'] = 'reserved'): RawOperation {
  return {
    status, organizationId: actor.organizationId, operationId: resolved.operationId, actorUserId: actor.userId, erpIdempotencyKey: resolved.erpIdempotencyKey, commandHash: resolved.commandHash,
    reservedAt: now, retryUntil, resolvedBody: resolved.resolvedBody, resolvedSha256: resolved.resolvedSha256, paramsBody: resolved.paramsBody, paramsSha256: resolved.paramsSha256, providerKey: resolved.idempotencyKey,
    proofBody: status === 'reserved' ? null : calculated.proofBody, proofSha256: status === 'reserved' ? null : calculated.proofSha256,
    assessment: status === 'reserved' ? null : structuredClone(calculated.assessment), receipt: status === 'committed' ? receipt() : null,
  };
}
function rewrite(value: RawOperation, change: (payload: Record<string, unknown>) => void) {
  const payload = JSON.parse(value.resolvedBody) as Record<string, unknown>;
  change(payload);
  value.resolvedBody = canonicalErpJson(payload); value.resolvedSha256 = hash(value.resolvedBody);
  const accountId = (payload.binding as Record<string, unknown>)?.accountId;
  value.providerKey = 'ztax_test_' + hash(canonicalErpJson(['zentra:us:stripe-tax:calculation:v1', actor.organizationId, value.operationId, accountId ?? null, 'test', value.resolvedSha256]));
}
function transport(result: unknown) {
  const rpc = vi.fn<(name: string, parameters: Readonly<Record<string, unknown>>) => Promise<unknown>>().mockResolvedValue(result);
  const client: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, parameters: Readonly<Record<string, unknown>>): Promise<T> { return await rpc(name, parameters) as T; } };
  const store = createSupabaseUsTaxOperationStore(client);
  return { rpc, store, client };
}
async function safeFailure(promise: Promise<unknown>, expected: { code: string; status: number }) {
  try { await promise; throw new Error('Expected private operation rejection'); }
  catch (error) {
    expect(error).toMatchObject({ ...expected, message: expected.code });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  }
}
type Method = 'read' | 'reserve' | 'record' | 'commit';
function invoke(method: 'commit', t: ReturnType<typeof transport>): Promise<ErpReceipt>;
function invoke(method: 'read' | 'reserve' | 'record', t: ReturnType<typeof transport>): Promise<StoredUsTaxOperation | null>;
function invoke(method: Method, t: ReturnType<typeof transport>): Promise<StoredUsTaxOperation | ErpReceipt | null>;
function invoke(method: Method, t: ReturnType<typeof transport>) {
  if (method === 'read') return t.store.read(actor, resolved.erpIdempotencyKey, resolved.commandHash);
  if (method === 'reserve') return t.store.reserve(actor, resolved);
  if (method === 'record') return t.store.record(actor, resolved, calculated);
  return t.store.commit(resolved.operationId, commit());
}

describe('private TEST operation RPC transport', () => {
  it('reads by exact tenant, actor, ERP key and command hash; null remains absent', async () => {
    const t = transport(null);
    expect(await invoke('read', t)).toBeNull();
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_read_us_tax_operation', { p_organization: actor.organizationId, p_erp_idempotency_key: resolved.erpIdempotencyKey, p_command_hash: resolved.commandHash, p_actor: actor });
  });
  it('reserves only exact immutable bodies, digests and provider key through one RPC', async () => {
    const t = transport(raw()); await invoke('reserve', t);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_reserve_us_tax_operation', { p_organization: actor.organizationId, p_actor: actor, p_operation_id: resolved.operationId, p_resolved_body: resolved.resolvedBody, p_resolved_sha256: resolved.resolvedSha256, p_params_body: resolved.paramsBody, p_params_sha256: resolved.paramsSha256, p_provider_idempotency_key: resolved.idempotencyKey });
  });
  it('records only private canonical proof and public assessment through one RPC', async () => {
    const t = transport(raw('calculated')); await invoke('record', t);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_record_us_tax_calculation', { p_organization: actor.organizationId, p_operation_id: resolved.operationId, p_actor: actor, p_proof_body: calculated.proofBody, p_proof_sha256: calculated.proofSha256, p_assessment: calculated.assessment });
  });
  it('sends one complete commit RPC and returns only five receipt fields', async () => {
    const t = transport(receipt()), input = commit(), result = await t.store.commit(resolved.operationId, input);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_commit_us_tax_invoice_test_v2', { p_organization: input.organizationId, p_operation_id: resolved.operationId, p_expected_revision: input.expectedRevision, p_header: input.header, p_changes: input.changes, p_ledger_audit: input.ledgerAudit, p_receipt: input.receipt, p_actor: actor, p_supported_schema_version: 1 });
    expect(result).toEqual(receipt()); expect(result).not.toBe(input.receipt);
    expect(Object.keys(result)).toEqual(['idempotencyKey','commandHash','revision','entityId','action']); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([1,2,3,4] as const)('passes only the captured trusted factory capability%s to commit',async cap=>{
    const t=transport(receipt()),options={supportedSchemaVersion:cap},store=createSupabaseUsTaxOperationStore(t.client,options);
    options.supportedSchemaVersion=1;
    const input={...commit(),header:{...commit().header,schemaVersion:cap}};
    await store.commit(resolved.operationId,input);
    expect(t.rpc).toHaveBeenCalledExactlyOnceWith('zentra_commit_us_tax_invoice_test_v2',expect.objectContaining({p_supported_schema_version:cap,p_header:input.header}));
  });
  it.each([2,3,4] as const)('does not infer capability%s from a supplied candidate header',async cap=>{
    const t=transport(receipt()),input={...commit(),header:{...commit().header,schemaVersion:cap}};
    await safeFailure(t.store.commit(resolved.operationId,input),{code:'client_upgrade_required',status:409});expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each([0,5,null,'4',NaN] as const)('rejects unsupported trusted factory capability %s before constructing a port',cap=>{
    const t=transport(receipt());expect(()=>createSupabaseUsTaxOperationStore(t.client,{supportedSchemaVersion:cap} as unknown as Parameters<typeof createSupabaseUsTaxOperationStore>[1])).toThrow('service_unavailable');expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['owner','admin','accountant'] as const)('preserves real %s actor without synthesizing an owner', async role => {
    const t = transport(raw()); await t.store.reserve({ ...actor, role }, resolved);
    expect(t.rpc.mock.calls[0][1]).toMatchObject({ p_actor: { ...actor, role } });
  });
  it.each(['member','read_only'] as const)('refuses %s before private RPC access', async role => {
    const t = transport(raw()); await safeFailure(t.store.read({ ...actor, role }, resolved.erpIdempotencyKey, resolved.commandHash), { code: 'financial_permission_required', status: 403 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('refuses missing management entitlement before private RPC access', async () => {
    const t = transport(raw()); await safeFailure(t.store.reserve({ ...actor, managementEntitled: false }, resolved), { code: 'financial_permission_required', status: 403 }); expect(t.rpc).not.toHaveBeenCalled();
  });
  it.each(['organizationId','actorUserId'] as const)('rejects outbound resolved %s mismatch before reserve/record RPCs', async key => {
    for (const method of ['reserve','record'] as const) {
      const t = transport(raw()), other = { ...resolved, [key]: 'foreign-scope' };
      await safeFailure(method === 'reserve' ? t.store.reserve(actor, other) : t.store.record(actor, other, calculated), { code: 'tenant_mismatch', status: 403 }); expect(t.rpc).not.toHaveBeenCalled();
    }
  });
  it('rejects non-issue and foreign-scope commits before RPC access', async () => {
    for (const input of [{ ...commit(), organizationId: 'foreign-scope' }, { ...commit(), receipt: { ...receipt(), action: 'save_customer' as const } }]) {
      const t = transport(receipt()); await safeFailure(t.store.commit(resolved.operationId, input), { code: 'invalid_tax_operation', status: 422 }); expect(t.rpc).not.toHaveBeenCalled();
    }
  });
  it.each(['reserve','record'] as const)('rejects a coherent response for another operation from %s', async method => {
    const input = raw(method === 'record' ? 'calculated' : 'reserved');
    input.operationId = 'a3000000-0000-4000-8000-000000000002';
    rewrite(input, payload => { payload.operationId = input.operationId; });
    await safeFailure(invoke(method, transport(input)), invalid);
  });
  it.each(['reserve','record'] as const)('rejects changed private snapshots from %s even with correct body digests', async method => {
    const input = raw(method === 'record' ? 'calculated' : 'reserved');
    rewrite(input, payload => { ((payload.snapshots as Record<string, unknown>).taxFacts as Record<string, unknown>).legalName = 'Another fictitious private entity'; });
    await safeFailure(invoke(method, transport(input)), invalid);
  });
  it.each(['reserve','record'] as const)('rejects changed exact provider params from %s even with correct body digests', async method => {
    const input = raw(method === 'record' ? 'calculated' : 'reserved'), params = JSON.parse(input.paramsBody) as Record<string, unknown>;
    (params.line_items as Record<string, unknown>[])[0].amount = 2001;
    input.paramsBody = canonicalErpJson(params); input.paramsSha256 = hash(input.paramsBody);
    rewrite(input, payload => { payload.params = params; payload.paramsSha256 = input.paramsSha256; });
    await safeFailure(invoke(method, transport(input)), invalid);
  });
  it('rejects a reserved record response instead of assuming the calculation was durable', async () => {
    await safeFailure(invoke('record', transport(raw())), invalid);
  });
  it.each(['proofBody','proofSha256','assessment'] as const)('rejects record response with changed exact %s', async key => {
    const input = raw('calculated');
    if (key === 'proofBody') input.proofBody = calculated.proofBody + ' ';
    if (key === 'proofSha256') input.proofSha256 = 'f'.repeat(64);
    if (key === 'assessment') (input.assessment as { lines: { taxMinor: string }[] }).lines[0].taxMinor = '161';
    await safeFailure(invoke('record', transport(input)), invalid);
  });
  it.each(['reserved','calculated','committed'] as const)('allows exact %s reserve replay without new envelopes', async status => {
    expect((await invoke('reserve', transport(raw(status))))?.status).toBe(status);
  });
  it.each(['calculated','committed'] as const)('allows exact %s calculation record replay', async status => {
    expect((await invoke('record', transport(raw(status))))?.status).toBe(status);
  });
});

describe('private operation replay DTOs and isolation', () => {
  it.each(['reserved','calculated','committed'] as const)('returns a detached frozen %s replay DTO with exact stored bytes', async status => {
    const input = raw(status), t = transport(input), result = await invoke('read', t);
    expect(result).toMatchObject({ status, organizationId: actor.organizationId, operationId: resolved.operationId, actorUserId: actor.userId, erpIdempotencyKey: resolved.erpIdempotencyKey, commandHash: resolved.commandHash, reservedAt: now, retryUntil });
    expect(Object.keys(result!)).toEqual(['status','organizationId','operationId','actorUserId','erpIdempotencyKey','commandHash','reservedAt','retryUntil','resolved','calculation','receipt']);
    expect(result!.resolved).toEqual(resolved); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result!.resolved)).toBe(true);
    if (status === 'reserved') { expect(result!.calculation).toBeNull(); expect(result!.receipt).toBeNull(); }
    else { expect(result!.calculation).toEqual({ proofBody: calculated.proofBody, proofSha256: calculated.proofSha256, assessment: calculated.assessment }); expect(result!.calculation!.assessment).not.toBe(input.assessment); expect(Object.isFrozen(result!.calculation!.assessment)).toBe(true); }
    expect(result!.receipt).toEqual(status === 'committed' ? receipt() : null);
    input.resolvedBody = secret;
    expect((result!.resolved as ResolvedStripeTaxRequest).resolvedBody).toBe(resolved.resolvedBody);
  });
  it('supports committed replay without reapplying a fresh provider expiry clock', async () => {
    const input = raw('committed'); input.reservedAt = '2020-01-01T12:00:00.000Z'; input.retryUntil = '2020-01-02T11:00:00.000Z';
    expect((await invoke('read', transport(input)))?.receipt).toEqual(receipt());
  });
  it('captures nested assessment synchronously before digest awaits', async () => {
    let entered!: () => void, release!: () => void;
    const reachedHash = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { entered(); await gate; return digest(algorithm, bytes); });
    try {
      const input = raw('calculated'), t = transport(input), pending = invoke('read', t);
      await reachedHash;
      (input.assessment as { lines: { taxMinor: string }[] }).lines[0].taxMinor = secret;
      input.paramsBody = secret;
      release();
      const result = await pending;
      expect(result!.calculation!.assessment).toEqual(calculated.assessment);
      expect((result!.resolved as ResolvedStripeTaxRequest).paramsBody).toBe(resolved.paramsBody);
    } finally { release(); spy.mockRestore(); }
  });
  it('captures the real actor and outbound resolved data before awaiting RPC', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), t = transport(raw());
    t.rpc.mockImplementation(async () => { await gate; return raw(); });
    const mutableActor = { ...actor }, mutableResolved = structuredClone(resolved), pending = t.store.reserve(mutableActor, mutableResolved);
    mutableActor.userId = 'another-user'; mutableActor.role = 'owner';
    (mutableResolved as { resolvedBody: string }).resolvedBody = secret;
    release();
    expect((await pending).actorUserId).toBe(actor.userId);
    expect(t.rpc.mock.calls[0][1]).toMatchObject({ p_actor: actor, p_resolved_body: resolved.resolvedBody });
  });
  it.each(['organizationId','actorUserId','erpIdempotencyKey','commandHash','operationId'] as const)('rejects returned %s scope mismatch', async key => {
    const input = raw(); input[key] = key === 'operationId' ? 'a3000000-0000-4000-8000-000000000002' : 'foreign';
    await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['organizationId','actorUserId','erpIdempotencyKey','commandHash','operationId'] as const)('rejects embedded %s mismatch even with recalculated digests', async key => {
    const input = raw(); rewrite(input, payload => { payload[key] = 'foreign'; }); await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['mode','scope','organizationId','accountId'] as const)('rejects embedded binding %s mismatch', async key => {
    const input = raw(); rewrite(input, payload => { (payload.binding as Record<string, unknown>)[key] = key === 'mode' ? 'live' : key === 'accountId' ? 'not-an-account' : 'foreign'; }); await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['resolvedBody','paramsBody'] as const)('rejects invalid/noncanonical %s', async key => {
    for (const value of ['{', '{}', raw()[key] + ' ', '[' + raw()[key] + ']']) { const input = raw(); input[key] = value; await safeFailure(invoke('read', transport(input)), invalid); }
  });
  it.each(['resolvedSha256','paramsSha256','providerKey'] as const)('rejects changed or malformed %s', async key => {
    for (const value of ['', secret, key === 'providerKey' ? 'ztax_test_' + 'f'.repeat(64) : 'f'.repeat(64)]) { const input = raw(); input[key] = value; await safeFailure(invoke('read', transport(input)), invalid); }
  });
  it('rejects a canonical params body not identical to the embedded params', async () => {
    const input = raw(); input.paramsBody = canonicalErpJson({ currency: 'usd' }); input.paramsSha256 = hash(input.paramsBody);
    rewrite(input, payload => { payload.paramsSha256 = input.paramsSha256; }); await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['reservedAt','retryUntil'] as const)('requires canonical UTC milliseconds for %s', async key => {
    for (const value of [raw()[key].replace('.000Z', 'Z'), raw()[key].replace('.000Z', '.000000Z'), raw()[key].replace('Z', '+00:00')]) { const input = raw(); input[key] = value; await safeFailure(invoke('read', transport(input)), invalid); }
  });
  it.each(['2026-10-08T12:00:00.000Z','2026-10-08T13:00:00.000Z','2026-10-09T10:59:59.999Z','2026-10-09T11:00:00.001Z','invalid'])('requires exactly the persisted 23-hour retry window: %s', async until => {
    const input = raw(); input.retryUntil = until; await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['status','organizationId','operationId','actorUserId','erpIdempotencyKey','commandHash','reservedAt','retryUntil','resolvedBody','resolvedSha256','paramsBody','paramsSha256','providerKey','proofBody','proofSha256','assessment','receipt'] as const)('rejects a missing DTO field %s', async key => {
    const input: Record<string, unknown> = raw(); delete input[key]; await safeFailure(invoke('read', transport(input)), invalid);
  });
  it('rejects unknown DTO fields and statuses', async () => {
    await safeFailure(invoke('read', transport({ ...raw(), privateDebug: secret })), invalid);
    await safeFailure(invoke('read', transport({ ...raw(), status: 'orphaned' })), invalid);
  });
  it.each(['proofBody','proofSha256','assessment','receipt'] as const)('rejects a reserved operation with orphaned %s', async key => {
    const input = { ...raw(), [key]: raw('committed')[key] }; await safeFailure(invoke('read', transport(input)), invalid);
  });
  it.each(['calculated','committed'] as const)('requires complete proof and assessment for %s', async status => {
    for (const key of ['proofBody','proofSha256','assessment'] as const) { const input = { ...raw(status), [key]: null }; await safeFailure(invoke('read', transport(input)), invalid); }
  });
  it.each(['bad proof type','bad proof hash','array assessment','string assessment'] as const)('rejects calculated DTO with %s', async kind => {
    const input: Record<string, unknown> = raw('calculated');
    if (kind === 'bad proof type') input.proofBody = 1;
    if (kind === 'bad proof hash') input.proofSha256 = 'not-a-sha';
    if (kind === 'array assessment') input.assessment = [];
    if (kind === 'string assessment') input.assessment = secret;
    await safeFailure(invoke('read', transport(input)), invalid);
  });
  it('rejects a calculated operation with an orphan receipt', async () => {
    await safeFailure(invoke('read', transport({ ...raw('calculated'), receipt: receipt() })), invalid);
  });
  it('requires a strict receipt for a committed operation', async () => {
    for (const value of [null, { ...receipt(), facts: secret }]) await safeFailure(invoke('read', transport({ ...raw('committed'), receipt: value })), { code: 'invalid_stored_state', status: 503 });
  });
  it.each(['action','idempotencyKey','commandHash','entityId','revision'] as const)('rejects a committed receipt with changed %s', async key => {
    const value = { ...receipt(), [key]: key === 'revision' ? 6 : key === 'action' ? 'save_customer' : key === 'commandHash' ? 'b'.repeat(64) : 'foreign' };
    await safeFailure(invoke('read', transport({ ...raw('committed'), receipt: value })), invalid);
  });
});

describe('private JSON structural rejection', () => {
  it.each(['top-level','nested assessment','nested line'] as const)('never evaluates %s RPC getters', async location => {
    const input = raw('calculated'), getter = vi.fn(() => { throw new Error(secret); });
    const target = location === 'top-level' ? input : location === 'nested assessment' ? input.assessment as object : (input.assessment as { lines: object[] }).lines[0];
    Object.defineProperty(target, 'privateRaw', { get: getter, enumerable: true });
    await safeFailure(invoke('read', transport(input)), { code: 'service_unavailable', status: 503 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['inherited','symbol','hidden','cyclic','deep','sparse array','NUL','surrogate','infinity','bigint'] as const)('rejects %s private JSON without leakage', async kind => {
    const input = raw('calculated');
    if (kind === 'inherited') input.assessment = Object.assign(Object.create({ privateRaw: secret }), calculated.assessment);
    if (kind === 'symbol') input.assessment = { ...calculated.assessment, [Symbol('private')]: secret };
    if (kind === 'hidden') input.assessment = Object.defineProperty({ ...calculated.assessment }, 'privateRaw', { value: secret, enumerable: false });
    if (kind === 'cyclic') { const v: Record<string, unknown> = {}; v.self = v; input.assessment = v; }
    if (kind === 'deep') { let v: unknown = secret; for (let n = 0; n < 25; n++) v = { child: v }; input.assessment = v; }
    if (kind === 'sparse array') { const lines: unknown[] = []; lines.length = 2; input.assessment = { lines }; }
    if (kind === 'NUL') input.assessment = { privateRaw: 'bad\0' };
    if (kind === 'surrogate') input.assessment = { privateRaw: '\ud800' };
    if (kind === 'infinity') input.assessment = { privateRaw: Infinity };
    if (kind === 'bigint') input.assessment = { privateRaw: BigInt(1) };
    await safeFailure(invoke('read', transport(input)), { code: 'service_unavailable', status: 503 });
  });
  it('rejects outbound getters before the private RPC without evaluating them', async () => {
    const getter = vi.fn(() => { throw new Error(secret); });
    const input = Object.defineProperty({ ...resolved }, 'resolvedBody', { get: getter, enumerable: true }), t = transport(raw());
    await safeFailure(t.store.reserve(actor, input), { code: 'invalid_private_data', status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
  it('rejects actor getters before the private RPC without evaluating them', async () => {
    const getter = vi.fn(() => { throw new Error(secret); });
    const input = Object.defineProperty({ ...actor }, 'role', { get: getter, enumerable: true }), t = transport(raw());
    await safeFailure(t.store.read(input, resolved.erpIdempotencyKey, resolved.commandHash), { code: 'invalid_private_data', status: 503 }); expect(getter).not.toHaveBeenCalled(); expect(t.rpc).not.toHaveBeenCalled();
  });
});

describe('stable private RPC errors and commit receipt boundary', () => {
  it.each([
    ['PX001','tax_configuration_changed',409], ['PX002','tax_operation_conflict',409], ['PX003','tax_binding_unavailable',409], ['PX004','invalid_tax_operation',422], ['PX005','invalid_stored_tax_operation',503], ['PX006','tax_operation_expired',409], ['PX007','financial_permission_required',403],
    ['PU001','revision_conflict',409], ['PU002','idempotency_conflict',409], ['PU003','immutable_record',409], ['PU004','invalid_state',422], ['PU005','workspace_unavailable',409], ['PU006','configuration_changed',409], ['PU007','event_too_large',413],
    ['PU008','client_upgrade_required',409],
  ] as const)('maps %s to %s for every RPC without retrying or exposing private details', async (sqlCode, code, status) => {
    for (const method of ['read','reserve','record','commit'] as const) {
      const t = transport(null); t.rpc.mockRejectedValueOnce(new SupabaseServerError(500, sqlCode, secret));
      await safeFailure(invoke(method, t), { code, status }); expect(t.rpc).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['unknown SQL','plain error','non-Error rejection'] as const)('sanitizes %s for every RPC', async kind => {
    for (const method of ['read','reserve','record','commit'] as const) {
      const t = transport(null), error = kind === 'unknown SQL' ? new SupabaseServerError(500, 'XX999', secret) : kind === 'plain error' ? new Error(secret) : { code: 'PX003', detail: secret };
      t.rpc.mockRejectedValueOnce(error); await safeFailure(invoke(method, t), { code: 'service_unavailable', status: 503 }); expect(t.rpc).toHaveBeenCalledTimes(1);
    }
  });
  it('preserves an already classified ErpError without leaking privileged payload', async () => {
    const t = transport(null); t.rpc.mockRejectedValueOnce(new ErpError('revision_conflict', 409)); await safeFailure(invoke('read', t), { code: 'revision_conflict', status: 409 });
  });
  it.each(['extra private data','getter','inherited','null'] as const)('refuses %s from the commit receipt RPC', async kind => {
    const getter = vi.fn(() => { throw new Error(secret); });
    const value = kind === 'extra private data' ? { ...receipt(), proofBody: secret } : kind === 'getter' ? Object.defineProperty(receipt(), 'entityId', { get: getter, enumerable: true }) : kind === 'inherited' ? Object.create(receipt()) : null;
    await safeFailure(invoke('commit', transport(value)), { code: 'invalid_stored_state', status: 503 }); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['revision','idempotencyKey','commandHash','entityId','action'] as const)('refuses changed %s from the commit receipt RPC', async key => {
    const value = { ...receipt(), [key]: key === 'revision' ? 6 : key === 'commandHash' ? 'b'.repeat(64) : key === 'action' ? 'record_payment' : 'foreign' };
    await safeFailure(invoke('commit', transport(value)), invalid);
  });
  it.each(['private extra','null','malformed revision'] as const)('rejects outbound %s receipt before sending the atomic commit RPC', async kind => {
    const value = kind === 'private extra' ? { ...receipt(), proofBody: secret } : kind === 'null' ? null : { ...receipt(), revision: '5' };
    const input = { ...commit(), receipt: value } as unknown as ErpCommit, t = transport(receipt());
    await safeFailure(t.store.commit(resolved.operationId, input), { code: 'invalid_stored_state', status: 503 }); expect(t.rpc).not.toHaveBeenCalled();
  });
});
