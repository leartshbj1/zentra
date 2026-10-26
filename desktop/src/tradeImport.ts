/**
 * Catalogues professionnels dans l'assistant d'import : Datanorm, BMEcat et
 * NPK / CAN deviennent un aperçu ordinaire (mêmes contrôles, même import).
 */
import { CATALOG_IMPORT_MAX_BYTES, CATALOG_IMPORT_MAX_ROWS, recheckCatalogRows, type CatalogImportPreview } from './catalogImport';
import { detectTradeFormat, npkCatalog, parseBmecat, parseDatanorm, parseNpkText, type TradeCatalog, type XmlNode } from './tradeFormats';

/** Texte d'un fichier : UTF-8 si valide, sinon Windows-1252 (fichiers DOS des grossistes). */
export function decodeTradeBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes).replace(/^﻿/, '');
  }
}

const parseXml = (xml: string): XmlNode | null => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  return document.getElementsByTagName('parsererror').length ? null : (document.documentElement as unknown as XmlNode);
};

const FORMAT_LABEL: Record<TradeCatalog['format'], string> = { datanorm: 'Datanorm', bmecat: 'BMEcat', npk: 'NPK / CAN' };

/** Aperçu d'import d'un catalogue professionnel, ou null si le fichier n'en est pas un. */
export function tradeCatalogPreviewFromText(fileName: string, text: string): CatalogImportPreview | null {
  const format = detectTradeFormat(fileName, text.slice(0, 4_000));
  if (!format) return null;
  const catalog = format === 'datanorm' ? parseDatanorm(text) : format === 'bmecat' ? parseBmecat(text, parseXml) : npkCatalog(parseNpkText(text));
  const warnings = [...catalog.warnings];
  if (catalog.articles.length > CATALOG_IMPORT_MAX_ROWS) {
    warnings.push(`Le fichier contient ${catalog.articles.length} articles : les ${CATALOG_IMPORT_MAX_ROWS} premiers sont repris. Importez la suite avec un fichier partiel.`);
  }
  const rows = recheckCatalogRows(catalog.articles.slice(0, CATALOG_IMPORT_MAX_ROWS).map((article, index) => ({
    rowNumber: index + 2, sku: article.sku, name: article.name, description: article.description, unit: article.unit,
    purchaseCostCents: article.purchaseCostCents, salesPriceCents: article.salesPriceCents, vatBp: article.vatBp,
    kind: format === 'npk' ? 'service' as const : 'product' as const, errors: [],
    ...(article.ean ? { ean: article.ean } : {}), tradeSource: format,
  })));
  return {
    fileName, sheetName: FORMAT_LABEL[format], headerRowNumber: 1,
    columns: { sku: 'Numéro d’article', name: 'Désignation', unit: 'Unité', purchaseCostCents: 'Prix net', salesPriceCents: 'Prix public' },
    rows, ignoredRows: Math.max(0, catalog.articles.length - CATALOG_IMPORT_MAX_ROWS), warnings,
  };
}

export async function tradeCatalogPreview(file: File): Promise<CatalogImportPreview | null> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  // Les tableurs passent par l'import ordinaire (colonnes à associer).
  if (['xlsx', 'csv', 'tsv'].includes(extension)) return null;
  if (file.size > CATALOG_IMPORT_MAX_BYTES * 3) throw new Error('Le fichier dépasse 60 Mo. Demandez au grossiste un extrait par groupe d’articles.');
  const text = decodeTradeBytes(new Uint8Array(await file.arrayBuffer()));
  return tradeCatalogPreviewFromText(file.name, text);
}
