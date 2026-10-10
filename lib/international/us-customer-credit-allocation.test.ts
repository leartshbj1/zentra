import { describe, expect, it, vi } from 'vitest';
import { ErpError } from './erp-contract';
import { prepareUsCustomerCreditAllocation, remainingUsCustomerCredit, validateUsCustomerCreditSource } from './us-customer-credit-allocation';
import type { UsCustomerCreditAllocation, UsCustomerCreditAllocationHistory, UsCustomerCreditSelection, UsCustomerCreditSource, UsCustomerCreditSourceLine } from './us-customer-credit-types';

const fingerprint = 'a'.repeat(64);
const line = (change: Partial<UsCustomerCreditSourceLine> = {}): UsCustomerCreditSourceLine => ({ lineId: 'original-line', quantityUnits: '3', quantityScale: 0, netMinor: '100', taxMinor: '11', jurisdiction: 'Historical test jurisdiction', evidenceReference: 'historical-test-evidence', ...change });
const source = (lines: readonly UsCustomerCreditSourceLine[] = [line()]): UsCustomerCreditSource => ({ schemaVersion: 1, organizationId: 'workspace-not-necessarily-a-uuid', invoiceId: 'invoice-1', invoiceNumber: 'INV-000042', customerId: 'customer-1', currency: 'USD', invoiceFingerprint: fingerprint, lines });
const selection = (quantityUnits: string, lineId = 'original-line'): readonly UsCustomerCreditSelection[] => [{ lineId, quantityUnits }];
const uncheckedSelection = (input: unknown) => input as readonly UsCustomerCreditSelection[];
const uncheckedHistory = (input: unknown) => input as readonly UsCustomerCreditAllocationHistory[];
function expectError(task: () => unknown, code: string, status: number) {
  expect(task).toThrow(ErpError);
  try { task(); } catch (error) { expect(error).toMatchObject({ code, status, message: code }); }
}
function history(seed = source()): UsCustomerCreditAllocationHistory[] {
  return [{ id: 'preparation-1', allocation: prepareUsCustomerCreditAllocation(seed, selection('1')) }];
}
const replaceAllocation = (value: UsCustomerCreditAllocation, changes: Partial<UsCustomerCreditAllocation>): UsCustomerCreditAllocation => ({ ...value, ...changes });

