import { describe, expect, it, vi } from 'vitest';
import { recordProject, validateProjectInput, validateStoredProject, type ProjectInput } from './projects';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';

const config: CompanyConfiguration = { schemaVersion: 1, organizationId: 'fictional-projects', country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictional Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
const actor: FinancialAuthority = { organizationId: config.organizationId, userId: 'fictional-user', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const input = (): ProjectInput => ({ id: 'project-one', expectedProjectRevision: 0, customerId: 'customer-one', name: 'Fictional project', status: 'active', notes: 'Line one\nLine two', startDate: '2026-10-08', targetDate: '2026-11-08', budgetMinor: '100001', vendorBillIds: ['bill-one'] });
const recorded = () => recordProject(config, input(), null, 'PRJ-000001', actor);
const failure = (task: () => unknown, code = 'invalid_request', status = 422) => expect(task).toThrow(expect.objectContaining({ code, status, message: code }));

describe('authorized exact project metadata', () => {
  it.each(['owner','admin','accountant'] as const)('records %s metadata without a ledger or financial mutation', role => {
    const before = structuredClone({ config, input: input() });
    const project = recordProject(config, input(), null, 'PRJ-000001', { ...actor, role });
    expect(project).toEqual({ id: 'project-one', organizationId: config.organizationId, currency: 'USD', revision: 1, number: 'PRJ-000001', customerId: 'customer-one', name: 'Fictional project', status: 'active', notes: 'Line one\nLine two', startDate: '2026-10-08', targetDate: '2026-11-08', budget: { currency: 'USD', minorUnits: '100001' }, vendorBillIds: ['bill-one'], createdAt: actor.timestamp, updatedAt: actor.timestamp });
    expect({ config, input: input() }).toEqual(before); expect(Object.isFrozen(project)).toBe(true); expect(Object.isFrozen(project.vendorBillIds)).toBe(true); expect(Object.isFrozen(project.budget)).toBe(true);
    expect(Object.keys(project)).not.toContain('userId');
  });
  it.each(['member','read_only','invented-owner'])('rejects role %s', role => failure(() => recordProject(config, input(), null, 'PRJ-000001', { ...actor, role: role as FinancialAuthority['role'] }), 'financial_permission_required', 403));
  it('requires the actual workspace and entitlement', () => {
    failure(() => recordProject(config, input(), null, 'PRJ-000001', { ...actor, organizationId: 'other' }), 'tenant_mismatch', 403);
    failure(() => recordProject(config, input(), null, 'PRJ-000001', { ...actor, managementEntitled: false }), 'management_entitlement_required', 402);
  });
  it('retains numbering and creation history when archived, updated and reopened', () => {
    const before = recorded(), next = recordProject(config, { ...input(), expectedProjectRevision: 1, status: 'archived', notes: 'Updated notes' }, before, before.number, { ...actor, timestamp: '2026-10-09T12:00:00.000Z' });
    expect(next).toMatchObject({ revision: 2, status: 'archived', createdAt: actor.timestamp, updatedAt: '2026-10-09T12:00:00.000Z', number: before.number });
    const reopened = recordProject(config, { ...input(), expectedProjectRevision: 2 }, next, next.number, { ...actor, timestamp: '2026-10-10T12:00:00.000Z' });
    expect(reopened.status).toBe('active'); expect(before.notes).toBe('Line one\nLine two');
  });
  it('refuses stale revisions, renumbering, record substitution and time reversal', () => {
    const before = recorded(), update = { ...input(), expectedProjectRevision: 1 };
    for (const [value, previous, number, admitted] of [[input(),before,before.number,actor],[update,before,'PRJ-000002',actor],[{...update,id:'other'},before,before.number,actor],[update,before,before.number,{...actor,timestamp:'2026-10-07T12:00:00.000Z'}],[update,null,before.number,actor]] as const) failure(() => recordProject(config, value, previous, number, admitted), 'revision_conflict', 409);
  });
  it('never silently crosses another workspace or currency', () => {
    failure(() => validateStoredProject({ ...recorded(), organizationId: 'other' }, config), 'invalid_stored_state', 503);
    failure(() => validateStoredProject({ ...recorded(), currency: 'CHF' }, config), 'invalid_stored_state', 503);
    failure(() => validateStoredProject({ ...recorded(), budget: { currency: 'CHF', minorUnits: '1' } }, config), 'invalid_stored_state', 503);
  });
  it('supports CH metadata in the pure domain without activating or importing a Swiss book', () => {
    const ch: CompanyConfiguration = { schemaVersion:1, organizationId:config.organizationId, language:'fr', accountingBasis:'accrual', invoiceNumberPrefix:'INV', taxConfiguration:{status:'unconfigured'}, country: 'CH', currency: 'CHF', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' } };
    expect(recordProject(ch, input(), null, 'PRJ-000001', actor).budget).toEqual({ currency: 'CHF', minorUnits: '100001' });
  });
});

describe('project boundary validation', () => {
  it.each(['0','1','90071992547409931234567890','9'.repeat(36),null])('keeps budget %s exact and optional', budgetMinor => expect(recordProject(config, { ...input(), budgetMinor }, null, 'PRJ-000001', actor).budget).toEqual(budgetMinor === null ? null : { currency: 'USD', minorUnits: budgetMinor }));
  it.each(['-1','-0','01','+1','1.00','1e5','1,000','9'.repeat(37),'',1,undefined])('rejects budget %s instead of coercing/rounding', budgetMinor => {
    failure(() => validateProjectInput({ ...input(), budgetMinor }), budgetMinor === undefined ? 'invalid_request' : 'invalid_amount');
  });
  it.each(['0000-01-01','2026-02-29','2026-13-01','2026-01-32','2026-1-1','10/08/2026','2026-10-08T00:00:00Z',''])('rejects non-civil date %s', startDate => failure(() => validateProjectInput({ ...input(), startDate }), 'invalid_date'));
  it('supports leap days, missing planning dates and rejects reverse plans', () => {
    expect(validateProjectInput({ ...input(), startDate: null, targetDate: null }).startDate).toBeNull();
    expect(validateProjectInput({ ...input(), startDate: '2028-02-29', targetDate: '2028-03-01' }).startDate).toBe('2028-02-29');
    failure(() => validateProjectInput({ ...input(), targetDate: '2026-10-07' }), 'invalid_date');
  });
  it.each(['organizationId','currency','revision','number','createdAt','updatedAt','role','userId','delete','logoUrl'])('rejects injected field %s', field => failure(() => validateProjectInput({ ...input(), [field]: 'injected' })));
  it.each(['id','customerId','name','status','notes','startDate','targetDate','budgetMinor','vendorBillIds','expectedProjectRevision'])('requires field %s', field => { const data = { ...input() } as Record<string, unknown>; delete data[field]; failure(() => validateProjectInput(data)); });
  it('enforces useful text limits, line breaks and no control data', () => {
    expect(validateProjectInput({ ...input(), name: 'n'.repeat(200), notes: 'n'.repeat(20_000) }).name.length).toBe(200);
    for (const update of [{ name: 'n'.repeat(201) },{ notes: 'n'.repeat(20_001) },{ id: 'x\n' },{ name: ' ' },{ notes: 'x\u0001' },{ status: 'deleted' }]) failure(() => validateProjectInput({ ...input(), ...update }));
  });
  it('accepts a bounded list without duplicates or foreign fields', () => {
    expect(validateProjectInput({ ...input(), vendorBillIds: Array.from({length:1000},(_,i)=>'bill-'+i) }).vendorBillIds).toHaveLength(1000);
    for (const vendorBillIds of [['bill-one','bill-one'],Array.from({length:1001},(_,i)=>'bill-'+i),[''],['x\n'],[1],null]) failure(() => validateProjectInput({ ...input(), vendorBillIds }));
  });
  it.each([-1,0.5,Number.MAX_SAFE_INTEGER,NaN,Infinity,'0'])('rejects revision %s', expectedProjectRevision => failure(() => validateProjectInput({ ...input(), expectedProjectRevision })));
  it.each(['PRJ-000000','PRJ-1','INV-000001','PRJ-9007199254740991','PRJ-000001x'])('rejects invalid generated number %s', number => failure(() => recordProject(config, input(), null, number, actor)));
  it('bounds revision overflow', () => failure(() => recordProject(config, { ...input(), expectedProjectRevision: Number.MAX_SAFE_INTEGER-1 }, { ...recorded(), revision: Number.MAX_SAFE_INTEGER-1 }, 'PRJ-000001', actor), 'revision_conflict', 409));
  it('rejects getters, cycles, sparse arrays and unsafe JSON without executing callbacks', () => {
    const getter = vi.fn(() => 'sensitive'), value = input(); Object.defineProperty(value,'name',{get:getter,enumerable:true});
    failure(() => validateProjectInput(value)); expect(getter).not.toHaveBeenCalled();
    const cycle = input() as unknown as Record<string,unknown>; cycle.notes = cycle; failure(() => validateProjectInput(cycle));
    const sparseVendorBillIds: string[] = []; sparseVendorBillIds.length = 1;
    failure(() => validateProjectInput({ ...input(), vendorBillIds: sparseVendorBillIds }));
    failure(() => validateProjectInput(Object.assign(Object.create({grant:'owner'}),input())));
  });
  it('detaches caller-owned arrays and preserves previous immutable records', () => {
    const value = input(), project = recordProject(config, value, null, 'PRJ-000001', actor); (value.vendorBillIds as string[]).push('later');
    expect(project.vendorBillIds).toEqual(['bill-one']); expect(validateStoredProject(project,config)).toEqual(project);
  });
  it.each([{revision:0},{number:'INV-000001'},{updatedAt:'2026-10-07T12:00:00.000Z'},{createdAt:'2026-02-30T12:00:00.000Z'},{userId:'injected'},{budget:{currency:'USD',minorUnits:null}}])('rejects malformed persisted project %j', update => failure(() => validateStoredProject({ ...recorded(), ...update }, config), 'invalid_stored_state', 503));
});
