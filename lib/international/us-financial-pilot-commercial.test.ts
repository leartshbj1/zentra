import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { validateUsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotCommercialRequest, usFinancialPilotCommercialEntityId, validateUsFinancialPilotCommercialReceipt, validateUsFinancialPilotCommercialRequest,
  US_FINANCIAL_PILOT_COMMERCIAL_MAX_BODY_BYTES, type UsFinancialPilotCommercialRequest } from './us-financial-pilot-commercial';

const requestId = 'a1000000-0000-4000-8000-000000000001';
const address = { country: 'US', line1: '1 Synthetic Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' } as const;
const publicCustomer = { kind: 'business', name: 'Synthetic customer — Genève 🌍', billingAddress: address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 } as const;
function quote() {
  return { consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 9, command: { type: 'save_estimate', estimateId: null, expectedEstimateRevision: 0, customerId: 'customer', projectId: null,
    date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: [{ id: null, description: 'Synthetic service\nSecond line', quantityUnits: '333', quantityScale: 2, unitPriceMinor: '10001', discountBasisPoints: 1250, taxTreatment: 'taxable' }], notes: 'Synthetic notes\nSecond paragraph' } } as const;
}
function create() { return { consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 9, command: { type: 'create_customer', customer: publicCustomer } } as const; }
const bad = (value: unknown) => expect(() => validateUsFinancialPilotCommercialRequest(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 }));