describe('strict detached US customer-credit arithmetic source', () => {
  it('accepts exact original units, zero historical tax and non-UUID ERP identities without changing user data', () => {
    const seed = source([line({ quantityUnits: '1250000', quantityScale: 6, netMinor: '1199', taxMinor: '0' })]);
    const captured = validateUsCustomerCreditSource(seed);
    expect(captured).toEqual(seed); expect(captured).not.toBe(seed); expect(captured.lines).not.toBe(seed.lines); expect(captured.lines[0]).not.toBe(seed.lines[0]);
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.lines)).toBe(true); expect(Object.isFrozen(captured.lines[0])).toBe(true);
    expect(Object.isFrozen(seed)).toBe(false); expect(Object.isFrozen(seed.lines)).toBe(false);
  });
  it.each([
    ['schema', { schemaVersion: 2 }], ['currency', { currency: 'CHF' }], ['extra field', { taxRate: '0.081' }],
    ['uppercase fingerprint', { invoiceFingerprint: 'A'.repeat(64) }], ['short fingerprint', { invoiceFingerprint: 'a'.repeat(63) }], ['non-hex fingerprint', { invoiceFingerprint: 'x'.repeat(64) }],
    ['empty organization', { organizationId: '' }], ['padded identity', { invoiceId: ' invoice-1' }], ['overlong number', { invoiceNumber: 'n'.repeat(161) }], ['control identity', { customerId: 'customer\n1' }],
    ['no lines', { lines: [] }], ['null lines', { lines: null }], ['too many lines', { lines: Array.from({ length: 1001 }, (_, index) => line({ lineId: String(index) })) }],
  ])('rejects a malformed %s source privately', (_name, changes) => {
    expectError(() => validateUsCustomerCreditSource({ ...source(), ...changes }), 'invalid_credit_source', 503);
  });
  it.each([
    ['quantity zero', { quantityUnits: '0' }], ['quantity leading zero', { quantityUnits: '01' }], ['quantity negative', { quantityUnits: '-1' }], ['quantity decimal', { quantityUnits: '1.5' }], ['quantity exponent', { quantityUnits: '1e2' }], ['quantity Number', { quantityUnits: 1 }], ['overlong quantity', { quantityUnits: '1'.repeat(37) }],
    ['negative net', { netMinor: '-1' }], ['padded net', { netMinor: ' 1' }], ['leading zero net', { netMinor: '00' }], ['decimal tax', { taxMinor: '0.0' }], ['positive sign tax', { taxMinor: '+1' }], ['Number net', { netMinor: 0 }], ['overlong tax', { taxMinor: '9'.repeat(37) }],
    ['negative scale', { quantityScale: -1 }], ['negative-zero scale', { quantityScale: -0 }], ['overlong scale', { quantityScale: 7 }], ['fractional scale', { quantityScale: 1.5 }], ['string scale', { quantityScale: '0' }], ['NaN scale', { quantityScale: Number.NaN }],
    ['empty jurisdiction', { jurisdiction: '' }], ['overlong evidence', { evidenceReference: 'x'.repeat(501) }], ['extra line field', { price: '100' }], ['padded line ID', { lineId: ' original-line' }],
  ])('rejects %s while preserving the generic private error', (_name, changes) => {
    expectError(() => validateUsCustomerCreditSource({ ...source(), lines: [{ ...line(), ...changes }] }), 'invalid_credit_source', 503);
  });
  it('requires all exact own source and line keys, and unique original line identities', () => {
    const { customerId: _customer, ...missing } = source();
    expectError(() => validateUsCustomerCreditSource(missing), 'invalid_credit_source', 503);
    const { evidenceReference: _evidence, ...missingLine } = line();
    expectError(() => validateUsCustomerCreditSource({ ...source(), lines: [missingLine] }), 'invalid_credit_source', 503);
    expectError(() => validateUsCustomerCreditSource(source([line(), line()])), 'invalid_credit_source', 503);
  });
  it('admits a null-prototype JSON object but refuses class prototypes, inherited fields and toJSON hooks', () => {
    const nullObject = Object.assign(Object.create(null) as Record<string, unknown>, source());
    expect(validateUsCustomerCreditSource(nullObject)).toEqual(source());
    expectError(() => validateUsCustomerCreditSource(Object.create(source()) as unknown), 'invalid_credit_source', 503);
    class PrivateSource { constructor(readonly value = source()) {} }
    expectError(() => validateUsCustomerCreditSource(new PrivateSource()), 'invalid_credit_source', 503);
    const toJSON = vi.fn(() => source());
    expectError(() => validateUsCustomerCreditSource({ ...source(), toJSON }), 'invalid_credit_source', 503); expect(toJSON).not.toHaveBeenCalled();
  });
  it('does not invoke accessors and rejects hidden/symbol fields, sparse or decorated arrays, cycles and malformed Unicode', () => {
    const getter = vi.fn(() => 'SECRET');
    const accessor = Object.defineProperty({ ...source() }, 'invoiceId', { enumerable: true, get: getter });
    expectError(() => validateUsCustomerCreditSource(accessor), 'invalid_credit_source', 503); expect(getter).not.toHaveBeenCalled();
    const hidden = Object.defineProperty({ ...source() }, 'privateSecret', { value: 'SECRET', enumerable: false });
    expectError(() => validateUsCustomerCreditSource(hidden), 'invalid_credit_source', 503);
    expectError(() => validateUsCustomerCreditSource({ ...source(), [Symbol('private')]: 'SECRET' }), 'invalid_credit_source', 503);
    const sparse: UsCustomerCreditSourceLine[] = []; sparse.length = 1;
    const decorated = Object.assign([line()], { privateSecret: 'SECRET' });
    for (const lines of [sparse, decorated, Object.setPrototypeOf([line()], null) as unknown, [line({ jurisdiction: '\ud800' })]]) expectError(() => validateUsCustomerCreditSource({ ...source(), lines }), 'invalid_credit_source', 503);
    const cycle: Record<string, unknown> = { ...source() }; cycle.lines = [cycle];
    expectError(() => validateUsCustomerCreditSource(cycle), 'invalid_credit_source', 503);
  });
});

