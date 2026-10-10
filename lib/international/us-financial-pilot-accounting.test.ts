import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { validateUsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotAccountingRequest, US_FINANCIAL_PILOT_ACCOUNTING_MAX_BODY_BYTES, usFinancialPilotAccountingEntityId,
  validateUsFinancialPilotAccountingReceipt, validateUsFinancialPilotAccountingRequest, type UsFinancialPilotAccountingCommand } from './us-financial-pilot-accounting';

const requestId = 'a1000000-0000-4000-8000-000000000001';
const lines = (amount = '9007199254740993') => [{ accountId: 'inventory', debitMinor: amount, creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: amount }];
const journal = () => ({ type: 'post_manual_journal', transactionDate: '2025-12-31', accountingDate: '2026-10-10', periodId: '2026', description: 'Synthetic journal — Genève 🌍', sourceReference: 'Manual source', lines: lines() }) as const;
const reversal = () => ({ type: 'reverse_manual_journal', journalRevision: 2, transactionDate: '2024-01-01', accountingDate: '2026-10-11', periodId: '2026', reason: 'Synthetic correction' }) as const;
const open = () => ({ type: 'open_period', start: '2027-01-01', end: '2027-12-31' }) as const;
const close = () => ({ type: 'close_period', periodId: '2026' }) as const;
const request = <T>(command: T) => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 9, command });
const bad = (value: unknown) => expect(() => validateUsFinancialPilotAccountingRequest(value)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_request', status: 422 }));

describe('financial-pilot accounting closed commands and server identity', () => {
  it.each([journal(), reversal(), open(), close()])('builds $type with deterministic server identity and no public-only fields', command => {
    const input = validateUsFinancialPilotAccountingRequest(request(command)), built = buildUsFinancialPilotAccountingRequest(input, 'workspace', command.type === 'reverse_manual_journal' ? 'immutable-private-original' : undefined);
    expect(built.idempotencyKey).toBe(`pilot:accounting:${requestId}`); expect(built.expectedRevision).toBe(9);
    expect(validateUsFinancialRequestV5(built, 'workspace')).toEqual(built);
    if (command.type === 'reverse_manual_journal') {
      expect(built.command).toEqual({ type: 'erp_command', request: { type: command.type, id: `pilot-journal-reversal:${requestId}`, entryId: 'immutable-private-original', transactionDate: command.transactionDate, accountingDate: command.accountingDate, periodId: command.periodId, reason: command.reason } });
      expect(JSON.stringify(built)).not.toContain('journalRevision');
    } else expect(built.command).toEqual({ type: 'erp_command', request: command.type === 'close_period' ? command : { ...command, id: usFinancialPilotAccountingEntityId(input) } });
    expect(JSON.stringify(built)).not.toMatch(/postedBy|postedAt|currency|basis|organizationId|fingerprint|policy/);
  });
  it('requires a resolved reversal identity and rejects identity parameters on other commands', () => {
    expect(() => buildUsFinancialPilotAccountingRequest(request(reversal()), 'workspace')).toThrow(expect.objectContaining({ status: 422 }));
    for (const value of ['', ' '.repeat(2), 'x'.repeat(161), 'private\nentry']) expect(() => buildUsFinancialPilotAccountingRequest(request(reversal()), 'workspace', value)).toThrow();
    for (const command of [journal(), open(), close()]) expect(() => buildUsFinancialPilotAccountingRequest(request(command), 'workspace', 'unexpected')).toThrow();
    expect(() => buildUsFinancialPilotAccountingRequest(request(journal()), 'x'.repeat(129))).toThrow();
  });
  it('captures immutable lines and Unicode exactly and retains each editable fact in the native payload', () => {
    const raw = request({ ...journal(), lines: lines().map(row => ({ ...row, description: 'Exact 🌍 line' })) }), checked = validateUsFinancialPilotAccountingRequest(raw), built = buildUsFinancialPilotAccountingRequest(raw, 'workspace'), before = canonicalErpJson(built);
    raw.command.lines[0].description = 'Changed'; raw.command.lines[0].debitMinor = '1';
    expect(checked.command.type === 'post_manual_journal' && checked.command.lines[0]).toMatchObject({ debitMinor: '9007199254740993', description: 'Exact 🌍 line' });
    expect(canonicalErpJson(built)).toBe(before); expect(Object.isFrozen(checked.command)).toBe(true);
    expect(checked.command.type === 'post_manual_journal' && Object.isFrozen(checked.command.lines)).toBe(true);
    expect(checked.command.type === 'post_manual_journal' && Object.isFrozen(checked.command.lines[0])).toBe(true);
    for (const patch of [{ description: 'Different' }, { sourceReference: 'Different' }, { transactionDate: '2020-01-01' }, { accountingDate: '2026-10-11' }, { periodId: 'other' }, { lines: lines('9007199254740994') }, { cashFlowCategory: 'financing' }]) {
      expect(canonicalErpJson(buildUsFinancialPilotAccountingRequest(request({ ...journal(), ...patch }), 'workspace'))).not.toBe(canonicalErpJson(buildUsFinancialPilotAccountingRequest(request(journal()), 'workspace')));
    }
    expect(canonicalErpJson(buildUsFinancialPilotAccountingRequest(request(reversal()), 'workspace', 'one'))).not.toBe(canonicalErpJson(buildUsFinancialPilotAccountingRequest(request(reversal()), 'workspace', 'two')));
  });
  it('supports 1000 exact lines and aggregate totals above36 digits without a new economic cap', () => {
    const amount = '9'.repeat(36), thousand = Array.from({ length: 500 }, () => lines(amount)).flat(), checked = validateUsFinancialPilotAccountingRequest(request({ ...journal(), lines: thousand }));
    expect(checked.command.type === 'post_manual_journal' && checked.command.lines).toHaveLength(1000);
    expect((BigInt(amount) * BigInt(500)).toString()).toHaveLength(39);
    expect(() => buildUsFinancialPilotAccountingRequest(checked, 'workspace')).not.toThrow();
    bad(request({ ...journal(), lines: [...thousand, thousand[0]] })); bad(request({ ...journal(), lines: [thousand[0]] }));
  });
  it('requires classification for net cash movement and permits cash lines with a zero net movement', () => {
    const cash = [{ accountId: 'cash', debitMinor: '100', creditMinor: '0' }, { accountId: 'sales', debitMinor: '0', creditMinor: '100' }];
    bad(request({ ...journal(), lines: cash }));
    for (const cashFlowCategory of ['operating', 'investing', 'financing']) expect(validateUsFinancialPilotAccountingRequest(request({ ...journal(), lines: cash, cashFlowCategory })).command).toMatchObject({ cashFlowCategory });
    const neutral = [cash[0], { accountId: 'cash', debitMinor: '0', creditMinor: '100' }];
    expect(validateUsFinancialPilotAccountingRequest(request({ ...journal(), lines: neutral })).command).not.toHaveProperty('cashFlowCategory');
  });
  it('enforces the exact UTF8 body boundary including valid multibyte text', () => {
    const raw = request({ ...journal(), lines: Array.from({ length: 500 }, () => lines('1')).flat().map(row => ({ ...row, description: 'x' })) });
    let remaining = US_FINANCIAL_PILOT_ACCOUNTING_MAX_BODY_BYTES - new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    for (const row of raw.command.lines) { const add = Math.min(1999, remaining); row.description += 'x'.repeat(add); remaining -= add; }
    expect(remaining).toBe(0); expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBe(262_144);
    expect(() => validateUsFinancialPilotAccountingRequest(raw)).not.toThrow();
    raw.command.lines[0].description = 'é' + raw.command.lines[0].description.slice(1);
    expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBe(262_145); bad(raw);
  });
  it('accepts text and calendar endpoints at the domain boundaries without adding date ordering rules', () => {
    const checked = validateUsFinancialPilotAccountingRequest(request({ ...journal(), periodId: 'p'.repeat(160), description: 'd'.repeat(2000), sourceReference: 's'.repeat(160), lines: lines().map(row => ({ ...row, accountId: row.accountId, description: 'l'.repeat(2000) })) }));
    expect(checked.command.type).toBe('post_manual_journal'); expect(validateUsFinancialPilotAccountingRequest(request({ ...reversal(), reason: 'r'.repeat(2000) })).command.type).toBe('reverse_manual_journal');
    expect(validateUsFinancialPilotAccountingRequest(request({ ...open(), start: '2028-02-29', end: '2028-02-29' })).command).toMatchObject({ start: '2028-02-29' });
  });
  it.each([
    ['private envelope', () => ({ ...request(journal()), actor: 'owner' })], ['wrong consumer', () => ({ ...request(journal()), consumer: 'erp5' })], ['wrong schema', () => ({ ...request(journal()), schemaVersion: 5 })],
    ['uppercase UUID', () => ({ ...request(journal()), requestId: requestId.toUpperCase() })], ['invalid UUID', () => ({ ...request(journal()), requestId: 'id' })], ['zero revision', () => ({ ...request(journal()), expectedRevision: 0 })], ['unsafe revision', () => ({ ...request(journal()), expectedRevision: Number.MAX_SAFE_INTEGER })],
    ['other command', () => request({ type: 'record_payment' })], ['private ID', () => request({ ...journal(), id: 'caller' })], ['private source', () => request({ ...journal(), source: { type: 'other', id: 'caller' } })], ['private actor', () => request({ ...journal(), postedBy: 'owner' })],
    ['private currency', () => request({ ...journal(), currency: 'CHF' })], ['private revision ID', () => request({ ...reversal(), entryId: 'caller' })], ['client reversal lines', () => request({ ...reversal(), lines: lines() })], ['source on close', () => request({ ...close(), start: '2026-01-01' })],
    ['invalid date', () => request({ ...journal(), accountingDate: '2026-02-30' })], ['year zero', () => request({ ...journal(), transactionDate: '0000-01-01' })], ['period end before start', () => request({ ...open(), end: '2026-01-01' })], ['zero journal revision', () => request({ ...reversal(), journalRevision: 0 })],
    ['long ID', () => request({ ...close(), periodId: 'x'.repeat(161) })], ['long source', () => request({ ...journal(), sourceReference: 'x'.repeat(161) })], ['long journal description', () => request({ ...journal(), description: 'x'.repeat(2001) })], ['long reason', () => request({ ...reversal(), reason: 'x'.repeat(2001) })],
    ['blank source', () => request({ ...journal(), sourceReference: ' ' })], ['control text', () => request({ ...journal(), description: 'x\ny' })], ['bad Unicode', () => request({ ...journal(), description: '\ud800' })], ['null category', () => request({ ...journal(), cashFlowCategory: null })], ['unknown category', () => request({ ...journal(), cashFlowCategory: 'other' })],
    ['leading zero', () => request({ ...journal(), lines: lines('01') })], ['signed amount', () => request({ ...journal(), lines: lines('+1') })], ['exponent', () => request({ ...journal(), lines: lines('1e3') })], ['decimal', () => request({ ...journal(), lines: lines('1.00') })], ['blank amount', () => request({ ...journal(), lines: lines('') })], ['long amount', () => request({ ...journal(), lines: lines('1'.repeat(37)) })],
    ['zero line', () => request({ ...journal(), lines: lines('0') })], ['both sides positive', () => request({ ...journal(), lines: lines().map(row => ({ ...row, debitMinor: '1', creditMinor: '1' })) })], ['unbalanced', () => request({ ...journal(), lines: [lines()[0], { ...lines()[1], creditMinor: '1' }] })], ['unknown account', () => request({ ...journal(), lines: lines().map(row => ({ ...row, accountId: 'unknown' })) })],
    ['null optional description', () => request({ ...journal(), lines: lines().map(row => ({ ...row, description: null })) })], ['empty optional description', () => request({ ...journal(), lines: lines().map(row => ({ ...row, description: '' })) })], ['long line description', () => request({ ...journal(), lines: lines().map(row => ({ ...row, description: 'x'.repeat(2001) })) })], ['private line field', () => request({ ...journal(), lines: lines().map(row => ({ ...row, fingerprint: 'private' })) })],
  ] as const)('rejects %s', (_name, input) => bad(input()));
  it.each(['receivables', 'payables', 'tax-payable', 'deposits'])('protects %s from manual entries', accountId => bad(request({ ...journal(), lines: [{ ...lines()[0], accountId }, lines()[1]] })));
  it('rejects hidden keys, prototypes, symbols and getters without executing them', () => {
    const getter = vi.fn(() => 'private');
    for (const raw of [Object.defineProperty(request(journal()), 'actor', { enumerable: true, get: getter }), Object.defineProperty(request(journal()), 'requestId', { enumerable: true, get: getter }), Object.defineProperty(request(journal()), 'private', { value: true }), Object.assign(Object.create({ role: 'owner' }) as object, request(journal())), { ...request(journal()), [Symbol('private')]: true }, request({ ...journal(), lines: [Object.defineProperty(lines()[0], 'debitMinor', { enumerable: true, get: getter }), lines()[1]] })]) bad(raw);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([journal(), reversal(), open(), close()] as UsFinancialPilotAccountingCommand[])('binds receipt $type to request, action, entity and exact successor revision', command => {
    const expected = validateUsFinancialPilotAccountingRequest(request(command)), receipt = { consumer: 'financial-pilot', schemaVersion: 1, organizationId: 'workspace', revision: 10, entityId: usFinancialPilotAccountingEntityId(expected), action: command.type, requestId };
    expect(validateUsFinancialPilotAccountingReceipt(receipt, 'workspace', expected)).toEqual(receipt);
    for (const patch of [{ organizationId: 'other' }, { requestId: 'a1000000-0000-4000-8000-000000000002' }, { revision: 11 }, { entityId: 'other' }, { action: 'erp_command' }, { action: command.type === 'close_period' ? 'open_period' : 'close_period' }, { hash: 'private' }]) expect(() => validateUsFinancialPilotAccountingReceipt({ ...receipt, ...patch }, 'workspace', expected)).toThrow(expect.objectContaining({ code: 'invalid_financial_pilot_response', status: 503 }));
    const getter = vi.fn(() => 'private'); expect(() => validateUsFinancialPilotAccountingReceipt(Object.defineProperty({ ...receipt }, 'entityId', { enumerable: true, get: getter }), 'workspace', expected)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
