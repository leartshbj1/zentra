// Export des écritures vers le logiciel de la fiduciaire : Banana, Crésus,
// Abacus, WinBIZ ou un CSV standard. Le fichier est calculé ici, à partir du
// journal en CHF, sans arrondi ni montant recalculé : chaque ligne du journal
// garde son compte, son côté et son montant.
//
// TVA. Par défaut, les lignes de TVA restent des lignes ordinaires (le solde de
// chaque compte est toujours juste). En mode « codes TVA », une écriture simple
// à un seul taux (une contrepartie, une base, une ligne de TVA) porte le code
// TVA du logiciel cible, qui refait alors la TVA lui-même. Une écriture à taux
// mixtes ou sans code connu garde ses lignes de TVA.
//
// Formats vérifiés dans la documentation publique : Banana (texte avec en-têtes
// XML), Crésus (texte tabulé étendu), Abacus (ASCII Buchungen). Non vérifiés :
// séparateur d'Abacus, contrepartie « ... » des écritures multiples Crésus,
// colonnes de WinBIZ (CSV à associer dans son import paramétrable).
import type { JournalReport } from './types';

export type ExportFormat = 'banana' | 'cresus' | 'abacus' | 'winbiz' | 'csv';
export type VatMode = 'lines' | 'codes';
export type VatDirection = 'sales' | 'purchase';

export const exportFormats: readonly { id: ExportFormat; name: string; extension: 'txt' | 'csv' }[] = [
  { id: 'banana', name: 'Banana', extension: 'txt' },
  { id: 'cresus', name: 'Crésus', extension: 'txt' },
  { id: 'abacus', name: 'Abacus', extension: 'csv' },
  { id: 'winbiz', name: 'WinBIZ', extension: 'csv' },
  { id: 'csv', name: 'CSV standard', extension: 'csv' },
];

/** Taux suisses actuels (2024) et précédents (2018-2023), en points de base. */
export const SWISS_VAT_RATES_BP = [810, 260, 380, 770, 250, 370] as const;

/** Codes proposés par défaut ; ils restent modifiables (plans TVA propres à chaque dossier). */
export const defaultVatCodes: Record<ExportFormat, Record<string, string>> = {
  banana: {
    'sales:810': 'V81', 'sales:260': 'V26', 'sales:380': 'V38', 'sales:770': 'V77', 'sales:250': 'V25', 'sales:370': 'V37',
    'purchase:810': 'M81', 'purchase:260': 'M26', 'purchase:380': 'M38', 'purchase:770': 'M77', 'purchase:250': 'M25', 'purchase:370': 'M37',
  },
  cresus: {},
  abacus: {},
  winbiz: {},
  csv: {},
};

export type ExportLine = { accountId: string; code: string; name: string; debitCents: number; creditCents: number; memo: string };
export type ExportEntry = { id: string; number: string; date: string; description: string; lines: ExportLine[] };

export function entriesFromJournal(report: JournalReport): ExportEntry[] {
  const byEntry = new Map<string, ExportLine[]>();
  for (const line of report.lines) {
    const lines = byEntry.get(line.journalEntryId) ?? [];
    lines.push({ accountId: line.accountId, code: line.accountCode, name: line.accountName, debitCents: line.debitCents, creditCents: line.creditCents, memo: line.memo });
    byEntry.set(line.journalEntryId, lines);
  }
  return report.entries
    .filter((entry) => byEntry.has(entry.id))
    .map((entry) => ({ id: entry.id, number: entry.number, date: entry.entryDate, description: entry.description, lines: byEntry.get(entry.id)! }));
}

export type VatAccounts = { sales: ReadonlySet<string>; purchase: ReadonlySet<string> };

export type VatSplit = { counterpart: number; base: number; vat: number; rateBp: number; direction: VatDirection };

/**
 * Écriture simple à un seul taux : trois lignes, une ligne de TVA, la base du
 * même côté et la contrepartie de l'autre côté pour la somme exacte des deux.
 * Le taux est reconnu à un centime près (arrondi de la ligne).
 */
