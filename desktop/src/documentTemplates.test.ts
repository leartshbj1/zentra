import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { initialOnboardingSettings } from './onboardingDraft';
import { documentAppearance } from './documentAppearance';
import { normalizeComposition } from './documentComposition';
import { applyDocumentTemplate, captureDocumentTemplate, templateNameError, type DocumentDesignTemplate } from './documentTemplates';
import { designChange, joinDesignChanges, restoreDesignChange } from './documentDesignEditing';
import type { AppSettings } from './types';

const id = '713a3d9d-e8da-4ca8-9b56-b0e02d3b3da3';
function fixture(): AppSettings {
  const appearance = documentAppearance(); appearance.invoices.footer = 'Pied facture'; appearance.quotes.footer = 'Pied devis';
  appearance.invoices.accentColor = '#182b49';
  return { ...initialOnboardingSettings, organization:{ ...initialOnboardingSettings.organization, legalName:'Atelier test' }, documentAppearance: appearance, documentComposition: {
    invoices: normalizeComposition({ fontFamily: 'times', titleFontFamily: 'courier', logoPosition: 'right', marginMm: 20.5, pageOrientation: 'landscape', tableLineColor: '#b3c6bb', closing: [{ runs: [{ text: 'Conditions facture', bold: true }] }] }),
    quotes: normalizeComposition({ intro: [{ runs: [{ text: 'Intro devis' }] }], closing: [{ runs: [{ text: 'Conditions devis', italic: true }] }], footerText: [{ runs: [{ text: 'Pied mis en forme' }] }] }),
  } };
}
describe('personal document templates', () => {
  it('captures only design and model text, with independent nested objects', () => {
    const settings = fixture(); const template = captureDocumentTemplate(settings, 'invoices', '  Mon modèle  ', id);
    expect(Object.keys(template).sort()).toEqual(['id', 'name', 'sourceKind', 'style', 'version']);
    expect(Object.keys(template.style).sort()).toEqual(['accentColor', 'composition', 'footer', 'layout', 'logoWidth']);
    expect(template.name).toBe('Mon modèle');
    expect(template.style.composition).toEqual(settings.documentComposition?.invoices);
    template.style.composition!.closing[0].runs[0].text = 'Edited';
    expect(settings.documentComposition?.invoices?.closing[0].runs[0].text).toBe('Conditions facture');
  });
  it('rejects empty, multiline, too long and duplicate names without truncation', () => {
    const template = captureDocumentTemplate(fixture(), 'invoices', 'Mon modèle', id);
    for (const value of ['', ' ', 'a\nb', 'a'.repeat(61), 'MON MODÈLE']) expect(templateNameError(value, [template])).not.toBeNull();
    expect(templateNameError('Mon modèle', [template], id)).toBeNull();
    expect(templateNameError('É'.repeat(60), [])).toBeNull();
  });
  it('limits the library and rejects unprintable model text before capture', () => {
    const settings = fixture(); const template = captureDocumentTemplate(settings, 'invoices', 'One', id);
    settings.documentDesignTemplates = Array.from({ length:20 }, (_, index) => ({ ...template, id:String(index), name:String(index) }));
    expect(() => captureDocumentTemplate(settings, 'invoices', 'New', id)).toThrow('20 modèles');
    settings.documentDesignTemplates = []; settings.documentComposition!.invoices!.closing[0].runs[0].text = 'Invalid 🐈';
    expect(() => captureDocumentTemplate(settings, 'invoices', 'New', id)).toThrow('dans Textes');
    expect(() => captureDocumentTemplate(settings, 'quotes', 'Valid', id)).not.toThrow();
  });
  it('applies every style setting, preserving destination text and unrelated data by default', () => {
    const settings = fixture(), before = structuredClone(settings);
    const template = captureDocumentTemplate(settings, 'invoices', 'Model', id);
    for (const kind of ['quotes', 'invoices', 'accounts', 'payslips'] as const) {
      const result = applyDocumentTemplate(settings, kind, template);
      expect(result.documentComposition?.[kind]).toMatchObject({ fontFamily:'times', titleFontFamily:'courier', logoPosition:'right', marginMm:20.5, pageOrientation:'landscape', tableLineColor:'#b3c6bb' });
      const target = normalizeComposition(settings.documentComposition?.[kind]);
      for (const zone of ['intro', 'closing', 'footerText'] as const) expect(result.documentComposition?.[kind]?.[zone]).toEqual(target[zone]);
      expect(result.documentAppearance?.[kind].footer).toBe(settings.documentAppearance?.[kind].footer);
      expect(result.organization).toEqual(settings.organization);
    }
    expect(settings).toEqual(before);
  });
  it('replaces all model text only when asked and never mutates the template', () => {
    const settings = fixture(), template = captureDocumentTemplate(settings, 'invoices', 'Model', id);
    const applied = applyDocumentTemplate(settings, 'quotes', template, true);
    expect(applied.documentComposition?.quotes).toEqual(template.style.composition);
    expect(applied.documentAppearance?.quotes.footer).toBe('Pied facture');
    applied.documentComposition!.quotes!.closing[0].runs[0].text = 'Changed';
    expect(template.style.composition?.closing[0].runs[0].text).toBe('Conditions facture');
  });
  it('supports legacy models without adding flexible composition when all text is replaced', () => {
    const settings = fixture(); const legacy = captureDocumentTemplate({ ...settings, documentComposition:undefined }, 'invoices', 'Legacy', id);
    expect(legacy.style.composition).toBeUndefined();
    expect(applyDocumentTemplate(settings, 'quotes', legacy, true).documentComposition?.quotes).toBeUndefined();
    expect(applyDocumentTemplate(settings, 'quotes', legacy).documentComposition?.quotes?.closing).toEqual(settings.documentComposition?.quotes?.closing);
  });
});
describe('template history', () => {
  it('leaves legacy presentation settings absent when only the library is undone', () => {
    const before = { ...initialOnboardingSettings };
    const after = { ...before, documentDesignTemplates:[captureDocumentTemplate(before, 'invoices', 'Model', id)] };
    const restored = restoreDesignChange(after, designChange(before, after)!)!;
    expect(restored.documentAppearance).toEqual(before.documentAppearance);
    expect(restored.documentComposition).toEqual(before.documentComposition);
  });
  it('undoes and redoes creation, rename and removal without restoring stale settings', () => {
    let before = fixture(); const template = captureDocumentTemplate(before, 'invoices', 'Model', id);
    const libraries: DocumentDesignTemplate[][] = [[template], [{ ...template, name:'Renamed' }], []];
    for (const library of libraries) {
      const after = { ...before, documentDesignTemplates:library }, edit = designChange(before, after)!;
      const live = { ...after, documentComposition:{ ...after.documentComposition, payslips:normalizeComposition({ marginMm:24 }) }, organization:{ ...after.organization, legalName:'Current company' } };
      const undo = restoreDesignChange(live, edit)!;
      expect(undo.documentDesignTemplates).toEqual(before.documentDesignTemplates);
      expect(undo.organization.legalName).toBe('Current company');
      expect(undo.documentComposition?.payslips?.marginMm).toBe(24);
      expect(restoreDesignChange(undo, edit, true)).toEqual(live);
      before = after;
    }
  });
  it('refuses to replace models refreshed elsewhere and keeps model edits out of slider groups', () => {
    const before = fixture(), template = captureDocumentTemplate(before, 'invoices', 'Model', id);
    const after = { ...before, documentDesignTemplates:[template] }, edit = designChange(before, after)!;
    expect(restoreDesignChange({ ...after, documentDesignTemplates:[{ ...template, name:'External' }] }, edit)).toBeNull();
    const applied = applyDocumentTemplate(after, 'quotes', template);
    expect(joinDesignChanges(edit, designChange(after, applied)!)).toBeNull();
  });
  it('undoing an applied style preserves a library updated after the application', () => {
    const before = fixture(), template = captureDocumentTemplate(before, 'invoices', 'Model', id);
    const after = applyDocumentTemplate(before, 'quotes', template);
    const restored = restoreDesignChange({ ...after, documentDesignTemplates:[template] }, designChange(before, after)!)!;
    expect(restored.documentDesignTemplates).toEqual([template]);
    expect(restored.documentComposition?.quotes).toEqual(before.documentComposition?.quotes);
  });
});

it('sends the library through the production settings bridge and restores it after reload', async () => {
  const settings = fixture(); settings.documentDesignTemplates = [captureDocumentTemplate(settings, 'invoices', 'Stored', id)];
  let stored: Record<string, unknown> = {};
  invokeMock.mockReset().mockImplementation(async (command: string, args?: { data:Record<string, unknown> }) => {
    if (command === 'update_settings') { stored = args!.data; return stored; }
    if (command === 'get_app_state') return { onboarding_completed:1 };
    if (command === 'get_workspace') return { settings:stored };
    throw new Error(command);
  });
  const result = await desktopApi.saveSettings(settings);
  expect(JSON.parse(stored.extra_settings_json as string).documentDesignTemplates).toEqual(settings.documentDesignTemplates);
  expect(result.settings?.documentDesignTemplates).toEqual(settings.documentDesignTemplates);
  const reloaded = await desktopApi.loadWorkspace();
  expect(reloaded.settings?.documentDesignTemplates).toEqual(settings.documentDesignTemplates);
});
