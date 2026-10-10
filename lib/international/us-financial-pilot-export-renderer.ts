import type { PDFFont, PDFPage } from 'pdf-lib';
import { formatAddress } from './addresses';
import { formatDateOnly } from './localization';
import { formatMoney, money } from './money';
import { financialPilotCsvDecimal as decimal, financialPilotCsvTextCell as textCell, financialPilotCsvQuoted as quoted } from './us-financial-pilot-csv';
import { usFinancialPilotExportCopy } from './us-financial-pilot-export-copy';
import {
  validateUsFinancialPilotExportSnapshot, UsFinancialPilotExportError,
  US_FINANCIAL_PILOT_EXPORT_MAX_PDF_PAGES, US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES,
  type UsFinancialPilotExportSnapshot,
} from './us-financial-pilot-export-contract';

export interface UsFinancialPilotExportFonts { readonly regular: Uint8Array; readonly bold: Uint8Array }
type Snapshot = UsFinancialPilotExportSnapshot;
type Section = Snapshot['sections'][number];

const tooLarge = (): never => { throw new UsFinancialPilotExportError('financial_pilot_export_too_large', 413); };
const usd = (minor: string) => formatMoney(money('USD', minor), 'en-US');
const date = (value: string) => value === '' ? '' : formatDateOnly(value, 'en-US');
const title = (s: Snapshot) => usFinancialPilotExportCopy[s.language][s.selector.kind === 'invoice' ? 'invoice' : s.selector.reportType];
const trace = (s: Snapshot) => { const c = usFinancialPilotExportCopy[s.language]; return `${c.organization}: ${s.organizationId} | ${c.financialRevision}: ${s.revision} | ${c.ledgerRevision}: ${s.ledgerRevision}`; };
const partyLines = (s: Snapshot, party: Snapshot['issuer']) => {
  const lines = formatAddress(party.address);
  return [...(party.name === null ? [s.organizationId] : [party.name]), ...lines.slice(0, -1), new Intl.DisplayNames([s.language], { type: 'region' }).of(party.address.country)!, ...(party.email ? [party.email] : []), ...(party.phone ? [party.phone] : [])];
};
const columnLabel = (s: Snapshot, section: Section, column: Section['columns'][number]) => usFinancialPilotExportCopy[s.language][section.kind === 'credits' && column.label === 'total' ? 'credited' : column.label];
function displayCell(s: Snapshot, column: Section['columns'][number], value: string): string {
  const c = usFinancialPilotExportCopy[s.language];
  if (column.kind === 'money') return usd(value);
  if (column.kind === 'date') return date(value);
  if (column.label === 'accountType') return value === 'asset' ? c.assets : value === 'liability' ? c.liabilities : value === 'equity' ? c.equity : value === 'income' ? c.income : c.expense;
  if (column.label === 'taxDisposition') return value === 'adjustment_pending' ? c.taxAdjustmentPending : c.historicalZeroTax;
  if (column.label === 'status' && (value === 'open' || value === 'partially_settled' || value === 'paid' || value === 'credited' || value === 'settled_with_credit')) return c[value];
  return value;
}
const factValue = (s: Snapshot, fact: Snapshot['facts'][number]) => fact.kind === 'date' ? date(fact.value) : fact.label === 'accountingBasis' && fact.value === 'accrual' ? usFinancialPilotExportCopy[s.language].accrual : fact.value;

