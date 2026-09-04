import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import {
  applyCatalogVatFallback,
  previewCatalogFile,
  previewCatalogGrid,
  previewCatalogXlsxBuffer,
} from './catalogImport';

const cells = (...values: unknown[]) => values.map((value) => ({ value }));

describe('catalogue fournisseur', () => {
  it('détecte des en-têtes français et conserve les valeurs réelles', () => {
    const preview = previewCatalogGrid('tarif.xlsx', 'Produits', [
      cells('Catalogue fournisseur 2026'),
      cells('Référence', 'Désignation', 'Description', 'Unité', "Prix d’achat", 'Prix de vente', 'TVA', 'Type'),
      cells('A-100', 'Cheville', 'Boîte de 100', 'boîte', "12'345.60 CHF", '15’000,50', '8,1 %', 'Produit'),
      cells('S-20', 'Pose', '', 'heure', 75, 120, 0.081, 'Prestation'),
    ]);

    expect(preview.headerRowNumber).toBe(2);
    expect(preview.rows).toEqual([
      expect.objectContaining({
        sku: 'A-100',
        name: 'Cheville',
        purchaseCostCents: 1_234_560,
        salesPriceCents: 1_500_050,
        vatBp: 810,
        kind: 'product',
        errors: [],
      }),
      expect.objectContaining({
        sku: 'S-20',
        salesPriceCents: 12_000,
        vatBp: 810,
        kind: 'service',
        errors: [],
      }),
    ]);
  });

  it('bloque les références dupliquées et les montants invalides', () => {
    const preview = previewCatalogGrid('tarif.xlsx', 'Feuil1', [
      cells('SKU', 'Nom', 'Prix de vente'),
      cells('ABC', 'Article 1', 10),
      cells('abc', 'Article 2', 'invalide'),
      cells('', '', ''),
    ]);

    expect(preview.ignoredRows).toBe(1);
    expect(preview.rows[1].errors).toEqual([
      'Prix de vente invalide',
      'Référence dupliquée dans le fichier',
    ]);
  });

  it('refuse un fichier sans les trois colonnes indispensables', () => {
    expect(() =>
      previewCatalogGrid('tarif.xlsx', 'Feuil1', [cells('Article', 'Coût'), cells('X', 4)]),
    ).toThrow(/Référence, Désignation et Prix de vente/);
  });

  it('lit un vrai classeur xlsx et ses pourcentages Excel', async () => {
    const workbook = new Workbook();
    workbook.addWorksheet('Couverture').addRow(['Catalogue 2026', 'Confidentiel']);
    const sheet = workbook.addWorksheet('Tarifs fournisseur');
    sheet.addRow(['Référence fournisseur', 'Désignation article', 'Prix achat CHF', 'Prix de vente CHF', 'TVA', 'Unité de vente']);
    sheet.addRow(['FOUR-17', 'Robinet chromé', 82.4, 129.9, 0.081, 'pièce']);
    sheet.getCell('E2').numFmt = '0.0%';
    const output = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(output);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const preview = await previewCatalogXlsxBuffer('catalogue-reel.xlsx', data);

    expect(preview.sheetName).toBe('Tarifs fournisseur');
    expect(preview.rows).toEqual([
      expect.objectContaining({
        sku: 'FOUR-17',
        name: 'Robinet chromé',
        purchaseCostCents: 8_240,
        salesPriceCents: 12_990,
        vatBp: 810,
        unit: 'pièce',
        errors: [],
      }),
    ]);
  });

  it('reconnaît aussi les intitulés usuels des catalogues suisses allemands', () => {
    const preview = previewCatalogGrid('preisliste.xlsx', 'Artikel', [
      cells('Artikelnummer', 'Bezeichnung', 'Einkaufspreis', 'Verkaufspreis', 'MWST Satz', 'Einheit'),
      cells('ZH-42', 'Montageset', 25, 49.9, '8.1 %', 'Stück'),
    ]);

    expect(preview.rows[0]).toEqual(
      expect.objectContaining({
        sku: 'ZH-42',
        name: 'Montageset',
        purchaseCostCents: 2_500,
        salesPriceCents: 4_990,
        vatBp: 810,
        unit: 'Stück',
        errors: [],
      }),
    );
  });

  it('applique la TVA de repli uniquement aux cellules vides et conserve un vrai taux de 0 %', () => {
    const preview = previewCatalogGrid('tarif.xlsx', 'Produits', [
      cells('Référence', 'Désignation', 'Prix de vente', 'TVA'),
      cells('EXO-0', 'Article exonéré', 10, 0),
      cells('STD-1', 'Article sans taux renseigné', 20, ''),
      cells('BAD-1', 'Article avec taux illisible', 30, 'taux inconnu'),
    ]);

    expect(preview.rows.map((row) => row.vatBp)).toEqual([0, null, null]);
    expect(preview.rows[2].errors).toContain('Taux TVA invalide');
    expect(preview.warnings).toContain(
      '1 ligne sans TVA : confirmez le taux à appliquer uniquement à cette ligne.',
    );

    const importedRows = applyCatalogVatFallback(preview.rows, 810);
    expect(importedRows.map((row) => row.vatBp)).toEqual([0, 810, 810]);
  });

  it('détecte le séparateur CSV sur la ligne d’en-tête après une ligne de garde', async () => {
    const csv = [
      'Catalogue fournisseur, septembre 2026',
      'Référence;Désignation;Prix de vente;TVA',
      'SEM-1;Mèche béton;12,50;8,1 %',
    ].join('\n');
    const file = {
      name: 'catalogue.csv',
      size: new TextEncoder().encode(csv).byteLength,
      text: async () => csv,
    } as File;

    const preview = await previewCatalogFile(file);

    expect(preview.headerRowNumber).toBe(2);
    expect(preview.rows[0]).toEqual(expect.objectContaining({
      sku: 'SEM-1',
      name: 'Mèche béton',
      salesPriceCents: 1_250,
      vatBp: 810,
      errors: [],
    }));
  });
});
