import { describe, expect, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { CompanyLanguage } from './types';
import {
  US_FINANCIAL_PILOT_EXPORT_COLUMNS as columns, US_FINANCIAL_PILOT_EXPORT_TOTALS as totalLabels,
  validateUsFinancialPilotExportSnapshot, type UsFinancialPilotExportSnapshot as Snapshot,
  type UsFinancialPilotExportSection as Section, type UsFinancialPilotExportSectionKind as SectionKind,
} from './us-financial-pilot-export-contract';
import { usFinancialPilotExportCopy as copy } from './us-financial-pilot-export-copy';
import { renderUsFinancialPilotExportCsv as csv, renderUsFinancialPilotExportPdf as pdf, type UsFinancialPilotExportFonts } from './us-financial-pilot-export-renderer';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import type { UsFinancialOperationV5 } from './us-financial-kernel-types';
import { buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';

// Neutral presentation fixtures, deliberately fictitious. These are not proof of
// a server, persisted book, hosted authentication, bank transaction or tax filing.
const organizationId = 'synthetic-renderer-test-workspace';
const address = { country: 'US' as const, line1: '1 Fictitious Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const issuer = { name: 'Société fictive Énergie - Genève Zürich città', address, email: 'fictitious@example.test', phone: null };
function section(kind: SectionKind, rows: string[][], values: string[]): Section {
  return { kind, columns: columns[kind], rows, totals: totalLabels[kind].map((label, i) => ({ label, minorUnits: values[i] })) };
}
function commonFacts(): Snapshot['facts'] {
  return [{ label: 'organization', kind: 'text', value: organizationId }, { label: 'currency', kind: 'text', value: 'USD' }, { label: 'accountingBasis', kind: 'text', value: 'accrual' }, { label: 'financialRevision', kind: 'text', value: '7' }, { label: 'ledgerRevision', kind: 'text', value: '3' }];
}
function invoice(language: CompanyLanguage = 'en'): Snapshot {
  return {
    consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: 7, ledgerRevision: 3, currency: 'USD', paper: 'Letter', language,
    selector: { kind: 'invoice', invoiceId: 'synthetic-invoice-1', revision: 7, format: 'pdf', language }, number: 'TEST-INVOICE-1', issuer,
    recipient: { name: 'Fictitious Customer - local tests only', address, email: null, phone: null },
    facts: [...commonFacts(), { label: 'date', kind: 'date', value: '2026-10-09' }, { label: 'accountingDate', kind: 'date', value: '2026-10-09' }, { label: 'dueDate', kind: 'date', value: '2026-11-08' }, { label: 'sourceEstimateRevision', kind: 'text', value: '2' }],
    sections: [
      section('invoice_lines', [['Fictitious service - no commercial transaction', '1', '10000', '10000', '700', '10700']], ['10000', '0', '10000', '700', '10700', '5000', '3500', '2200']),
      section('payments', [['TEST-PAYMENT-1', '2026-10-10', '2026-10-10', '5000']], ['5000']),
      section('credits', [['TEST-CREDIT-1', '2026-10-10', '2026-10-10', 'Fictitious adjustment', 'adjustment_pending', '3300', '200', '3500']], ['3500']),
    ], notes: 'Fictitious renderer fixture. No money moved. Accents: Genève, Zürich, città.',
  };
}
function report(kind: 'trial_balance' | 'profit_loss' | 'balance_sheet' | 'cash_flow' | 'general_ledger' | 'receivables', language: CompanyLanguage = 'en'): Snapshot {
  const base = invoice(language), range = { from: '2026-10-01', to: '2026-10-31' };
  const selector: Snapshot['selector'] = kind === 'trial_balance' || kind === 'balance_sheet'
    ? { kind: 'report', reportType: kind, asOf: range.to, revision: 7, format: 'csv', language }
    : kind === 'receivables' ? { kind: 'report', reportType: kind, revision: 7, format: 'csv', language }
      : kind === 'general_ledger' ? { kind: 'report', reportType: kind, ...range, accountId: 'synthetic-cash', revision: 7, format: 'csv', language }
        : { kind: 'report', reportType: kind, ...range, revision: 7, format: 'csv', language };
  const facts: Snapshot['facts'] = [...commonFacts(), ...(kind === 'trial_balance' || kind === 'balance_sheet' ? [{ label: 'asOf' as const, kind: 'date' as const, value: range.to }] : kind === 'receivables' ? [] : [{ label: 'from' as const, kind: 'date' as const, value: range.from }, { label: 'to' as const, kind: 'date' as const, value: range.to }, ...(kind === 'general_ledger' ? [{ label: 'account' as const, kind: 'text' as const, value: 'synthetic-cash' }] : [])])];
  const data: Record<typeof kind, Section> = {
    trial_balance: section('trial_balance', [['synthetic-cash', 'Fictitious cash account', 'asset', '10000', '0'], ['synthetic-equity', 'Fictitious equity account', 'equity', '0', '10000']], ['10000', '10000']),
    profit_loss: section('profit_loss', [['Fictitious income', 'income', '10000'], ['Fictitious expense', 'expense', '2000']], ['10000', '2000', '8000']),
    balance_sheet: section('balance_sheet', [['Fictitious asset', 'asset', '10000'], ['Fictitious liability', 'liability', '2000'], ['Fictitious equity', 'equity', '3000']], ['10000', '2000', '3000', '5000']),
    cash_flow: section('cash_flow', [], ['10000', '-1000', '2000', '-3000', '-2000', '8000']),
    general_ledger: section('general_ledger', [['1', '2026-10-09', '2026-10-09', '', '', '1000', '0', '11000'], ['3', '2026-10-10', '2026-10-10', '2026-10-10', 'TEST-PAYMENT-1', '0', '500', '10500']], ['10000', '10500']),
    receivables: section('receivables', [['TEST-INVOICE-1', 'Fictitious Customer', '2026-10-09', '2026-11-08', '10700', '5000', '3500', '2200', 'partially_settled']], ['10700', '5000', '3500', '2200']),
  };
  return { ...base, selector, number: null, issuer: { name: null, address, email: null, phone: null }, recipient: null, facts, sections: [data[kind]] };
}
const fonts: UsFinancialPilotExportFonts = { regular: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Regular.ttf'))), bold: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Bold.ttf'))) };
const python = 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
type Inspection = { pages: number; text: string; pageTexts: string[]; outside: unknown[]; sizes: number[][]; images: number };
/** Independent parsers inspect ToUnicode text, every glyph box, image resources,
 * page geometry and page count; neither parser uses our renderer's layout code. */
