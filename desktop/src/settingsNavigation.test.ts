import { describe, expect, it } from 'vitest';
import { matchesSettingsSearch, settingsSearchTerms } from './settingsNavigation';
import { settingsNavigationTranslations } from './translationsSettingsNavigation';

describe('settings discovery', () => {
  it.each([
    ['assurance', 'payroll', 0], ['versicherungen', 'payroll', 0],
    ['assicurazione', 'payroll', 1], ['insurance', 'payroll', 2],
    ['taille texte', 'appearance', 0], ['textgrosse', 'appearance', 0],
    ['signature', 'mail', 2], ['mittente', 'mail', 1],
    ['reinitialiser', 'storage', 0], ['zurucksetzen', 'storage', 0],
  ])('finds %s without requiring the category name', (query, id, index) => {
    const source = settingsSearchTerms[id as string];
    expect(matchesSettingsSearch(query as string, [source, settingsNavigationTranslations[source][index as number]])).toBe(true);
  });
  it('requires every search term and handles blank and punctuation-only input', () => {
    expect(matchesSettingsSearch('logo pension', ['Logo adresse'])).toBe(false);
    expect(matchesSettingsSearch('   ', ['Logo adresse'])).toBe(true);
    expect(matchesSettingsSearch('e-mail SMTP', ['E mail SMTP'])).toBe(true);
    expect(matchesSettingsSearch('aucune rubrique', ['Autre réglage'])).toBe(false);
  });
});
