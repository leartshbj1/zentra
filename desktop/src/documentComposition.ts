/** Structured text only: never store HTML, executable markup or document totals here. */
export const documentFontIds = ['helvetica', 'times', 'courier', 'inter', 'literata'] as const;
export type DocumentFont = typeof documentFontIds[number];
export const documentFontChoices: { value: DocumentFont; name: string; description: string }[] = [
  { value: 'helvetica', name: 'Helvetica', description: 'sobre et classique' },
  { value: 'times', name: 'Times', description: 'traditionnelle' },
  { value: 'courier', name: 'Courier', description: 'style dactylographié' },
  { value: 'inter', name: 'Inter', description: 'nette et contemporaine' },
  { value: 'literata', name: 'Literata', description: 'élégante, style éditorial' },
];
export type RichRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; highlight?: string; fontFamily?: DocumentFont; fontSize?: number };
export type RichParagraph = { runs: RichRun[]; align?: 'left' | 'center' | 'right'; bullet?: boolean; numbered?: boolean; indent?: number; spaceAfter?: number };
export type RichText = RichParagraph[];
export type DocumentComposition = {
  version: 1;
  fontFamily: DocumentFont;
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
  companyAlign?: 'left' | 'center' | 'right';
  recipientAlign?: 'left' | 'center' | 'right';
  topMarginMm?: number;
  logoGap?: number;
  blockSpacing?: number;
  textColor?: string;
  titleColor?: string;
  titleFontFamily?: DocumentFont;
  pageOrientation?: 'portrait' | 'landscape';
  tableHeaderColor?: string;
  tableHeaderTextColor?: string;
  tableStripeColor?: string;
  tableLineColor?: string;
  closingOnNewPage?: boolean;
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
export const richColor = (value: unknown): string | undefined => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
export const richFont = (value: unknown): DocumentFont | undefined => documentFontIds.includes(value as DocumentFont) ? value as DocumentFont : undefined;
export const richFontSize = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 8 && value <= 24 ? value : undefined;
export function normalizeRichText(value: unknown): RichText {
  if (!Array.isArray(value)) return [];
  return value.filter(p => p && typeof p === 'object' && Array.isArray(p.runs)).map(p => {
    const runs: RichRun[] = [];
    for (const raw of p.runs) {
      if (!raw || typeof raw.text !== 'string' || !raw.text) continue;
      const color = richColor(raw.color), highlight = richColor(raw.highlight), fontFamily = richFont(raw.fontFamily), fontSize = richFontSize(raw.fontSize);
      const run: RichRun = { text: raw.text.replace(/\r\n?/g, '\n'), bold: raw.bold === true, italic: raw.italic === true, underline: raw.underline === true, ...(color ? { color } : {}), ...(highlight ? { highlight } : {}), ...(fontFamily ? { fontFamily } : {}), ...(fontSize ? { fontSize } : {}) };
      const previous = runs.at(-1);
      if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.underline === run.underline && previous.color === run.color && previous.highlight === run.highlight && previous.fontFamily === run.fontFamily && previous.fontSize === run.fontSize) previous.text += run.text;
      else runs.push(run);
    }
    return { align: choice(p.align, ['left', 'center', 'right'] as const, 'left'), bullet: p.bullet === true && p.numbered !== true,
      ...(p.numbered === true ? { numbered: true } : {}),
      ...(typeof p.indent === 'number' && Number.isFinite(p.indent) && p.indent > 0 ? { indent: Math.min(3, Math.floor(p.indent)) } : {}),
      ...(typeof p.spaceAfter === 'number' && Number.isFinite(p.spaceAfter) && p.spaceAfter > 0 ? { spaceAfter: Math.min(18, p.spaceAfter) } : {}), runs };
  });
}
export function normalizeComposition(value?: Partial<DocumentComposition>): DocumentComposition {
  const d = defaultDocumentComposition;
  return { version: 1, fontFamily: choice(value?.fontFamily, documentFontIds, d.fontFamily),
    bodySize: bounded(value?.bodySize, 8, 12, d.bodySize), titleSize: bounded(value?.titleSize, 18, 34, d.titleSize),
    titleBold: value?.titleBold !== false, titleItalic: value?.titleItalic === true,
    titleAlign: choice(value?.titleAlign, ['left', 'center', 'right'], 'left'),
    marginMm: bounded(value?.marginMm, 12, 25, d.marginMm), lineSpacing: bounded(value?.lineSpacing, 1.15, 1.8, d.lineSpacing),
    logoPosition: choice(value?.logoPosition, ['left', 'center', 'right', 'hidden'], 'left'), logoHeight: bounded(value?.logoHeight, 24, 72, d.logoHeight),
    tableStyle: choice(value?.tableStyle, ['band', 'striped', 'lines'], 'band'), tablePadding: bounded(value?.tablePadding, 4, 10, d.tablePadding),
    totalsPosition: choice(value?.totalsPosition, ['beforeNotes', 'afterNotes'], 'beforeNotes'),
    // Absent controls keep the rendering of existing saved presentations.
    ...(value?.companyAlign ? { companyAlign: choice(value.companyAlign, ['left', 'center', 'right'] as const, 'left') } : {}),
    ...(value?.recipientAlign ? { recipientAlign: choice(value.recipientAlign, ['left', 'center', 'right'] as const, 'left') } : {}),
    ...(value?.topMarginMm != null ? { topMarginMm: bounded(value.topMarginMm, 12, 45, d.marginMm) } : {}),
    ...(value?.logoGap != null ? { logoGap: bounded(value.logoGap, 0, 36, 14) } : {}),
    ...(value?.blockSpacing != null ? { blockSpacing: bounded(value.blockSpacing, .5, 2, 1) } : {}),
    ...(richColor(value?.textColor) ? { textColor: richColor(value?.textColor) } : {}),
    ...(richColor(value?.titleColor) ? { titleColor: richColor(value?.titleColor) } : {}),
    ...(richFont(value?.titleFontFamily) ? { titleFontFamily: richFont(value?.titleFontFamily) } : {}),
    ...(value?.pageOrientation ? { pageOrientation: choice(value.pageOrientation, ['portrait', 'landscape'] as const, 'portrait') } : {}),
    ...Object.fromEntries((['tableHeaderColor', 'tableHeaderTextColor', 'tableStripeColor', 'tableLineColor'] as const).filter(key => richColor(value?.[key])).map(key => [key, richColor(value?.[key])])),
    ...(value?.closingOnNewPage === true ? { closingOnNewPage: true } : {}),
    intro: normalizeRichText(value?.intro), closing: normalizeRichText(value?.closing), footerText: normalizeRichText(value?.footerText),
  };
}
export function documentCompositions(value?: DocumentCompositions): DocumentCompositions {
  return Object.fromEntries((['invoices', 'quotes', 'accounts', 'payslips'] as const).filter(k => value?.[k]).map(k => [k, normalizeComposition(value![k])]));
}
export const richPlainText = (value: RichText) => value.map(p => p.runs.map(r => r.text).join('')).join('\n');
export const documentFontCss: Record<DocumentFont, string> = { helvetica: 'Arial, Helvetica, sans-serif', times: '"Times New Roman", Times, serif', courier: '"Courier New", Courier, monospace', inter: '"Zentra Document Inter", Arial, sans-serif', literata: '"Zentra Document Literata", Georgia, serif' };