/** Complete, quoted UTF-8 CSV with BOM and CRLF records; never an ERP1-4 snapshot. */
export function renderUsFinancialPilotExportCsv(input: unknown): string {
  const s = validateUsFinancialPilotExportSnapshot(input), c = usFinancialPilotExportCopy[s.language];
  const textRow = (...values: string[]) => values.map(textCell);
  const rows: string[][] = [textRow(title(s), s.number ?? ''), textRow(c.testNotice), textRow(s.number === null ? c.reportNotice : c.invoiceNotice), textRow(c.organization, s.organizationId), [c.financialRevision, String(s.revision)], [c.ledgerRevision, String(s.ledgerRevision)], ...partyLines(s, s.issuer).map(line => textRow(s.number === null ? c.organization : c.seller, line)), ...(s.recipient ? partyLines(s, s.recipient).map(line => textRow(c.customer, line)) : []), ...s.facts.map(fact => textRow(c[fact.label], factValue(s, fact)))];
  for (const section of s.sections) {
    rows.push([], textRow(c[section.kind]));
    if (section.kind === 'receivables') rows.push(textRow(c.currentNotice));
    rows.push(textRow(...section.columns.map(column => columnLabel(s, section, column) + (column.kind === 'money' ? ' (USD)' : ''))));
    rows.push(...section.rows.map(row => row.map((value, index) => section.columns[index].kind === 'money' ? decimal(value) : textCell(displayCell(s, section.columns[index], value)))));
    rows.push(...section.totals.map(total => [c[total.label], decimal(total.minorUnits)]));
  }
  if (s.notes) rows.push([], textRow(c.notes, s.notes));
  const result = '\uFEFF' + rows.map(row => row.map(quoted).join(',')).join('\r\n') + '\r\n';
  if (new TextEncoder().encode(result).byteLength > US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES) tooLarge();
  return result;
}

function fontBytes(input: unknown): UsFinancialPilotExportFonts {
  const invalid = (): never => { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_font', 503); };
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) return invalid();
  function copy(key: 'regular' | 'bold'): Uint8Array {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !(descriptor.value instanceof Uint8Array) || Object.getPrototypeOf(descriptor.value) !== Uint8Array.prototype) return invalid();
    const bytes = new Uint8Array(descriptor.value);
    if (bytes.byteLength < 1024 || bytes.byteLength > 6 * 1024 * 1024) return invalid();
    return bytes;
  }
  return { regular: copy('regular'), bold: copy('bold') };
}

/** Real vector/text Letter PDF. The owned, validated snapshot and copied fonts
 * are captured before the first await. No filesystem, network, raster or remote font. */
