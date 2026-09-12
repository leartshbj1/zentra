import { describe, expect, it } from 'vitest';
import { normalizeComposition } from './documentComposition';
import { copyDocumentDesign, designChange, restoreDesignChange, resetDocumentDesign } from './documentDesignEditing';
import { initialOnboardingSettings } from './onboardingDraft';

describe('document block layout', () => {
  const chosen = { companyAlign: 'center' as const, recipientAlign: 'right' as const, topMarginMm: 35, logoGap: 7, blockSpacing: 1.5, textColor: '#182b49', titleColor: '#793c32', closingOnNewPage: true };
  it('leaves legacy compositions without new overrides', () => {
    const value = normalizeComposition();
    for (const key of Object.keys(chosen)) expect(value).not.toHaveProperty(key);
  });
  it('preserves every new layout setting through serialization', () => {
    const design = normalizeComposition(chosen);
    expect(normalizeComposition(JSON.parse(JSON.stringify(design)))).toEqual(design);
    expect(design).toMatchObject(chosen);
  });
  it('bounds spacing and rejects colors and alignments outside the supported format', () => {
    expect(normalizeComposition({ topMarginMm: 90, logoGap: -1, blockSpacing: NaN, companyAlign: 'url(x)' as never, textColor: 'red', titleColor: '#ABCDEF' })).toMatchObject({ topMarginMm: 45, logoGap: 0, blockSpacing: 1, companyAlign: 'left', titleColor: '#abcdef' });
    expect(normalizeComposition({ textColor: 'red' })).not.toHaveProperty('textColor');
  });
  it('removes overrides when automatic choices are restored', () => {
    const changed = normalizeComposition({ ...chosen, topMarginMm: undefined, textColor: undefined, titleColor: undefined, closingOnNewPage: false });
    for (const key of ['topMarginMm', 'textColor', 'titleColor', 'closingOnNewPage']) expect(changed).not.toHaveProperty(key);
    expect(changed.recipientAlign).toBe('right');
  });
  it.each(['quotes', 'accounts', 'payslips'] as const)('copies layout to %s while preserving its text and allows undo', kind => {
    const settings = { ...initialOnboardingSettings, documentComposition: { invoices: normalizeComposition(chosen), [kind]: normalizeComposition({ closing: [{ runs: [{ text: `Texte ${kind}` }] }] }) } };
    const next = copyDocumentDesign(settings, 'invoices', kind);
    expect(next.documentComposition![kind]).toMatchObject(chosen);
    expect(next.documentComposition![kind]!.closing[0].runs[0].text).toBe(`Texte ${kind}`);
    const change = designChange(settings, next)!;
    const undone = restoreDesignChange(next, change)!;
    expect(undone.documentComposition![kind]).toEqual(settings.documentComposition[kind]);
    expect(restoreDesignChange(undone, change, true)!.documentComposition![kind]).toEqual(next.documentComposition![kind]);
  });
  it('reset preserves conditions while clearing advanced layout', () => {
    const closing = [{ runs: [{ text: 'Conditions conservées.' }] }];
    const settings = { ...initialOnboardingSettings, documentComposition: { quotes: normalizeComposition({ ...chosen, closing }) } };
    const reset = resetDocumentDesign(settings, 'quotes').documentComposition!.quotes!;
    expect(reset.closing[0].runs[0].text).toBe('Conditions conservées.');
    for (const key of Object.keys(chosen)) expect(reset).not.toHaveProperty(key);
  });
});
