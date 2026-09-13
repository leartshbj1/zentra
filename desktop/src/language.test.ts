import { afterEach, describe, expect, it, vi } from 'vitest';
import { translations } from './translations';
import { appLanguages, getAppLanguage, getAppLocale, languageStorageKey, parseLanguage, setAppLanguage, t } from './language';
import { setupIssueText } from './setupLanguage';
import { initialOnboardingSettings } from './onboardingDraft';
import { validateOnboarding } from './onboardingValidation';
import { formatMoney } from './utils';

afterEach(() => { setAppLanguage('fr'); vi.unstubAllGlobals(); });
describe('offline interface language', () => {
  it('accepts only the four supported choices', () => {
    expect(appLanguages).toEqual(['fr','de','it','en']);
    for (const value of [null, {}, 'de-DE', 'script', 'fr-CH']) expect(parseLanguage(value)).toBeNull();
  });
  it('persists a device preference without modifying company data', () => {
    const setItem=vi.fn(); vi.stubGlobal('localStorage',{setItem});
    expect(setAppLanguage('de')).toBe(true);
    expect(setItem).toHaveBeenCalledWith(languageStorageKey,'de');
    expect(getAppLanguage()).toBe('de'); expect(getAppLocale()).toBe('de-CH');
    expect(t('TVA')).toBe('MWST');
    expect(t('Atelier Leart {client}')).toBe('Atelier Leart {client}');
  });
  it('keeps a session usable while reporting a failure to save the preference', () => {
    vi.stubGlobal('localStorage',{setItem:()=>{throw new Error('storage full');}});
    expect(setAppLanguage('it')).toBe(false); expect(t('Factures')).toBe('Fatture');
  });
  it('preserves boundaries and substitutes values once, without treating their text as a template', () => {
    expect(t('  Continuer ',undefined,'en')).toBe('  Continue ');
    expect(t('   ',undefined,'de')).toBe('   ');
    expect(t('Rechercher dans {section}',{section:'Client {section}'},'en')).toBe('Search in Client {section}');
  });
  it('has all three nonempty translations and preserves every named parameter', () => {
    const keys=(value:string)=>[...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match=>match[1]).sort();
    for(const [source,row] of Object.entries(translations)) {
      expect(row,source).toHaveLength(3);
      for(const target of row){expect(target.trim().length,source).toBeGreaterThan(0);expect(keys(target),source).toEqual(keys(source));}
    }
  });
  it('translates required-field guidance at display time without changing validation or routing', () => {
    const issue={step:1,field:'organization.legalName',label:'La raison sociale',message:'La raison sociale est obligatoire.'};
    const original=structuredClone(issue);
    setAppLanguage('de');expect(setupIssueText(issue)).toBe('Firmenname: Dieses Feld ist erforderlich.');
    setAppLanguage('it');expect(setupIssueText(issue)).toBe('Ragione sociale: questo campo è obbligatorio.');
    setAppLanguage('en');expect(setupIssueText(issue)).toBe('Legal company name: this field is required.');
    expect(issue).toEqual(original);
    setAppLanguage('fr');expect(setupIssueText(issue)).toBe(issue.message);
  });
  it('covers every missing-field message in the complete initial setup', () => {
    const issues=validateOnboarding(initialOnboardingSettings,null,false);
    for(const language of ['de','it','en'] as const){setAppLanguage(language);for(const issue of issues)expect(setupIssueText(issue),issue.message).not.toBe(issue.message);}
  });
  it('formats the same CHF value using the selected locale', () => {
    for(const language of appLanguages){setAppLanguage(language);expect(formatMoney(123456)).toBe(new Intl.NumberFormat(getAppLocale(),{style:'currency',currency:'CHF',minimumFractionDigits:2,maximumFractionDigits:2}).format(1234.56));}
  });
});