export async function renderUsFinancialPilotExportPdf(input: unknown, fontInput: UsFinancialPilotExportFonts): Promise<Uint8Array> {
  const s = validateUsFinancialPilotExportSnapshot(input), bytes = fontBytes(fontInput), c = usFinancialPilotExportCopy[s.language];
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let regular: PDFFont, bold: PDFFont;
  try {
    pdf.registerFontkit(fontkitModule.default);
    regular = await pdf.embedFont(bytes.regular, { subset: true });
    bold = await pdf.embedFont(bytes.bold, { subset: true });
  } catch { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_font', 503); }
  const regularGlyphs = new Set(regular.getCharacterSet()), boldGlyphs = new Set(bold.getCharacterSet());
  const allText = [title(s), s.number ?? '', c.testNotice, c.invoiceNotice, c.reportNotice, c.currentNotice, c.seller, c.customer, c.organization, c.notes, c.totals, c.continuation, c.page, c.of, trace(s), ...partyLines(s, s.issuer), ...(s.recipient ? partyLines(s, s.recipient) : []), ...s.facts.flatMap(fact => [c[fact.label], factValue(s, fact)]), s.notes, ...s.sections.flatMap(section => [c[section.kind], ...section.columns.map(column => columnLabel(s, section, column)), ...section.rows.flatMap(row => row.map((value, index) => displayCell(s, section.columns[index], value))), ...section.totals.flatMap(total => [c[total.label], usd(total.minorUnits)])])];
  for (const value of allText) for (const character of value) {
    if ('\r\n\t'.includes(character)) continue;
    const point = character.codePointAt(0)!;
    if (!regularGlyphs.has(point) || !boldGlyphs.has(point)) throw new UsFinancialPilotExportError('unsupported_financial_pilot_export_glyph', 422);
  }
  const margin = 42, pageWidth = 612, pageHeight = 792, contentWidth = pageWidth - 2 * margin, bottom = 66;
  const ink = rgb(.09, .15, .11), muted = rgb(.28, .36, .31), lineColor = rgb(.82, .87, .84), tint = rgb(.93, .96, .94);
  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]), y = pageHeight - margin;
  function newPage() {
    if (pdf.getPageCount() >= US_FINANCIAL_PILOT_EXPORT_MAX_PDF_PAGES) tooLarge();
    page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin;
  }
  function wrap(raw: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const token of paragraph.split(/(\s+)/u)) {
        if (!token) continue;
        if (font.widthOfTextAtSize(current + token, size) <= width) { current += token; continue; }
        if (current) { lines.push(current.trimEnd()); current = ''; }
        for (const character of token.trimStart()) {
          if (font.widthOfTextAtSize(character, size) > width) tooLarge();
          if (current && font.widthOfTextAtSize(current + character, size) > width) { lines.push(current); current = ''; }
          current += character;
        }
      }
      if (current) lines.push(current.trimEnd());
    }
    return lines.length ? lines : [''];
  }
  function draw(raw: string, options: { size?: number; strong?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    const size = options.size ?? 10, font = options.strong ? bold : regular, leading = size * 1.45;
    for (const value of wrap(raw, font, size, contentWidth)) {
      if (y - leading < bottom) newPage();
      page.drawText(value, { x: margin, y: y - size, size, font, color: options.color ?? ink }); y -= leading;
    }
  }
  function drawTotals(section: Section) {
    const values = section.totals.map(total => `${c[total.label]}: ${usd(total.minorUnits)}`);
    const height = values.reduce((sum, value) => sum + wrap(value, bold, 10, contentWidth).length * 14.5, 0);
    // Keep small, comparable total blocks together rather than orphaning one
    // amount on a fresh page. Long validated amounts still wrap in full.
    if (y - height < bottom && height + 26 < pageHeight - margin - bottom) {
      newPage(); draw(`${c[section.kind]} - ${c.totals}`, { size: 11, strong: true }); y -= 8;
    }
    for (const value of values) draw(value, { size: 10, strong: true });
  }
  draw(title(s), { size: 21, strong: true });
  if (s.number) draw(s.number, { size: 12, strong: true });
  y -= 10; draw(c.testNotice, { size: 9, strong: true });
  draw(s.number === null ? c.reportNotice : c.invoiceNotice, { size: 9, color: muted }); y -= 14;
  const parties = [[s.number === null ? c.organization : c.seller, s.issuer], ...(s.recipient ? [[c.customer, s.recipient] as const] : [])] as const;
  for (const [label, party] of parties) {
    draw(label, { size: 9, strong: true });
    for (const value of partyLines(s, party)) draw(value, { size: 10 });
    y -= 12;
  }
  for (const fact of s.facts) draw(`${c[fact.label]}: ${factValue(s, fact)}`, { size: 9 });
  y -= 6;
  for (const section of s.sections) {
    // Keep a section heading with its table header and first content line.
    if (y - 90 < bottom) newPage();
    y -= 14; draw(c[section.kind], { size: 12, strong: true }); y -= 8;
    if (section.kind === 'receivables') { draw(c.currentNotice, { size: 9, color: muted }); y -= 8; }
    if (section.columns.length === 0) { drawTotals(section); continue; }
    const size = section.columns.length > 5 ? 8 : 9, leading = size * 1.5;
    const weights = section.columns.map((column, index) => column.kind === 'text' ? index === 0 ? 2.3 : 1.6 : column.kind === 'date' ? 1.25 : 1.2);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0), initialWidths = weights.map(weight => contentWidth * weight / totalWeight);
    const minimumDateWidth = regular.widthOfTextAtSize('12/31/2026', size) + 12;
    const extra = initialWidths.reduce((sum, width, index) => sum + (section.columns[index].kind === 'date' ? Math.max(0, minimumDateWidth - width) : 0), 0);
    const flexible = initialWidths.map((width, index) => section.columns[index].kind === 'text' ? Math.max(0, width - 30) : 0), flexibility = flexible.reduce((sum, width) => sum + width, 0);
    if (extra > flexibility) tooLarge();
    const widths = initialWidths.map((width, index) => section.columns[index].kind === 'date' ? Math.max(width, minimumDateWidth) : section.columns[index].kind === 'text' && extra ? width - extra * flexible[index] / flexibility : width);
    const headers = section.columns.map((column, index) => wrap(columnLabel(s, section, column), bold, size, widths[index] - 12));
    const headerHeight = Math.max(...headers.map(values => values.length)) * leading + 12;
    function header() {
      if (y - headerHeight - leading - 12 < bottom) newPage();
      page.drawRectangle({ x: margin, y: y - headerHeight, width: contentWidth, height: headerHeight, color: tint });
      let x = margin;
      headers.forEach((values, index) => {
        values.forEach((value, row) => page.drawText(value, { x: section.columns[index].align === 'right' ? x + widths[index] - 6 - bold.widthOfTextAtSize(value, size) : x + 6, y: y - 6 - size - row * leading, font: bold, size, color: ink }));
        x += widths[index];
      });
      y -= headerHeight;
    }
    function continuation(continued: boolean) {
      newPage(); draw(`${c[section.kind]}${continued ? ` - ${c.continuation}` : ''}`, { size: 11, strong: true }); y -= 8; header();
    }
    header();
    for (const row of section.rows) {
      const cells = row.map((value, index) => wrap(displayCell(s, section.columns[index], value), regular, size, widths[index] - 12));
      const count = Math.max(1, ...cells.map(values => values.length));
      let offset = 0;
      if (y - Math.min(count, 2) * leading - 12 < bottom) continuation(false);
      while (offset < count) {
        let available = Math.floor((y - bottom - 12) / leading);
        if (available < 1) { continuation(offset > 0); available = Math.floor((y - bottom - 12) / leading); }
        if (available < 1) tooLarge();
        const chunk = Math.min(available, count - offset);
        let x = margin;
        cells.forEach((values, index) => {
          for (let n = 0; n < chunk; n++) {
            const value = values[offset + n]; if (value === undefined) continue;
            page.drawText(value, { x: section.columns[index].align === 'right' ? x + widths[index] - 6 - regular.widthOfTextAtSize(value, size) : x + 6, y: y - 6 - size - n * leading, font: regular, size, color: ink });
          }
          x += widths[index];
        });
        y -= chunk * leading + 12;
        page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: .5, color: lineColor });
        offset += chunk;
      }
    }
    y -= 12;
    drawTotals(section);
  }
  if (s.notes) { if (y - 60 < bottom) newPage(); y -= 18; draw(c.notes, { size: 10, strong: true }); draw(s.notes, { size: 10 }); }
  pdf.getPages().forEach((sheet, index) => {
    sheet.drawLine({ start: { x: margin, y: 50 }, end: { x: pageWidth - margin, y: 50 }, thickness: .5, color: lineColor });
    const footer = `${trace(s)} | TEST | ${c.page} ${index + 1} ${c.of} ${pdf.getPageCount()}`;
    const lines = wrap(footer, regular, 7, contentWidth);
    if (lines.length > 3) tooLarge();
    lines.forEach((value, row) => sheet.drawText(value, { x: margin, y: 37 - row * 9, font: regular, size: 7, color: muted }));
  });
  let output: Uint8Array;
  try { output = await pdf.save({ useObjectStreams: false }); }
  catch { throw new UsFinancialPilotExportError('invalid_financial_pilot_export_font', 503); }
  if (output.byteLength > US_FINANCIAL_PILOT_EXPORT_MAX_OUTPUT_BYTES) tooLarge();
  return new Uint8Array(output);
}