describe('financial-pilot closed commercial presentation contract', () => {
  it('constructs a scoped exact private customer command without browser authority or nullable private fields', () => {
    const input = create(), publicRequest = validateUsFinancialPilotCommercialRequest(input), built = buildUsFinancialPilotCommercialRequest(input, 'workspace');
    expect(built).toEqual({ idempotencyKey: `pilot:commercial:${requestId}`, expectedRevision: 9, command: { type: 'erp_command', request: { type: 'save_customer', customer: { id: `pilot-customer:${requestId}`, organizationId: 'workspace', kind: publicCustomer.kind, name: publicCustomer.name, billingAddress: address, paymentTermsDays: 30 } } } });
    expect(validateUsFinancialRequestV5(built, 'workspace')).toEqual(built); expect(usFinancialPilotCommercialEntityId(publicRequest)).toBe(`pilot-customer:${requestId}`);
    expect(Object.isFrozen(built.command)).toBe(true); expect(Object.isFrozen(publicRequest.command)).toBe(true);
  });
  it('derives new quote and line IDs, preserves exact money and existing line identities on edits', () => {
    const built = buildUsFinancialPilotCommercialRequest(quote(), 'workspace');
    if (built.command.type !== 'erp_command' || built.command.request.type !== 'save_estimate') throw Error('Synthetic quote command required');
    expect(built.command.request).toMatchObject({ id: `pilot-estimate:${requestId}`, expectedEstimateRevision: 0, lines: [{ id: `pilot-line:${requestId}:0`, unitPrice: { currency: 'USD', minorUnits: '10001' }, quantityUnits: '333', quantityScale: 2 }] });
    expect(built.command.request).not.toHaveProperty('projectId');
    const edit = { ...quote(), command: { ...quote().command, estimateId: 'existing-quote', expectedEstimateRevision: 4, projectId: 'project', lines: [{ ...quote().command.lines[0], id: 'stable-original-line' }, { ...quote().command.lines[0], id: null }] } };
    const result = buildUsFinancialPilotCommercialRequest(edit, 'workspace');
    if (result.command.type !== 'erp_command' || result.command.request.type !== 'save_estimate') throw Error('Synthetic quote edit required');
    expect(result.command.request.lines.map(line => line.id)).toEqual(['stable-original-line', `pilot-line:${requestId}:1`]); expect(result.command.request.projectId).toBe('project');
    expect(validateUsFinancialRequestV5(result, 'workspace')).toEqual(result);
  });
  it('maps an internal acceptance only, leaving number, status, customer snapshot and all ledger effects to the domain', () => {
    const input = { ...quote(), command: { type: 'accept_estimate', estimateId: 'quote', expectedEstimateRevision: 2 } };
    expect(buildUsFinancialPilotCommercialRequest(input, 'workspace').command).toEqual({ type: 'erp_command', request: { type: 'accept_estimate', estimateId: 'quote', expectedEstimateRevision: 2 } });
  });
  it('captures owned detached data, allows C1 business text and retains user content without silent normalization', () => {
    const input = structuredClone(create()) as unknown as { command: { customer: { name: string; billingAddress: { city: string } } } };
    input.command.customer.name = 'Synthetic\u0080 name';
    const checked = validateUsFinancialPilotCommercialRequest(input), built = buildUsFinancialPilotCommercialRequest(input, 'workspace'), before = canonicalErpJson(built);
    input.command.customer.billingAddress.city = 'Changed after validation';
    expect(checked.command.type === 'create_customer' && checked.command.customer.billingAddress.city).toBe('Brooklyn'); expect(canonicalErpJson(built)).toBe(before);
  });
  it.each([
    ['unknown envelope', () => ({ ...quote(), grantVersion: 1 })],
    ['wrong protocol', () => ({ ...quote(), schemaVersion: 5 })],
    ['UUID uppercase', () => ({ ...quote(), requestId: requestId.toUpperCase() })],
    ['global revision zero', () => ({ ...quote(), expectedRevision: 0 })],
    ['unsafe global revision', () => ({ ...quote(), expectedRevision: Number.MAX_SAFE_INTEGER })],
    ['private customer identity', () => ({ ...create(), command: { ...create().command, customer: { ...publicCustomer, organizationId: 'other' } } })],
    ['customer email malformed', () => ({ ...create(), command: { ...create().command, customer: { ...publicCustomer, email: 'invalid' } } })],
    ['address mismatched state', () => ({ ...create(), command: { ...create().command, customer: { ...publicCustomer, billingAddress: { ...address, subdivision: 'ZZ' } } } })],
    ['unavailable command', () => ({ ...quote(), command: { type: 'issue_invoice' } })],
    ['create revision mismatch', () => ({ ...quote(), command: { ...quote().command, expectedEstimateRevision: 2 } })],
    ['edit revision missing', () => ({ ...quote(), command: { ...quote().command, estimateId: 'existing' } })],
    ['accept revision zero', () => ({ ...quote(), command: { type: 'accept_estimate', estimateId: 'existing', expectedEstimateRevision: 0 } })],
    ['calendar invalid', () => ({ ...quote(), command: { ...quote().command, date: '2026-02-30' } })],
    ['expiry before date', () => ({ ...quote(), command: { ...quote().command, expiresAt: '2026-10-09' } })],
    ['year zero', () => ({ ...quote(), command: { ...quote().command, date: '0000-01-01' } })],
    ['empty lines', () => ({ ...quote(), command: { ...quote().command, lines: [] } })],
    ['more than100 public lines', () => ({ ...quote(), command: { ...quote().command, lines: Array.from({ length: 101 }, () => quote().command.lines[0]) } })],
    ['private line total', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], netMinor: '1' }] } })],
    ['caller-owned new line ID', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], id: 'caller-new-id' }] } })],
    ['noncanonical quantity', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], quantityUnits: '01' }] } })],
    ['zero quantity', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], quantityUnits: '0' }] } })],
    ['money exponent', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], unitPriceMinor: '1e3' }] } })],
    ['negative money', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], unitPriceMinor: '-1' }] } })],
    ['scale seven', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], quantityScale: 7 }] } })],
    ['discount over100%', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], discountBasisPoints: 10001 }] } })],
    ['duplicate supplied IDs', () => ({ ...quote(), command: { ...quote().command, estimateId: 'existing', expectedEstimateRevision: 1, lines: [{ ...quote().command.lines[0], id: 'same' }, { ...quote().command.lines[0], id: 'same' }] } })],
    ['collision with generated ID', () => ({ ...quote(), command: { ...quote().command, estimateId: 'existing', expectedEstimateRevision: 1, lines: [quote().command.lines[0], { ...quote().command.lines[0], id: `pilot-line:${requestId}:0` }] } })],
    ['subtotal overflow', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], quantityUnits: '2', quantityScale: 0, unitPriceMinor: '9'.repeat(36) }] } })],
    ['DEL description', () => ({ ...quote(), command: { ...quote().command, lines: [{ ...quote().command.lines[0], description: 'Synthetic\u007f' }] } })],
  ] as const)('rejects %s', (_label, input) => bad(input()));
  it('rejects getters, extra symbols, inherited fields, sparse arrays and malformed Unicode without executing accessors', () => {
    const getter = vi.fn(() => 'private'); bad(Object.defineProperty({ ...quote() }, 'grant', { enumerable: true, get: getter })); expect(getter).not.toHaveBeenCalled();
    bad(Object.assign(Object.create({ role: 'owner' }) as object, quote())); bad({ ...quote(), [Symbol('private')]: true });
    const lines: unknown[] = []; lines.length = 1; bad({ ...quote(), command: { ...quote().command, lines } });
    bad({ ...quote(), command: { ...quote().command, notes: '\ud800' } });
  });
  it('bounds actual UTF8 request bytes independently of the per-line limits', () => {
    const input = { ...quote(), command: { ...quote().command, lines: Array.from({ length: 100 }, () => ({ ...quote().command.lines[0], description: '🌍'.repeat(1999) })) } };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(US_FINANCIAL_PILOT_COMMERCIAL_MAX_BODY_BYTES); bad(input);
  });
  it.each(['create_customer', 'save_estimate', 'accept_estimate'] as const)('binds %s receipt to concrete action, entity, organization and captured revision', action => {
    const input: UsFinancialPilotCommercialRequest = validateUsFinancialPilotCommercialRequest(action === 'create_customer' ? create() : action === 'save_estimate' ? quote() : { ...quote(), command: { type: 'accept_estimate', estimateId: 'existing', expectedEstimateRevision: 3 } });
    const receipt = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', revision: input.expectedRevision + 1, entityId: usFinancialPilotCommercialEntityId(input), action };
    expect(validateUsFinancialPilotCommercialReceipt(receipt, 'workspace', input)).toEqual(receipt);
    for (const patch of [{ entityId: 'unrelated' }, { revision: receipt.revision + 1 }, { organizationId: 'other' }, { action: 'erp_command' }, { replayed: true }]) {
      expect(() => validateUsFinancialPilotCommercialReceipt({ ...receipt, ...patch }, 'workspace', input)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_response', status: 503 }));
    }
  });
});

