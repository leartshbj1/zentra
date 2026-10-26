// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decodeTradeBytes, tradeCatalogPreviewFromText } from './tradeImport';

describe('catalogues professionnels dans l’assistant d’import', () => {
  it('transforme un fichier Datanorm fictif en aperçu ordinaire avec EAN', () => {
    const preview = tradeCatalogPreviewFromText('grossiste.001', 'V 050;Fictif;\r\nA;N;100200;00;Tube cuivre 15 mm;;1;0;M;1590;;;;\r\nB;N;100200;;;;;;7610000000017;\r\nA;N;100200b;00;Tube cuivre 18 mm;;1;0;M;1890;;;;');
    expect(preview?.sheetName).toBe('Datanorm');
    expect(preview?.rows[0]).toMatchObject({ rowNumber: 2, sku: '100200', name: 'Tube cuivre 15 mm', unit: 'm', salesPriceCents: 1_590, purchaseCostCents: 0, kind: 'product', ean: '7610000000017', tradeSource: 'datanorm', errors: [] });
    expect(preview?.rows).toHaveLength(2);
  });

  it('reprend un catalogue NPK comme prestations et laisse passer les autres fichiers', () => {
    const preview = tradeCatalogPreviewFromText('positions.npk', '314     Peinture\n314.211  Dispersion intérieure, 2 couches   m2   1   18.50');
    expect(preview?.rows[0]).toMatchObject({ sku: '314.211', kind: 'service', unit: 'm²', salesPriceCents: 1_850, tradeSource: 'npk' });
    expect(tradeCatalogPreviewFromText('notes.txt', 'Bonjour, rien à importer')).toBeNull();
  });

  it('décode l’UTF-8 et, à défaut, le Windows-1252 des fichiers DOS', () => {
    expect(decodeTradeBytes(new TextEncoder().encode('Raccord coudé'))).toBe('Raccord coudé');
    expect(decodeTradeBytes(Uint8Array.from([0x63, 0x6f, 0x75, 0x64, 0xe9]))).toBe('coudé');
  });
});
