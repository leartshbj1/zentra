import { validateUsExportSnapshot, ExportError, MAX_EXPORT_PDF_PAGES, type ExportSnapshot } from './export-snapshot';
import { exportCopy } from './export-copy';
import { formatMoney, money } from './money';
import { escapeDocumentHtml, type PrintedParty } from './documents';
import { formatAddress } from './addresses';
import type { PDFFont, PDFPage } from 'pdf-lib';

const title = (snapshot: ExportSnapshot) => exportCopy[snapshot.language][snapshot.selector.kind === 'document' ? snapshot.selector.documentType : snapshot.selector.reportType];
const notice = (snapshot: ExportSnapshot) => snapshot.selector.kind === 'report' ? exportCopy[snapshot.language].reportNotice : snapshot.selector.documentType === 'vendor_bill' ? exportCopy[snapshot.language].internalBillNotice : snapshot.selector.documentType === 'estimate' ? exportCopy[snapshot.language].taxPending : '';
const amount = (snapshot: ExportSnapshot, value: string) => formatMoney(money('USD', value), `${snapshot.language}-US`);
const companyLabel = (snapshot: ExportSnapshot): string => exportCopy[snapshot.language][snapshot.selector.kind === 'report' || snapshot.selector.documentType === 'vendor_bill' ? 'company' : 'seller'];
const address = (party: PrintedParty): string[] => [party.name, ...formatAddress(party.address), ...(party.contactEmail ? [party.contactEmail] : []), ...(party.contactPhone ? [party.contactPhone] : [])];
const cell = (snapshot: ExportSnapshot, value: string, index: number): string => {
  const column = snapshot.columns[index], c = exportCopy[snapshot.language];
  if (column.kind === 'money') return amount(snapshot, value);
  if (column.label === 'accountType') return value === 'asset' ? c.assets : value === 'liability' ? c.liabilities : c[value as 'income' | 'expense' | 'equity'];
  return value;
};
const trace = (snapshot: ExportSnapshot) => { const c = exportCopy[snapshot.language]; return `${c.erpRevision}: ${snapshot.erpRevision} | ${c.ledgerRevision}: ${snapshot.ledgerRevision}${snapshot.recordRevision === null ? '' : ` | ${c.recordRevision}: ${snapshot.recordRevision}`}`; };
const esc = escapeDocumentHtml;