export function detectVat(entry: ExportEntry, accounts: VatAccounts): VatSplit | null {
  if (entry.lines.length !== 3) return null;
  const vatIndexes = entry.lines.flatMap((line, index) => (accounts.sales.has(line.accountId) || accounts.purchase.has(line.accountId) ? [index] : []));
  if (vatIndexes.length !== 1) return null;
  const vat = vatIndexes[0];
  const side = (line: ExportLine) => (line.debitCents > 0 ? 'debit' : 'credit');
  const amount = (line: ExportLine) => line.debitCents || line.creditCents;
  const vatLine = entry.lines[vat];
  const others = [0, 1, 2].filter((index) => index !== vat);
  const base = others.find((index) => side(entry.lines[index]) === side(vatLine));
  const counterpart = others.find((index) => side(entry.lines[index]) !== side(vatLine));
  if (base === undefined || counterpart === undefined) return null;
  const baseCents = amount(entry.lines[base]);
  const vatCents = amount(vatLine);
  if (baseCents <= 0 || amount(entry.lines[counterpart]) !== baseCents + vatCents) return null;
  const rateBp = SWISS_VAT_RATES_BP.find((rate) => Math.abs(Math.round((baseCents * rate) / 10_000) - vatCents) <= 1);
  if (rateBp === undefined) return null;
  return { counterpart, base, vat, rateBp, direction: accounts.sales.has(vatLine.accountId) ? 'sales' : 'purchase' };
}

export const vatCodeKey = (direction: VatDirection, rateBp: number) => `${direction}:${rateBp}`;

export type ExportOptions = {
  format: ExportFormat;
  vatMode: VatMode;
  /** Numéro de compte Zentra → numéro dans le logiciel cible ; vide = même numéro. */
  accountMap: Readonly<Record<string, string>>;
  vatCodes: Readonly<Record<string, string>>;
  vatAccounts: VatAccounts;
};

export type ExportResult = {
  content: string;
  extension: 'txt' | 'csv';
  entries: number;
  rows: number;
  /** Écritures qui portent un code TVA. */
  coded: number;
  /** Écritures avec TVA qui gardent leurs lignes de TVA (taux mixtes ou code manquant). */
  explicitVat: number;
  /** (sens, taux) rencontrés, pour proposer la correspondance des codes. */
  vatKeys: string[];
};

const cents = (value: number) => {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};
const rate = (bp: number) => `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
const swissDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const oneLine = (value: string) => value.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** Cellule CSV : guillemets si besoin, et jamais de formule de tableur. */
function csvCell(value: string, separator: string): string {
  let text = oneLine(value);
  if (/^[=+@]/.test(text) || (/^-/.test(text) && !/^-?\d+(\.\d+)?$/.test(text))) text = `'${text}`;
  return text.includes(separator) || text.includes('"') ? `"${text.replace(/"/g, '""')}"` : text;
}

type Prepared = { entry: ExportEntry; split: VatSplit | null; code: string; hasVat: boolean };

function prepare(entries: readonly ExportEntry[], options: ExportOptions) {
  const vatKeys = new Set<string>();
  const prepared: Prepared[] = entries.map((entry) => {
    const hasVat = entry.lines.some((line) => options.vatAccounts.sales.has(line.accountId) || options.vatAccounts.purchase.has(line.accountId));
    const split = detectVat(entry, options.vatAccounts);
    if (split) vatKeys.add(vatCodeKey(split.direction, split.rateBp));
    const code = split && options.vatMode === 'codes' ? (options.vatCodes[vatCodeKey(split.direction, split.rateBp)] ?? '').trim() : '';
    return { entry, split: code ? split : null, code, hasVat };
  });
  return { prepared, vatKeys: [...vatKeys].sort() };
}

