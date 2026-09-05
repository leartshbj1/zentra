import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, shareMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), shareMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
vi.mock('./mobileRuntime', () => ({ isMobileRuntime: () => true, shareMobileExport: shareMock, materializeMobileFile: vi.fn() }));
import { desktopApi } from './bridge';

const exported = { export_id: 'export-1', review_id: 'review-1', created_at: '2026-09-05', period: { id: 'year-2025', name: 'Exercice 2025', date_from: '2025-01-01', date_to: '2025-12-31', status: 'closed' }, package_status: 'FINAL', source_sha256: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64), file_name: 'Dossier-2025.zip', path: '/exports/Dossier-2025.zip', file_count: 47, disclaimer: '' };

describe('closing archive delivery', () => {
  beforeEach(() => { invokeMock.mockReset(); shareMock.mockReset(); });
  it('preserves the created archive when mobile sharing fails and retries only sharing', async () => {
    invokeMock.mockResolvedValue(exported);
    shareMock.mockRejectedValueOnce(new Error('Share sheet unavailable'));
    const result = await desktopApi.exportFiduciaryClosingZip('review-1');
    expect(result).toMatchObject({ exportId: 'export-1', packageStatus: 'FINAL', fileCount: 47, path: exported.path, deliveryWarning: expect.stringContaining('a été créé') });
    shareMock.mockResolvedValueOnce(undefined);
    await desktopApi.shareExistingExport(result.path);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('export_fiduciary_closing_zip', { reviewId: 'review-1' });
    expect(shareMock).toHaveBeenNthCalledWith(1, exported.path);
    expect(shareMock).toHaveBeenNthCalledWith(2, exported.path);
  });
  it('propagates a refused archive export without offering an invented path or sharing', async () => {
    invokeMock.mockRejectedValue(new Error('Revue déjà consommée'));
    await expect(desktopApi.exportFiduciaryClosingZip('review-1')).rejects.toThrow('Revue déjà consommée');
    expect(shareMock).not.toHaveBeenCalled();
  });
  it('returns a successfully shared archive without a warning', async () => {
    invokeMock.mockResolvedValue(exported);
    shareMock.mockResolvedValue(undefined);
    const result = await desktopApi.exportFiduciaryClosingZip('review-1');
    expect(result.deliveryWarning).toBeUndefined();
    expect(result.manifestSha256).toBe(exported.manifest_sha256);
  });
});