function inspect(bytes: Uint8Array): Inspection {
  const script = `import sys,json,io,pdfplumber\nfrom pypdf import PdfReader\ndata=sys.stdin.buffer.read()\nr=PdfReader(io.BytesIO(data))\nout=[]\ntexts=[]\nsizes=[]\nimages=0\nfor p in r.pages:\n sizes.append([float(p.mediabox.width),float(p.mediabox.height)])\n texts.append(p.extract_text())\n for item in p.get('/Resources',{}).get('/XObject',{}).values():\n  if item.get_object().get('/Subtype')=='/Image': images+=1\nwith pdfplumber.open(io.BytesIO(data)) as document:\n for n,p in enumerate(document.pages):\n  for c in p.chars:\n   if c['text'].strip() and (c['x0']<41.5 or c['x1']>570.5 or c['top']<41 or c['bottom']>776): out.append([n,c['text'],c['x0'],c['x1'],c['top'],c['bottom']])\nprint(json.dumps({'pages':len(r.pages),'text':'\\n'.join(texts),'pageTexts':texts,'outside':out,'sizes':sizes,'images':images},ensure_ascii=False))`;
  return JSON.parse(execFileSync(python, ['-X', 'utf8', '-c', script], { input: bytes, encoding: 'utf8', maxBuffer: 6 * 1024 * 1024 }));
}
function parseCsv(value: string): string[][] {
  const script = "import sys,csv,io,json\nprint(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode('utf-8').removeprefix('\\ufeff'),newline=''))),ensure_ascii=False))";
  return JSON.parse(execFileSync(python, ['-X', 'utf8', '-c', script], { input: value, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
}

describe('financial pilot CSV rendering from its neutral presentation contract', () => {
  it.each(['fr', 'de', 'it', 'en'] as const)('keeps %s labels separate from exact USD and US dates', language => {
    const result = csv(invoice(language)), rows = parseCsv(result);
    expect(result.startsWith('\uFEFF')).toBe(true); expect(result.endsWith('\r\n')).toBe(true);
    expect(rows).toContainEqual([copy[language].date, '10/09/2026']); expect(result).toContain('"107.00"');
    expect(result).toContain(copy[language].received); expect(result).toContain(copy[language].credited); expect(result).toContain(copy[language].outstanding);
    expect(result).toContain(copy[language].taxAdjustmentPending); expect(result).toContain('Genève Zürich città');
    expect(rows.find(row => row[0] === copy[language].number && row.length === 8)?.at(-1)).toBe(copy[language].credited + ' (USD)');
    expect(result).not.toContain('financial_snapshot_changed');
  });
  it.each(['=SUM(1,2)', ' +2', '\u00a0@SUM(1,2)', '\u2003-2', '\u200b=2', '\uFEFF=2', '\u2060+2', '\u0085@2', '\t\r\n=2'])('protects text formula prefix %j even after Unicode whitespace and format characters', value => {
    const base = invoice(), snapshot = { ...base, notes: value, sections: base.sections.map(s => s.kind === 'payments' ? { ...s, rows: [[value, '2026-10-10', '2026-10-10', '5000']] } : s) };
    const rows = parseCsv(csv(snapshot)); expect(rows).toContainEqual([copy.en.notes, "'" + value]);
    expect(rows).toContainEqual(["'" + value, '10/10/2026', '10/10/2026', '50.00']);
  });
  it('round-trips commas, quotes, CRLF and Unicode rather than breaking CSV records', () => {
    const notes = 'Fictitious "quoted", note\r\nSecond line: Genève, Zürich, città.';
    const result = csv({ ...invoice(), notes }); expect(result).toContain('""quoted""'); expect(parseCsv(result)).toContainEqual([copy.en.notes, notes]);
  });
  it('keeps negative numeric money cells unprefixed and exact beyond Number precision', () => {
    const base = report('cash_flow'), amount = '-9007199254740993';
    const result = csv({ ...base, sections: [section('cash_flow', [], ['0', amount, '0', '0', amount, amount])] });
    expect(parseCsv(result)).toContainEqual([copy.en.operating, '-90071992547409.93']);
    expect(result).not.toContain("'-90071992547409.93");
  });
  it.each(['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger', 'receivables'] as const)('contains every %s section, total and trace without private input fields', kind => {
    const snapshot = report(kind, 'fr'), result = csv(snapshot), rows = parseCsv(result);
    expect(rows).toContainEqual([copy.fr[kind]]); expect(rows).toContainEqual([copy.fr.financialRevision, '7']); expect(rows).toContainEqual([copy.fr.ledgerRevision, '3']);
    expect(result).toContain(copy.fr.reportNotice); expect(result).not.toContain(issuer.name);
    for (const total of snapshot.sections[0].totals) expect(result).toContain(copy.fr[total.label]);
    if (kind === 'receivables') expect(result).toContain(copy.fr.currentNotice);
  });
  it('requires the complete new schema before rendering and does not invoke snapshot getters', () => {
    let calls = 0; const invalid = { ...invoice() }; Object.defineProperty(invalid, 'notes', { enumerable: true, get() { calls++; return 'PRIVATE'; } });
    expect(() => csv(invalid)).toThrow('invalid_financial_pilot_export_snapshot'); expect(calls).toBe(0);
    expect(() => csv({ ...invoice(), privateTaxProof: 'SECRET' })).toThrow('invalid_financial_pilot_export_snapshot');
  });
  it('keeps the four copy dictionaries complete and makes no live accounting or tax certification claim', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) expect(Object.keys(copy[language])).toEqual(Object.keys(copy.en));
    expect(Object.values(copy.de).join(' ')).not.toContain('ß');
    for (const language of ['fr', 'de', 'it', 'en'] as const) expect(copy[language].testNotice).toContain('TEST');
  });
});

describe('financial pilot real text/vector PDF rendering', () => {
  it('writes five explicitly fictitious QA PDFs, preserves all four languages and keeps every glyph in US Letter bounds', async () => {
    const directory = resolve('.qa/us-financial-exports'); mkdirSync(directory, { recursive: true }); const evidence: unknown[] = [];
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const snapshot = invoice(language), bytes = await pdf(snapshot, fonts), inspected = inspect(bytes), filename = `fictitious-invoice-${language}.pdf`;
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-'); expect(inspected.text).toContain(issuer.name);
      expect(inspected.text).toContain(copy[language].testNotice); expect(inspected.text).toContain('10/09/2026'); expect(inspected.text).toContain('11/08/2026');
      expect(inspected.text).toContain('$107.00'); expect(inspected.text).toContain('$50.00'); expect(inspected.text).toContain('$35.00'); expect(inspected.text).toContain('$22.00');
      expect(inspected.text).toContain(copy[language].financialRevision); expect(inspected.text).toContain(copy[language].ledgerRevision);
      expect(inspected.sizes.every(size => size[0] === 612 && size[1] === 792)).toBe(true); expect(inspected.outside).toEqual([]); expect(inspected.images).toBe(0);
      for (let i = 0; i < inspected.pages; i++) expect(inspected.pageTexts[i]).toContain(`${copy[language].page} ${i + 1} ${copy[language].of} ${inspected.pages}`);
      writeFileSync(resolve(directory, filename), bytes); writeFileSync(resolve(directory, `fictitious-invoice-${language}.csv`), csv(snapshot));
      evidence.push({ filename, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), pages: inspected.pages, sizes: inspected.sizes, outside: inspected.outside, images: inspected.images });
    }
    const base = invoice(), description = 'START-DESCRIPTION ' + 'FictitiousVeryLongRecordedWordWithoutSpaces'.repeat(110) + ' END-DESCRIPTION';
    const notes = 'START-NOTES\n' + 'Fictitious note with accents: Genève, Zürich, città. '.repeat(230) + '\nEND-NOTES';
    const long = { ...base, notes, sections: base.sections.map(s => s.kind === 'invoice_lines' ? { ...s, rows: s.rows.map(row => [description, ...row.slice(1)]) } : s) }, bytes = await pdf(long, fonts), inspected = inspect(bytes), filename = 'fictitious-invoice-long-en.pdf';
    expect(inspected.pages).toBeGreaterThan(3); expect(inspected.text).toContain('START-DESCRIPTION'); expect(inspected.text).toContain('END-DESCRIPTION'); expect(inspected.text).toContain('END-NOTES');
    expect(inspected.text.match(/Description/gu)!.length).toBeGreaterThan(1); expect(inspected.text).toContain(copy.en.continuation); expect(inspected.outside).toEqual([]); expect(inspected.images).toBe(0);
    writeFileSync(resolve(directory, filename), bytes); evidence.push({ filename, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), pages: inspected.pages, sizes: inspected.sizes, outside: inspected.outside, images: inspected.images });
    writeFileSync(resolve(directory, 'renderer-proof.json'), JSON.stringify({ scope: 'Fictitious neutral presentation fixtures only. Genuine vector/text PDFs independently parsed with pypdf/pdfplumber, including every glyph bound. Not evidence of a persisted book, hosted Auth, multiple connections, bank transfer, legal/tax compliance or production readiness.', limits: { rows: 1000, textCharacters: 500000, pdfPages: 200, outputBytes: 12 * 1024 * 1024 }, evidence }, null, 2));
  }, 30_000);
  it('writes dense report QA PDFs from the actual builder and a real, fictitious V5 book with payments, credit and negative cash', async () => {
    const fixture = await financialKernelFixture({ tax: '0' }); let book = await promoteUsFinancialBookV5(fixture.baseline, fixture.policy, fixture.actor);
    const apply = async (operation: UsFinancialOperationV5, id = `synthetic-renderer-event-${book.revision}`) => {
      book = (await applyUsFinancialOperationV5(book, operation, fixture.actor, operation.type === 'erp_command' ? usFinancialErpEntityIdV5(operation.command, fixture.configuration.organizationId) : id)).book;
    };
    await apply({ type: 'customer_payment', idempotencyKey: 'PRIVATE-RENDERER-PAYMENT', invoiceId: 'invoice-1', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Fictitious payment - no money moved' });
    const creditInput = { type: 'customer_credit' as const, idempotencyKey: 'PRIVATE-RENDERER-CREDIT', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Fictitious historical zero-tax correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] }, candidate = await buildUsFinancialCreditCandidateV5(book, creditInput);
    await apply({ ...creditInput, taxProof: { schemaVersion: 1, environment: 'test', kind: 'historical_zero_tax', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'PRIVATE-LOCAL-REVIEW', verifiedBy: 'PRIVATE-LOCAL-REVIEWER', verifiedAt: fixture.actor.timestamp } });
    for (let i = 0; i < 26; i++) {
      await apply({ type: 'erp_command', idempotencyKey: `PRIVATE-RENDERER-JOURNAL-${i}`, command: { type: 'post_manual_journal', id: `synthetic-renderer-journal-${i}`, transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', description: 'Fictitious cash expense - no money moved', sourceReference: `Fictitious expense ${i} - Genève Zürich città`, cashFlowCategory: 'operating', lines: [{ accountId: 'purchases', debitMinor: '10000', creditMinor: '0' }, { accountId: 'cash', debitMinor: '0', creditMinor: '10000' }] }, facts: { kind: 'none' } });
    }
    const directory = resolve('.qa/us-financial-exports'); mkdirSync(directory, { recursive: true }); const evidence: unknown[] = [];
    for (const kind of ['general_ledger', 'receivables', 'trial_balance'] as const) {
      const common = { kind: 'report' as const, revision: book.revision, language: 'fr' as const, format: 'pdf' as const };
      const selector: Snapshot['selector'] = kind === 'general_ledger' ? { ...common, reportType: kind, from: '2026-01-01', to: '2026-12-31', accountId: 'cash' } : kind === 'trial_balance' ? { ...common, reportType: kind, asOf: '2026-12-31' } : { ...common, reportType: kind };
      const snapshot = await buildUsFinancialPilotExportSnapshot(book, selector), bytes = await pdf(snapshot, fonts), inspected = inspect(bytes), filename = `fictitious-v5-${kind}-fr.pdf`;
      expect(inspected.outside).toEqual([]); expect(inspected.images).toBe(0); expect(inspected.text).toContain(copy.fr[kind]); expect(inspected.text.replace(/\s+/gu, ' ')).toContain(copy.fr.reportNotice);
      expect(inspected.text).not.toMatch(/PRIVATE-|invoiceFingerprint|allocationSha256|idempotencyKey|providerAccount/);
      if (kind === 'general_ledger') {
        expect(snapshot.sections[0].rows.length).toBeGreaterThan(25); expect(inspected.pages).toBeGreaterThan(1);
        expect(inspected.text).toContain('-$2,590.00'); expect(inspected.text).toContain('10/10/2026'); expect(inspected.text.replace(/\s+/gu, ' ').match(/Révision de l'écriture/gu)!.length).toBeGreaterThan(1);
      }
      if (kind === 'receivables') {
        expect(inspected.text.replace(/\s+/gu, ' ')).toContain(copy.fr.currentNotice); expect(snapshot.sections[0].totals.map(t => t.minorUnits)).toEqual(['30000', '1000', '10000', '19000']);
        expect(inspected.text).toContain('10/09/2026'); expect(inspected.text).toContain('11/08/2026');
        for (const amount of ['$300.00', '$10.00', '$100.00', '$190.00']) expect(inspected.text).toContain(amount);
      }
      if (kind === 'trial_balance') expect(inspected.pageTexts.find(text => text.includes('Débit:'))).toContain('Crédit:');
      writeFileSync(resolve(directory, filename), bytes); writeFileSync(resolve(directory, `fictitious-v5-${kind}-fr.csv`), csv(snapshot));
      evidence.push({ filename, revision: snapshot.revision, ledgerRevision: snapshot.ledgerRevision, rows: snapshot.sections[0].rows.length, columns: snapshot.sections[0].columns.length, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), pages: inspected.pages, sizes: inspected.sizes, outside: inspected.outside, images: inspected.images });
    }
    writeFileSync(resolve(directory, 'renderer-v5-reports-proof.json'), JSON.stringify({ scope: 'Actual V5 promotion, payment, historical zero-tax credit and 26 manual journals in a fictitious memory book, then actual export builder and PDF/CSV renderers. No hosted Auth, persistence, bank movement or production evidence.', evidence }, null, 2));
  }, 60_000);
  it.each(['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger', 'receivables'] as const)('renders and independently parses the %s report', async kind => {
    const bytes = await pdf(report(kind, 'de'), fonts), document = await PDFDocument.load(bytes), inspected = inspect(bytes);
    expect(document.getPageCount()).toBe(inspected.pages); expect(inspected.text).toContain(copy.de[kind]); expect(inspected.text).toContain(copy.de.reportNotice); expect(inspected.outside).toEqual([]);
    if (kind === 'receivables') expect(inspected.text).toContain(copy.de.currentNotice);
  });
  it('wraps the full 96-digit monetary domain without rounding, truncation or crop', async () => {
    const base = invoice(), huge = '9'.repeat(96), snapshot = { ...base, sections: [section('invoice_lines', [['Fictitious huge amount', '1', huge, huge, '0', huge]], [huge, '0', huge, '0', huge, '0', '0', huge]), section('payments', [], ['0']), section('credits', [], ['0'])] };
    const inspected = inspect(await pdf(snapshot, fonts)), formatted = '$' + '9'.repeat(94).replace(/\B(?=(\d{3})+(?!\d))/gu, ',') + '.99';
    expect(inspected.text.replace(/\s/gu, '')).toContain(formatted); expect(inspected.outside).toEqual([]); expect(csv(snapshot)).toContain('"' + '9'.repeat(94) + '.99"');
  }, 15_000);
  it('owns the snapshot and font buffers synchronously before its first await', async () => {
    const input: { notes: string } & Snapshot = { ...invoice(), notes: 'ORIGINAL-OWNED-NOTE' }, ownedFonts = { regular: new Uint8Array(fonts.regular), bold: new Uint8Array(fonts.bold) };
    const rendering = pdf(input, ownedFonts); input.notes = 'MUTATED-PRIVATE-NOTE'; ownedFonts.regular.fill(0); ownedFonts.bold.fill(0);
    const inspected = inspect(await rendering); expect(inspected.text).toContain('ORIGINAL-OWNED-NOTE'); expect(inspected.text).not.toContain('MUTATED-PRIVATE-NOTE');
  });
  it('rejects an unsupported glyph explicitly rather than substituting or dropping it', async () => {
    await expect(pdf({ ...invoice(), notes: 'Unsupported glyph 🧪' }, fonts)).rejects.toMatchObject({ code: 'unsupported_financial_pilot_export_glyph', status: 422 });
  });
  it('rejects invalid fonts and accessors without executing caller code', async () => {
    await expect(pdf(invoice(), { regular: new Uint8Array(1024), bold: fonts.bold })).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_font', status: 503 });
    let calls = 0; const injected = { ...fonts }; Object.defineProperty(injected, 'regular', { enumerable: true, get() { calls++; return fonts.regular; } });
    await expect(pdf(invoice(), injected)).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_font', status: 503 }); expect(calls).toBe(0);
    await expect(pdf({ secretProof: 'SECRET' }, injected)).rejects.toMatchObject({ code: 'invalid_financial_pilot_export_snapshot', status: 503 }); expect(calls).toBe(0);
  });
  it('refuses more than 1000 rows or 500000 aggregate characters explicitly', async () => {
    const base = report('trial_balance'), rows = Array.from({ length: 1001 }, () => ['1', 'Fictitious', 'asset', '0', '0']);
    const tooMany = { ...base, sections: [section('trial_balance', rows, ['0', '0'])] };
    expect(() => csv(tooMany)).toThrow('financial_pilot_export_too_large'); await expect(pdf(tooMany, fonts)).rejects.toMatchObject({ code: 'financial_pilot_export_too_large', status: 413 });
    expect(() => csv({ ...base, sections: [section('trial_balance', Array.from({ length: 1000 }, () => ['1', 'W'.repeat(600), 'asset', '0', '0']), ['0', '0'])] })).toThrow('financial_pilot_export_too_large');
  });
  it('refuses the 201st PDF page explicitly instead of silently truncating a valid bounded snapshot', async () => {
    const base = report('trial_balance'), snapshot = { ...base, sections: [section('trial_balance', Array.from({ length: 1000 }, () => ['1', 'W'.repeat(400), 'asset', '0', '0']), ['0', '0'])] };
    expect(validateUsFinancialPilotExportSnapshot(snapshot).sections[0].rows).toHaveLength(1000);
    await expect(pdf(snapshot, fonts)).rejects.toMatchObject({ code: 'financial_pilot_export_too_large', status: 413 });
  }, 30_000);
});
