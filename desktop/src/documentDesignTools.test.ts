import './languageTestPacks';
import { afterEach, describe, expect, it } from 'vitest';
import { documentDesignTools, findDocumentDesignTools } from './documentDesignTools';
import { setAppLanguage, t } from './language';
import { translations } from './translations';

afterEach(() => setAppLanguage('fr'));

describe('finding document tools in everyday French', () => {
  it('finds accented labels and multiple keywords without interpreting regular expressions', () => {
    expect(findDocumentDesignTools('  DÉPLACER  logo ', 'invoices').map(tool => tool.id)).toContain('logo');
    expect(findDocumentDesignTools('POLICE TITRE', 'quotes').map(tool => tool.id)).toEqual(['title-font']);
    expect(findDocumentDesignTools('[.*', 'quotes')).toEqual([]);
    expect(findDocumentDesignTools('   ', 'quotes')).toEqual([]);
  });
  it('does not direct a balance sheet to controls that apply only to recipients or totals', () => {
    expect(findDocumentDesignTools('destinataire', 'accounts')).toEqual([]);
    expect(findDocumentDesignTools('position totaux', 'accounts')).toEqual([]);
    expect(findDocumentDesignTools('commentaire', 'accounts').some(tool => tool.zone === 'closing')).toBe(true);
    expect(findDocumentDesignTools('position totaux', 'quotes')[0].id).toBe('totals');
  });
  it('takes rich text requests to editable zones rather than changing text or amounts', () => {
    for (const kind of ['invoices', 'quotes', 'accounts', 'payslips'] as const) {
      expect(findDocumentDesignTools('gras', kind).every(tool => tool.panel === 'text' && tool.zone)).toBe(true);
      expect(findDocumentDesignTools('police passage', kind)[0].zone).toBe('closing');
    }
  });
});

describe('finding document tools in the selected language', () => {
  const cases = [
    ['fr', 'POLICE TITRE', 'title-font', 'gras', 'commentaire', 'position totaux'],
    ['de', 'TITELSCHRIFT', 'title-font', 'fett', 'Kommentar', 'Position Summen'],
    ['it', 'CARATTERE TITOLO', 'title-font', 'grassetto', 'commento', 'Posizione totali'],
    ['en', 'TITLE FONT', 'title-font', 'bold', 'commentary', 'totals position'],
  ] as const;
  for (const [language, query, expected, richQuery, accountQuery, totalsQuery] of cases) {
    it(`${language}: finds the correct controls and keeps the document type restrictions`, async () => {
      await setAppLanguage(language);
      expect(findDocumentDesignTools(query, 'quotes').map(tool => tool.id)).toContain(expected);
      expect(findDocumentDesignTools('  DÉPLACER logo ', 'quotes').map(tool => tool.id)).toContain('logo');
      expect(findDocumentDesignTools(totalsQuery, 'accounts')).toEqual([]);
      expect(findDocumentDesignTools(accountQuery, 'accounts').map(tool => tool.id)).toContain('closing');
      for (const kind of ['quotes', 'invoices', 'accounts', 'payslips'] as const) {
        const matches = findDocumentDesignTools(richQuery, kind);
        expect(matches.map(tool => tool.id)).toContain('closing');
        expect(matches.every(tool => tool.panel === 'text' && tool.zone)).toBe(true);
        expect(findDocumentDesignTools('[.*', kind)).toEqual([]);
        expect(findDocumentDesignTools('  ', kind)).toEqual([]);
      }
    });
    it(`${language}: every translated result still targets its original real control`, () => {
      for (const tool of documentDesignTools) {
        const result = findDocumentDesignTools(t(tool.label, undefined, language), 'invoices', language).find(found => found.id === tool.id);
        expect(result, tool.id).toEqual(tool);
      }
    });
  }
  it('finds accented and unaccented Swiss German and Italian search words', () => {
    expect(findDocumentDesignTools('SEITENRÄNDER', 'quotes', 'de').map(tool => tool.id)).toContain('margins');
    expect(findDocumentDesignTools('seitenrander', 'quotes', 'de').map(tool => tool.id)).toContain('margins');
    expect(findDocumentDesignTools('AUFZÄHLUNG', 'accounts', 'de').map(tool => tool.id)).toContain('closing');
    expect(findDocumentDesignTools('piè di pagina', 'quotes', 'it').map(tool => tool.id)).toContain('footer');
  });
  it('has complete labels, descriptions and search vocabulary without changing placeholders', () => {
    for (const tool of documentDesignTools) {
      for (const key of [tool.label, tool.description, tool.keywords]) {
        expect(translations[key], key).toHaveLength(3);
        for (const value of translations[key]) expect(value.trim(), key).not.toBe('');
      }
    }
  });
});
