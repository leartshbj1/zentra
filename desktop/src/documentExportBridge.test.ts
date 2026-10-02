import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invokeMock, shareMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), shareMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
vi.mock('./mobileRuntime', () => ({ isMobileRuntime: () => true, shareMobileExport: shareMock, materializeMobileFile: vi.fn() }));
import { desktopApi } from './bridge';
import type { CertificateInput } from './salaryCertificate';

const certificate: CertificateInput = { employeeId: 'employee-1', year: 2026, sourceHash: 'source', identity: { name: 'Employé fictif', address: 'Rue fictive', avsNumber: '', birthDate: '', periodStart: '2026-01-01', periodEnd: '2026-12-31', employerContact: 'Entreprise fictive', placeDate: 'Lausanne' }, sourceIds: [], realizationNote: '', allocations: {}, extras: [], freeTransport: false, meals: false, effectiveExpensesAttested: false, benefits: '', remarks: '', reviewed: true };

const exports = [
  ['generate_sales_document_pdf', () => desktopApi.exportSalesDocumentPdf('quotes', 'quote-1', 'devis.pdf')],
  ['generate_sales_document_pdf', () => desktopApi.exportSalesDocumentPdf('invoices', 'invoice-1', 'facture.pdf')],
  ['export_annual_accounts_pdf', () => desktopApi.exportAnnualAccountsPdf({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })],
  ['export_document_design_example', () => desktopApi.exportDocumentDesignExample({ kind: 'invoices', style: { accentColor: '#134d33', layout: 'signature', logoWidth: 120, footer: '' }, issuer: {} })],
  ['export_salary_certificate', () => desktopApi.exportSalaryCertificate(certificate)],
] as const;
describe('created document PDFs survive mobile sharing errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (command: string) => ['prepare_mobile_export', 'export_document_design_example', 'export_salary_certificate'].includes(command) ? '/cache/document.pdf' : { path: '/cache/document.pdf', pages: 3, closed: false, balanced: true, final_document: true, document_type: 'invoice', has_qr: true });
    shareMock.mockRejectedValue(new Error('Share sheet unavailable'));
  });
  for (const [command, generate] of exports) {
    it(`retains the saved file and metadata for ${command}`, async () => {
      const result = await generate();
      expect(result?.path).toBe('/cache/document.pdf');
      expect(result?.deliveryWarning).toContain('Le PDF a été créé');
      expect(invokeMock.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
      expect(shareMock).toHaveBeenCalledExactlyOnceWith('/cache/document.pdf');
      shareMock.mockResolvedValue(undefined);
      await desktopApi.shareExistingExport(result!.path);
      expect(invokeMock.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
    });
    it(`keeps generation errors distinct for ${command}`, async () => {
      invokeMock.mockImplementation(async (name: string) => { if (name === command) throw new Error('Document incomplet'); return '/cache/document.pdf'; });
      await expect(generate()).rejects.toThrow('Document incomplet');
      expect(shareMock).not.toHaveBeenCalled();
    });
  }
  it('retains the certificate when sharing is cancelled and does not restart generation', async () => {
    shareMock.mockResolvedValue(undefined);
    const result = await desktopApi.exportSalaryCertificate(certificate);
    expect(result).toEqual({ path: '/cache/document.pdf' });
    expect(invokeMock.mock.calls.filter(([command]) => command === 'export_salary_certificate')).toHaveLength(1);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });
});
