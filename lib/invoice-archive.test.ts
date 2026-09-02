import { describe, expect, it } from 'vitest';
import {
  buildArchiveIdentity,
  decodePdfBase64,
  normalizeArchiveInput,
  safeInvoiceFilename,
} from './invoice-archive';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const PDF_BASE64 = btoa(String.fromCharCode(...PDF));

describe('invoice archive contract', () => {
  it('accepts a complete initial PDF and calculates a stable identity', async () => {
    const archive = normalizeArchiveInput({
      sourceInvoiceId: 'invoice-42',
      revision: 1,
      invoiceNumber: 'F-2026/0042',
      issueDate: '2026-09-02',
      paidAt: '2026-09-10',
      correctionKind: 'initial',
      pdfBase64: PDF_BASE64,
    });
    const first = await buildArchiveIdentity({
      organizationId: 'org_1',
      archive,
      previousChainSha256: null,
    });
    const again = await buildArchiveIdentity({
      organizationId: 'org_1',
      archive,
      previousChainSha256: null,
    });
    expect(first).toEqual(again);
    expect(first.retentionUntil).toBe('2036-12-31');
    expect(first.objectKey).toMatch(
      /^organizations\/org_1\/invoices\/[0-9a-f]{64}\/revision-0001-[0-9a-f]{64}\.pdf$/,
    );
  });

  it('requires a reason and explicit correction marker after version one', () => {
    expect(() =>
      normalizeArchiveInput({
        sourceInvoiceId: 'invoice-42',
        revision: 2,
        invoiceNumber: 'F-2026/0042',
        issueDate: '2026-09-02',
        correctionKind: 'initial',
        pdfBase64: PDF_BASE64,
      }),
    ).toThrow('correction');
    expect(() =>
      normalizeArchiveInput({
        sourceInvoiceId: 'invoice-42',
        revision: 2,
        invoiceNumber: 'F-2026/0042',
        issueDate: '2026-09-02',
        correctionKind: 'correction',
        correctionReason: 'x',
        pdfBase64: PDF_BASE64,
      }),
    ).toThrow('5 à 1 000');
  });

  it('rejects truncated or disguised files and creates safe filenames', () => {
    expect(() => decodePdfBase64(btoa('not a pdf'))).toThrow('PDF complet');
    expect(() => decodePdfBase64(btoa('%PDF-1.7 without eof'))).toThrow(
      'PDF complet',
    );
    expect(safeInvoiceFilename('../Facture été/42', 2)).toBe(
      'Facture-ete-42-v2.pdf',
    );
  });
});
