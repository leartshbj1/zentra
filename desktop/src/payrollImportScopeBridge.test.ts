import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi, updatePayrollImportDraftMutation } from './bridge';
import type { PayrollImportDraft } from './types';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { recentDiagnosticEvents } from './diagnostics';

const scope = 'synthetic-payroll-company-a';
const draft: PayrollImportDraft = {
  employee: { employeeNumber: '', name: 'Collaborateur fictif', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' },
  period: '2026-09', paymentDate: '', grossCents: 500_000, netCents: 500_000,
  lines: [{ id: 'synthetic-line', sourceRef: '', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, recurring: false, confidenceBp: 10_000 }], warnings: [],
};
const rawDraft = updatePayrollImportDraftMutation('synthetic-import', draft, 'manual_review', '', 10_000).args.input.draft;
const commands = [
  ['stage_payroll_documents', () => desktopApi.stagePayrollDocuments(['synthetic.pdf'], scope)],
  ['list_payroll_document_imports', () => desktopApi.listPayrollDocumentImports(scope)],
  ['get_payroll_document_preview', () => desktopApi.getPayrollDocumentPreview('synthetic-import', scope)],
  ['update_payroll_import_draft', () => desktopApi.updatePayrollImportDraft('synthetic-import', draft, 'manual_review', '', 10_000, undefined, scope)],
  ['confirm_payroll_document_import', () => desktopApi.confirmPayrollDocumentImport('synthetic-import', draft, undefined, false, true, scope)],
  ['reject_payroll_document_import', () => desktopApi.rejectPayrollDocumentImport('synthetic-import', scope)],
] as const;
const completed = [
  ['confirm_payroll_document_import', () => desktopApi.confirmPayrollDocumentImport('synthetic-import', draft, undefined, false, true, scope)],
  ['reject_payroll_document_import', () => desktopApi.rejectPayrollDocumentImport('synthetic-import', scope)],
] as const;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') return { settings: { company_name: 'Entreprise fictive', extra_settings_json: '{}' }, work_notes_scope: scope };
    if (command === 'get_payroll_document_preview') return { mime_type: 'application/pdf', data_base64: 'JVBERi0=' };
    if (command === 'update_payroll_import_draft') return { id: 'synthetic-import', draft_json: JSON.stringify(rawDraft) };
    return { imports: [] };
  });
});