describe('exact original-net and historical-tax candidate allocation', () => {
  it('preserves source ordering even when selections arrive reversed and uses only original net after discounts', () => {
    const seed = source([line({ lineId: 'z-first', quantityUnits: '2', netMinor: '999', taxMinor: '1' }), line({ lineId: 'a-second', quantityUnits: '5', netMinor: '400', taxMinor: '17' })]);
    const result = prepareUsCustomerCreditAllocation(seed, [{ lineId: 'a-second', quantityUnits: '2' }, { lineId: 'z-first', quantityUnits: '1' }]);
    expect(result.lines).toEqual([
      { lineId: 'z-first', quantityUnits: '1', netMinor: '500', taxMinor: '1', totalMinor: '501' },
      { lineId: 'a-second', quantityUnits: '2', netMinor: '160', taxMinor: '7', totalMinor: '167' },
    ]);
    expect(result).toMatchObject({ invoiceFingerprint: fingerprint, netMinor: '660', taxMinor: '8', totalMinor: '668' });
    expect(Object.keys(result).sort()).toEqual(['invoiceFingerprint', 'lines', 'netMinor', 'taxMinor', 'totalMinor']);
    expect(JSON.stringify(result)).not.toMatch(/rate|refund|journal|discount|issued|provider/i);
  });
  it('allocates original net and original tax independently at exact ties, never a combined gross ratio', () => {
    const seed = source([line({ quantityUnits: '2', netMinor: '3', taxMinor: '1' })]);
    const first = prepareUsCustomerCreditAllocation(seed, selection('1'));
    expect(first).toMatchObject({ netMinor: '2', taxMinor: '1', totalMinor: '3' });
    const last = prepareUsCustomerCreditAllocation(seed, selection('1'), [{ id: 'first', allocation: first }]);
    expect(last).toMatchObject({ netMinor: '1', taxMinor: '0', totalMinor: '1' });
    expect(BigInt(first.totalMinor) + BigInt(last.totalMinor)).toBe(BigInt(4));
  });
  it.each([0, 1, 2, 3, 4, 5, 6])('uses the original units correctly at quantity scale %s', quantityScale => {
    const seed = source([line({ quantityScale, quantityUnits: '1250000', netMinor: '1199', taxMinor: '97' })]);
    const first = prepareUsCustomerCreditAllocation(seed, selection('500000'));
    expect(first).toMatchObject({ netMinor: '480', taxMinor: '39', totalMinor: '519' });
    const last = prepareUsCustomerCreditAllocation(seed, selection('750000'), [{ id: 'partial', allocation: first }]);
    expect(last).toMatchObject({ netMinor: '719', taxMinor: '58', totalMinor: '777' });
    expect(remainingUsCustomerCredit(seed, [{ id: 'partial', allocation: first }, { id: 'last', allocation: last }])[0]).toMatchObject({ remainingQuantityUnits: '0', remainingNetMinor: '0', remainingTaxMinor: '0' });
  });
  it('reconstructs successive thirds and assigns every final cent from the cumulative original amounts', () => {
    const seed = source(), batches: UsCustomerCreditAllocationHistory[] = [];
    for (let index = 0; index < 3; index++) batches.push({ id: `partial-${index}`, allocation: prepareUsCustomerCreditAllocation(seed, selection('1'), batches) });
    expect(batches.map(batch => [batch.allocation.netMinor, batch.allocation.taxMinor])).toEqual([['33', '4'], ['34', '3'], ['33', '4']]);
    expect(batches.reduce((sum, batch) => sum + BigInt(batch.allocation.totalMinor), BigInt(0))).toBe(BigInt(111));
    expectError(() => prepareUsCustomerCreditAllocation(seed, selection('1'), batches), 'credit_quantity_exceeded', 409);
  });
  it('keeps quantities and amounts above Number precision exact', () => {
    const seed = source([line({ quantityUnits: '9007199254740993', netMinor: '9007199254740993', taxMinor: '9007199254740992' })]);
    const first = prepareUsCustomerCreditAllocation(seed, selection('4503599627370496'));
    expect(first).toMatchObject({ netMinor: '4503599627370496', taxMinor: '4503599627370496', totalMinor: '9007199254740992' });
    const last = prepareUsCustomerCreditAllocation(seed, selection('4503599627370497'), [{ id: 'first', allocation: first }]);
    expect(last).toMatchObject({ netMinor: '4503599627370497', taxMinor: '4503599627370496', totalMinor: '9007199254740993' });
  });
  it('accepts36digit source integers and exact sums larger than an input field', () => {
    const maximum = '9'.repeat(36), seed = source([line({ lineId: 'one', quantityUnits: maximum, netMinor: maximum, taxMinor: maximum }), line({ lineId: 'two', quantityUnits: '1', netMinor: maximum, taxMinor: maximum })]);
    const full = prepareUsCustomerCreditAllocation(seed, [{ lineId: 'one', quantityUnits: maximum }, { lineId: 'two', quantityUnits: '1' }]);
    expect(full.netMinor).toBe((BigInt(maximum) * BigInt(2)).toString()); expect(full.taxMinor).toBe(full.netMinor); expect(full.totalMinor).toBe((BigInt(maximum) * BigInt(4)).toString());
    expect(remainingUsCustomerCredit(seed, [{ id: 'full', allocation: full }]).every(item => item.remainingNetMinor === '0' && item.remainingTaxMinor === '0')).toBe(true);
  });
  it('checks a matrix of indivisible cumulative amounts without losing cents', () => {
    for (let quantity = 1; quantity <= 17; quantity++) {
      const seed = source([line({ quantityUnits: String(quantity), netMinor: String(quantity * 2 + 1), taxMinor: String(quantity - 1) })]), batches: UsCustomerCreditAllocationHistory[] = [];
      let net = BigInt(0), tax = BigInt(0);
      for (let used = 1; used <= quantity; used++) {
        const allocation = prepareUsCustomerCreditAllocation(seed, selection('1'), batches);
        net += BigInt(allocation.netMinor); tax += BigInt(allocation.taxMinor);
        // Algebraically independent rounded-rational expression at every prefix.
        const q = BigInt(quantity), cumulative = BigInt(used);
        expect(net).toBe((BigInt(quantity * 2 + 1) * cumulative * BigInt(2) + q) / (q * BigInt(2)));
        expect(tax).toBe((BigInt(quantity - 1) * cumulative * BigInt(2) + q) / (q * BigInt(2)));
        expect(BigInt(allocation.totalMinor)).toBe(BigInt(allocation.netMinor) + BigInt(allocation.taxMinor));
        batches.push({ id: `batch-${used}`, allocation });
      }
      expect(net).toBe(BigInt(seed.lines[0].netMinor)); expect(tax).toBe(BigInt(seed.lines[0].taxMinor));
    }
  });
  it('includes a zero-value selected line when the same batch contains a positive line', () => {
    const seed = source([line({ lineId: 'free', quantityUnits: '2', netMinor: '0', taxMinor: '0' }), line({ lineId: 'paid', quantityUnits: '1', netMinor: '100', taxMinor: '0' })]);
    const result = prepareUsCustomerCreditAllocation(seed, [{ lineId: 'free', quantityUnits: '1' }, { lineId: 'paid', quantityUnits: '1' }]);
    expect(result.lines[0]).toEqual({ lineId: 'free', quantityUnits: '1', netMinor: '0', taxMinor: '0', totalMinor: '0' }); expect(result.totalMinor).toBe('100');
    expectError(() => prepareUsCustomerCreditAllocation(seed, selection('1', 'free')), 'credit_amount_zero', 422);
  });
  it('rejects a positive-quantity partial slice that rounds entirely to zero', () => {
    const seed = source([line({ netMinor: '1', taxMinor: '0', quantityUnits: '3' })]);
    expectError(() => prepareUsCustomerCreditAllocation(seed, selection('1')), 'credit_amount_zero', 422);
    expect(prepareUsCustomerCreditAllocation(seed, selection('2')).totalMinor).toBe('1');
  });
  it('returns detached frozen allocations and remaining lines without changing the supplied source, selection or history', () => {
    const seed = source(), selected = selection('1'), prior = history(seed), before = JSON.stringify([seed, selected, prior]);
    const result = prepareUsCustomerCreditAllocation(seed, selected, prior), remaining = remainingUsCustomerCredit(seed, prior);
    expect(JSON.stringify([seed, selected, prior])).toBe(before);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.lines)).toBe(true); expect(Object.isFrozen(result.lines[0])).toBe(true);
    expect(Object.isFrozen(remaining)).toBe(true); expect(Object.isFrozen(remaining[0])).toBe(true); expect(remaining[0]).not.toBe(seed.lines[0]);
    expect(Object.isFrozen(prior)).toBe(false); expect(remaining[0]).toMatchObject({ remainingQuantityUnits: '2', remainingNetMinor: '67', remainingTaxMinor: '7' });
  });
});

