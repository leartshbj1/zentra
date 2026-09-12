/** Structured text only: never store HTML, executable markup or document totals here. */
export type RichRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };
export type RichParagraph = { runs: RichRun[]; align?: 'left' | 'center' | 'right'; bullet?: boolean };
export type RichText = RichParagraph[];
export type DocumentComposition = {
  version: 1;
  fontFamily: 'helvetica' | 'times' | 'courier';
  bodySize: number;
  titleSize: number;
  titleBold: boolean;
  titleItalic: boolean;
  titleAlign: 'left' | 'center' | 'right';
  marginMm: number;
  lineSpacing: number;
  logoPosition: 'left' | 'center' | 'right' | 'hidden';
  logoHeight: number;
  tableStyle: 'band' | 'striped' | 'lines';
  tablePadding: number;
  totalsPosition: 'beforeNotes' | 'afterNotes';
  intro: RichText;
  closing: RichText;
  footerText: RichText;
};
export type DocumentCompositions = Partial<Record<'invoices' | 'quotes' | 'accounts' | 'payslips', DocumentComposition>>;
export const defaultDocumentComposition: DocumentComposition = {
  version: 1, fontFamily: 'helvetica', bodySize: 9, titleSize: 24, titleBold: true, titleItalic: false,
  titleAlign: 'left', marginMm: 15, lineSpacing: 1.35, logoPosition: 'left', logoHeight: 36,
  tableStyle: 'band', tablePadding: 6, totalsPosition: 'beforeNotes', intro: [], closing: [], footerText: [],
};
const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T => choices.includes(value as T) ? value as T : fallback;
const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function normalizeRichText(value: unknown): RichText {
  if (!Array.isArray(value)) return [];
  return value.filter(p => p && typeof p === 'object' && Array.isArray(p.runs)).slice(0, 60).map(p => ({
    align: choice(p.align, ['left', 'center', 'right'] as const, 'left'), bullet: p.bullet === true,
    runs: p.runs.filter((r: RichRun) => r && typeof r.text === 'string').slice(0, 500).map((r: RichRun) => ({ text: r.text.replace(/\r\n?/g, '\n'), bold: r.bold === true, italic: r.italic === true, underline: r.underline === true })),
  }));
}
export function normalizeComposition(value?: Partial<DocumentComposition>): DocumentComposition {
  const d = defaultDocumentComposition;
  return { version: 1, fontFamily: choice(value?.fontFamily, ['helvetica', 'times', 'courier'], d.fontFamily),
    bodySize: bounded(value?.bodySize, 8, 12, d.bodySize), titleSize: bounded(value?.titleSize, 18, 34, d.titleSize),
    titleBold: value?.titleBold !== false, titleItalic: value?.titleItalic === true,
    titleAlign: choice(value?.titleAlign, ['left', 'center', 'right'], 'left'),
    marginMm: bounded(value?.marginMm, 12, 25, d.marginMm), lineSpacing: bounded(value?.lineSpacing, 1.15, 1.8, d.lineSpacing),
    logoPosition: choice(value?.logoPosition, ['left', 'center', 'right', 'hidden'], 'left'), logoHeight: bounded(value?.logoHeight, 24, 72, d.logoHeight),
    tableStyle: choice(value?.tableStyle, ['band', 'striped', 'lines'], 'band'), tablePadding: bounded(value?.tablePadding, 4, 10, d.tablePadding),
    totalsPosition: choice(value?.totalsPosition, ['beforeNotes', 'afterNotes'], 'beforeNotes'),
    intro: normalizeRichText(value?.intro), closing: normalizeRichText(value?.closing), footerText: normalizeRichText(value?.footerText),
  };
}
export function documentCompositions(value?: DocumentCompositions): DocumentCompositions {
  return Object.fromEntries((['invoices', 'quotes', 'accounts', 'payslips'] as const).filter(k => value?.[k]).map(k => [k, normalizeComposition(value![k])]));
}
export const richPlainText = (value: RichText) => value.map(p => p.runs.map(r => r.text).join('')).join('\n');
export const documentFontCss = { helvetica: 'Arial, Helvetica, sans-serif', times: '"Times New Roman", Times, serif', courier: '"Courier New", Courier, monospace' };
