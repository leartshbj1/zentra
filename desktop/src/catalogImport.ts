import type { CatalogItem } from './types';

export const CATALOG_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const CATALOG_IMPORT_MAX_ROWS = 5_000;

export type CatalogImportColumn =
  | 'sku'
  | 'name'
  | 'description'
  | 'unit'
  | 'purchaseCostCents'
  | 'salesPriceCents'
  | 'vatBp'
  | 'kind';

export type CatalogImportRow = {
  rowNumber: number;
  sku: string;
  name: string;
  description: string;
  unit: string;
  purchaseCostCents: number;
  salesPriceCents: number;
  vatBp: number;
  kind: CatalogItem['kind'];
  errors: string[];
};

export type CatalogImportPreviewRow = Omit<CatalogImportRow, 'vatBp'> & {
  /** null means that no usable VAT value was present in the source cell. */
  vatBp: number | null;
};

export type CatalogImportPreview = {
  fileName: string;
  sheetName: string;
  headerRowNumber: number;
  columns: Partial<Record<CatalogImportColumn, string>>;
  rows: CatalogImportPreviewRow[];
  ignoredRows: number;
  warnings: string[];
};

type GridCell = { value: unknown; numberFormat?: string };
type GridRow = GridCell[];

const HEADER_ALIASES: Record<CatalogImportColumn, string[]> = {
  sku: [
    'reference',
    'ref',
    'sku',
    'no article',
    'numero article',
    'numero d article',
    'code article',
    'reference article',
    'reference fournisseur',
    'ref fournisseur',
    'numero de reference',
    'n article',
    'article no',
    'artikelnummer',
    'artikel nr',
    'art nr',
    'product code',
  ],
  name: [
    'nom',
    'designation',
    'article',
    'produit',
    'service',
    'libelle',
    'product name',
    'designation article',
    'bezeichnung',
    'produktname',
    'descrizione',
  ],
  description: ['description', 'details', 'detail', 'texte', 'text'],
  unit: [
    'unite',
    'unite de vente',
    'unit',
    'uom',
    'conditionnement',
    'einheit',
    'mengeneinheit',
    'unita',
  ],
  purchaseCostCents: [
    'prix achat',
    'prix d achat',
    'cout achat',
    'cout',
    'purchase price',
    'cost price',
    'prix fournisseur',
    'prix achat chf',
    'pa',
    'einkaufspreis',
    'ek preis',
  ],
  salesPriceCents: [
    'prix vente',
    'prix de vente',
    'tarif vente',
    'tarif',
    'sales price',
    'selling price',
    'prix de vente chf',
    'prix vente chf',
    'prix vente ht',
    'prix catalogue',
    'prix public',
    'prix unitaire',
    'prix unitaire ht',
    'pv',
    'verkaufspreis',
    'vk preis',
    'listenpreis',
  ],
  vatBp: [
    'tva',
    'taux tva',
    'vat',
    'vat rate',
    'mwst',
    'mwst satz',
    'mehrwertsteuer',
    'iva',
  ],
  kind: [
    'type',
    'genre',
    'nature',
    'product service',
    'produit service',
    'artikelart',
    'produkttyp',
  ],
};

function normalizedHeader(value: unknown): string {
  return cellText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value).trim();
  const record = value as Record<string, unknown>;
  if (record.result !== undefined && record.result !== null) return cellText(record.result);
  if (typeof record.text === 'string') return record.text.trim();
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) =>
        part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : '',
      )
      .join('')
      .trim();
  }
  if (typeof record.hyperlink === 'string') return cellText(record.text ?? record.hyperlink);
  return '';
}

function headerKey(value: unknown): CatalogImportColumn | null {
  const normalized = normalizedHeader(value);
  if (!normalized) return null;
  for (const [column, aliases] of Object.entries(HEADER_ALIASES) as Array<[
    CatalogImportColumn,
    string[],
  ]>) {
    if (aliases.includes(normalized)) return column;
  }
  return null;
}

