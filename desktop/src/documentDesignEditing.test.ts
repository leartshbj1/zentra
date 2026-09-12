import { describe, expect, it } from 'vitest';
import { initialOnboardingSettings } from './onboardingDraft';
import { normalizeComposition } from './documentComposition';
import { documentAppearance } from './documentAppearance';
import { copyDocumentDesign, designChange, resetDocumentDesign, restoreDesignChange } from './documentDesignEditing';

function fixture() {
  const appearance = documentAppearance();
  appearance.invoices.footer = 'Pied facture'; appearance.quotes.footer = 'Pied devis';
  appearance.invoices.accentColor = '#793c32';
  return { ...initialOnboardingSettings, documentAppearance: appearance, documentComposition: {
    invoices: normalizeComposition({ fontFamily: 'times', logoPosition: 'right', marginMm: 20, closing: [{ runs: [{ text: 'Paiement facture', bold: true }] }] }),
    quotes: normalizeComposition({ intro: [{ runs: [{ text: 'Offre personnelle' }] }], closing: [{ runs: [{ text: 'Conditions devis', italic: true }] }], footerText: [{ runs: [{ text: 'Contact devis' }] }] }),
  } };
}
describe('reuse document presentation', () => {
  it('copies layout while preserving all destination text zones including plain footer', () => {
    const settings = fixture(), before = structuredClone(settings);
    const result = copyDocumentDesign(settings, 'invoices', 'quotes');
    expect(result.documentComposition?.quotes).toMatchObject({ ...settings.documentComposition.quotes, fontFamily: 'times', logoPosition: 'right', marginMm: 20 });
    expect(result.documentAppearance?.quotes).toMatchObject({ accentColor: '#793c32', footer: 'Pied devis' });
    expect(settings).toEqual(before);
  });
  it('copies every text explicitly and isolates references from the source', () => {
    const settings = fixture();
    const result = copyDocumentDesign(settings, 'invoices', 'quotes', true);
    expect(result.documentComposition?.quotes).toEqual(settings.documentComposition.invoices);
    expect(result.documentAppearance?.quotes.footer).toBe('Pied facture');
    result.documentComposition!.quotes!.closing[0].runs[0].text = 'Modified';
    expect(settings.documentComposition.invoices.closing[0].runs[0].text).toBe('Paiement facture');
  });
  it('handles old presentations and a copy to the same category', () => {
    const settings = { ...fixture(), documentComposition: { quotes: fixture().documentComposition.quotes } };
    expect(copyDocumentDesign(settings, 'quotes', 'quotes')).toBe(settings);
    expect(copyDocumentDesign(settings, 'invoices', 'quotes').documentComposition?.quotes?.closing).toEqual(settings.documentComposition.quotes.closing);
    expect(copyDocumentDesign(settings, 'invoices', 'quotes', true).documentComposition?.quotes).toBeUndefined();
  });
  it('resets styling with text kept by default; complete reset is explicit', () => {
    const settings = fixture();
    const result = resetDocumentDesign(settings, 'invoices');
    expect(result.documentComposition?.invoices).toEqual(normalizeComposition({ closing: settings.documentComposition.invoices.closing }));
    expect(result.documentAppearance?.invoices.footer).toBe('Pied facture');
    const cleared = resetDocumentDesign(settings, 'invoices', true);
    expect(cleared.documentComposition?.invoices).toBeUndefined();
    expect(cleared.documentAppearance?.invoices.footer).toBe('');
    expect(cleared.documentComposition?.quotes).toEqual(settings.documentComposition.quotes);
  });
});
describe('presentation history', () => {
  it('does not record unchanged documents or business-only changes', () => {
    const settings = fixture();
    expect(designChange(settings, structuredClone(settings))).toBeNull();
    expect(designChange(settings, { ...settings, organization: { ...settings.organization, legalName: 'Nouveau nom' } })).toBeNull();
  });
  it('undo and redo preserve newer company settings and unrelated categories', () => {
    const before = fixture(), after = copyDocumentDesign(before, 'invoices', 'quotes', true);
    const edit = designChange(before, after)!;
    const live = { ...after, organization: { ...after.organization, legalName: 'Entreprise actualisée' }, documentComposition: { ...after.documentComposition, accounts: normalizeComposition({ marginMm: 25 }) } };
    const restored = restoreDesignChange(live, edit)!;
    expect(restored.documentComposition?.quotes).toEqual(before.documentComposition.quotes);
    expect(restored.organization.legalName).toBe('Entreprise actualisée');
    expect(restored.documentComposition?.accounts?.marginMm).toBe(25);
    expect(restoreDesignChange(restored, edit, true)).toEqual(live);
  });
  it('does not overwrite a concurrently updated category', () => {
    const before = fixture(), after = copyDocumentDesign(before, 'invoices', 'quotes', true);
    const changed = resetDocumentDesign(after, 'quotes', true);
    expect(restoreDesignChange(changed, designChange(before, after)!)).toBeNull();
  });
  it('restores legacy absence of flexible composition', () => {
    const before = { ...fixture(), documentComposition: undefined };
    const after = resetDocumentDesign(before, 'quotes');
    const edit = designChange(before, after)!;
    expect(restoreDesignChange(after, edit)?.documentComposition?.quotes).toBeUndefined();
  });
});
