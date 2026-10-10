import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { supplierDocumentMedia, supplierDocumentText } from './us-supplier-document-bytes';
import { US_SUPPLIER_DOCUMENT_MAX_BYTES } from './us-supplier-document-contract';

describe('US original literal parsing (no OCR)', () => {
  it.each([
    ['application/pdf', '%PDF-1.7\n'], ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]], ['image/jpeg', [255, 216, 255, 1, 2, 3, 4, 5]], ['text/plain', 'A literal invoice\nUSD 10.00'],
  ] as const)('checks actual bytes for %s', (media, source) => {
    const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : Uint8Array.from(source);
    expect(supplierDocumentMedia(bytes, media)).toBe(media);
    for (const other of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].filter(v => v !== media)) expect(() => supplierDocumentMedia(bytes, other)).toThrow('invalid_supplier_document');
  });
  it.each(['text/html', 'application/octet-stream', null])('rejects unsupported media %s', media => {
    expect(() => supplierDocumentMedia(new TextEncoder().encode('original text'), media)).toThrow('invalid_supplier_document');
  });
  it('rejects empty, excessive, invalid UTF8 and control text without truncating it', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(US_SUPPLIER_DOCUMENT_MAX_BYTES + 1), Uint8Array.from([255, 254]), new TextEncoder().encode('a\u0000b'), new TextEncoder().encode('é'.repeat(8193))]) expect(() => supplierDocumentMedia(bytes, 'text/plain')).toThrow('invalid_supplier_document');
  });
  it('preserves literal UTF8 and line breaks', async () => {
    const text = 'Fournisseur déjà reçu\nMontant USD 10.00\r\nNet\t9.00';
    expect(await supplierDocumentText(new TextEncoder().encode(text), 'text/plain')).toBe(text);
  });
  it('extracts a real PDF without consuming or rewriting its source bytes', async () => {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Harbor Supplies LLC - Invoice US-1043 - USD 1,082.50', { font, size: 12 });
    const bytes = await pdf.save(), before = bytes.slice();
    expect(supplierDocumentMedia(bytes, 'application/pdf')).toBe('application/pdf');
    expect(await supplierDocumentText(bytes, 'application/pdf')).toContain('Invoice US-1043');
    expect(bytes).toEqual(before);
  });
  it('keeps empty, malformed, more-than-12-page PDFs and images unreadable', async () => {
    const empty = await PDFDocument.create(); empty.addPage();
    expect(await supplierDocumentText(await empty.save(), 'application/pdf')).toBeNull();
    const long = await PDFDocument.create(); for (let n = 0; n < 13; n++) long.addPage().drawText('Do not silently truncate pages');
    expect(await supplierDocumentText(await long.save(), 'application/pdf')).toBeNull();
    expect(await supplierDocumentText(new TextEncoder().encode('%PDF-1.7\ninvalid'), 'application/pdf')).toBeNull();
    expect(await supplierDocumentText(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png')).toBeNull();
  });
});
