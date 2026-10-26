// Reprise d'un plan comptable exporté d'un autre logiciel. Ce module lit le
// fichier et propose la nature et la rubrique de chaque compte, d'après la
// colonne de catégorie (BClass de Banana, catégorie de Crésus…) ou, à défaut,
// d'après le numéro du plan comptable PME suisse. L'app native refait les
// contrôles et n'ajoute que les comptes absents.
import { catalogHeaders, type CatalogMappingSource } from './catalogImport';
import type { AccountType, NormalBalance, ReportSection } from './types';

type Cell = CatalogMappingSource['rows'][number][number];

export const chartFields = {
  code: 'N° de compte',
  name: 'Nom du compte',
  nature: 'Catégorie',
  rowType: 'Type de ligne',
} as const;
export type ChartField = keyof typeof chartFields;

const normalize = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const aliases: Record<ChartField, string[]> = {
  code: ['compte', 'n compte', 'no compte', 'n de compte', 'numero', 'numero de compte', 'no', 'nr', 'konto', 'kontonummer', 'konto nr', 'account', 'account number', 'conto', 'numero conto'],
  name: ['nom', 'nom du compte', 'titre', 'libelle', 'designation', 'intitule', 'description', 'bezeichnung', 'kontobezeichnung', 'kontoname', 'name', 'account name', 'descrizione', 'denominazione'],
  nature: ['bclass', 'categorie', 'category', 'classe', 'kategorie', 'nature', 'kontoart', 'kontotyp', 'account type', 'categoria'],
  rowType: ['type', 'typ', 'tipo', 'genre'],
};

function cellText(cell: Cell | undefined): string {
  if (!cell) return '';
  const value = cell.value as unknown;
  if (typeof value === 'string') return value.trim();
  if (cell.displayText) return cell.displayText.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof record.text === 'string') return record.text.trim();
    if (record.richText) return record.richText.map((part) => part.text).join('').trim();
    if (typeof record.result === 'number' || typeof record.result === 'string') return String(record.result).trim();
  }
  return '';
}

export function defaultChartMapping(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const key = normalize(header);
    const match = (Object.keys(aliases) as ChartField[]).find((field) => !used.has(field) && aliases[field].includes(key));
    if (match) used.add(match);
    return match ?? 'ignore';
  });
}

export function chartHeaderScore(headers: string[]): number {
  const fields = defaultChartMapping(headers);
  if (!fields.includes('code') || !fields.includes('name')) return 0;
  return fields.filter((field) => field !== 'ignore').length;
}

export function chartHeaderIndex(source: CatalogMappingSource): number {
  let best = 0;
  let score = 0;
  source.rows.slice(0, 20).forEach((_, index) => {
    const next = defaultChartMapping(catalogHeaders(source, index)).filter((key) => key !== 'ignore').length;
    if (next > score) { best = index; score = next; }
  });
  return best;
}

export type AccountClass = { accountType: AccountType; normalBalance: NormalBalance; reportSection: ReportSection };

/**
 * Nature, solde normal et rubrique d'après le plan comptable PME suisse
 * (classes 1 à 8, numéros à 4 chiffres et plus). Null pour la classe 9 et
 * les numéros qu'on ne sait pas classer.
 */
export function swissAccountClass(code: string): AccountClass | null {
  if (!/^\d{4,8}$/.test(code)) return null;
  const group = Number(code.slice(0, 2));
  const detail = code.slice(2, 4);
  const asset = (reportSection: ReportSection, contra = false): AccountClass => ({ accountType: 'asset', normalBalance: contra ? 'credit' : 'debit', reportSection });
  const result = (accountType: 'revenue' | 'expense', reportSection: ReportSection): AccountClass => ({ accountType, normalBalance: accountType === 'revenue' ? 'credit' : 'debit', reportSection });
  switch (code[0]) {
    case '1':
      // Les corrections de valeur (ducroire, amortissements cumulés) finissent par 9.
      return asset(group <= 13 ? 'current_assets' : 'fixed_assets', code.length === 4 && code.endsWith('9'));
    case '2':
      if (group >= 28) return { accountType: 'equity', normalBalance: group === 28 && detail.startsWith('5') ? 'debit' : 'credit', reportSection: 'equity' };
      return { accountType: 'liability', normalBalance: 'credit', reportSection: group <= 23 ? 'short_term_liabilities' : 'long_term_liabilities' };
    case '3':
      return result('revenue', 'net_revenue');
    case '4':
      return result('expense', 'cost_of_goods');
    case '5':
      return result('expense', 'personnel_expense');
    case '6':
      if (group === 68) return result('expense', 'depreciation');
      if (group === 69) return result(Number(code[2]) >= 5 ? 'revenue' : 'expense', 'financial_result');
      return result('expense', 'other_operating_expense');
    case '7':
      // 7000/7500 : produits des activités annexes ; 7010/7510 : leurs charges.
      return result(detail === '00' ? 'revenue' : 'expense', 'non_operating_result');
    case '8':
      if (group === 89) return result('expense', 'taxes');
      if (group >= 85) return result(detail === '00' ? 'expense' : 'revenue', 'exceptional_result');
      return result(group % 2 === 0 ? 'expense' : 'revenue', 'non_operating_result');
    default:
      return null;
  }
}

const defaultSection: Record<AccountType, ReportSection> = {
  asset: 'current_assets',
  liability: 'short_term_liabilities',
  equity: 'equity',
  revenue: 'net_revenue',
  expense: 'other_operating_expense',
};

