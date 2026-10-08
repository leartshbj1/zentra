import { describe, expect, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import type { ErpState } from './runtime-types';
import type { CompanyLanguage } from './types';
import { exportFixture } from './export-test-fixture';
import { buildUsExportSnapshot, validateUsExportSnapshot, validateUsExportSelector, ExportError, MAX_EXPORT_ROWS, type ExportSelector } from './export-snapshot';
import { exportCopy } from './export-copy';
import { renderUsExportCsv, renderUsExportHtml, renderUsExportPdf } from './export-renderer';

const org = 'fictitious-export-company';
const seller = { organizationId: org, displayName: 'Current Seller Example', contactEmail: 'seller@example.test' };
const reportSelectors: ExportSelector[] = [{ kind: 'report', reportType: 'trial_balance', asOf: '2026-10-08' }, { kind: 'report', reportType: 'profit_loss', start: '2026-01-01', end: '2026-12-31' }, { kind: 'report', reportType: 'balance_sheet', asOf: '2026-10-08' }, { kind: 'report', reportType: 'cash_flow', start: '2026-01-01', end: '2026-12-31' }, { kind: 'report', reportType: 'general_ledger', accountId: 'cash', start: '2026-01-01', end: '2026-12-31' }];
describe('strict exports of real durable ERP records', () => {
  it.each(['cash', 'accrual'] as const)('projects all reports from the %s ledger without writes or private fields', async basis => {
    const state = await exportFixture(basis), original = JSON.stringify(state);
    for (const selector of reportSelectors) {
      const s = buildUsExportSnapshot(state, seller, selector); expect(s.erpRevision).toBe(8); expect(s.ledgerRevision).toBe(state.ledger.revision); expect(s.selector).toEqual(selector); expect(s.paper).toBe('Letter'); expect(Object.isFrozen(s.rows)).toBe(true); expect(validateUsExportSnapshot(s)).toEqual(s);
      expect(JSON.stringify(s)).not.toMatch(/ein|taxAssessment|private-fictitious|actual-fixture-accountant|fingerprint|approvedAt|recordedBy/);
    }
    expect(JSON.stringify(state)).toBe(original);
  });
  it('reprints the actual archived seller, address and tax after current configuration and identity change', async () => {
    const initial = await exportFixture(); if (initial.configuration.country !== 'US') throw new Error('US fixture required'); const state: ErpState = { ...initial, configuration: { ...initial.configuration, address: { ...initial.configuration.address, line1: '99 New Address' }, taxConfiguration: { status: 'unconfigured' }, language: 'it' } };
    const s = buildUsExportSnapshot(state, null, { kind: 'document', documentType: 'invoice', id: 'invoice 1 é' });
    expect(s.language).toBe('en'); expect(s.seller.name).toBe('Historical Seller Énergie'); expect(s.seller.address.line1).toBe('1 Example Street'); expect(s.totals).toContainEqual({ label: 'tax', minorUnits: '825' }); expect(s.recordRevision).toBeNull(); expect(s.facts).toContainEqual({ label: 'sourceEstimateRevision', value: '2' });
    expect(s.facts).toContainEqual({ label: 'accountingBasis', value: exportCopy.en.accrual }); expect(JSON.stringify(s)).not.toContain('private-fictitious');
  });
  it('exports a vendor entry as an internal sheet, with the frozen supplier and exact remaining balance', async () => {
    const initial = await exportFixture(); const state: ErpState = { ...initial, vendors: initial.vendors!.map(v => ({ ...v, name: 'Later supplier name' })) };
    const s = buildUsExportSnapshot(state, seller, { kind: 'document', documentType: 'vendor_bill', id: 'bill-1' }); expect(s.recipient?.name).toBe('Recorded supplier'); expect(s.recipient?.address.country).toBe('CH'); expect(s.recordRevision).toBe(7); expect(s.totals).toContainEqual({ label: 'balance', minorUnits: '5825' }); expect(renderUsExportHtml(s)).toContain(exportCopy.en.internalBillNotice.replace("'", '&#39;')); expect(renderUsExportHtml(s)).toContain('1201 Genève'); expect(renderUsExportHtml(s)).toContain('New York, NY 10001'); expect(renderUsExportCsv(s)).toContain('1201 Genève'); expect(renderUsExportHtml(s)).not.toContain('Genève, GE 1201');
  });
  it.each(['fr', 'de', 'it', 'en'] as CompanyLanguage[])('produces escaped %s HTML and safe exact CSV with all revision traces', async language => {
    const state = await exportFixture('accrual', '=DANGEROUS("note")', '<script>Long & real service</script>');
    const s = buildUsExportSnapshot(state, { ...seller, displayName: '=FORMULA supplier' }, { kind: 'document', documentType: 'estimate', id: 'estimate 1 é' }, language);
    const html = renderUsExportHtml(s), csv = renderUsExportCsv(s); expect(html).toContain(`lang="${language}"`); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;Long &amp; real service&lt;/script&gt;'); expect(html).not.toMatch(/https?:\/\/|<script|ein|proof/); expect(csv).toContain("'=FORMULA supplier"); expect(csv).toContain("'=DANGEROUS"); expect(csv).toContain('"246.90"'); expect(csv).toContain(exportCopy[language].erpRevision);
  });
  it('preserves a 256-character legal seller name', async () => { const s = buildUsExportSnapshot(await exportFixture(), { ...seller, displayName: 'S'.repeat(256) }, reportSelectors[0]); expect(s.seller.name).toHaveLength(256); });
  it.each([{ kind: 'document', documentType: 'credit_memo', id: 'x' }, { kind: 'document', documentType: 'estimate', id: 'x', organizationId: 'other' }, { kind: 'report', reportType: 'profit_loss', start: '2026-10-08', end: '2026-01-01' }, { kind: 'report', reportType: 'trial_balance', asOf: '2026-02-30' }, { kind: 'report', reportType: 'general_ledger', start: '2026-01-01', end: '2026-12-31' }])('refuses malformed selector %j', value => { expect(() => validateUsExportSelector(value)).toThrow(ExportError); });
  it('does not invoke an accessor or accept prototype/symbol/extra data', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[0]); let getter = 0;
    const injected = { ...s }; Object.defineProperty(injected, 'notes', { enumerable: true, get() { getter++; return 'private'; } }); expect(() => renderUsExportHtml(injected)).toThrow(ExportError); expect(getter).toBe(0);
    for (const malformed of [{ ...s, ein: 'secret' }, Object.assign(Object.create({ private: true }), s), { ...s, [Symbol('private')]: 'secret' }, { ...s, rows: [['bad']] }, { ...s, totals: s.totals.map(t => ({ ...t, minorUnits: '-0' })) }]) expect(() => validateUsExportSnapshot(malformed)).toThrow(ExportError);
  });
  it('rejects malformed persisted books, absent real seller and absent source without revealing the data', async () => {
    const state = await exportFixture(); expect(() => buildUsExportSnapshot({ ...state, hiddenPrivate: 'SECRET' }, seller, reportSelectors[0])).toThrow('invalid_export_snapshot'); expect(() => buildUsExportSnapshot(state, null, reportSelectors[0])).toThrow('seller_configuration_required'); expect(() => buildUsExportSnapshot(state, seller, { kind: 'document', documentType: 'estimate', id: 'missing' })).toThrow('export_source_not_found');
  });
  it('detects tampered document and report monetary identities', async () => {
    for (const selector of [...reportSelectors, { kind: 'document', documentType: 'invoice', id: 'invoice 1 é' } as const, { kind: 'document', documentType: 'vendor_bill', id: 'bill-1' } as const]) {
      const s = buildUsExportSnapshot(await exportFixture(), seller, selector); const changed = { ...s, totals: s.totals.map((t, i) => i === 0 ? { ...t, minorUnits: (BigInt(t.minorUnits) + BigInt(1)).toString() } : t) }; expect(() => validateUsExportSnapshot(changed)).toThrow(ExportError);
    }
  });
  it('rejects cash-flow row amounts or labels that disagree with their exact six totals', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[3]);
    for (const rows of [s.rows.slice(1), s.rows.map((r, i) => i === 1 ? [r[0], '123'] : r), s.rows.map((r, i) => i === 2 ? ['invented category', r[1]] : r)]) expect(() => validateUsExportSnapshot({ ...s, rows })).toThrow('invalid_export_snapshot');
  });
  it('rejects intermediate general-ledger balances even when final totals are unchanged', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, { kind: 'report', reportType: 'general_ledger', accountId: 'payables', start: '2026-01-01', end: '2026-12-31' }); expect(s.rows.length).toBeGreaterThan(1);
    const rows = s.rows.map((r, i) => i === 0 ? [...r.slice(0, 6), (BigInt(r[6]) + BigInt(1)).toString()] : r); expect(() => validateUsExportSnapshot({ ...s, rows })).toThrow('invalid_export_snapshot');
  });
  it('rejects altered column/total schemas and invalid account types', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[0]);
    for (const changed of [{ ...s, columns: s.columns.map((c, i) => i === 0 ? { ...c, label: 'notes' } : c) }, { ...s, totals: [...s.totals, { label: 'profit', minorUnits: '0' }] }, { ...s, rows: s.rows.map((r, i) => i === 0 ? [...r.slice(0, 2), 'invented', ...r.slice(3)] : r) }]) expect(() => validateUsExportSnapshot(changed)).toThrow('invalid_export_snapshot');
  });
  it('rejects invented document revisions, missing date facts and simultaneous debit/credit values', async () => {
    const state = await exportFixture(), invoice = buildUsExportSnapshot(state, null, { kind: 'document', documentType: 'invoice', id: 'invoice 1 é' });
    for (const malformed of [{ ...invoice, recordRevision: 8 }, { ...invoice, facts: invoice.facts.filter(f => f.label !== 'accountingDate') }, { ...invoice, facts: [...invoice.facts, { label: 'notes', value: 'unsupported extra metadata' }] }]) expect(() => validateUsExportSnapshot(malformed)).toThrow('invalid_export_snapshot');
    const gl = buildUsExportSnapshot(state, seller, { kind: 'report', reportType: 'general_ledger', accountId: 'payables', start: '2026-01-01', end: '2026-12-31' });
    expect(() => validateUsExportSnapshot({ ...gl, rows: gl.rows.map((r, i) => i === 0 ? [...r.slice(0, 4), (BigInt(r[4]) + BigInt(1)).toString(), (BigInt(r[5]) + BigInt(1)).toString(), r[6]] : r) })).toThrow('invalid_export_snapshot');
  });
  it.each(['fr', 'de', 'it'] as const)('translates canonical account types in %s but preserves entered account names', async language => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[1], language); const html = renderUsExportHtml(s), csv = renderUsExportCsv(s);
    expect(html).toContain(exportCopy[language].income); expect(csv).toContain(exportCopy[language].expense); expect(html).not.toContain('<td class="left">income</td>'); expect(html).toContain(s.rows[0][0]);
  });
  it.each(['fr', 'de', 'it', 'en'] as const)('labels the actual buying/reporting company separately from the invoice seller in %s', async language => {
    const state = await exportFixture();
    for (const selector of [reportSelectors[0], { kind: 'document', documentType: 'vendor_bill', id: 'bill-1' } as const]) {
      const s = buildUsExportSnapshot(state, seller, selector, language); expect(renderUsExportHtml(s)).toContain(`<h2>${exportCopy[language].company}</h2>`); expect(renderUsExportHtml(s)).not.toContain(`<h2>${exportCopy[language].seller}</h2>`); expect(renderUsExportCsv(s)).toContain(`"${exportCopy[language].company}","Current Seller Example"`);
    }
    const invoice = buildUsExportSnapshot(state, null, { kind: 'document', documentType: 'invoice', id: 'invoice 1 é' }, language); expect(renderUsExportHtml(invoice)).toContain(`<h2>${exportCopy[language].seller}</h2>`);
  });
  it('rejects unknown source accounts and bounds rows and aggregate text explicitly', async () => {
    const state = await exportFixture(); expect(() => buildUsExportSnapshot(state, seller, { kind: 'report', reportType: 'general_ledger', accountId: 'missing', start: '2026-01-01', end: '2026-12-31' })).toThrow('export_source_not_found');
    const s = buildUsExportSnapshot(state, seller, reportSelectors[1]), zeroRow = ['N'.repeat(4000), 'income', '0'];
    expect(() => validateUsExportSnapshot({ ...s, rows: [...s.rows, ...Array.from({ length: 125 }, () => zeroRow)] })).toThrow('export_too_large');
    expect(() => validateUsExportSnapshot({ ...s, rows: Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => zeroRow) })).toThrow(ExportError);
  });
  it('keeps the four copy dictionaries exact and their legal claims restrained', () => { for (const language of ['fr', 'de', 'it', 'en'] as const) expect(Object.keys(exportCopy[language])).toEqual(Object.keys(exportCopy.en)); expect(Object.values(exportCopy.de).join(' ')).not.toContain('ß'); });
});

