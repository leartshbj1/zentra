import './languageTestPacks';
import { afterEach, expect, it } from 'vitest';
import { setAppLanguage, t } from './language';
import { formatUpdateBytes, formatUpdateDate, updaterFailureExplanation } from './appUpdaterLogic';
import { updaterTranslations } from './translationsUpdater';

afterEach(() => setAppLanguage('fr'));

it('keeps version, date and size placeholders in all updater translations', () => {
  const fields = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [source, messages] of Object.entries(updaterTranslations)) {
    expect(messages).toHaveLength(3);
    for (const message of messages) { expect(message.trim()).not.toBe(''); expect(fields(message), source).toEqual(fields(source)); }
  }
});

it('formats byte sizes with the selected language and still rejects invalid dates', async () => {
  await setAppLanguage('fr'); expect(formatUpdateBytes(1572864)).toBe('1,5 Mo');
  await setAppLanguage('en'); expect(formatUpdateBytes(1572864)).toBe('1.5 MB');
  expect(formatUpdateBytes(0)).toBe('0 bytes');
  expect(formatUpdateDate('invalid-date')).toBeNull();
});

it('preserves version values and translates the observed Windows refusal in each language', async () => {
  for (const language of ['de', 'it', 'en'] as const) {
    await setAppLanguage(language);
    const text = t('Zentra {version} est déjà à jour.', { version: '1.90.6-beta+42' });
    expect(text).toContain('1.90.6-beta+42'); expect(text).not.toContain('déjà à jour');
    const source = updaterFailureExplanation('(os error 4551)')!;
    expect(t(source)).not.toBe(source);
  }
});