describe('payroll import origin and confirmed-read contracts through the real bridge', () => {
  it.each(commands)('%s sends the original scope outside the business input', async (command, run) => {
    await run();
    const call = invoke.mock.calls.find(([name]) => name === command);
    expect(call?.[1]).toHaveProperty('expectedWorkspaceScope', scope);
    expect(call?.[1]?.input ?? {}).not.toHaveProperty('expectedWorkspaceScope');
    expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
  });

  it.each(completed)('%s keeps an acknowledged mutation distinct from a failed read', async (command, run) => {
    const cause = new Error('Lecture locale refusée');
    invoke.mockImplementation(async name => { if (name === command) return {}; throw cause; });
    await expect(run()).rejects.toMatchObject({ name: 'WorkspaceRefreshAfterMutationError', refreshCause: cause });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([command, 'get_app_state']);
  });

  it.each(completed)('%s refuses a foreign workspace after acknowledgement without replay', async (command, run) => {
    invoke.mockImplementation(async name => name === command ? {} : name === 'get_app_state' ? { onboarding_completed: true } : { settings: { company_name: 'Entreprise fictive B', extra_settings_json: '{}' }, work_notes_scope: 'synthetic-payroll-company-b' });
    await expect(run()).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === 'get_workspace')).toHaveLength(1);
  });

  it.each(completed)('%s preserves a native refusal and does not read or replay', async (_command, run) => {
    const reason = new Error('Le contrôle humain doit être confirmé.');
    invoke.mockRejectedValue(reason);
    await expect(run()).rejects.toBe(reason);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves the explicit manifest-clear flag and every existing draft field', () => {
    const original = updatePayrollImportDraftMutation('synthetic-import', draft, 'manual_review', '', 10_000, null);
    const scoped = updatePayrollImportDraftMutation('synthetic-import', draft, 'manual_review', '', 10_000, null, scope);
    expect(scoped.args).toHaveProperty('expectedWorkspaceScope', scope);
    expect(scoped.args.input).toEqual(original.args.input);
    expect(scoped.args.input.clear_analysis_manifest).toBe(true);
    expect(scoped.args.input.draft).toEqual(rawDraft);
  });

  it('retains omission for the legacy caller and does not add unknown input fields', async () => {
    await desktopApi.stagePayrollDocuments(['synthetic.pdf']);
    await desktopApi.listPayrollDocumentImports();
    await desktopApi.getPayrollDocumentPreview('synthetic-import');
    await desktopApi.updatePayrollImportDraft('synthetic-import', draft, 'manual_review', '', 10_000);
    await desktopApi.confirmPayrollDocumentImport('synthetic-import', draft, undefined, false, true);
    await desktopApi.rejectPayrollDocumentImport('synthetic-import');
    for (const [command] of commands) {
      const call = invoke.mock.calls.find(([name]) => name === command);
      expect(call?.[1] ?? {}).not.toHaveProperty('expectedWorkspaceScope');
      expect(call?.[1]?.input ?? {}).not.toHaveProperty('expectedWorkspaceScope');
    }
    expect(invoke.mock.calls.find(([name]) => name === 'list_payroll_document_imports')?.[1]).toBeUndefined();
  });

  it('does not re-evaluate a mutable caller scope while the confirmation is pending', async () => {
    let finish!: () => void;
    const native = new Promise<void>(resolve => { finish = resolve; });
    const ordinary = invoke.getMockImplementation()!;
    invoke.mockImplementation((name, ...args) => name === 'confirm_payroll_document_import' ? native : ordinary(name, ...args));
    let current = scope;
    const pending = desktopApi.confirmPayrollDocumentImport('synthetic-import', draft, undefined, false, true, current);
    current = 'synthetic-payroll-company-b';
    expect(invoke.mock.calls.find(([name]) => name === 'confirm_payroll_document_import')?.[1]).toHaveProperty('expectedWorkspaceScope', scope);
    finish();
    await pending;
    expect(current).not.toBe(scope);
    expect(invoke.mock.calls.filter(([name]) => name === 'confirm_payroll_document_import')).toHaveLength(1);
  });

  it('traces every import command without retaining the file, employee, draft or workspace', async () => {
    const offset = recentDiagnosticEvents().length;
    for (const [, run] of commands) await run();
    const events = recentDiagnosticEvents().slice(offset);
    for (const [command] of commands) {
      const pair = events.filter(event => event.operation === command);
      expect(pair.map(event => event.phase)).toEqual(['start', 'success']);
      expect(pair[0].id).toBe(pair[1].id);
      expect(pair[1].durationMs).toBeGreaterThanOrEqual(0);
    }
    for (const event of events) expect(Object.keys(event).every(key => ['id', 'sessionId', 'timestamp', 'area', 'operation', 'phase', 'durationMs', 'errorCode'].includes(key))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/synthetic\.pdf|synthetic-import|synthetic-payroll-company|Collaborateur fictif|data_base64|draft_json/);
  });

  it('keeps a scope refusal traceable while preserving the original error and avoiding replay', async () => {
    const offset = recentDiagnosticEvents().length;
    const refusal = new Error('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');
    invoke.mockRejectedValue(refusal);
    await expect(desktopApi.confirmPayrollDocumentImport('synthetic-import', draft, undefined, false, true, scope)).rejects.toBe(refusal);
    const pair = recentDiagnosticEvents().slice(offset);
    expect(pair.map(event => event.phase)).toEqual(['start', 'failure']);
    expect(pair[0].id).toBe(pair[1].id);
    expect(pair[1].errorCode).toBe('CONFLICT');
    expect(JSON.stringify(pair)).not.toMatch(/synthetic|entreprise|fictif/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