const fonts = { regular: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Regular.ttf'))), bold: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Bold.ttf'))) };
/** Independent PDF parser inspects real ToUnicode text and placement. No screenshot
 * is counted as proof of persisted state, tax, bank transfer or production. */
function inspectPdf(bytes: Uint8Array): { pages: number; text: string; outside: unknown[]; sizes: number[][] } {
  const script = `import sys,json,io,pdfplumber\nfrom pypdf import PdfReader\ndata=sys.stdin.buffer.read()\nr=PdfReader(io.BytesIO(data))\nout=[]\ntexts=[]\nsizes=[]\nfor p in r.pages:\n sizes.append([float(p.mediabox.width),float(p.mediabox.height)])\n def visitor(t,cm,tm,f,size):\n  if t.strip():\n   x=tm[4]*cm[0]+tm[5]*cm[2]+cm[4]\n   y=tm[4]*cm[1]+tm[5]*cm[3]+cm[5]\n   if x<41.5 or x>571 or y<17 or y>751: out.append([t,x,y,size])\n texts.append(p.extract_text(visitor_text=visitor))\nwith pdfplumber.open(io.BytesIO(data)) as pdf:\n for n,p in enumerate(pdf.pages):\n  for c in p.chars:\n   if c['text'].strip() and (c['x0']<41.5 or c['x1']>570.5 or c['top']<41 or c['bottom']>776): out.append(['glyph',n,c['text'],c['x0'],c['x1'],c['top'],c['bottom']])\nprint(json.dumps({'pages':len(r.pages),'text':'\\n'.join(texts),'outside':out,'sizes':sizes},ensure_ascii=False))`;
  return JSON.parse(execFileSync('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe', ['-X', 'utf8', '-c', script], { input: bytes, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }));
}
describe('real vector and text PDF exports', () => {
  it('writes six fictitious QA PDFs with exact text, historical identity and Letter geometry', async () => {
    const state = await exportFixture(), directory = resolve('.qa/us-exports'); mkdirSync(directory, { recursive: true });
    const evidence: unknown[] = [];
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const s = buildUsExportSnapshot(state, null, { kind: 'document', documentType: 'invoice', id: 'invoice 1 é' }, language), bytes = await renderUsExportPdf(s, fonts), inspected = inspectPdf(bytes);
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-'); expect(inspected.text).toContain('Historical Seller Énergie'); expect(inspected.text).toContain('255'); expect(inspected.text).toContain(exportCopy[language].erpRevision); expect(inspected.text).not.toMatch(/12-3456789|private-fictitious|fingerprint|actual-fixture-accountant/); expect(inspected.outside).toEqual([]); expect(inspected.sizes.every(size => size[0] === 612 && size[1] === 792)).toBe(true);
      const filename = `invoice-${language}.pdf`; writeFileSync(resolve(directory, filename), bytes); writeFileSync(resolve(directory, `invoice-${language}.html`), renderUsExportHtml(s)); writeFileSync(resolve(directory, `invoice-${language}.csv`), renderUsExportCsv(s)); evidence.push({ filename, ...inspected, text: undefined });
    }
    const longDescription = 'START-DESCRIPTION ' + 'VeryLongRecordedWordWithoutSpaces'.repeat(100) + ' END-DESCRIPTION', longNotes = 'START-NOTES\n' + 'Exact recorded note with accents: Genève, Zürich, città. '.repeat(250) + '\nEND-NOTES';
    const longState = await exportFixture('accrual', longNotes, longDescription), long = buildUsExportSnapshot(longState, seller, { kind: 'document', documentType: 'estimate', id: 'estimate 1 é' }), longBytes = await renderUsExportPdf(long, fonts), longPdf = inspectPdf(longBytes);
    expect(longPdf.pages).toBeGreaterThan(3); expect(longPdf.text).toContain('START-DESCRIPTION'); expect(longPdf.text).toContain('END-DESCRIPTION'); expect(longPdf.text).toContain('END-NOTES'); expect(longPdf.outside).toEqual([]); expect(longPdf.text.match(/Description/g)!.length).toBeGreaterThan(1); writeFileSync(resolve(directory, 'estimate-long-en.pdf'), longBytes); evidence.push({ filename: 'estimate-long-en.pdf', pages: longPdf.pages, outside: longPdf.outside });
    const bill = buildUsExportSnapshot(state, seller, { kind: 'document', documentType: 'vendor_bill', id: 'bill-1' }, 'fr'), billBytes = await renderUsExportPdf(bill, fonts), billPdf = inspectPdf(billBytes); expect(billPdf.text).toContain(exportCopy.fr.internalBillNotice); expect(billPdf.text).toContain('1201 Genève'); expect(billPdf.text).toContain(exportCopy.fr.company); expect(billPdf.text).not.toContain(exportCopy.fr.seller); expect(billPdf.outside).toEqual([]); writeFileSync(resolve(directory, 'vendor-entry-fr.pdf'), billBytes); evidence.push({ filename: 'vendor-entry-fr.pdf', pages: billPdf.pages, outside: billPdf.outside });
    writeFileSync(resolve(directory, 'renderer-proof.json'), JSON.stringify({ scope: 'Fictitious real engine/RAM CAS sources; genuine vector/text PDFs parsed independently with pypdf and pdfplumber, including individual glyph bounds. No hosted persistence, tax provider, original supplier invoice, retention or production evidence.', limits: { rows: 1000, serializedCharacters: 500000, pdfPages: 200 }, evidence }, null, 2));
  }, 30_000);
  it.each(reportSelectors)('renders and parses genuine %j report PDFs', async selector => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, selector), bytes = await renderUsExportPdf(s, fonts), pdf = await PDFDocument.load(bytes), inspected = inspectPdf(bytes); expect(pdf.getPageCount()).toBeGreaterThan(0); expect(inspected.text).toContain(exportCopy.en[selector.kind === 'report' ? selector.reportType : selector.documentType]); expect(inspected.outside).toEqual([]); expect(inspected.text).toContain(exportCopy.en.reportNotice);
  });
  it('fails unsupported glyphs explicitly rather than replacing or dropping user text', async () => { const s = buildUsExportSnapshot(await exportFixture('accrual', 'Unsupported emoji 🧪'), seller, { kind: 'document', documentType: 'estimate', id: 'estimate 1 é' }); await expect(renderUsExportPdf(s, fonts)).rejects.toMatchObject({ code: 'unsupported_export_glyph', status: 422 }); });
  it('keeps amounts beyond Number safe integers exact in snapshot, CSV and PDF', async () => {
    const s = buildUsExportSnapshot(await exportFixture('accrual', '', 'Exact huge recorded amount', '9007199254740993'), seller, { kind: 'document', documentType: 'estimate', id: 'estimate 1 é' });
    expect(s.rows[0][2]).toBe('9007199254740993'); expect(s.totals).toContainEqual({ label: 'total', minorUnits: '18014398509481986' }); expect(renderUsExportCsv(s)).toContain('"180143985094819.86"');
    const inspected = inspectPdf(await renderUsExportPdf(s, fonts)); expect(inspected.text.replace(/\s/g, '')).toContain('180,143,985,094,819.86'); expect(inspected.outside).toEqual([]);
  });
  it('fails explicitly at the 200-page limit rather than truncating long recorded rows', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[0]); const bounded = { ...s, rows: Array.from({ length: 1000 }, () => ['1', 'W'.repeat(400), 'asset', '0', '0']), totals: [{ label: 'debit', minorUnits: '0' }, { label: 'credit', minorUnits: '0' }] };
    expect(validateUsExportSnapshot(bounded).rows).toHaveLength(1000); await expect(renderUsExportPdf(bounded, fonts)).rejects.toMatchObject({ code: 'export_too_large', status: 413 });
  }, 30_000);
  it('rejects invalid font bytes and font accessors without invoking them', async () => {
    const s = buildUsExportSnapshot(await exportFixture(), seller, reportSelectors[0]); await expect(renderUsExportPdf(s, { regular: new Uint8Array(1024), bold: fonts.bold })).rejects.toMatchObject({ code: 'invalid_export_font' }); let calls = 0; const injected = { ...fonts }; Object.defineProperty(injected, 'regular', { enumerable: true, get() { calls++; return fonts.regular; } }); await expect(renderUsExportPdf(s, injected)).rejects.toMatchObject({ code: 'invalid_export_font' }); expect(calls).toBe(0);
  });
  it('rejects invalid snapshots before loading or using a caller font getter', async () => { let calls = 0; const injected = { ...fonts }; Object.defineProperty(injected, 'regular', { enumerable: true, get() { calls++; return fonts.regular; } }); await expect(renderUsExportPdf({ privateProof: 'SECRET' }, injected)).rejects.toMatchObject({ code: 'invalid_export_snapshot' }); expect(calls).toBe(0); });
});