export function buildAccountingExport(entries: readonly ExportEntry[], options: ExportOptions): ExportResult {
  const account = (line: ExportLine) => (options.accountMap[line.code] ?? '').trim() || line.code;
  const { prepared, vatKeys } = prepare(entries, options);
  const format = exportFormats.find((entry) => entry.id === options.format)!;
  let rows: string[][] = [];
  let header: string[] | null = null;
  let separator = '\t';

  if (options.format === 'banana') {
    header = ['Date', 'Doc', 'Description', 'AccountDebit', 'AccountCredit', 'Amount', 'VatCode'];
    for (const { entry, split, code } of prepared) {
      const text = oneLine(entry.description);
      const row = (line: ExportLine, amountCents: number, vatCode = '') => [entry.date, entry.number, text, line.debitCents ? account(line) : '', line.creditCents ? account(line) : '', cents(amountCents), vatCode];
      if (split) {
        // Banana : la contrepartie pour le total, la base hors TVA avec son code ; Banana passe la TVA.
        const counterpart = entry.lines[split.counterpart];
        const base = entry.lines[split.base];
        rows.push(row(counterpart, counterpart.debitCents || counterpart.creditCents));
        rows.push(row(base, base.debitCents || base.creditCents, code));
      } else if (entry.lines.length === 2 && entry.lines[0].debitCents && entry.lines[1].creditCents && entry.lines[0].debitCents === entry.lines[1].creditCents) {
        rows.push([entry.date, entry.number, text, account(entry.lines[0]), account(entry.lines[1]), cents(entry.lines[0].debitCents), '']);
      } else if (entry.lines.length === 2 && entry.lines[1].debitCents && entry.lines[0].creditCents && entry.lines[1].debitCents === entry.lines[0].creditCents) {
        rows.push([entry.date, entry.number, text, account(entry.lines[1]), account(entry.lines[0]), cents(entry.lines[1].debitCents), '']);
      } else {
        for (const line of entry.lines) rows.push(row(line, line.debitCents || line.creditCents));
      }
    }
  } else if (options.format === 'cresus') {
    let multiple = 0;
    let vatNumber = 0;
    for (const { entry, split, code } of prepared) {
      const text = oneLine(entry.description);
      const date = swissDate(entry.date);
      const simple = !split && entry.lines.length === 2 && Boolean(entry.lines[0].debitCents) !== Boolean(entry.lines[1].debitCents);
      if (simple) {
        const debit = entry.lines.find((line) => line.debitCents)!;
        const credit = entry.lines.find((line) => line.creditCents)!;
        rows.push([date, account(debit), account(credit), entry.number, text, cents(debit.debitCents), '0', '0', '0', '0', '0', '0', '', text, '', '', '', '', '']);
        continue;
      }
      multiple += 1;
      const number = split ? ++vatNumber : 0;
      entry.lines.forEach((line, index) => {
        const coded = split && (index === split.base || index === split.vat);
        rows.push([
          date,
          line.debitCents ? account(line) : '...',
          line.creditCents ? account(line) : '...',
          entry.number,
          text,
          cents(line.debitCents || line.creditCents),
          '0',
          '0',
          String(multiple),
          '0',
          coded ? (split.direction === 'sales' ? '1' : '5') : '0',
          coded ? String(number) : '0',
          coded ? code : '',
          oneLine(line.memo) || text,
          '', '', '', '', '',
        ]);
      });
    }
  } else if (options.format === 'abacus') {
    separator = ',';
    let record = 0;
    const base = (date: string, number: string, text: string, memo: string) => {
      const fields = Array.from({ length: 50 }, () => '');
      fields[1] = 'J';
      fields[2] = date;
      fields[5] = text.slice(0, 80);
      fields[7] = memo.slice(0, 80);
      fields[11] = number.slice(-10);
      fields[23] = 'CHF';
      fields[24] = 'CHF';
      fields[25] = '0';
      fields[36] = '0.00';
      fields[38] = '0';
      fields[40] = '100.00';
      fields[41] = '0';
      fields[42] = '0';
      fields[43] = '0';
      fields[44] = '0.00';
      fields[49] = '0';
      return fields;
    };
    for (const { entry, split, code } of prepared) {
      const text = oneLine(entry.description);
      if (split) {
        const counterpart = entry.lines[split.counterpart];
        const baseLine = entry.lines[split.base];
        const vatLine = entry.lines[split.vat];
        const left = counterpart.debitCents ? counterpart : baseLine;
        const right = counterpart.debitCents ? baseLine : counterpart;
        const fields = base(entry.date, entry.number, text, oneLine(baseLine.memo));
        fields[0] = String(++record);
        fields[3] = account(left);
        fields[4] = account(right);
        fields[6] = cents(counterpart.debitCents || counterpart.creditCents);
        fields[8] = 'D';
        fields[35] = code;
        fields[36] = rate(split.rateBp);
        fields[37] = 'I';
        fields[38] = '1';
        fields[39] = 'CH';
        fields[41] = account(vatLine);
        fields[43] = baseLine === left ? '1' : '2';
        fields[44] = cents(vatLine.debitCents || vatLine.creditCents);
        fields[49] = split.direction === 'sales' ? '1' : '2';
        rows.push(fields);
        continue;
      }
      const debit = entry.lines.filter((line) => line.debitCents);
      const credit = entry.lines.filter((line) => line.creditCents);
      if (debit.length === 1 && credit.length === 1) {
        const fields = base(entry.date, entry.number, text, '');
        fields[0] = String(++record);
        fields[3] = account(debit[0]);
        fields[4] = account(credit[0]);
        fields[6] = cents(debit[0].debitCents);
        fields[8] = 'D';
        rows.push(fields);
        continue;
      }
      for (const line of entry.lines) {
        const fields = base(entry.date, entry.number, text, oneLine(line.memo));
        fields[0] = String(++record);
        fields[3] = account(line);
        fields[4] = '0';
        fields[6] = cents(line.debitCents || line.creditCents);
        fields[8] = line.debitCents ? 'D' : 'C';
        rows.push(fields);
      }
    }
  } else {
    // WinBIZ et CSV standard : une ligne par mouvement, point-virgule.
    separator = ';';
    header = ['Date', 'Pièce', 'Compte débit', 'Compte crédit', 'Libellé', 'Montant CHF', 'Code TVA', 'Taux TVA', 'Montant TVA'];
    const date = (iso: string) => (options.format === 'winbiz' ? swissDate(iso) : iso);
    for (const { entry, split, code } of prepared) {
      const text = entry.description;
      if (!split && entry.lines.length === 2 && entry.lines[0].debitCents && entry.lines[0].debitCents === entry.lines[1].creditCents) {
        rows.push([date(entry.date), entry.number, account(entry.lines[0]), account(entry.lines[1]), text, cents(entry.lines[0].debitCents), '', '', '']);
        continue;
      }
      entry.lines.forEach((line, index) => {
        const vat = split && index === split.base ? entry.lines[split.vat] : null;
        rows.push([
          date(entry.date),
          entry.number,
          line.debitCents ? account(line) : '',
          line.creditCents ? account(line) : '',
          line.memo && line.memo !== entry.description ? `${text} · ${line.memo}` : text,
          cents(line.debitCents || line.creditCents),
          vat ? code : '',
          vat && split ? rate(split.rateBp) : '',
          vat ? cents(vat.debitCents || vat.creditCents) : '',
        ]);
      });
    }
  }

  const write = (cells: string[]) => cells.map((cell) => (separator === '\t' ? oneLine(cell) : csvCell(cell, separator))).join(separator);
  const lines = [...(header ? [write(header)] : []), ...rows.map(write)];
  // Banana lit les noms de colonnes tels quels : pas de BOM. Les CSV en ont un pour Excel.
  const bom = format.extension === 'csv' ? '﻿' : '';
  const coded = prepared.filter((item) => item.split).length;
  return {
    content: bom + lines.join('\r\n') + '\r\n',
    extension: format.extension,
    entries: entries.length,
    rows: rows.length,
    coded,
    explicitVat: prepared.filter((item) => item.hasVat && !item.split).length,
    vatKeys,
  };
}

export function exportFileName(format: ExportFormat, dateFrom: string, dateTo: string): string {
  const { extension } = exportFormats.find((entry) => entry.id === format)!;
  return `Zentra-ecritures-${format}-${dateFrom}-${dateTo}.${extension}`;
}

/** Comptes de TVA d'après les comptes de liaison, avec les numéros PME usuels en repli. */
export function vatAccountsFrom(
  accounts: readonly { id: string; code: string }[],
  settings: { vatPayableAccountId?: string; vatDeferredPayableAccountId?: string; vatReceivableAccountId?: string } | null,
): VatAccounts {
  const sales = new Set<string>([settings?.vatPayableAccountId, settings?.vatDeferredPayableAccountId].filter((id): id is string => Boolean(id)));
  const purchase = new Set<string>([settings?.vatReceivableAccountId].filter((id): id is string => Boolean(id)));
  for (const account of accounts) {
    if (/^220[01]$/.test(account.code) && !purchase.has(account.id)) sales.add(account.id);
    if (/^117[0-3]$/.test(account.code) && !sales.has(account.id)) purchase.add(account.id);
  }
  return { sales, purchase };
}
