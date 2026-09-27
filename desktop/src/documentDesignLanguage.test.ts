import './languageTestPacks';
import { afterEach, describe, expect, it } from 'vitest';
import { setAppLanguage, t } from './language';
import { initialOnboardingSettings } from './onboardingDraft';
import { normalizeComposition, richPlainText } from './documentComposition';
import { documentDesignTextProblems, nativeDesignProblem } from './documentDesignValidation';
import { applyDocumentTemplate, captureDocumentTemplate } from './documentTemplates';
import { findRichText, replaceRichTextMatches } from './richTextSearch';
import { documentDesignTranslations } from './translationsDocumentDesign';
import { richTextTranslations } from './translationsRichText';

afterEach(() => setAppLanguage('fr'));
describe('document editing across languages', () => {
  for (const language of ['fr', 'de', 'it', 'en'] as const) {
    it(`${language}: translates a correction while preserving the document and selected UTF-16 range`, async () => {
      await setAppLanguage(language);
      const settings = { ...initialOnboardingSettings, documentComposition: { quotes: normalizeComposition({ closing: [{ runs: [{ text: 'Merci 🧾' }] }] }) } };
      const before = JSON.stringify(settings);
      const [problem] = documentDesignTextProblems(settings);
      expect(problem.kind).toBe('quotes'); expect(problem.zone).toBe('closing');
      expect(problem.range).toEqual({ start: 6, end: 8 });
      expect(problem.title).toContain(t('Devis'));
      expect(problem.message).toBe(t('Le caractère « {character} » ne peut pas être imprimé avec ces polices. Remplacez le passage sélectionné par du texte ou un symbole courant.', { character: '🧾' }));
      expect(JSON.stringify(settings)).toBe(before);
      const footer = nativeDesignProblem('invoices', new Error('Le pied de page prend trop de place.'), initialOnboardingSettings);
      expect(footer.zone).toBe('footer');
      if (language !== 'fr') {
        expect(footer.message).toBe(t('Vérifiez le pied de page : réduisez sa longueur ou sa taille, puis relancez l’aperçu.'));
        expect(footer.details).toBe('Le pied de page prend trop de place.');
      }
      const company = nativeDesignProblem('invoices', 'Le logo est introuvable.', initialOnboardingSettings);
      expect(company).toMatchObject({ zone: 'company', companyTarget: 'logo' });
      expect(nativeDesignProblem('invoices', 'Un caractère manque dans cette police.', initialOnboardingSettings)).toMatchObject({ zone: 'company', companyTarget: 'identity' });
    });
    it(`${language}: template names, client text and financial values stay verbatim`, async () => {
      await setAppLanguage(language);
      const settings = { ...initialOnboardingSettings, documentComposition: { invoices: normalizeComposition({ fontFamily: 'literata', closing: [{ runs: [{ text: 'Factures · CHF 500 · Bedingungen', bold: true }] }] }) } };
      const before = JSON.stringify(settings);
      const template = captureDocumentTemplate(settings, 'invoices', 'Factures / Conditions', 'language-fixture');
      expect(template.name).toBe('Factures / Conditions');
      const copied = applyDocumentTemplate(settings, 'quotes', template, true);
      expect(copied.documentComposition?.quotes).toEqual(settings.documentComposition.invoices);
      expect(copied.organization).toEqual(settings.organization);
      expect(JSON.stringify(settings)).toBe(before);
      const content = [{ runs: [{ text: 'Délai Délai', bold: true }] }];
      const result = replaceRichTextMatches(content, findRichText(content, 'Délai', true), 'CHF 500', 100);
      expect(richPlainText(result.value)).toBe('CHF 500 CHF 500');
      expect(result.value[0].runs[0].bold).toBe(true);
      const tooLong = replaceRichTextMatches(content, findRichText(content, 'Délai'), 'x'.repeat(181), 180);
      expect(tooLong.value).toBe(content);
      expect(tooLong.error).toBe(t('Ce texte peut contenir {max} caractères au maximum. Le texte précédent est conservé.', { max: 180 }));
    });
  }
  it('preserves every interpolation token in each authored language', () => {
    const tokens = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [source, translations] of Object.entries({ ...documentDesignTranslations, ...richTextTranslations })) {
      expect(translations).toHaveLength(3);
      for (const translation of translations) {
        expect(translation.trim()).not.toBe('');
        expect(tokens(translation), source).toEqual(tokens(source));
      }
    }
  });
});
