import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { recentDiagnosticEvents } from './diagnostics';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { WorkspaceStockOutcomeUnknownError, WorkspaceStockRefreshError } from './stockWorkflow';

const originScope = 'QA_PRIVATE_STOCK_ORIGIN_A';
const foreignScope = 'QA_PRIVATE_STOCK_FOREIGN_B';
const input = { requestId: 'stable-request', catalogItemId: 'same-product-id', reason: ' Private reason ', reference: ' Private reference ', date: '2026-10-03' };
const cases = [
  { command: 'record_stock_entry', type: 'entry', delta: 2000, balance: 12000, run: (scope?: string) => desktopApi.recordStockEntry({ ...input, quantityMilli: 2000 }, scope) },
  { command: 'record_stock_exit', type: 'exit', delta: -2000, balance: 8000, run: (scope?: string) => desktopApi.recordStockExit({ ...input, quantityMilli: 2000 }, scope) },
  { command: 'record_stock_correction', type: 'correction', delta: -2000, balance: 8000, run: (scope?: string) => desktopApi.recordStockCorrection({ ...input, deltaQuantityMilli: -2000 }, scope) },
  { command: 'record_stock_count', type: 'correction', delta: -2000, balance: 8000, run: (scope?: string) => desktopApi.recordStockCount({ ...input, expectedQuantityMilli: 10000, countedQuantityMilli: 8000 }, scope) },
] as const;
afterEach(() => invoke.mockReset());

describe.each(cases)('$command scope and confirmed receipt', ({ command, type, delta, balance, run }) => {
  const raw = (scope: string | undefined = originScope) => ({
    work_notes_scope: scope,
    settings: { company_name: 'QA_PRIVATE_COMPANY', extra_settings_json: '{}' },
    catalog_items: [{ id: input.catalogItemId, kind: 'product', name: 'QA_PRIVATE_PRODUCT', track_stock: 1, stock_quantity_milli: balance }],
    stock_movements: [{ id: 'same-movement-id', request_id: input.requestId, catalog_item_id: input.catalogItemId, source_type: 'manual', movement_type: type, quantity_delta_milli: delta, balance_after_milli: balance, reason: input.reason.trim(), reference: input.reference.trim(), movement_date: input.date }],
  });
  const ready = (scope: string | undefined = originScope) => invoke.mockImplementation(async name => name === command ? {} : name === 'get_app_state' ? { onboarding_completed: true } : raw(scope));
  const writeCount = () => invoke.mock.calls.filter(call => call[0] === command).length;

  it('sends scope only at the top level, preserves normalized input, and writes once', async () => {
    const from = recentDiagnosticEvents().length;
    ready();
    const result = await run(originScope);
    expect(result.workNotesScope).toBe(originScope);
    const args = invoke.mock.calls.find(call => call[0] === command)![1];
    expect(args.expectedWorkspaceScope).toBe(originScope);
    expect(args.input).not.toHaveProperty('expectedWorkspaceScope');
    expect(args.input).not.toHaveProperty('expected_workspace_scope');
    expect(args.input).toMatchObject({ request_id: input.requestId, catalog_item_id: input.catalogItemId, reason: input.reason.trim(), reference: input.reference.trim(), date: input.date });
    expect(invoke.mock.calls.map(call => call[0])).toEqual([command, 'get_app_state', 'get_workspace']);
    expect(writeCount()).toBe(1);
    const events = recentDiagnosticEvents().slice(from);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(Object.keys(event).every(key => ['id', 'sessionId', 'timestamp', 'area', 'operation', 'phase', 'durationMs', 'errorCode'].includes(key))).toBe(true);
    const logged = JSON.stringify(events);
    for (const value of [originScope, input.requestId, input.catalogItemId, input.reason.trim(), input.reference.trim(), 'QA_PRIVATE_COMPANY', 'QA_PRIVATE_PRODUCT']) expect(logged).not.toContain(value);
  });

  it('keeps undefined scope compatible and absent from the legacy payload', async () => {
    ready(foreignScope);
    const result = await run(undefined);
    expect(result.workNotesScope).toBe(foreignScope);
    const args = invoke.mock.calls.find(call => call[0] === command)![1];
    expect(Object.keys(args)).toEqual(['input']);
    expect(writeCount()).toBe(1);
  });

  it('keeps ACK confirmed but refuses a same-ID foreign receipt in first read and recovery', async () => {
    ready(foreignScope);
    const error = await run(originScope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceStockRefreshError);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(error).not.toBeInstanceOf(WorkspaceStockOutcomeUnknownError);
    expect(error.refreshCause.message).toContain('L’entreprise ouverte a changé');
    const foreign = await desktopApi.loadWorkspace();
    expect(() => error.validateRead(foreign)).toThrow('L’entreprise ouverte a changé');
    ready(originScope);
    const recovered = await desktopApi.loadWorkspace();
    expect(() => error.validateRead(recovered)).not.toThrow();
    expect(error.intent.expectedWorkspaceScope).toBe(originScope);
    expect(error.intent.requestId).toBe(input.requestId);
    expect(writeCount()).toBe(1);
  });

  it('preserves the original read rejection and rejects foreign fallback without replay', async () => {
    const cause = new Error('QA_PRIVATE_READ_FAILURE');
    invoke.mockImplementation(async name => { if (name === command) return {}; if (name === 'get_app_state') return { onboarding_completed: true }; throw cause; });
    const error = await run(originScope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceStockRefreshError);
    expect(error.refreshCause).toBe(cause);
    ready(foreignScope);
    const foreign = await desktopApi.loadWorkspace();
    expect(() => error.validateRead(foreign)).toThrow('L’entreprise ouverte a changé');
    ready(originScope);
    const current = await desktopApi.loadWorkspace();
    expect(() => error.validateRead(current)).not.toThrow();
    expect(error.intent.expectedWorkspaceScope).toBe(originScope);
    expect(writeCount()).toBe(1);
  });

  it('preserves an ambiguous write rejection and refuses a foreign restored receipt', async () => {
    const cause = new Error('QA_PRIVATE_WRITE_REPLY_LOST');
    invoke.mockImplementation(async name => { if (name === command) throw cause; return name === 'get_app_state' ? { onboarding_completed: true } : raw(foreignScope); });
    const error = await run(originScope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceStockOutcomeUnknownError);
    expect(error.mutationCause).toBe(cause);
    expect(invoke.mock.calls.map(call => call[0])).toEqual([command]);
    const foreign = await desktopApi.loadWorkspace();
    expect(() => error.wasRecorded(foreign)).toThrow('L’entreprise ouverte a changé');
    ready(originScope);
    expect(error.wasRecorded(await desktopApi.loadWorkspace())).toBe(true);
    expect(error.intent.expectedWorkspaceScope).toBe(originScope);
    expect(writeCount()).toBe(1);
  });

  it('does not accept a receipt lacking scope when the caller explicitly supplied one', async () => {
    invoke.mockImplementation(async name => name === command ? {} : name === 'get_app_state' ? { onboarding_completed: true } : { ...raw(), work_notes_scope: undefined });
    const error = await run(originScope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceStockRefreshError);
    expect(error.refreshCause.message).toContain('L’entreprise ouverte a changé');
    expect(writeCount()).toBe(1);
  });
});
