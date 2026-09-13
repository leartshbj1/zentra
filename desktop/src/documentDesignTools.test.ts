import { describe, expect, it } from 'vitest';
import { findDocumentDesignTools } from './documentDesignTools';

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
