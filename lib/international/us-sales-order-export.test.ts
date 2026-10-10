import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getUsExportFonts } from './export-fonts';
import { ExportError } from './export-snapshot';
import type { UsSalesOrderRecord } from './us-sales-order-contract';
import type { CompanyLanguage } from './types';
import { buildUsSalesOrderExportSnapshot, renderUsSalesOrderCsv, renderUsSalesOrderHtml, renderUsSalesOrderPdf, usSalesOrderExportCopy, validateUsSalesOrderExportSnapshot } from './us-sales-order-export';

const org = 'd0800000-0000-4000-8000-000000000001', orderId = 'd0800000-0000-4000-8000-000000000002';
const address = { country: 'US' as const, line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
function fixture(language: CompanyLanguage = 'en', description = 'Recorded consulting service', notes = 'Payment terms agreed separately.'): UsSalesOrderRecord {
  return {
    order: {
      schemaVersion: 1, organizationId: org, id: orderId, sequence: 1, number: 'SO-000001', revision: 2, state: 'confirmed', sourceErpRevision: 8,
      sourceEstimate: { id: 'estimate-1', organizationId: org, revision: 3, currency: 'USD', number: 'Q-000001', customer: { id: 'customer-1', organizationId: org, kind: 'business', name: 'Recorded Customer Énergie', billingAddress: address, contactName: 'Alex Example', email: 'customer@example.test', paymentTermsDays: 30 }, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: [{ id: 'line-1', description, quantityUnits: '250', quantityScale: 2, unitPrice: { currency: 'USD', minorUnits: '12345' }, discountBasisPoints: 1000, taxTreatment: 'taxable' }], notes, status: 'accepted' },
      companyConfiguration: { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language, timeZone: 'America/New_York', address, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV-', taxConfiguration: { status: 'unconfigured' } },
      sellerSnapshot: { organizationId: org, displayName: 'Recorded Seller Énergie', contactEmail: 'seller@example.test' },
      orderDate: '2026-10-10', customerReference: 'PO-2026-42', createdBy: 'fictitious-staff-creator', createdAt: '2026-10-10T12:00:00Z',
      confirmation: { reference: 'Internal review 42', confirmedBy: 'fictitious-staff-confirmation', confirmedAt: '2026-10-10T12:05:00Z' }, cancellation: null,
    },
    invoice: null,
  };
}

describe('independent US commercial order exports', () => {
  it('projects the frozen source and explicit revisions without fabricating an ERP v5 or financial status', () => {
    const record = fixture(), before = JSON.stringify(record), snapshot = buildUsSalesOrderExportSnapshot(record);
    expect(snapshot).toMatchObject({ documentType: 'sales_order', schemaVersion: 1, orderRevision: 2, sourceEstimateRevision: 3, sourceErpRevision: 8, currency: 'USD', paper: 'Letter', taxStatus: 'pending', subtotalMinor: '30863', discountMinor: '3086', netMinor: '27777' });
    expect(snapshot.confirmation).toEqual({ userId: 'fictitious-staff-confirmation', at: '2026-10-10T12:05:00Z', reference: 'Internal review 42' });
    expect(snapshot.customerReference).toBe('PO-2026-42'); expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/ein|accountingBasis|ledger|taxAssessment|taxTreatment|taxConfiguration|logoRef|idempotencyKey/);
    expect(JSON.stringify(record)).toBe(before); expect(validateUsSalesOrderExportSnapshot(snapshot)).toEqual(snapshot);
  });
  it.each(['fr', 'de', 'it', 'en'] as const)('defaults to the archived %s language and supports an explicit translated projection', language => {
    const snapshot = buildUsSalesOrderExportSnapshot(fixture(language)); expect(snapshot.language).toBe(language);
    expect(buildUsSalesOrderExportSnapshot(fixture(), language).language).toBe(language);
    const html = renderUsSalesOrderHtml(snapshot), csv = renderUsSalesOrderCsv(snapshot), c = usSalesOrderExportCopy[language];
    expect(html).toContain(`lang="${language}"`); expect(html).toContain(c.title); expect(html).toContain(c.taxPending); expect(html).toContain(c.netTotal);
    expect(csv).toContain(c.orderRevision); expect(csv).toContain(c.sourceEstimateRevision); expect(csv).toContain('"277.77"'); expect(csv).toContain('"2.5"');
    expect(html).not.toContain('>Tax<'); expect(html).toContain('Recorded Seller Énergie'); expect(html).toContain('Recorded Customer Énergie');
  });
  it('keeps draft and cancelled histories explicit and never turns cancellation into a refund', () => {
    const initial = fixture();
    const draft = buildUsSalesOrderExportSnapshot({ ...initial, order: { ...initial.order, revision: 1, state: 'draft', confirmation: null } });
    expect(draft.confirmation).toBeNull(); expect(renderUsSalesOrderHtml(draft)).toContain('Draft');
    const cancelled = buildUsSalesOrderExportSnapshot({ ...initial, order: { ...initial.order, revision: 3, state: 'cancelled', cancellation: { reason: 'Customer requested a revised scope', cancelledBy: 'fictitious-staff-cancellation', cancelledAt: '2026-10-10T12:10:00Z' } } });
    expect(renderUsSalesOrderHtml(cancelled)).toContain('Cancelled'); expect(renderUsSalesOrderCsv(cancelled)).toContain('Customer requested a revised scope');
    expect(JSON.stringify(cancelled)).not.toMatch(/refund|payments|journal|creditMemo/);
  });
  it('identifies an actual linked invoice without presenting the order as an invoice', () => {
    const snapshot = buildUsSalesOrderExportSnapshot({ ...fixture(), invoice: { id: 'invoice-1', number: 'INV-000001', sourceEstimateRevision: 3, issuedAt: '2026-10-10T13:00:00Z' } });
    expect(renderUsSalesOrderHtml(snapshot)).toContain('Related invoice'); expect(renderUsSalesOrderHtml(snapshot)).toContain('INV-000001');
    expect(snapshot.documentType).toBe('sales_order'); expect(snapshot.taxStatus).toBe('pending');
    expect(() => buildUsSalesOrderExportSnapshot({ ...fixture(), invoice: { ...snapshot.invoice, sourceEstimateRevision: 2 } })).toThrow(ExportError);
  });
  it('preserves literal user text while escaping HTML and neutralizing CSV formulas', () => {
    const input = fixture('fr', '<script>Text & service</script>', '=DANGEROUS("notes")');
    const snapshot = buildUsSalesOrderExportSnapshot({ ...input, order: { ...input.order, customerReference: '=FORMULA("reference")', sellerSnapshot: { ...input.order.sellerSnapshot, displayName: '+FORMULA seller' } } });
    const html = renderUsSalesOrderHtml(snapshot), csv = renderUsSalesOrderCsv(snapshot);
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;Text &amp; service&lt;/script&gt;');
    expect(csv).toContain("'=DANGEROUS"); expect(csv).toContain("'=FORMULA"); expect(csv).toContain("'+FORMULA seller");
    expect(snapshot.notes).toBe('=DANGEROUS("notes")');
  });
  it('rejects secret/unknown fields, wrong company, unsupported language and inconsistent source facts', () => {
    const input = fixture();
    for (const changed of [
      { ...input, hidden: 'PRIVATE_SECRET' },
      { ...input, order: { ...input.order, organizationId: 'd0800000-0000-4000-8000-000000000099' } },
      { ...input, order: { ...input.order, companyConfiguration: { ...input.order.companyConfiguration, ein: '12-3456789' } } },
      { ...input, order: { ...input.order, sourceErpRevision: 2 } },
    ]) expect(() => buildUsSalesOrderExportSnapshot(changed)).toThrow('invalid_export_snapshot');
    expect(() => buildUsSalesOrderExportSnapshot(input, 'es' as CompanyLanguage)).toThrow('invalid_export_snapshot');
  });
  it('refuses getters/prototypes/symbols and detaches the original record before rendering', () => {
    const source = fixture(), snapshot = buildUsSalesOrderExportSnapshot(source);
    let getter = 0; const injected = { ...snapshot }; Object.defineProperty(injected, 'notes', { enumerable: true, get() { getter++; return 'PRIVATE_SECRET'; } });
    expect(() => renderUsSalesOrderHtml(injected)).toThrow(ExportError); expect(getter).toBe(0);
    for (const malformed of [Object.assign(Object.create({ secret: true }), snapshot), { ...snapshot, [Symbol('secret')]: true }, { ...snapshot, ein: 'PRIVATE_SECRET' }]) expect(() => validateUsSalesOrderExportSnapshot(malformed)).toThrow(ExportError);
    (source.order.sourceEstimate as { notes: string }).notes = 'Changed later'; expect(snapshot.notes).not.toBe('Changed later');
  });
  it('recomputes every exact line and total rather than trusting coherent-looking submitted totals', () => {
    const snapshot = buildUsSalesOrderExportSnapshot(fixture());
    for (const altered of [
      { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, netMinor: '27778' })), netMinor: '27778' },
      { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, grossMinor: '30864', discountMinor: '3087' })), subtotalMinor: '30864', discountMinor: '3087' },
      { ...snapshot, rows: snapshot.rows.map(row => ({ ...row, quantityUnits: '0' })) },
      { ...snapshot, rows: [...snapshot.rows, snapshot.rows[0]], subtotalMinor: '61726', discountMinor: '6172', netMinor: '55554' },
      { ...snapshot, subtotalMinor: '-0' }, { ...snapshot, taxStatus: 'exempt' }, { ...snapshot, tax: '0' },
    ]) expect(() => validateUsSalesOrderExportSnapshot(altered)).toThrow('invalid_export_snapshot');
  });
  it('rejects impossible confirmation/cancellation/revision/invoice sequences', () => {
    const s = buildUsSalesOrderExportSnapshot(fixture());
    for (const altered of [
      { ...s, confirmation: null }, { ...s, status: 'draft' }, { ...s, orderRevision: 1 },
      { ...s, confirmation: { ...s.confirmation, at: '2026-10-10T11:00:00Z' } },
      { ...s, status: 'cancelled', cancellation: { userId: 'staff', at: '2026-10-10T12:01:00Z', reason: 'Scope changed' }, orderRevision: 3 },
      { ...s, invoice: { id: 'i', number: 'I-1', sourceEstimateRevision: 4, issuedAt: '2026-10-10T13:00:00Z' } },
    ]) expect(() => validateUsSalesOrderExportSnapshot(altered)).toThrow('invalid_export_snapshot');
  });
  it('keeps four exact dictionaries and restrained internal-status labels', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) expect(Object.keys(usSalesOrderExportCopy[language])).toEqual(Object.keys(usSalesOrderExportCopy.en));
    expect(Object.values(usSalesOrderExportCopy.de).join(' ')).not.toContain('ß');
    expect(usSalesOrderExportCopy.en.confirmed).toBe('Internally confirmed');
  });
  it('bounds rows and aggregate public text without truncating recorded data', () => {
    const snapshot = buildUsSalesOrderExportSnapshot(fixture());
    expect(() => validateUsSalesOrderExportSnapshot({ ...snapshot, rows: Array.from({ length: 1001 }, (_, index) => ({ ...snapshot.rows[0], id: `row-${index}` })) })).toThrow(ExportError);
    const rows = Array.from({ length: 140 }, (_, index) => ({ ...snapshot.rows[0], id: `row-${index}`, description: 'D'.repeat(4000) }));
    expect(() => validateUsSalesOrderExportSnapshot({ ...snapshot, rows, subtotalMinor: String(BigInt(snapshot.subtotalMinor) * BigInt(rows.length)), discountMinor: String(BigInt(snapshot.discountMinor) * BigInt(rows.length)), netMinor: String(BigInt(snapshot.netMinor) * BigInt(rows.length)) })).toThrow('export_too_large');
  });
});

