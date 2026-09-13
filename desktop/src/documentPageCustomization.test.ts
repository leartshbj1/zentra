import { describe, expect, it } from 'vitest';
import { normalizeComposition, normalizeRichText, richPlainText } from './documentComposition';
import { copyRichTextFormat, setRichMarks } from './richTextEditing';
import { copyDocumentDesign, designChange, restoreDesignChange } from './documentDesignEditing';
import { initialOnboardingSettings } from './onboardingDraft';

describe('document page customization', () => {
  it('leaves old layouts unchanged and accepts only supported overrides', () => {
    expect(normalizeComposition()).not.toHaveProperty('pageOrientation');
    expect(normalizeComposition({ titleFontFamily: 'remote' as never, pageOrientation: 'sideways' as never, tableHeaderColor: 'url(x)', tableHeaderTextColor: '#FFFFFF' })).toMatchObject({ pageOrientation: 'portrait', tableHeaderTextColor: '#ffffff' });
    expect(normalizeComposition({ titleFontFamily: 'remote' as never })).not.toHaveProperty('titleFontFamily');
    expect(normalizeComposition({ tableHeaderColor: 'url(x)' })).not.toHaveProperty('tableHeaderColor');
  });
  it('copies page design across categories, keeps target text, and undoes without affecting company data', () => {
    const source = normalizeComposition({ pageOrientation: 'landscape', titleFontFamily: 'times', tableHeaderColor: '#182b49', tableHeaderTextColor: '#ffffff', tableStripeColor: '#eeeeee', tableLineColor: '#000000' });
    const target = normalizeComposition({ intro: [{ runs: [{ text: 'Texte du devis' }] }] });
    const before = { ...initialOnboardingSettings, documentComposition: { invoices: source, quotes: target } };
    const next = copyDocumentDesign(before, 'invoices', 'quotes');
    expect(next.documentComposition?.quotes).toEqual({ ...source, intro: target.intro });
    const entry = designChange(before, next)!;
    expect(restoreDesignChange(next, entry)?.documentComposition?.quotes).toEqual(target);
  });
  it('copies the first selected style and clears formatting absent from the source', () => {
    const text = normalizeRichText([{ runs: [{ text: 'Simple ' }, { text: 'Titre', bold: true, fontFamily: 'times', fontSize: 18, color: '#182b49' }, { text: ' Cible', italic: true, underline: true, highlight: '#ffff00', color: '#ff0000' }] }]);
    const style = copyRichTextFormat(text, { start: 7, end: 14 });
    const next = setRichMarks(text, { start: 13, end: 18 }, style);
    expect(richPlainText(next)).toBe('Simple Titre Cible');
    expect(next[0].runs.at(-1)).toMatchObject({ text: 'Cible', bold: true, italic: false, underline: false, fontFamily: 'times', fontSize: 18, color: '#182b49' });
    expect(next[0].runs.at(-1)).not.toHaveProperty('highlight');
    const normal = setRichMarks(next, { start: 13, end: 18 }, copyRichTextFormat(text, { start: 0, end: 2 }));
    expect(normal[0].runs.at(-1)).not.toHaveProperty('fontFamily');
    expect(normal[0].runs.at(-1)).not.toHaveProperty('color');
  });
});