describe('closed customer correction intention', () => {
  const update = () => ({ ...create(), command: { type: 'update_customer' as const, customerId: 'customer-1', customer: publicCustomer } });
  it('keeps the supplied customer identity and isolates update replay from an identical create command', () => {
    const creation = buildUsFinancialPilotCommercialRequest(create(), 'workspace');
    const edit = buildUsFinancialPilotCommercialRequest({ ...update(), command: { ...update().command, customerId: `pilot-customer:${requestId}` } }, 'workspace');
    expect(edit.command).toEqual(creation.command); expect(edit.expectedRevision).toBe(creation.expectedRevision);
    expect(creation.idempotencyKey).toBe(`pilot:commercial:${requestId}`);
    expect(edit.idempotencyKey).toBe(`pilot:commercial:update_customer:${requestId}`); expect(edit.idempotencyKey).toHaveLength(69);
    expect(validateUsFinancialRequestV5(edit, 'workspace')).toEqual(edit);
    expect(usFinancialPilotCommercialEntityId(validateUsFinancialPilotCommercialRequest(update()))).toBe('customer-1');
  });
  it('captures and freezes every update value while explicit null clears optional contact fields', () => {
    const value = JSON.parse(JSON.stringify(update())) as { command: { customer: { billingAddress: { city: string }; name: string }; customerId: string } }, captured = validateUsFinancialPilotCommercialRequest(value), mapped = buildUsFinancialPilotCommercialRequest(value, 'workspace');
    value.command.customer.billingAddress.city = 'Changed after capture'; value.command.customer.name = 'Changed'; value.command.customerId = 'retargeted';
    expect(captured.command).toMatchObject({ type: 'update_customer', customerId: 'customer-1', customer: { name: publicCustomer.name, shippingAddress: null, email: null, phone: null, contactName: null } });
    expect(Object.isFrozen(captured.command)).toBe(true);
    if (captured.command.type !== 'update_customer' || mapped.command.type !== 'erp_command' || mapped.command.request.type !== 'save_customer') throw Error('Update fixture');
    expect(Object.isFrozen(captured.command.customer.billingAddress)).toBe(true);
    expect(mapped.command.request.customer).toEqual({ id: 'customer-1', organizationId: 'workspace', kind: publicCustomer.kind, name: publicCustomer.name, billingAddress: address, paymentTermsDays: 30 });
  });
  it.each(['shippingAddress', 'email', 'phone', 'contactName'] as const)('requires explicit nullable %s', field => {
    const value: Record<string, unknown> = { ...publicCustomer }; delete value[field]; bad({ ...update(), command: { ...update().command, customer: value } });
  });
  it.each(['', ' customer-1', 'customer-1 ', 'x'.repeat(161), 'customer\n1', 'customer\u007f1'])('refuses noncanonical customer identity %j', customerId => bad({ ...update(), command: { ...update().command, customerId } }));
  it('reuses contact/address validation and closes update fields without evaluating getters', () => {
    for (const customer of [{ ...publicCustomer, email: 'invalid' }, { ...publicCustomer, paymentTermsDays: 366 }, { ...publicCustomer, billingAddress: { ...address, subdivision: 'ZZ' } }, { ...publicCustomer, organizationId: 'foreign' }]) bad({ ...update(), command: { ...update().command, customer } });
    bad({ ...update(), command: { ...update().command, sourceRevision: 2 } }); bad({ ...update(), command: { ...update().command, customer: { ...publicCustomer, name: '\ud800' } } });
    const getter = vi.fn(() => 'private'); bad({ ...update(), command: Object.defineProperty({ ...update().command }, 'customerId', { enumerable: true, get: getter }) }); expect(getter).not.toHaveBeenCalled();
    bad({ ...update(), command: Object.assign(Object.create({ authority: 'private' }) as object, update().command) });
    bad({ ...update(), command: { ...update().command, [Symbol('private')]: true } });
  });
  it('binds the six-field update receipt to action, historical F+1, tenant and retained ID', () => {
    const input = validateUsFinancialPilotCommercialRequest(update()), receipt = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', revision: 10, entityId: 'customer-1', action: 'update_customer' };
    expect(validateUsFinancialPilotCommercialReceipt(receipt, 'workspace', input)).toEqual(receipt);
    for (const patch of [{ action: 'create_customer' }, { entityId: `pilot-customer:${requestId}` }, { revision: 11 }, { revision: 9 }, { organizationId: 'foreign' }, { replayed: true }, { actorId: 'private' }]) expect(() => validateUsFinancialPilotCommercialReceipt({ ...receipt, ...patch }, 'workspace', input)).toThrow(expect.objectContaining({ status: 503 }));
  });
});
