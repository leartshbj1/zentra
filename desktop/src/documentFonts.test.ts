import { describe, expect, it } from 'vitest';
import { normalizeComposition, normalizeRichText, richFont, richPlainText } from './documentComposition';
import { captureDocumentTemplate, applyDocumentTemplate } from './documentTemplates';
import { designChange, restoreDesignChange } from './documentDesignEditing';
import { initialOnboardingSettings } from './onboardingDraft';
import { setRichMarks } from './richTextEditing';

describe('document fonts that travel with the PDF', () => {
  it('preserves the body, title and selected-passage fonts through serialization', () => {
    const design = normalizeComposition({ fontFamily:'inter', titleFontFamily:'literata', closing:[{ runs:[{text:'Délai ',fontFamily:'inter'}, {text:'de paiement',fontFamily:'literata',bold:true,italic:true}] }] });
    expect(normalizeComposition(JSON.parse(JSON.stringify(design)))).toEqual(design);
    expect(normalizeComposition().fontFamily).toBe('helvetica');
    for (const invalid of ['Inter.ttf','url(remote)','system','']) expect(richFont(invalid)).toBeUndefined();
  });
  it('changes a selection without losing the surrounding words or their styles', () => {
    const before = normalizeRichText([{runs:[{text:'Avant conditions après',fontFamily:'inter',italic:true}]}]);
    const changed = setRichMarks(before,{start:6,end:16},{fontFamily:'literata',bold:true});
    expect(richPlainText(changed)).toBe('Avant conditions après');
    expect(changed[0].runs.map(run=>[run.text,run.fontFamily,run.italic,run.bold])).toEqual([
      ['Avant ','inter',true,false], ['conditions','literata',true,true], [' après','inter',true,false],
    ]);
    expect(before[0].runs).toHaveLength(1);
  });
  it('keeps new font choices in a reusable model and in undo history', () => {
    const before = { ...initialOnboardingSettings, documentComposition:{ invoices:normalizeComposition({fontFamily:'inter',titleFontFamily:'literata',footerText:[{runs:[{text:'Merci.',fontFamily:'literata',italic:true}]}]}) } };
    const template = captureDocumentTemplate(before,'invoices','Ma présentation','713a3d9d-e8da-4ca8-9b56-b0e02d3b3da3');
    for (const kind of ['quotes','accounts','payslips'] as const) {
      const after = applyDocumentTemplate(before,kind,template,true);
      expect(after.documentComposition?.[kind]).toEqual(before.documentComposition.invoices);
      const change = designChange(before,after)!;
      expect(change).toBeTruthy();
      const undone = restoreDesignChange(after,change);
      expect(undone?.documentComposition?.[kind]).toBeUndefined();
    }
  });
});
