/**
 * Tarifs de régie des associations professionnelles (chef d'équipe, ouvrier
 * qualifié, aide, apprenti, machines). Le client importe le fichier de son
 * association (CSV ou Excel) ; Zentra n'en fournit aucun. Les rapports de
 * régie signés peuvent ensuite être facturés à ces tarifs.
 */
import type { WorkReportLine } from './types';

export type LaborRateKind = 'personnel' | 'machine';
export type LaborRate = { id: string; kind: LaborRateKind; code: string | null; label: string; unit: string; rateCents: number; costCents: number | null };
export type LaborRateTable = { id: string; name: string; source: string; validFrom: string | null; isDefault: boolean; archivedAt: string | null; rates: LaborRate[] };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const integer = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);

export function laborRatesFromRaw(tables: readonly RawRow[], rates: readonly RawRow[]): LaborRateTable[] {
  return tables.map(row => ({
    id: text(row.id), name: text(row.name), source: text(row.source), validFrom: text(row.valid_from) || null,
    isDefault: integer(row.is_default) === 1, archivedAt: text(row.archived_at) || null,
    rates: rates.filter(rate => rate.table_id === row.id).sort((a, b) => integer(a.position) - integer(b.position)).map(rate => ({
      id: text(rate.id), kind: rate.kind === 'machine' ? 'machine' : 'personnel', code: text(rate.code) || null, label: text(rate.label),
      unit: text(rate.unit) || 'h', rateCents: integer(rate.rate_cents), costCents: rate.cost_cents == null ? null : integer(rate.cost_cents),
    })),
  }));
}

/** La table utilisée par défaut : celle marquée, sinon la plus récente active. */
export function defaultRateTable(tables: readonly LaborRateTable[] | undefined): LaborRateTable | null {
  const active = (tables ?? []).filter(table => !table.archivedAt);
  return active.find(table => table.isDefault) ?? [...active].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0] ?? null;
}

const normalized = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const HEADERS: Record<'label' | 'code' | 'unit' | 'rate' | 'cost' | 'kind', string[]> = {
  label: ['categorie', 'designation', 'libelle', 'fonction', 'qualification', 'personnel', 'description', 'bezeichnung', 'kategorie', 'funktion', 'categoria', 'designazione'],
  code: ['code', 'no', 'numero', 'nr', 'reference', 'ref', 'kurzzeichen', 'codice'],
  unit: ['unite', 'unit', 'einheit', 'unita'],
  rate: ['tarif', 'prix', 'taux', 'tarif horaire', 'prix horaire', 'ansatz', 'preis', 'stundenansatz', 'tariffa', 'prezzo', 'chf'],
  cost: ['cout', 'cout horaire', 'prix de revient', 'kosten', 'selbstkosten', 'costo'],
  kind: ['type', 'genre', 'art', 'tipo'],
};
const MACHINE_WORDS = ['machine', 'pelle', 'camion', 'nacelle', 'echafaudage', 'compresseur', 'betonniere', 'grue', 'vehicule', 'fourgon', 'chariot', 'perforateur', 'pompe', 'disqueuse', 'ponceuse', 'maschine', 'bagger', 'fahrzeug', 'geruest', 'kran', 'macchina', 'veicolo'];

function headerKind(header: string): keyof typeof HEADERS | null {
  const value = normalized(header);
  if (!value) return null;
  for (const key of ['cost', 'rate', 'code', 'unit', 'kind', 'label'] as const) {
    if (HEADERS[key].some(word => value === word || value.startsWith(word + ' ') || value.endsWith(' ' + word))) return key;
  }
  return null;
}

