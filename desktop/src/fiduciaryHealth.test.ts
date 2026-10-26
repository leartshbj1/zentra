import { expect, it } from 'vitest';
import { computeHealthSummary } from './fiduciaryHealth';

it('counts missing receipts of the last year, unreconciled bank lines and the latest VAT and closing dates', () => {
  const summary = computeHealthSummary({
    expenses: [{ id: 'e1', date: '2026-09-01' }, { id: 'e2', date: '2026-09-02' }, { id: 'old', date: '2025-01-01' }],
    supplierInvoices: [
      { id: 's1', documentStatus: 'validated', attachments: [] },
      { id: 's2', documentStatus: 'validated', attachments: [{ id: 'a', projectId: null, entityType: 'supplier_invoice', entityId: 's2', originalName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: '', createdAt: '', updatedAt: '' }] },
      { id: 's3', documentStatus: 'draft', attachments: [] },
    ],
    attachments: [{ entityType: 'expense', entityId: 'e2' }],
    unreconciledBank: 7,
    vatExports: [{ dateTo: '2026-03-31' }, { dateTo: '2026-06-30' }],
    periods: [{ dateTo: '2025-12-31', status: 'closed' }, { dateTo: '2026-12-31', status: 'open' }],
    accountingEnabled: true,
    now: new Date('2026-10-25T10:00:00Z'),
  });
  expect(summary).toEqual({
    version: 1,
    computedAt: '2026-10-25T10:00:00.000Z',
    missingReceipts: 2,
    unreconciledBank: 7,
    vatFiledThrough: '2026-06-30',
    closedThrough: '2025-12-31',
    accountingEnabled: true,
  });
  // Seuls des nombres, des dates et un booléen partent : aucun texte métier.
  expect(Object.values(summary).every((value) => typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}/.test(value))).toBe(true);
});
