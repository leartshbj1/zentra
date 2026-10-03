import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { WorkspaceCreationOutcomeUnknownError, createWorkspaceEntity } from './workspaceCreation';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { assertWorkspaceOrigin, refreshWorkspaceInOrigin, workspaceOriginFailure, WorkspaceOriginChangedError } from './workspaceOrigin';
import { CatalogSaveUnknownError, catalogDraft, catalogFormData } from './catalogForm';
import { initialOnboardingSettings } from './onboardingDraft';
import { classifyUserError } from './userErrors';
import type { EntityKind, Payslip, Workspace } from './types';

const scope = 'SYNTHETIC-WORKSPACE-A';
const foreignScope = 'SYNTHETIC-WORKSPACE-B';
const workspace = (origin = scope, rows: Partial<Workspace> = {}) => ({ onboardingCompleted: true, workNotesScope: origin, ...rows }) as Workspace;
const entities: [EntityKind, string][] = [['clients', 'clients'], ['suppliers', 'suppliers'], ['catalogItems', 'catalog_items'], ['employees', 'employees'], ['timeEntries', 'time_entries'], ['expenses', 'expenses'], ['projects', 'projects'], ['quotes', 'quotes'], ['invoices', 'invoices'], ['payslips', 'payslips']];
beforeEach(() => {
  invoke.mockReset();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: true } : command === 'get_workspace' ? { work_notes_scope: scope } : { id: 'synthetic-record' });
});
afterEach(() => vi.unstubAllGlobals());