const sectionsByType: Record<AccountType, readonly ReportSection[]> = {
  asset: ['current_assets', 'fixed_assets'],
  liability: ['short_term_liabilities', 'long_term_liabilities'],
  equity: ['equity'],
  revenue: ['net_revenue', 'financial_result', 'non_operating_result', 'exceptional_result'],
  expense: ['cost_of_goods', 'personnel_expense', 'other_operating_expense', 'depreciation', 'financial_result', 'non_operating_result', 'exceptional_result', 'taxes'],
};

/** Nature lue dans le fichier : BClass Banana (1 à 4), catégorie Crésus, mots usuels FR/DE/IT/EN. */
export function natureFromText(text: string, code: string): AccountType | 'skip' | null {
  const value = normalize(text);
  if (!value) return null;
  const equityCode = /^2[89]/.test(code);
  if (value === '1' || /^(actif|actifs|aktiv|aktiven|aktivkonto|asset|assets|attivo|attivi)$/.test(value)) return 'asset';
  if (value === '2' || /^(passif|passifs|passiv|passiven|passivkonto|liability|liabilities|passivo|passivi)$/.test(value)) return equityCode ? 'equity' : 'liability';
  if (value === '3' || /^(charge|charges|aufwand|aufwande|expense|expenses|costo|costi)$/.test(value)) return 'expense';
  if (value === '4' || /^(produit|produits|ertrag|ertrage|revenue|revenues|income|ricavo|ricavi)$/.test(value)) return 'revenue';
  if (/^(capital propre|fonds propres|eigenkapital|equity|capitale proprio)$/.test(value)) return 'equity';
  // Crésus « Exploitation » : comptes de bouclement, que Zentra crée lui-même.
  if (/^(exploitation|bouclement|abschluss)/.test(value)) return 'skip';
  return null;
}

export function classFor(code: string, nature: AccountType | null): AccountClass | null {
  const byCode = swissAccountClass(code);
  if (!nature) return byCode;
  if (byCode && byCode.accountType === nature) return byCode;
  const reportSection = byCode && sectionsByType[nature].includes(byCode.reportSection) ? byCode.reportSection : defaultSection[nature];
  return { accountType: nature, normalBalance: nature === 'asset' || nature === 'expense' ? 'debit' : 'credit', reportSection };
}

export type ChartRow = {
  line: number;
  code: string;
  name: string;
  /** Nature choisie à la main dans l'aperçu ; sinon celle du fichier ou du numéro. */
  class: AccountClass | null;
  errors: string[];
  /** Raison d'une ligne écartée sans erreur (titre, groupe, compte déjà présent…). */
  skipped: string | null;
};

export function previewChart(
  source: CatalogMappingSource,
  header: number,
  map: string[],
  existingCodes: readonly string[],
  overrides: Readonly<Record<number, AccountType>> = {},
): ChartRow[] {
  const headers = catalogHeaders(source, header);
  const mapped = map.filter((value) => value !== 'ignore');
  if (map.length !== headers.length || new Set(mapped).size !== mapped.length || mapped.some((key) => !Object.hasOwn(chartFields, key))) {
    throw Error('Chaque champ doit correspondre à une seule colonne.');
  }
  if (!mapped.includes('code') || !mapped.includes('name')) throw Error('Choisissez les colonnes N° de compte et Nom du compte.');
  const existing = new Set(existingCodes.map((code) => code.trim().toUpperCase()));
  const seen = new Set<string>();
  const rows: ChartRow[] = [];
  source.rows.slice(header + 1).forEach((cells, index) => {
    const line = header + index + 2;
    const text = (key: ChartField) => (map.indexOf(key) >= 0 ? cellText(cells[map.indexOf(key)]) : '');
    const code = text('code').replace(/\s+/g, '').toUpperCase();
    const name = text('name').replace(/\s+/g, ' ');
    if (!code && !name) return;
    const rowType = normalize(text('rowType'));
    let skipped: string | null = null;
    if (/^(groupe|titre|group|gruppe|titel|total|somme|summe)/.test(rowType) || !/^\d{4,8}$/.test(code)) skipped = 'Titre ou groupe, pas un compte';
    else if (code.startsWith('9')) skipped = 'Compte de bouclement : Zentra le crée lui-même';
    else if (existing.has(code)) skipped = 'Déjà dans votre plan comptable';
    const nature = natureFromText(text('nature'), code);
    if (!skipped && nature === 'skip') skipped = 'Compte de bouclement : Zentra le crée lui-même';
    const errors: string[] = [];
    let accountClass: AccountClass | null = null;
    if (!skipped) {
      if (seen.has(code)) errors.push('Compte en double dans le fichier');
      seen.add(code);
      if (!name || name.length > 200) errors.push('Nom du compte manquant ou trop long');
      accountClass = classFor(code, overrides[line] ?? (nature === 'skip' ? null : nature));
      if (!accountClass) errors.push('Nature à choisir');
    }
    rows.push({ line, code, name, class: accountClass, errors, skipped });
  });
  if (rows.length > 2000) throw Error('Importez au maximum 2 000 comptes à la fois.');
  return rows;
}

export type NativeAccountRow = { line: number; code: string; name: string; account_type: AccountType; normal_balance: NormalBalance; report_section: ReportSection };

export function chartImportRows(rows: readonly ChartRow[]): NativeAccountRow[] {
  return rows
    .filter((row) => !row.skipped && !row.errors.length && row.class)
    .map((row) => ({ line: row.line, code: row.code, name: row.name, account_type: row.class!.accountType, normal_balance: row.class!.normalBalance, report_section: row.class!.reportSection }));
}

export const accountTypeLabels: Record<AccountType, string> = {
  asset: 'Actif',
  liability: 'Passif',
  equity: 'Fonds propres',
  revenue: 'Produit',
  expense: 'Charge',
};