function priceCents(cell: GridCell): number | null {
  if (typeof cell.value === 'number') {
    return Number.isFinite(cell.value) ? Math.round(cell.value * 100) : null;
  }
  const raw = cellText(cell.value);
  if (!raw) return null;
  let normalized = raw
    .replace(/[\s\u00a0'’]/g, '')
    .replace(/(?:chf|fr\.?|eur|€|\$)/gi, '')
    .replace(/[^0-9,.-]/g, '');
  if (!/\d/.test(normalized)) return null;
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    normalized = normalized.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) {
    normalized = normalized.replace(/,/g, '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function vatBasisPoints(cell: GridCell): number | null {
  if (cell.value === null || cell.value === undefined || cellText(cell.value) === '') return null;
  const raw = typeof cell.value === 'number'
    ? cell.value
    : Number(cellText(cell.value).replace('%', '').replace(',', '.').trim());
  if (!Number.isFinite(raw)) return null;
  const formattedAsPercent = cell.numberFormat?.includes('%') === true;
  const percentage = formattedAsPercent || (raw > 0 && raw <= 1) ? raw * 100 : raw;
  return Math.round(percentage * 100);
}

function itemKind(value: unknown): CatalogItem['kind'] {
  const normalized = normalizedHeader(value);
  return /service|prestation|travail|heure/.test(normalized) ? 'service' : 'product';
}

function mappedColumns(row: GridRow): Map<CatalogImportColumn, number> {
  const result = new Map<CatalogImportColumn, number>();
  row.forEach((cell, index) => {
    const key = headerKey(cell.value);
    if (key && !result.has(key)) result.set(key, index);
  });
  return result;
}

function findHeader(rows: GridRow[]): { rowIndex: number; columns: Map<CatalogImportColumn, number> } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const columns = mappedColumns(rows[rowIndex]);
    if (columns.has('sku') && columns.has('name') && columns.has('salesPriceCents')) {
      return { rowIndex, columns };
    }
  }
  throw new Error(
    'Colonnes introuvables. Le fichier doit contenir au minimum Référence, Désignation et Prix de vente.',
  );
}

function rowCell(row: GridRow, columns: Map<CatalogImportColumn, number>, key: CatalogImportColumn): GridCell {
  const index = columns.get(key);
  return index === undefined ? { value: null } : (row[index] ?? { value: null });
}

export function previewCatalogGrid(
  fileName: string,
  sheetName: string,
  rows: GridRow[],
): CatalogImportPreview {
  const { rowIndex: headerIndex, columns } = findHeader(rows);
  const warnings: string[] = [];
  if (!columns.has('purchaseCostCents')) {
    warnings.push('Aucune colonne de prix d’achat détectée : la valeur 0 sera utilisée.');
  }
  if (!columns.has('vatBp')) {
    warnings.push('Aucune colonne TVA détectée : confirmez le taux à appliquer avant l’import.');
  }
  if (!columns.has('unit')) {
    warnings.push('Aucune colonne unité détectée : « unité » sera utilisée.');
  }

  const parsedRows: CatalogImportPreviewRow[] = [];
  let ignoredRows = 0;
  const seenSku = new Set<string>();
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const source = rows[index];
    const sku = cellText(rowCell(source, columns, 'sku').value);
    const name = cellText(rowCell(source, columns, 'name').value);
    const sale = priceCents(rowCell(source, columns, 'salesPriceCents'));
    const purchase = priceCents(rowCell(source, columns, 'purchaseCostCents'));
    const vatCell = rowCell(source, columns, 'vatBp');
    const vatCellIsEmpty = cellText(vatCell.value) === '';
    const vat = vatBasisPoints(vatCell);
    const hasAnyValue = source.some((cell) => cellText(cell.value) !== '');
    if (!hasAnyValue) {
      ignoredRows += 1;
      continue;
    }
    if (parsedRows.length >= CATALOG_IMPORT_MAX_ROWS) {
      throw new Error(`Le catalogue dépasse la limite de ${CATALOG_IMPORT_MAX_ROWS.toLocaleString('fr-CH')} lignes.`);
    }
    const errors: string[] = [];
    if (!sku) errors.push('Référence manquante');
    if (!name) errors.push('Désignation manquante');
    if (sale === null || sale < 0) errors.push('Prix de vente invalide');
    if (purchase !== null && purchase < 0) errors.push('Prix d’achat invalide');
    if (!vatCellIsEmpty && (vat === null || vat < 0 || vat > 10_000)) {
      errors.push('Taux TVA invalide');
    }
    const normalizedSku = sku.toLocaleLowerCase('fr-CH');
    if (normalizedSku && seenSku.has(normalizedSku)) errors.push('Référence dupliquée dans le fichier');
    if (normalizedSku) seenSku.add(normalizedSku);
    parsedRows.push({
      rowNumber: index + 1,
      sku,
      name,
      description: cellText(rowCell(source, columns, 'description').value),
      unit: cellText(rowCell(source, columns, 'unit').value) || 'unité',
      purchaseCostCents: purchase ?? 0,
      salesPriceCents: sale ?? 0,
      vatBp: vat,
      kind: itemKind(rowCell(source, columns, 'kind').value),
      errors,
    });
  }
  if (!parsedRows.length) throw new Error('Le fichier ne contient aucune ligne de catalogue sous les en-têtes.');
  if (columns.has('vatBp')) {
    const missingVatRows = parsedRows.filter((row) => row.vatBp === null && !row.errors.includes('Taux TVA invalide')).length;
    if (missingVatRows > 0) {
      warnings.push(
        `${missingVatRows.toLocaleString('fr-CH')} ligne${missingVatRows > 1 ? 's' : ''} sans TVA : confirmez le taux à appliquer uniquement à ${missingVatRows > 1 ? 'ces lignes' : 'cette ligne'}.`,
      );
    }
  }
  return {
    fileName,
    sheetName,
    headerRowNumber: headerIndex + 1,
    columns: Object.fromEntries(
      Array.from(columns.entries()).map(([key, index]) => [key, cellText(rows[headerIndex][index]?.value)]),
    ),
    rows: parsedRows,
    ignoredRows,
    warnings,
  };
}