describe('selection constraints and business limits', () => {
  it.each([
    ['empty', []], ['unknown line', selection('1', 'other')], ['duplicate line', [...selection('1'), ...selection('1')]],
    ['quantity zero', selection('0')], ['negative quantity', selection('-1')], ['leading zero', selection('01')], ['decimal quantity', selection('1.0')], ['overlong quantity', selection('1'.repeat(37))],
    ['Number quantity', [{ lineId: 'original-line', quantityUnits: 1 }]], ['extra amount', [{ lineId: 'original-line', quantityUnits: '1', netMinor: '1' }]],
    ['missing quantity', [{ lineId: 'original-line' }]], ['padded ID', selection('1', ' original-line')], ['nonarray', {}], ['null', null], ['oversized', Array.from({ length: 1001 }, () => ({ lineId: 'original-line', quantityUnits: '1' }))],
  ])('rejects %s as a public selection error', (_name, input) => {
    expectError(() => prepareUsCustomerCreditAllocation(source(), uncheckedSelection(input)), 'invalid_credit_selection', 422);
  });
  it('refuses to over-credit before or after a valid partial history', () => {
    expectError(() => prepareUsCustomerCreditAllocation(source(), selection('4')), 'credit_quantity_exceeded', 409);
    expectError(() => prepareUsCustomerCreditAllocation(source(), selection('3'), history()), 'credit_quantity_exceeded', 409);
    expect(remainingUsCustomerCredit(source())[0]).toMatchObject({ remainingQuantityUnits: '3', remainingNetMinor: '100', remainingTaxMinor: '11' });
  });
  it('does not invoke selection accessors or accept sparse/decorated/prototype arrays', () => {
    const getter = vi.fn(() => '1'), accessor = Object.defineProperty({ lineId: 'original-line' }, 'quantityUnits', { enumerable: true, get: getter });
    const sparse: UsCustomerCreditSelection[] = []; sparse.length = 1;
    const decorated = Object.assign([...selection('1')], { reference: 'untrusted' });
    for (const input of [[accessor], sparse, decorated, Object.setPrototypeOf([...selection('1')], null) as unknown]) expectError(() => prepareUsCustomerCreditAllocation(source(), uncheckedSelection(input)), 'invalid_credit_selection', 422);
    expect(getter).not.toHaveBeenCalled();
  });
  it('handles maximum1000 source lines and selectors while preserving original order', () => {
    const seed = source(Array.from({ length: 1000 }, (_, index) => line({ lineId: `line-${index}`, quantityUnits: '1', netMinor: '1', taxMinor: '0' })));
    const selected = [...seed.lines].reverse().map(item => ({ lineId: item.lineId, quantityUnits: '1' }));
    const result = prepareUsCustomerCreditAllocation(seed, selected);
    expect(result.lines).toHaveLength(1000); expect(result.lines[0].lineId).toBe('line-0'); expect(result.lines.at(-1)?.lineId).toBe('line-999'); expect(result.totalMinor).toBe('1000');
  });
});