/** Montant « 98.50 », « 98,50 », « CHF 1'250.– », ou null. */
export function parseRateAmount(value: string): number | null {
  const cleaned = value.replace(/chf|fr\.?|sfr\.?/gi, '').replace(/[’'\s]/g, '').replace(/[.,][-–]$/, '').replace(/[-–]$/, '');
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

export type ParsedRates = { rates: Omit<LaborRate, 'id'>[]; skipped: number[]; headerRow: number | null };

/**
 * Lit la grille d'un fichier de tarifs : la ligne d'en-tête est cherchée dans
 * les 20 premières lignes (désignation et tarif au moins). Sans en-tête, la
 * première colonne texte est la catégorie et la première colonne chiffrée le tarif.
 */
export function parseRateGrid(grid: readonly (readonly string[])[]): ParsedRates {
  let headerRow: number | null = null;
  let columns: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (let index = 0; index < Math.min(grid.length, 20); index += 1) {
    const found: Partial<Record<keyof typeof HEADERS, number>> = {};
    grid[index].forEach((cell, column) => { const kind = headerKind(cell); if (kind && found[kind] === undefined) found[kind] = column; });
    if (found.label !== undefined && found.rate !== undefined) { headerRow = index; columns = found; break; }
  }
  const rates: Omit<LaborRate, 'id'>[] = [];
  const skipped: number[] = [];
  const start = headerRow === null ? 0 : headerRow + 1;
  for (let index = start; index < grid.length; index += 1) {
    const row = grid[index].map(cell => cell.trim());
    if (!row.some(Boolean)) continue;
    let label: string | undefined, rate: number | null = null;
    if (headerRow === null) {
      label = row.find(cell => cell && parseRateAmount(cell) === null);
      rate = row.map(parseRateAmount).find(value => value !== null) ?? null;
    } else {
      label = row[columns.label!];
      rate = parseRateAmount(row[columns.rate!] ?? '');
    }
    if (!label || rate === null || label.length > 160) { skipped.push(index + 1); continue; }
    const kindCell = columns.kind === undefined ? '' : normalized(row[columns.kind] ?? '');
    const machine = kindCell ? /machine|engin|maschine|gerat|macchin|equipement/.test(kindCell) : MACHINE_WORDS.some(word => normalized(label!).split(' ').includes(word));
    const unit = (columns.unit === undefined ? '' : row[columns.unit]) || 'h';
    const cost = columns.cost === undefined ? null : parseRateAmount(row[columns.cost] ?? '');
    const code = columns.code === undefined ? '' : row[columns.code];
    rates.push({ kind: machine ? 'machine' : 'personnel', code: code ? code.slice(0, 40) : null, label, unit: unit.slice(0, 32), rateCents: rate, costCents: cost });
  }
  return { rates: rates.slice(0, 500), skipped, headerRow };
}

/** Tarif d'une ligne d'heures dans une table : même règle que l'app native. */
export function matchingRate(table: LaborRateTable, line: Pick<WorkReportLine, 'description'> & { laborRateId?: string | null }, allTables: readonly LaborRateTable[]): LaborRate | null {
  if (line.laborRateId) {
    const direct = table.rates.find(rate => rate.id === line.laborRateId);
    if (direct) return direct;
    const source = allTables.flatMap(candidate => candidate.rates).find(rate => rate.id === line.laborRateId);
    const byCode = source?.code ? table.rates.find(rate => rate.code === source.code) : undefined;
    if (byCode) return byCode;
  }
  const label = line.description.trim().toLowerCase();
  return table.rates.find(rate => rate.label.trim().toLowerCase() === label) ?? null;
}

/** Montant HT des heures d'un rapport aux tarifs d'une table (aperçu avant facture). */
export function reportAtRates(lines: readonly (WorkReportLine & { laborRateId?: string | null })[], table: LaborRateTable, allTables: readonly LaborRateTable[]): { netCents: number; repriced: number } {
  let netCents = 0, repriced = 0;
  for (const line of lines) {
    const rate = line.kind === 'labor' ? matchingRate(table, line, allTables) : null;
    if (rate && rate.rateCents !== line.unitPriceCents) repriced += 1;
    netCents += Math.round(line.quantity * (rate ? rate.rateCents : line.unitPriceCents));
  }
  return { netCents, repriced };
}