function csvSeparator(lines: string[]): ',' | ';' | '\t' {
  const candidates = [',', ';', '\t'] as const;
  const samples = lines.filter((line) => line.trim() !== '').slice(0, 20);
  let best: (typeof candidates)[number] = ',';
  let bestScore = -1;
  for (const separator of candidates) {
    let score = 0;
    for (const line of samples) {
      const cells = parseCsvLine(line, separator).map((value) => ({ value }));
      const columns = mappedColumns(cells);
      const requiredColumns = Number(columns.has('sku'))
        + Number(columns.has('name'))
        + Number(columns.has('salesPriceCents'));
      // A recognizable catalogue header is a much stronger signal than punctuation
      // in a title or description line.
      score = Math.max(
        score,
        requiredColumns * 10_000 + columns.size * 100 + Math.max(0, cells.length - 1),
      );
    }
    if (score > bestScore) {
      best = separator;
      bestScore = score;
    }
  }
  return best;
}

function parseCsvLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

async function workbookRows(file: File): Promise<{ sheetName: string; rows: GridRow[] }> {
  if (file.size > CATALOG_IMPORT_MAX_BYTES) {
    throw new Error('Le fichier dépasse 20 Mo. Réduisez le catalogue avant de recommencer.');
  }
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'csv' || extension === 'tsv') {
    const text = (await file.text()).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const separator = extension === 'tsv' ? '\t' : csvSeparator(lines);
    return {
      sheetName: extension.toUpperCase(),
      rows: lines.map((line) => parseCsvLine(line, separator).map((value) => ({ value }))),
    };
  }
  if (extension !== 'xlsx') {
    throw new Error('Format non pris en charge. Choisissez un fichier .xlsx, .csv ou .tsv.');
  }
  return xlsxRows(await file.arrayBuffer());
}

async function xlsxRows(data: ArrayBuffer): Promise<{ sheetName: string; rows: GridRow[] }> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(data);
  const worksheets = workbook.worksheets.filter((candidate) => candidate.actualRowCount > 0);
  if (!worksheets.length) throw new Error('Le classeur Excel ne contient aucune feuille lisible.');
  let fallback: { sheetName: string; rows: GridRow[] } | null = null;
  for (const worksheet of worksheets) {
    if (worksheet.actualRowCount > CATALOG_IMPORT_MAX_ROWS + 20) {
      throw new Error(
        `La feuille « ${worksheet.name} » dépasse la limite de ${CATALOG_IMPORT_MAX_ROWS.toLocaleString('fr-CH')} lignes de catalogue.`,
      );
    }
    if (worksheet.actualColumnCount > 100) {
      throw new Error(`La feuille « ${worksheet.name} » contient trop de colonnes pour un catalogue.`);
    }
    const rows: GridRow[] = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      while (rows.length < rowNumber - 1) rows.push([]);
      const cells: GridRow = [];
      const lastCell = Math.max(row.actualCellCount, row.cellCount);
      for (let column = 1; column <= lastCell; column += 1) {
        const cell = row.getCell(column);
        cells.push({ value: cell.value, numberFormat: cell.numFmt });
      }
      rows.push(cells);
    });
    const candidate = { sheetName: worksheet.name, rows };
    fallback ??= candidate;
    try {
      findHeader(rows);
      return candidate;
    } catch {
      // Les catalogues fournisseurs contiennent souvent une feuille de garde.
    }
  }
  return fallback!;
}

export async function previewCatalogXlsxBuffer(
  fileName: string,
  data: ArrayBuffer,
): Promise<CatalogImportPreview> {
  if (data.byteLength > CATALOG_IMPORT_MAX_BYTES) {
    throw new Error('Le fichier dépasse 20 Mo. Réduisez le catalogue avant de recommencer.');
  }
  const { sheetName, rows } = await xlsxRows(data);
  return previewCatalogGrid(fileName, sheetName, rows);
}

export async function previewCatalogFile(file: File): Promise<CatalogImportPreview> {
  const { sheetName, rows } = await workbookRows(file);
  return previewCatalogGrid(file.name, sheetName, rows);
}

export function applyCatalogVatFallback(
  rows: CatalogImportPreviewRow[],
  fallbackVatBp: number,
): CatalogImportRow[] {
  return rows.map((row) => ({
    ...row,
    // Null represents a blank/unusable source value; an explicit numeric 0 is retained.
    vatBp: row.vatBp ?? fallbackVatBp,
  }));
}
