import { beforeEach, describe, expect, it, vi } from 'vitest';

const { open, save, invoke } = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save }));
vi.mock('./mobileRuntime', () => ({ isMobileRuntime: () => false, materializeMobileFile: async (path: string) => path, shareMobileExport: vi.fn() }));

import { desktopApi } from './bridge';
import { recentDiagnosticEvents, resolveErrorIncident } from './diagnostics';

describe('real file picker bridge diagnostics', () => {
  beforeEach(() => { vi.clearAllMocks(); open.mockResolvedValue(null); save.mockResolvedValue(null); });

  it('retains a chosen file and records a fixed operation without its name', async () => {
    const before = recentDiagnosticEvents().length;
    open.mockResolvedValue('/Users/private/Confidential-client.xml');
    expect(await desktopApi.chooseCamtFile()).toBe('/Users/private/Confidential-client.xml');
    expect(open.mock.calls[0][0]).toMatchObject({ multiple: false, directory: false });
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['dialog.open_file', 'start'], ['dialog.open_file', 'success']]);
    expect(events[0].id).toBe(events[1].id);
    expect(JSON.stringify(events)).not.toMatch(/Confidential|private|xml/);
  });

  it('records a directory picker cancellation without changing its null result', async () => {
    const before = recentDiagnosticEvents().length;
    expect(await desktopApi.chooseBackupFolder()).toBeNull();
    expect(open.mock.calls[0][0]).toMatchObject({ directory: true });
    expect(recentDiagnosticEvents().slice(before).map(event => [event.operation, event.phase])).toEqual([['dialog.open_directory', 'start'], ['dialog.open_directory', 'success']]);
  });

  it('returns the selected batch in order and logs no document paths', async () => {
    const before = recentDiagnosticEvents().length;
    const files = ['/private/payroll-a.pdf', '/private/payroll-b.pdf'];
    open.mockResolvedValue(files);
    expect(await desktopApi.choosePayrollDocuments()).toEqual(files);
    expect(recentDiagnosticEvents().slice(before).map(event => [event.operation, event.phase])).toEqual([['dialog.open_files', 'start'], ['dialog.open_files', 'success']]);
    expect(JSON.stringify(recentDiagnosticEvents().slice(before))).not.toMatch(/private|payroll/);
  });

  it('preserves a save picker failure, correlates its incident and never starts PDF generation', async () => {
    const before = recentDiagnosticEvents().length;
    const error = new Error('disk full: /private/company.pdf password=secret');
    save.mockRejectedValue(error);
    await expect(desktopApi.exportDocumentDesignExample({ kind: 'invoices', style: { accentColor: '#134d33', layout: 'signature', logoWidth: 120, footer: '' }, issuer: {} })).rejects.toBe(error);
    expect(invoke).not.toHaveBeenCalled();
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['dialog.save_file', 'start'], ['dialog.save_file', 'failure']]);
    expect(resolveErrorIncident(error).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/private|company.pdf|password|secret/);
  });
});
