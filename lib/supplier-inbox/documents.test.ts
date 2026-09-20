import { it, expect } from 'vitest';
import { invoiceText, invoiceMedia, MAX_INVOICE_BYTES } from './documents';
export function invoicePdf() {
  const lines = [
    'Fournisseur: Acme SA',
    'Facture No INV-2026-19',
    'Date: 20.09.2026',
    'Echeance: 20.10.2026',
    'Hors taxe CHF 100.00',
    'TVA 8.10 % 8.10',
    'Total CHF 108.10',
  ];
  const stream =
    'BT /F1 12 Tf 30 750 Td ' +
    lines
      .map((line, i) => (i ? '0 -20 Td ' : '') + '(' + line + ') Tj')
      .join('\n') +
    ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('');
  pdf += `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
it('extracts literal invoice text from a real PDF without OCR', async () => {
  const bytes = invoicePdf();
  expect(invoiceMedia(bytes)).toBe('application/pdf');
  const text = await invoiceText(bytes, 'application/pdf');
  expect(text).toContain('Acme SA');
  expect(text).toContain('108.10');
  expect(text).toContain('20.09.2026');
});
it('does not treat scans as machine-readable or arbitrary files as invoices', async () => {
  expect(await invoiceText(new Uint8Array(20), 'image/png')).toBe('');
  expect(
    invoiceMedia(new TextEncoder().encode('<html>oops</html>')),
  ).toBeNull();
  expect(invoiceMedia(new Uint8Array(MAX_INVOICE_BYTES + 1))).toBeNull();
});
