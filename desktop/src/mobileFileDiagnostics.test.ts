import { beforeEach, describe, expect, it, vi } from 'vitest';

const { copyFile, mkdir, appCacheDir, join, invoke } = vi.hoisted(() => ({ copyFile: vi.fn(), mkdir: vi.fn(), appCacheDir: vi.fn(), join: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ copyFile, mkdir, BaseDirectory: { AppCache: 16 } }));
vi.mock('@tauri-apps/api/path', () => ({ appCacheDir, join }));

import { isMobileRuntime, materializeMobileFile } from './mobileRuntime';
import { recentDiagnosticEvents, resolveErrorIncident } from './diagnostics';

// Also run with TAURI_ENV_PLATFORM=ios and =android: the default desktop build
// must remain a passthrough, while mobile copies and failures are exercised.
describe('mobile import cache diagnostic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyFile.mockResolvedValue(undefined); mkdir.mockResolvedValue(undefined);
    appCacheDir.mockResolvedValue('/private/cache');
    join.mockResolvedValue('/private/cache/imports/confidential.pdf');
    invoke.mockResolvedValue('confidential.pdf');
  });

  it('preserves the file operation and keeps its source/destination out of the trace', async () => {
    const before = recentDiagnosticEvents().length, source = '/private/customer-secret.pdf';
    const destination = await materializeMobileFile(source);
    if (!isMobileRuntime()) {
      expect(destination).toBe(source); expect(copyFile).not.toHaveBeenCalled();
      expect(recentDiagnosticEvents().slice(before)).toEqual([]); return;
    }
    expect(destination).toBe('/private/cache/imports/confidential.pdf');
    expect(mkdir).toHaveBeenCalledExactlyOnceWith('imports', { baseDir: 16, recursive: true });
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(source, destination);
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['file.materialize_mobile', 'start'], ['file.materialize_mobile', 'success']]);
    expect(JSON.stringify(events)).not.toMatch(/private|customer|secret|confidential/);
  });

  it('preserves a copy failure and matches the incident without reporting a successful copy', async () => {
    const before = recentDiagnosticEvents().length, error = new Error('disk full at /private/confidential.pdf');
    copyFile.mockRejectedValue(error);
    if (!isMobileRuntime()) { expect(await materializeMobileFile('/private/source.pdf')).toBe('/private/source.pdf'); expect(copyFile).not.toHaveBeenCalled(); return; }
    await expect(materializeMobileFile('/private/source.pdf')).rejects.toBe(error);
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => event.phase)).toEqual(['start', 'failure']);
    expect(events[1].errorCode).toBe('STORAGE');
    expect(resolveErrorIncident(error).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/private|confidential/);
  });

  it('does not proceed with a copy after a cache directory failure', async () => {
    const before = recentDiagnosticEvents().length, error = new Error('mkdir refused');
    mkdir.mockRejectedValue(error);
    if (!isMobileRuntime()) { expect(await materializeMobileFile('/private/source.pdf')).toBe('/private/source.pdf'); return; }
    await expect(materializeMobileFile('/private/source.pdf')).rejects.toBe(error);
    expect(copyFile).not.toHaveBeenCalled();
    expect(recentDiagnosticEvents().slice(before).at(-1)?.phase).toBe('failure');
  });

  it('keeps content URI resolution and copied document data out of diagnostics', async () => {
    const before = recentDiagnosticEvents().length, source = 'content://private-provider/customer-secret';
    const path = await materializeMobileFile(source);
    if (!isMobileRuntime()) { expect(path).toBe(source); expect(invoke).not.toHaveBeenCalled(); return; }
    expect(invoke).toHaveBeenCalledExactlyOnceWith('mobile_file_name', { url: source });
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(source, path);
    expect(recentDiagnosticEvents().slice(before).map(event => [event.operation, event.phase])).toEqual([
      ['file.materialize_mobile', 'start'], ['mobile_file_name', 'start'], ['mobile_file_name', 'success'], ['file.materialize_mobile', 'success'],
    ]);
    expect(JSON.stringify(recentDiagnosticEvents().slice(before))).not.toMatch(/private-provider|customer-secret|confidential/);
  });
});