describe('reconstruction of every prior allocation', () => {
  it.each([
    ['different source', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { invoiceFingerprint: 'b'.repeat(64) })],
    ['wrong net sum', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { netMinor: '34' })],
    ['wrong tax sum', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { taxMinor: '3' })],
    ['wrong total sum', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { totalMinor: '38' })],
    ['Number amount', (a: UsCustomerCreditAllocation) => ({ ...a, totalMinor: 37 })],
    ['leading zero amount', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { totalMinor: '037' })],
    ['negative amount', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { taxMinor: '-4' })],
    ['missing amount', (a: UsCustomerCreditAllocation) => ({ invoiceFingerprint: a.invoiceFingerprint, lines: a.lines, netMinor: a.netMinor, taxMinor: a.taxMinor })],
    ['extra field', (a: UsCustomerCreditAllocation) => ({ ...a, authorized: true })],
    ['no lines', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { lines: [] })],
    ['duplicate line', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { lines: [...a.lines, ...a.lines] })],
    ['unknown line', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { lines: [{ ...a.lines[0], lineId: 'other' }] })],
    ['zero quantity', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { lines: [{ ...a.lines[0], quantityUnits: '0' }] })],
    ['line total mismatch', (a: UsCustomerCreditAllocation) => replaceAllocation(a, { lines: [{ ...a.lines[0], totalMinor: '38' }] })],
    ['extra line field', (a: UsCustomerCreditAllocation) => ({ ...a, lines: [{ ...a.lines[0], rate: '0.1' }] })],
  ])('refuses a forged history with %s in both preparation and remaining projections', (_name, forge) => {
    const original = history(), forged = [{ id: 'forged', allocation: forge(original[0].allocation) }];
    expectError(() => prepareUsCustomerCreditAllocation(source(), selection('1'), uncheckedHistory(forged)), 'invalid_credit_history', 503);
    expectError(() => remainingUsCustomerCredit(source(), uncheckedHistory(forged)), 'invalid_credit_history', 503);
  });
  it('rejects independently rounded slices even if line totals and batch totals are arithmetically consistent', () => {
    const first = history(), wrong = { invoiceFingerprint: fingerprint, lines: [{ lineId: 'original-line', quantityUnits: '1', netMinor: '33', taxMinor: '4', totalMinor: '37' }], netMinor: '33', taxMinor: '4', totalMinor: '37' };
    expectError(() => prepareUsCustomerCreditAllocation(source(), selection('1'), [...first, { id: 'wrong-second-rounding', allocation: wrong }]), 'invalid_credit_history', 503);
  });
  it('requires archived line order rather than accepting a numerically equivalent reordered allocation', () => {
    const seed = source([line({ lineId: 'z-first' }), line({ lineId: 'a-second' })]), allocation = prepareUsCustomerCreditAllocation(seed, [{ lineId: 'a-second', quantityUnits: '1' }, { lineId: 'z-first', quantityUnits: '1' }]);
    const forged = [{ id: 'reordered', allocation: { ...allocation, lines: [...allocation.lines].reverse() } }];
    expectError(() => remainingUsCustomerCredit(seed, forged), 'invalid_credit_history', 503);
  });
  it('rejects duplicate batch IDs and historical over-credit even with fabricated matching sums', () => {
    const first = history()[0];
    expectError(() => remainingUsCustomerCredit(source(), [first, first]), 'invalid_credit_history', 503);
    const over = { invoiceFingerprint: fingerprint, lines: [{ lineId: 'original-line', quantityUnits: '4', netMinor: '133', taxMinor: '15', totalMinor: '148' }], netMinor: '133', taxMinor: '15', totalMinor: '148' };
    expectError(() => remainingUsCustomerCredit(source(), [{ id: 'over', allocation: over }]), 'invalid_credit_history', 503);
  });
  it('rejects a historical zero-value batch, rather than silently consuming quantity', () => {
    const seed = source([line({ netMinor: '1', taxMinor: '0' })]), zero = { invoiceFingerprint: fingerprint, lines: [{ lineId: 'original-line', quantityUnits: '1', netMinor: '0', taxMinor: '0', totalMinor: '0' }], netMinor: '0', taxMinor: '0', totalMinor: '0' };
    expectError(() => remainingUsCustomerCredit(seed, [{ id: 'zero', allocation: zero }]), 'invalid_credit_history', 503);
  });
  it.each([null, {}, [{ allocation: {} }], [{ id: 'a', allocation: {}, unexpected: true }], Array.from({ length: 1001 }, (_, index) => ({ id: String(index), allocation: {} }))])('refuses malformed history containers without trusting summaries', input => {
    expectError(() => remainingUsCustomerCredit(source(), uncheckedHistory(input)), 'invalid_credit_history', 503);
  });
  it('does not invoke history getters and rejects decorated arrays, custom prototypes, symbols and hidden batch fields', () => {
    const getter = vi.fn(() => history()[0].allocation), accessor = Object.defineProperty({ id: 'first' }, 'allocation', { enumerable: true, get: getter });
    const decorated = Object.assign(history(), { privateSecret: 'SECRET' });
    const inherited = Object.create(history()[0]) as unknown;
    const symbol = { ...history()[0], [Symbol('secret')]: 'SECRET' };
    const hidden = Object.defineProperty({ ...history()[0] }, 'secret', { value: 'SECRET', enumerable: false });
    for (const input of [[accessor], decorated, [inherited], [symbol], [hidden]]) expectError(() => remainingUsCustomerCredit(source(), uncheckedHistory(input)), 'invalid_credit_history', 503);
    expect(getter).not.toHaveBeenCalled();
  });
  it('validates all1000 allowed batches and rejects any extra quantity afterward', () => {
    const seed = source([line({ quantityUnits: '1000', netMinor: '1000', taxMinor: '0' })]);
    const batches = Array.from({ length: 1000 }, (_, index) => ({ id: `batch-${index}`, allocation: { invoiceFingerprint: fingerprint, lines: [{ lineId: 'original-line', quantityUnits: '1', netMinor: '1', taxMinor: '0', totalMinor: '1' }], netMinor: '1', taxMinor: '0', totalMinor: '1' } }));
    expect(remainingUsCustomerCredit(seed, batches)[0]).toMatchObject({ remainingQuantityUnits: '0', remainingNetMinor: '0', remainingTaxMinor: '0' });
    expectError(() => prepareUsCustomerCreditAllocation(seed, selection('1'), batches), 'credit_quantity_exceeded', 409);
  });
});
