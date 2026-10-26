// Historique des reprises de données et leur annulation. L'app native garde
// chaque import, les fiches créées et l'état d'avant des fiches mises à jour.
import type { MigrationSource } from './migrationSources';

export type DataImportKind = 'clients' | 'suppliers' | 'catalog' | 'accounts' | 'opening_receivables' | 'opening_balance';

export type UndoReport = {
  removed: number;
  restored: number;
  reversed: number;
  kept: { entity: string; id: string; name: string; reason: string }[];
};

export type DataImport = {
  id: string;
  source: MigrationSource;
  kind: DataImportKind;
  fileName: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  createdAt: string;
  undoneAt: string | null;
  undoReport: UndoReport | null;
};

type Raw = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const sources: readonly MigrationSource[] = ['bexio', 'winbiz', 'cresus', 'banana', 'abaninja', 'generic'];
const kinds: readonly DataImportKind[] = ['clients', 'suppliers', 'catalog', 'accounts', 'opening_receivables', 'opening_balance'];

export function undoReportFromRaw(value: unknown): UndoReport | null {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Raw;
  return {
    removed: count(record.removed),
    restored: count(record.restored),
    reversed: count(record.reversed),
    kept: (Array.isArray(record.kept) ? record.kept : []).map((item) => {
      const kept = (item ?? {}) as Raw;
      return { entity: text(kept.entity), id: text(kept.id), name: text(kept.name), reason: text(kept.reason) };
    }),
  };
}

export function dataImportFromRaw(raw: Raw): DataImport {
  const source = text(raw.source) as MigrationSource;
  const kind = text(raw.kind) as DataImportKind;
  return {
    id: text(raw.id),
    source: sources.includes(source) ? source : 'generic',
    kind: kinds.includes(kind) ? kind : 'clients',
    fileName: text(raw.file_name),
    createdCount: count(raw.created_count),
    updatedCount: count(raw.updated_count),
    skippedCount: count(raw.skipped_count),
    createdAt: text(raw.created_at),
    undoneAt: text(raw.undone_at) || null,
    undoReport: undoReportFromRaw(raw.undo_report ?? raw.undo_report_json),
  };
}

export const dataImportKindLabels: Record<DataImportKind, string> = {
  clients: 'Clients',
  suppliers: 'Fournisseurs',
  catalog: 'Articles et services',
  accounts: 'Plan comptable',
  opening_receivables: 'Factures ouvertes',
  opening_balance: 'Bilan d’ouverture',
};

/** Ce qu'Annuler fera, dit avant le clic. */
export function undoExplanation(kind: DataImportKind): string {
  if (kind === 'opening_balance') return 'L’écriture d’ouverture est extournée dans le journal. Vous pourrez ensuite reprendre un autre bilan.';
  if (kind === 'opening_receivables') return 'Les factures encore ouvertes, sans paiement ni rappel, sont annulées et leur écriture est extournée. Les autres restent en place.';
  if (kind === 'catalog') return 'Les articles ajoutés et pas encore utilisés sont supprimés. Les articles mis à jour retrouvent leurs prix d’avant.';
  if (kind === 'accounts') return 'Les comptes ajoutés et encore sans écriture sont supprimés.';
  return 'Les fiches ajoutées et pas encore utilisées sont supprimées. Celles qui servent déjà restent en place.';
}

/** Résumé d'une ligne d'historique, en messages à traduire : « 12 ajouts · 3 déjà présents ». */
export function importSummary(entry: DataImport): { message: string; count: number }[] {
  const part = (count: number, one: string, many: string) => ({ message: count === 1 ? one : many, count });
  const parts = [entry.kind === 'opening_balance'
    ? part(entry.createdCount, '{count} compte repris', '{count} comptes repris')
    : part(entry.createdCount, '{count} ajout', '{count} ajouts')];
  if (entry.updatedCount) parts.push(part(entry.updatedCount, '{count} mise à jour', '{count} mises à jour'));
  if (entry.skippedCount) parts.push(part(entry.skippedCount, '{count} déjà présent', '{count} déjà présents'));
  return parts;
}

export function canUndo(entry: DataImport): boolean {
  return !entry.undoneAt && (entry.createdCount > 0 || entry.updatedCount > 0);
}
