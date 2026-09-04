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

  it('préserve les zéros significatifs d’une référence numérique formatée par Excel', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Tarifs');
    sheet.addRow(['Référence', 'Désignation', 'Prix de vente']);
    sheet.addRow([42, 'Pièce numérotée', 19.9]);
    sheet.getCell('A2').numFmt = '000000';
    const output = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(output);
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const preview = await previewCatalogXlsxBuffer('references.xlsx', data);

    expect(preview.rows[0]).toEqual(expect.objectContaining({
      sku: '000042',
      name: 'Pièce numérotée',
      salesPriceCents: 1_990,
      errors: [],
    }));
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

  it('conserve les retours à la ligne et guillemets contenus dans un champ CSV', async () => {
    const csv = [
      'Référence;Désignation;Description;Prix de vente;TVA',
      'MULTI-1;Rapport;"Première ligne\r\nSeconde ligne avec ""guillemets""";125,50;8,1 %',
    ].join('\r\n');
    const file = {
      name: 'catalogue-multiligne.csv',
      size: new TextEncoder().encode(csv).byteLength,
      text: async () => csv,
    } as File;

    const preview = await previewCatalogFile(file);

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toEqual(expect.objectContaining({
      sku: 'MULTI-1',
      description: 'Première ligne\nSeconde ligne avec "guillemets"',
      salesPriceCents: 12_550,
      vatBp: 810,
      errors: [],
    }));
  });

  it('conserve un symbole pouce non entouré de guillemets', async () => {
    const csv = [
      'Référence;Désignation;Description;Prix de vente',
      'DIM-2;Raccord;Filetage 2" renforcé;25,00',
    ].join('\n');
    const file = {
      name: 'dimensions.csv',
      size: new TextEncoder().encode(csv).byteLength,
      text: async () => csv,
    } as File;

    const preview = await previewCatalogFile(file);

    expect(preview.rows[0].description).toBe('Filetage 2" renforcé');
    expect(preview.rows[0].errors).toEqual([]);
  });

  it('explique clairement un champ CSV dont les guillemets ne sont pas refermés', async () => {
    const csv = [
      'Référence;Désignation;Prix de vente',
      'BAD-1;"Désignation inachevée;25.00',
    ].join('\n');
    const file = {
      name: 'catalogue-invalide.csv',
      size: new TextEncoder().encode(csv).byteLength,
      text: async () => csv,
    } as File;

    await expect(previewCatalogFile(file)).rejects.toThrow(/guillemets.*refermé/);
  });

  it('lit les anciens exports CSV Windows-1252 sans perdre les en-têtes accentués', async () => {
    const csv = [
      'Référence;Désignation;Prix de vente',
      'CP-1252;Pièce détachée;49,90',
    ].join('\r\n');
    const bytes = Uint8Array.from(
      Array.from(csv, (character) => character.charCodeAt(0)),
    );
    const file = {
      name: 'ancien-export.csv',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(0),
      text: async () => {
        throw new Error('le chemin de secours ne doit pas être utilisé');
      },
    } as unknown as File;

    const preview = await previewCatalogFile(file);

    expect(preview.rows[0]).toEqual(expect.objectContaining({
      sku: 'CP-1252',
      name: 'Pièce détachée',
      salesPriceCents: 4_990,
      errors: [],
    }));
  });
});
