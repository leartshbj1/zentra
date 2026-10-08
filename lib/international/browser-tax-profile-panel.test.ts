import { describe, expect, it } from 'vitest';
import { buildBrowserTaxFacts, type BrowserTaxProfileDraft } from '../../components/account/us-tax-profile-panel';
import { browserTaxProfileCopy } from './browser-tax-profile-copy';

const valid: BrowserTaxProfileDraft = { legalName: ' Fictitious US Company ', line1: ' 1 Fictitious Street ', line2: '', city: ' Brooklyn ', subdivision: 'NY', postalCode: '11201', timeZone: 'America/New_York' };
describe('private owner tax editor input and wording', () => {
  it('builds the declared private service contract without a grant, EIN or provider configuration', () => {
    expect(buildBrowserTaxFacts(valid)).toEqual({ schemaVersion: 1, legalName: 'Fictitious US Company', taxOrigin: { country: 'US', line1: '1 Fictitious Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, timeZone: 'America/New_York' });
  });
  it.each([{ postalCode: '1000' }, { subdivision: 'GE' }, { timeZone: 'Europe/Zurich' }, { legalName: '' }, { line1: '' }, { city: '' }, { legalName: 'bad\u0000name' }])('rejects an invalid private declaration %j', change => {
    expect(() => buildBrowserTaxFacts({ ...valid, ...change })).toThrow();
  });
  it('preserves ZIP+4 and an optional address complement', () => {
    expect(buildBrowserTaxFacts({ ...valid, postalCode: '11201-1234', line2: ' Suite 4 ' }).taxOrigin).toMatchObject({ postalCode: '11201-1234', line2: 'Suite 4' });
  });
  it('keeps every private editor state translated in all four languages', () => {
    const keys = Object.keys(browserTaxProfileCopy.en).sort();
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      expect(Object.keys(browserTaxProfileCopy[language]).sort()).toEqual(keys);
      expect(Object.values(browserTaxProfileCopy[language]).every(value => value.trim().length > 0)).toBe(true);
    }
    expect(JSON.stringify(browserTaxProfileCopy.de)).not.toContain('ß');
    expect(browserTaxProfileCopy.it.conflict).toContain('vostra');
  });
});
