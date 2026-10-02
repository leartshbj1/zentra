import { beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class { onmessage = null; }, invoke: invokeMock }));
import { desktopApi, importCatalogItemsMutation } from './bridge';

const scope = 'origin-company-scope';
const invoice = { id: '7ba86f19-c15d-4cb2-8151-30bd2f39f640', supplierId: 'supplier-1', date: '2026-09-02', dueDate: '2026-10-02', reference: 'SYNTHETIC-1', items: [{ description: 'Synthetic purchase', quantityMilli: 1000, unitPriceCents: 100, vatBp: 0, discountBp: 0, category: 'Fournitures' }] };
const source = { sourcePath: 'synthetic.eml', sourceSha256: 'a'.repeat(64), attachmentSha256: 'b'.repeat(64) };
const row = { rowNumber: 2, sku: 'SYNTHETIC', name: 'Synthetic article', description: '', unit: 'pièce', purchaseCostCents: 100, salesPriceCents: 200, vatBp: 0, kind: 'product' as const, errors: [] };

describe('origin workspace IPC arguments', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_app_state') return { onboarding_completed: 0 };
      if (command === 'get_bank_workspace') return { summary: {}, accounts: [], imports: [], movements: [], reconciliations: [], supplierReconciliations: [] };
      if (command === 'inspect_supplier_email_file') return { file_name: 'synthetic.eml', importable_attachments: [], issues: [] };
      if (command === 'import_camt_file') return { import: {}, warnings: [], imported_count: 0 };
      return {};
    });
  });

  it('keeps the origin top-level and never adds it to strict catalog or invoice schemas', async () => {
    const args = importCatalogItemsMutation([row], 'skip', scope).args;
    expect(args).toHaveProperty('expectedWorkspaceScope', scope);
    expect(args.input).not.toHaveProperty('expectedWorkspaceScope');
    await desktopApi.importCatalogItems([row], 'skip', scope);
    await desktopApi.saveSupplierInvoiceDraft(invoice, scope);
    await desktopApi.saveSupplierInvoiceDraftFromEmail(invoice, source, scope);
    await desktopApi.inspectSupplierEmailFile('synthetic.eml', scope);
    await desktopApi.addSupplierInvoiceAttachment(invoice.id, 'synthetic.pdf', scope);
    await desktopApi.importCamtFile('synthetic.xml', false, scope);
    await desktopApi.getBankWorkspace(scope);
    for (const command of ['import_catalog_items', 'save_supplier_invoice_draft', 'import_supplier_email_invoice_draft', 'inspect_supplier_email_file', 'add_supplier_invoice_attachment', 'import_camt_file', 'get_bank_workspace']) {
      const call = invokeMock.mock.calls.find(([name]) => name === command);
      expect(call?.[1], command).toHaveProperty('expectedWorkspaceScope', scope);
      expect(call?.[1]?.input ?? {}, command).not.toHaveProperty('expectedWorkspaceScope');
    }
  });

  it('preserves omitted legacy arguments instead of widening strict payloads', async () => {
    expect(importCatalogItemsMutation([row], 'skip').args).not.toHaveProperty('expectedWorkspaceScope');
    await desktopApi.getBankWorkspace();
    expect(invokeMock.mock.calls.find(([name]) => name === 'get_bank_workspace')?.[1]).toBeUndefined();
    await desktopApi.saveSupplierInvoiceDraftFromEmail(invoice, source);
    expect(invokeMock.mock.calls.find(([name]) => name === 'import_supplier_email_invoice_draft')?.[1]).not.toHaveProperty('expectedWorkspaceScope');
    await desktopApi.saveSupplierInvoiceDraft(invoice);
    expect(invokeMock.mock.calls.find(([name]) => name === 'save_supplier_invoice_draft')?.[1]).not.toHaveProperty('expectedWorkspaceScope');
  });

  it('retains the passed origin while FileReader is pending before a scanned attachment invoke', async () => {
    let finish!: () => void;
    class DeferredReader {
      result = 'data:application/pdf;base64,JVBERi0=';
      onload: (() => void) | null = null;
      readAsDataURL() { finish = () => this.onload?.(); }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    try {
      const file = { name: 'synthetic.pdf', type: 'application/pdf', size: 5 } as File;
      let currentScope = scope;
      const work = desktopApi.addScannedSupplierAttachment(invoice.id, file, currentScope);
      currentScope = 'different-company';
      expect(invokeMock.mock.calls.some(([name]) => name === 'add_scanned_supplier_attachment')).toBe(false);
      finish();
      await work;
      expect(invokeMock).toHaveBeenCalledWith('add_scanned_supplier_attachment', { invoiceId: invoice.id, originalName: 'synthetic.pdf', contentBase64: 'JVBERi0=', expectedWorkspaceScope: scope });
      expect(currentScope).not.toBe(scope);
    } finally { vi.unstubAllGlobals(); }
  });
});