/** Standalone text-only HTML. No scripts, URLs, remote fonts or provider payload. */
export function renderUsExportHtml(input: unknown): string {
  const s = validateUsExportSnapshot(input), c = exportCopy[s.language];
  const party = (name: string, value: PrintedParty) => `<section><h2>${esc(name)}</h2>${address(value).map(line => `<p>${esc(line)}</p>`).join('')}</section>`;
  return `<!doctype html><html lang="${s.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title(s))}${s.number ? ` - ${esc(s.number)}` : ''}</title><style>@page{size:Letter;margin:.6in}*{box-sizing:border-box}body{margin:0 auto;padding:32px;max-width:1000px;color:#17251e;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:26px;margin:0 0 8px}h2{font-size:14px;margin:0 0 8px}p{margin:0 0 4px}.parties{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px;margin:24px 0}.notice{padding:12px;border:1px solid #becfc4;margin:16px 0}dl{display:flex;gap:12px 24px;flex-wrap:wrap;margin:20px 0}dt{font-size:12px;color:#475c50}dd{margin:0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:9px 6px;border-bottom:1px solid #d8e1dc;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3ef;text-align:left}thead{display:table-header-group}.right{text-align:right;font-variant-numeric:tabular-nums}.totals{margin-top:20px}.notes{white-space:pre-wrap;margin:20px 0}footer{border-top:1px solid #d8e1dc;margin-top:24px;padding-top:12px;font-size:11px;color:#475c50}@media(max-width:520px){body{padding:16px}.parties{grid-template-columns:1fr;gap:20px}th,td{font-size:12px;padding:7px 3px}}@media print{body{padding:0}h1,h2{break-after:avoid}.parties{break-inside:avoid}}</style></head><body><h1>${esc(title(s))}</h1>${s.number ? `<p><strong>${esc(s.number)}</strong></p>` : ''}${notice(s) ? `<p class="notice">${esc(notice(s))}</p>` : ''}<div class="parties">${party(companyLabel(s), s.seller)}${s.recipient ? party(s.selector.kind === 'document' && s.selector.documentType === 'vendor_bill' ? c.vendor : c.customer, s.recipient) : ''}</div><dl>${s.facts.map(f => `<div><dt>${esc(c[f.label])}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl><table><thead><tr>${s.columns.map(col => `<th class="${col.align}">${esc(c[col.label])}</th>`).join('')}</tr></thead><tbody>${s.rows.map(row => `<tr>${row.map((value, index) => `<td class="${s.columns[index].align}">${esc(cell(s, value, index))}</td>`).join('')}</tr>`).join('')}</tbody></table><dl class="totals">${s.totals.map(t => `<div><dt>${esc(c[t.label])}</dt><dd>${esc(amount(s, t.minorUnits))}</dd></div>`).join('')}</dl>${s.notes ? `<section class="notes"><h2>${esc(c.notes)}</h2>${esc(s.notes)}</section>` : ''}<footer>${esc(trace(s))}</footer></body></html>`;
}
function decimal(minor: string): string { const n = BigInt(minor), absolute = n < BigInt(0) ? -n : n; return `${n < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${(absolute % BigInt(100)).toString().padStart(2, '0')}`; }
/** Text cells are protected against spreadsheet formula execution. Money is an
 * exact, ungrouped USD decimal; no Number conversion or locale parser is used. */
export function renderUsExportCsv(input: unknown): string {
  const s = validateUsExportSnapshot(input), c = exportCopy[s.language];
  const textCell = (value: string) => /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;
  const quoted = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows: string[][] = [[title(s), s.number ?? ''], [c.erpRevision, String(s.erpRevision)], [c.ledgerRevision, String(s.ledgerRevision)], ...(s.recordRevision === null ? [] : [[c.recordRevision, String(s.recordRevision)]]), ...address(s.seller).map(line => [companyLabel(s), textCell(line)]), ...(s.recipient ? address(s.recipient).map(line => [s.selector.kind === 'document' && s.selector.documentType === 'vendor_bill' ? c.vendor : c.customer, textCell(line)]) : []), ...(notice(s) ? [[textCell(notice(s))]] : []), ...s.facts.map(f => [c[f.label], textCell(f.value)]), [], s.columns.map(col => `${c[col.label]}${col.kind === 'money' ? ' (USD)' : ''}`), ...s.rows.map(row => row.map((value, index) => s.columns[index].kind === 'money' ? decimal(value) : textCell(cell(s, value, index)))), [], ...s.totals.map(t => [c[t.label], decimal(t.minorUnits)]), ...(s.notes ? [[c.notes, textCell(s.notes)]] : [])];
  // The title's document number is also submitted text, unlike numeric traces.
  rows[0][1] = textCell(rows[0][1]);
  return '\uFEFF' + rows.map(row => row.map(quoted).join(',')).join('\r\n') + '\r\n';
}
export interface UsExportFonts { readonly regular: Uint8Array; readonly bold: Uint8Array }
function fontBytes(input: unknown): UsExportFonts {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) throw new ExportError('invalid_export_font');
  const copy = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !(descriptor.value instanceof Uint8Array) || !ArrayBuffer.isView(descriptor.value) || Object.getPrototypeOf(descriptor.value) !== Uint8Array.prototype) throw new ExportError('invalid_export_font');
    const bytes = new Uint8Array(descriptor.value);
    if (bytes.byteLength < 1024 || bytes.byteLength > 6 * 1024 * 1024) throw new ExportError('invalid_export_font');
    return bytes;
  };
  return { regular: copy('regular'), bold: copy('bold') };
}
/** Actual text/vector PDF, US Letter. Capture all caller-owned data before await.
 * Libraries load only for PDF, so JSON/HTML/CSV do not load fontkit/pdf-lib. */
export async function renderUsExportPdf(input: unknown, fontInput: UsExportFonts): Promise<Uint8Array> {
  const s = validateUsExportSnapshot(input), bytes = fontBytes(fontInput), c = exportCopy[s.language];
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let regular: PDFFont, bold: PDFFont;
  try { pdf.registerFontkit(fontkitModule.default); regular = await pdf.embedFont(bytes.regular, { subset: true }); bold = await pdf.embedFont(bytes.bold, { subset: true }); } catch { throw new ExportError('invalid_export_font'); }
  const regularGlyphs = new Set(regular.getCharacterSet()), boldGlyphs = new Set(bold.getCharacterSet());
  const displayRows = s.rows.map(row => row.map((value, index) => cell(s, value, index)));
  const allText = [title(s), s.number ?? '', notice(s), ...address(s.seller), ...(s.recipient ? address(s.recipient) : []), ...s.facts.flatMap(f => [c[f.label], f.value]), ...s.columns.map(col => c[col.label]), ...displayRows.flat(), ...s.totals.flatMap(t => [c[t.label], amount(s, t.minorUnits)]), s.notes, trace(s), companyLabel(s), c.customer, c.vendor, c.notes, c.page, c.of];
  for (const value of allText) for (const character of value) { if ('\r\n\t'.includes(character)) continue; const point = character.codePointAt(0)!; if (!regularGlyphs.has(point) || !boldGlyphs.has(point)) throw new ExportError('unsupported_export_glyph'); }
  const margin = 42, pageWidth = 612, pageHeight = 792, contentWidth = pageWidth - 2 * margin, bottom = 62;
  const ink = rgb(.09, .15, .11), muted = rgb(.28, .36, .31), lineColor = rgb(.82, .87, .84), tint = rgb(.93, .96, .94);
  let page!: PDFPage, y = 750;
  function newPage() { if (pdf.getPageCount() >= MAX_EXPORT_PDF_PAGES) throw new ExportError('export_too_large'); page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  newPage();
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
          if (font.widthOfTextAtSize(character, size) > width) throw new ExportError('export_too_large');
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
    for (const value of wrap(raw, font, size, contentWidth)) { if (y - leading < bottom) newPage(); page.drawText(value, { x: margin, y: y - size, size, font, color: options.color ?? ink }); y -= leading; }
  }
  draw(title(s), { size: 20, strong: true }); if (s.number) draw(s.number, { size: 12, strong: true }); y -= 10;
  if (notice(s)) { draw(notice(s), { size: 9, color: muted }); y -= 12; }
  draw(companyLabel(s), { size: 9, strong: true }); for (const value of address(s.seller)) draw(value, { size: 10 }); y -= 12;
  if (s.recipient) { draw(s.selector.kind === 'document' && s.selector.documentType === 'vendor_bill' ? c.vendor : c.customer, { size: 9, strong: true }); for (const value of address(s.recipient)) draw(value, { size: 10 }); y -= 12; }
  for (const fact of s.facts) draw(`${c[fact.label]}: ${fact.value}`, { size: 9 }); y -= 18;
  const textColumns = s.columns.filter(col => col.kind === 'text').length;
  const weights = s.columns.map((col, index) => s.columns.length <= 4 && index === 0 ? 3 : col.kind === 'text' && textColumns < 3 ? 1.6 : 1);
  const weightTotal = weights.reduce((a, b) => a + b, 0), widths = weights.map(weight => contentWidth * weight / weightTotal), size = s.columns.length > 5 ? 8 : 9, leading = size * 1.5;
  const headers = s.columns.map((col, index) => wrap(c[col.label], bold, size, widths[index] - 12)), headerHeight = Math.max(...headers.map(h => h.length)) * leading + 12;
  function tableHeader() {
    if (y - headerHeight - leading - 12 < bottom) { newPage(); draw(title(s), { size: 12, strong: true }); y -= 12; }
    page.drawRectangle({ x: margin, y: y - headerHeight, width: contentWidth, height: headerHeight, color: tint });
    let x = margin; headers.forEach((values, index) => { values.forEach((value, row) => page.drawText(value, { x: x + 6, y: y - 6 - size - row * leading, font: bold, size, color: ink })); x += widths[index]; }); y -= headerHeight;
  }
  tableHeader();
  for (const row of displayRows) {
    const cells = row.map((value, index) => wrap(value, regular, size, widths[index] - 12)), count = Math.max(...cells.map(cell => cell.length));
    let offset = 0;
    while (offset < count) {
      let available = Math.floor((y - bottom - 12) / leading);
      if (available < 1) { newPage(); draw(title(s), { size: 12, strong: true }); y -= 12; tableHeader(); available = Math.floor((y - bottom - 12) / leading); }
      const chunk = Math.min(available, count - offset); let x = margin;
      cells.forEach((values, index) => { for (let n = 0; n < chunk; n++) { const value = values[offset + n]; if (value === undefined) continue; const width = regular.widthOfTextAtSize(value, size); page.drawText(value, { x: s.columns[index].align === 'right' ? x + widths[index] - 6 - width : x + 6, y: y - 6 - size - n * leading, font: regular, size, color: ink }); } x += widths[index]; });
      y -= chunk * leading + 12; page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: .5, color: lineColor }); offset += chunk;
    }
  }
  y -= 18; for (const total of s.totals) draw(`${c[total.label]}: ${amount(s, total.minorUnits)}`, { size: 10, strong: true });
  if (s.notes) { y -= 18; draw(c.notes, { size: 10, strong: true }); draw(s.notes, { size: 10 }); }
  pdf.getPages().forEach((sheet, index) => {
    sheet.drawLine({ start: { x: margin, y: 49 }, end: { x: pageWidth - margin, y: 49 }, thickness: .5, color: lineColor });
    const footer = `${trace(s)} | ${c.page} ${index + 1} ${c.of} ${pdf.getPageCount()}`;
    const lines = wrap(footer, regular, 7, contentWidth); if (lines.length > 3) throw new ExportError('export_too_large');
    lines.forEach((value, row) => sheet.drawText(value, { x: margin, y: 36 - row * 9, font: regular, size: 7, color: muted }));
  });
  return pdf.save({ useObjectStreams: false });
}