describe('origin of generic business mutations', () => {
  it.each(entities)('captures the %s origin as a top-level native argument', async (entity, backend) => {
    const input = { name: 'Synthetic private name', note: 'Synthetic private content' };
    expect((await desktopApi.createEntity(entity, input, scope)).workNotesScope).toBe(scope);
    const call = invoke.mock.calls.find(([command]) => command === 'create_record');
    expect(call?.[1]).toMatchObject({ entity: backend, expectedWorkspaceScope: scope });
    expect(call?.[1].data).not.toHaveProperty('expected_workspace_scope');
    expect(input).not.toHaveProperty('id');
  });
  it('rejects a foreign supplied-ID preflight before any mutation', async () => {
    const create = vi.fn();
    const load = vi.fn().mockResolvedValue(workspace(foreignScope, { clients: [] }));
    await expect(createWorkspaceEntity('clients', { id: 'same-id', name: 'New content' }, create, load, scope)).rejects.toBeInstanceOf(WorkspaceOriginChangedError);
    expect(create).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('never uses the same UUID in a foreign workspace as a creation receipt', async () => {
    const cause = new Error('Synthetic reply lost');
    const error = new WorkspaceCreationOutcomeUnknownError('clients', 'same-id', cause, scope);
    expect(error.wasRecorded(workspace(scope, { clients: [{ id: 'same-id' }] as Workspace['clients'] }))).toBe(true);
    expect(() => error.wasRecorded(workspace(foreignScope, { clients: [{ id: 'same-id' }] as Workspace['clients'] }))).toThrow(WorkspaceOriginChangedError);
    expect(error.mutationCause).toBe(cause);
  });
  it('retains the ACK distinction when the post-write read belongs to B', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'confirmed-id' });
    const load = vi.fn().mockResolvedValue(workspace(foreignScope, { clients: [] }));
    const error = await createWorkspaceEntity('clients', { name: 'Synthetic record' }, create, load, scope).catch(error => error);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(workspaceOriginFailure(error)).toBeInstanceOf(WorkspaceOriginChangedError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it.each(['clients', 'suppliers', 'catalogItems', 'timeEntries', 'projects'] as const)('protects the %s archive/delete native command', async entity => {
    await desktopApi.archiveEntity(entity, 'shared-id', scope);
    const call = invoke.mock.calls.find(([command]) => command === 'update_record' || command === 'delete_record');
    expect(call?.[1]).toMatchObject({ id: 'shared-id', expectedWorkspaceScope: scope });
    expect(call?.[1].data ?? {}).not.toHaveProperty('expected_workspace_scope');
  });
  it('rejects a foreign update refresh after forwarding the immutable origin', async () => {
    invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: true } : command === 'get_workspace' ? { work_notes_scope: foreignScope } : {});
    const error = await desktopApi.updateEntity('employees', 'same-id', { name: 'Synthetic employee' }, scope).catch(error => error);
    expect(workspaceOriginFailure(error)).toBeInstanceOf(WorkspaceOriginChangedError);
    expect(invoke.mock.calls.filter(([command]) => command === 'update_record')).toHaveLength(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ expectedWorkspaceScope: scope });
  });
  it.each([undefined, 'existing-project'])('forwards the project origin for id=%s', async id => {
    await desktopApi.saveProject({ name: 'Synthetic project' }, id, scope);
    expect(invoke.mock.calls).toHaveLength(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ expectedWorkspaceScope: scope });
  });
  it.each([undefined, 'same-revision'])('protects both catalogue paths revision=%s', async revision => {
    const data = catalogFormData({ ...catalogDraft(undefined, initialOnboardingSettings), name: 'Synthetic service', salesPrice: '50' }, false);
    invoke.mockImplementation(async command => { if (command === 'create_record' || command === 'update_catalog_item') throw Error('Synthetic refusal'); return {}; });
    const error = await desktopApi.saveCatalogItem('same-id', data, revision, scope).catch(error => error);
    expect(error).toBeInstanceOf(CatalogSaveUnknownError);
    expect(invoke.mock.calls[0][1]).toMatchObject({ expectedWorkspaceScope: scope });
    const row = { ...data, id: 'same-id' } as Workspace['catalogItems'][number];
    const correct = workspace(scope, { settings: initialOnboardingSettings, catalogItems: [row], stockMovements: [] });
    expect(error.wasRecorded(correct)).toBe(true);
    expect(error.wasRecorded({ ...correct, catalogItems: [{ ...row, name: 'Earlier payload' }] })).toBe(false);
    expect(() => error.wasRecorded({ ...correct, workNotesScope: foreignScope })).toThrow(WorkspaceOriginChangedError);
  });
  it('forwards one captured origin through every legacy payslip line command', async () => {
    const line = (id: string) => ({ id, label: 'Synthetic line', kind: 'earning' as const, amountCents: 100, postingAccountId: '', expenseAccountId: '' });
    const existing = { id: 'header', lines: [line('removed'), line('retained')] } as Payslip;
    await desktopApi.savePayslip({ employeeId: 'employee', period: '2026-01' }, [line('retained'), line('added')], existing, scope);
    const writes = invoke.mock.calls.filter(([command]) => ['create_record', 'update_record', 'delete_record'].includes(command));
    expect(writes.map(([command]) => command)).toEqual(['update_record', 'delete_record', 'update_record', 'create_record']);
    expect(writes.every(([, args]) => args.expectedWorkspaceScope === scope)).toBe(true);
    // This verifies workspace isolation only; the legacy multi-command save is not atomic.
  });
  it('keeps origin failures actionable without private identifiers in the message', async () => {
    expect(() => assertWorkspaceOrigin(workspace(foreignScope), scope)).toThrow(WorkspaceOriginChangedError);
    const error = await refreshWorkspaceInOrigin(async () => workspace(foreignScope), scope).catch(error => error);
    const failure = workspaceOriginFailure(error)!;
    expect(classifyUserError(failure)).toBe('workspace');
    expect(failure.message).not.toContain(scope);
    expect(failure.message).not.toContain(foreignScope);
  });
  it('preserves the omitted origin contract for older API callers', async () => {
    await desktopApi.createEntity('clients', { name: 'Legacy caller' });
    const call = invoke.mock.calls.find(([command]) => command === 'create_record');
    expect(call?.[1]).not.toHaveProperty('expectedWorkspaceScope');
  });
});
