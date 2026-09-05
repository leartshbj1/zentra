import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, shareMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), shareMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
vi.mock('./mobileRuntime', () => ({ isMobileRuntime: () => true, shareMobileExport: shareMock, materializeMobileFile: vi.fn() }));
import { desktopApi } from './bridge';

describe('salary PDF delivery', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    shareMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'prepare_mobile_export') return '/exports/Salaire.pdf';
      if (command === 'generate_payslip_pdf') return { path: '/exports/Salaire.pdf', pages: 2, final_document: true };
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it('keeps a generated PDF after a share failure and retries delivery without regeneration', async () => {
    shareMock.mockRejectedValueOnce(new Error('Share sheet unavailable'));
    const result = await desktopApi.exportPayslipPdf('salary', 'Salaire.pdf');
    expect(result).toMatchObject({ path: '/exports/Salaire.pdf', pages: 2, finalDocument: true, deliveryWarning: expect.stringContaining('a été créé') });
    shareMock.mockResolvedValueOnce(undefined);
    await desktopApi.shareExistingExport(result!.path);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'generate_payslip_pdf')).toEqual([['generate_payslip_pdf', { input: { payslip_id: 'salary', destination_path: '/exports/Salaire.pdf' } }]]);
    expect(shareMock).toHaveBeenCalledTimes(2);
    expect(shareMock).toHaveBeenNthCalledWith(2, '/exports/Salaire.pdf');
  });

  it('propagates a native generation refusal without sharing a nonexistent PDF', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'prepare_mobile_export') return '/exports/Salaire.pdf';
      throw new Error('Immutable source hash mismatch');
    });
    await expect(desktopApi.exportPayslipPdf('salary', 'Salaire.pdf')).rejects.toThrow('Immutable source hash mismatch');
    expect(shareMock).not.toHaveBeenCalled();
  });
});