function inspectPdf(bytes: Uint8Array): { pages: number; text: string; outside: unknown[]; sizes: number[][] } {
  const script = `import sys,json,io,pdfplumber\nfrom pypdf import PdfReader\ndata=sys.stdin.buffer.read()\nr=PdfReader(io.BytesIO(data))\nout=[]\ntexts=[]\nsizes=[]\nfor p in r.pages:\n sizes.append([float(p.mediabox.width),float(p.mediabox.height)])\n texts.append(p.extract_text())\nwith pdfplumber.open(io.BytesIO(data)) as pdf:\n for n,p in enumerate(pdf.pages):\n  for c in p.chars:\n   if c['text'].strip() and (c['x0']<41.5 or c['x1']>570.5 or c['top']<41 or c['bottom']>776): out.append([n,c['text'],c['x0'],c['x1'],c['top'],c['bottom']])\nprint(json.dumps({'pages':len(r.pages),'text':'\\n'.join(texts),'outside':out,'sizes':sizes},ensure_ascii=False))`;
  return JSON.parse(execFileSync('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe', ['-X', 'utf8', '-c', script], { input: bytes, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }));
}
describe('US sales order PDF rendering and extraction', () => {
  it('writes six local fictitious PDFs and independently verifies text, all languages, Letter and glyph bounds', async () => {
    const fonts = await getUsExportFonts(), directory = resolve('.qa/us-sales-orders/exports'); mkdirSync(directory, { recursive: true });
    const evidence: unknown[] = [];
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const s = buildUsSalesOrderExportSnapshot(fixture(language)), bytes = await renderUsSalesOrderPdf(s, fonts), parsed = inspectPdf(bytes), c = usSalesOrderExportCopy[language];
      expect(parsed.text).toContain(c.title); expect(parsed.text).toContain(c.taxPending); expect(parsed.text).toContain(c.netTotal); expect(parsed.text).toContain(c.internalConfirmation);
      expect(parsed.text).toContain('Recorded Seller Énergie'); expect(parsed.text).toContain('Recorded Customer Énergie'); expect(parsed.text).toContain('fictitious-staff-confirmation'); expect(parsed.text).toContain('2026-10-10T12:05:00.000Z');
      expect(parsed.text).toContain(c.orderRevision); expect(parsed.text).toContain(c.sourceEstimateRevision); expect(parsed.outside).toEqual([]); expect(parsed.sizes.every(size => size[0] === 612 && size[1] === 792)).toBe(true);
      expect(parsed.text).not.toMatch(/12-3456789|PRIVATE_SECRET|taxAssessment|taxTreatment|logoRef/);
      writeFileSync(resolve(directory, `order-${language}.pdf`), bytes); writeFileSync(resolve(directory, `order-${language}.html`), renderUsSalesOrderHtml(s)); writeFileSync(resolve(directory, `order-${language}.csv`), renderUsSalesOrderCsv(s));
      evidence.push({ file: `order-${language}.pdf`, ...parsed, text: undefined });
    }
    const description = 'START-DESCRIPTION ' + 'VeryLongRecordedWordWithoutSpaces'.repeat(100) + ' END-DESCRIPTION', notes = 'START-NOTES\n' + 'Exact note: Genève, Zürich, città. '.repeat(400) + '\nEND-NOTES';
    const long = buildUsSalesOrderExportSnapshot(fixture('en', description, notes)), longBytes = await renderUsSalesOrderPdf(long, fonts), parsedLong = inspectPdf(longBytes);
    expect(parsedLong.pages).toBeGreaterThan(3); expect(parsedLong.text).toContain('START-DESCRIPTION'); expect(parsedLong.text).toContain('END-DESCRIPTION'); expect(parsedLong.text).toContain('END-NOTES'); expect(parsedLong.outside).toEqual([]); expect(parsedLong.text.match(/Description/g)!.length).toBeGreaterThan(1);
    writeFileSync(resolve(directory, 'order-long-en.pdf'), longBytes); evidence.push({ file: 'order-long-en.pdf', pages: parsedLong.pages, outside: parsedLong.outside });
    const source = fixture('fr'), cancelled = buildUsSalesOrderExportSnapshot({ ...source, order: { ...source.order, revision: 3, state: 'cancelled', cancellation: { reason: 'Révision demandée par le client', cancelledBy: 'fictitious-staff-cancellation', cancelledAt: '2026-10-10T12:10:00Z' } } });
    const cancelledBytes = await renderUsSalesOrderPdf(cancelled, fonts), parsedCancelled = inspectPdf(cancelledBytes); expect(parsedCancelled.text).toContain('Annulée'); expect(parsedCancelled.text).toContain('Révision demandée par le client'); expect(parsedCancelled.outside).toEqual([]);
    writeFileSync(resolve(directory, 'order-cancelled-fr.pdf'), cancelledBytes); evidence.push({ file: 'order-cancelled-fr.pdf', pages: parsedCancelled.pages, outside: parsedCancelled.outside });
    writeFileSync(resolve(directory, 'renderer-proof.json'), JSON.stringify({ scope: 'Fictitious detached order records. Genuine PDFs independently parsed with pypdf/pdfplumber; no hosted state, customer acceptance, tax or financial posting is proven.', evidence }, null, 2));
  }, 30_000);
  it('preserves amounts beyond Number safe integers through quantity rounding, CSV and PDF', async () => {
    const source = fixture(), record = { ...source, order: { ...source.order, sourceEstimate: { ...source.order.sourceEstimate, lines: [{ ...source.order.sourceEstimate.lines[0], quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '9007199254740993' }, discountBasisPoints: 0 }] } } };
    const s = buildUsSalesOrderExportSnapshot(record); expect(s.netMinor).toBe('18014398509481986'); expect(renderUsSalesOrderCsv(s)).toContain('"180143985094819.86"');
    const parsed = inspectPdf(await renderUsSalesOrderPdf(s, await getUsExportFonts())); expect(parsed.text.replace(/\s/g, '')).toContain('180,143,985,094,819.86'); expect(parsed.outside).toEqual([]);
  });
  it('fails unsupported glyphs explicitly and rejects font accessors without invoking them', async () => {
    const fonts = await getUsExportFonts();
    await expect(renderUsSalesOrderPdf(buildUsSalesOrderExportSnapshot(fixture('en', 'Unsupported emoji 🧪')), fonts)).rejects.toMatchObject({ code: 'unsupported_export_glyph' });
    let getter = 0; const injected = { ...fonts }; Object.defineProperty(injected, 'regular', { enumerable: true, get() { getter++; return fonts.regular; } });
    await expect(renderUsSalesOrderPdf(buildUsSalesOrderExportSnapshot(fixture()), injected)).rejects.toMatchObject({ code: 'invalid_export_font' }); expect(getter).toBe(0);
    await expect(renderUsSalesOrderPdf(buildUsSalesOrderExportSnapshot(fixture()), { ...fonts, regular: new Uint8Array(1024) })).rejects.toMatchObject({ code: 'invalid_export_font' });
  });
  it('owns snapshot and font buffers before the first await', async () => {
    const snapshot = JSON.parse(JSON.stringify(buildUsSalesOrderExportSnapshot(fixture()))), fonts = await getUsExportFonts();
    const pending = renderUsSalesOrderPdf(snapshot, fonts); snapshot.notes = 'MUTATED_AFTER_RENDER'; fonts.regular.fill(0); fonts.bold.fill(0);
    const parsed = inspectPdf(await pending); expect(parsed.text).not.toContain('MUTATED_AFTER_RENDER'); expect(parsed.text).toContain('Payment terms agreed separately.');
  });
  it('uses the already licensed repository fonts without changing their binary files', async () => {
    const fonts = await getUsExportFonts();
    expect(fonts.regular).toEqual(new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Regular.ttf'))));
    expect(fonts.bold).toEqual(new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Bold.ttf'))));
  });
  it('fails explicitly at the PDF page bound instead of dropping long rows', async () => {
    const snapshot = buildUsSalesOrderExportSnapshot(fixture()), rows = Array.from({ length: 1000 }, (_, index) => ({ ...snapshot.rows[0], id: `row-${index}`, description: 'W'.repeat(250) }));
    const large = { ...snapshot, rows, subtotalMinor: String(BigInt(snapshot.subtotalMinor) * BigInt(rows.length)), discountMinor: String(BigInt(snapshot.discountMinor) * BigInt(rows.length)), netMinor: String(BigInt(snapshot.netMinor) * BigInt(rows.length)) };
    expect(validateUsSalesOrderExportSnapshot(large).rows).toHaveLength(1000);
    await expect(renderUsSalesOrderPdf(large, await getUsExportFonts())).rejects.toMatchObject({ code: 'export_too_large', status: 413 });
  }, 30_000);
});
