import type { CSSProperties } from 'react';

export type DocumentStyle = { accentColor: string; layout: 'signature' | 'minimal'; logoWidth: number; footer: string };
export type DocumentAppearance = Record<'invoices' | 'quotes' | 'accounts' | 'payslips', DocumentStyle>;
export type DocumentDesignKind = keyof DocumentAppearance;
export const defaultDocumentStyle: DocumentStyle = { accentColor: '#134d33', layout: 'signature', logoWidth: 88, footer: '' };
export function normalizeDocumentStyle(value?: Partial<DocumentStyle>): DocumentStyle {
  return {
    accentColor: /^#[0-9a-f]{6}$/i.test(value?.accentColor || '') ? value!.accentColor!.toLowerCase() : defaultDocumentStyle.accentColor,
    layout: value?.layout === 'minimal' ? 'minimal' : 'signature',
    logoWidth: [88, 120, 150].includes(value?.logoWidth || 0) ? value!.logoWidth! : defaultDocumentStyle.logoWidth,
    footer: typeof value?.footer === 'string' ? value.footer.slice(0, 100).replace(/[\r\n]/g, ' ') : '',
  };
}
export function documentAppearance(value?: Partial<DocumentAppearance>): DocumentAppearance {
  return { invoices: normalizeDocumentStyle(value?.invoices), quotes: normalizeDocumentStyle(value?.quotes), accounts: normalizeDocumentStyle(value?.accounts), payslips: normalizeDocumentStyle(value?.payslips) };
}
export function documentStyleVariables(style: DocumentStyle): CSSProperties {
  const rgb = [1, 3, 5].map(offset => parseInt(style.accentColor.slice(offset, offset + 2), 16));
  const luminance = rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  // Titles use a darkened tone when a light accent is selected; bands retain the chosen color.
  const ink = luminance > .18 ? `rgb(${rgb.map(value => Math.round(value * .45)).join(',')})` : style.accentColor;
  return { '--document-accent': style.accentColor, '--document-ink': ink, '--document-on-accent': luminance > .179 ? '#111111' : '#ffffff', '--document-pale': `rgb(${rgb.map(value => Math.round(value * .08 + 255 * .92)).join(',')})`, '--document-logo-width': `${style.logoWidth * 4 / 3}px`, '--document-logo-height': `${(style.logoWidth === 150 ? 40 : style.logoWidth === 120 ? 36 : 32) * 4 / 3}px` } as CSSProperties;
}
