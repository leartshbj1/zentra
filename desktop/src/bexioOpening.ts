// Reprise d'ouverture depuis bexio, WinBIZ, Crésus, Banana, AbaNinja/Swiss21
// ou un fichier Excel : factures clients encore ouvertes et
// bilan d'ouverture. Ce module lit seulement le fichier et prépare un aperçu ;
// l'app native contrôle chaque ligne et passe elle-même les écritures.
import { catalogHeaders, type CatalogMappingSource } from './catalogImport';
import type { Client } from './types';

type Cell = CatalogMappingSource['rows'][number][number];

const normalize = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function mapping<F extends string>(aliases: Record<F, string[]>, headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const key = normalize(header);
    const match = (Object.keys(aliases) as F[]).find((field) => !used.has(field) && aliases[field].includes(key));
    if (match) used.add(match);
    return match ?? 'ignore';
  });
}

function bestHeader(source: CatalogMappingSource, map: (headers: string[]) => string[]): number {
  let best = 0;
  let score = 0;
  source.rows.slice(0, 20).forEach((_, index) => {
    const next = map(catalogHeaders(source, index)).filter((key) => key !== 'ignore').length;
    if (next > score) { best = index; score = next; }
  });
  return best;
}

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

/** « 1'234.50 », « 1 234,50 CHF », « -80.00 », 1234.5 → centimes ; null si illisible. */
export function amountCents(cell: Cell | string | number | undefined): number | null {
  const value = typeof cell === 'object' && cell !== null ? (cell.value as unknown) : cell;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (value && typeof value === 'object' && typeof (value as { result?: unknown }).result === 'number') {
    return amountCents((value as { result: number }).result);
  }
  let text = (typeof cell === 'object' && cell !== null ? cellText(cell) : String(value ?? '')).trim();
  if (!text) return null;
  text = text.replace(/[\s '’]/g, '').replace(/^(?:chf|fr\.?)|(?:chf|fr\.?)$/gi, '');
  // « 80.- » : notation suisse pour 80 francs ronds.
  text = text.replace(/[.,][-–]$/, ".00");
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.endsWith('-')) { negative = true; text = text.slice(0, -1); }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  if (!/^[0-9.,]+$/.test(text) || !/\d/.test(text)) return null;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    text = text.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (comma >= 0) {
    // « 1,234 » est un millier, « 12,50 » des centimes.
    text = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if ((text.match(/\./g) ?? []).length > 1) {
    text = text.replace(/\./g, '');
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  const cents = Math.round(parsed * 100);
  return negative ? -cents : cents;
}

const iso = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
};

/** Date Excel, « 31.12.2025 », « 31/12/25 » ou « 2025-12-31 » → AAAA-MM-JJ. */
export function isoDate(cell: Cell | string | undefined): string | null {
  const value = typeof cell === 'object' && cell !== null ? (cell.value as unknown) : cell;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : iso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number' && value > 20_000 && value < 80_000) {
    // Numéro de série Excel (système 1900).
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const text = typeof cell === 'object' && cell !== null ? cellText(cell) : String(value ?? '').trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(text);
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return iso(year, Number(match[2]), Number(match[1]));
  }
  return null;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/* ---------- Factures ouvertes ---------- */

export const openInvoiceFields = {
  number: 'N° de facture',
  client: 'Client',
  title: 'Titre',
  issueDate: 'Date',
  dueDate: 'Échéance',
  total: 'Total',
  open: 'Montant ouvert',
  status: 'Statut',
} as const;
export type OpenInvoiceField = keyof typeof openInvoiceFields;

const invoiceAliases: Record<OpenInvoiceField, string[]> = {
  number: ['n', 'no', 'nr', 'numero', 'n de facture', 'no de facture', 'numero de facture', 'n facture', 'no facture', 'rechnungsnummer', 'rechnung nr', 'rechnungs nr', 'invoice number', 'invoice no', 'document nr', 'dokument nr', 'numero fattura', 'n fattura', 'fattura n', 'n document', 'no document', 'numero de document', 'facture', 'belegnummer', 'beleg nr', 'docinvoice'],
  client: ['contact', 'client', 'kontakt', 'kunde', 'customer', 'cliente', 'contatto', 'destinataire', 'empfanger', 'empfaenger', 'nom du client', 'debiteur', 'debitor', 'kundenname', 'raison sociale', 'societe'],
  title: ['titre', 'title', 'titel', 'objet', 'betreff', 'titolo', 'oggetto'],
  issueDate: ['date', 'datum', 'date de facture', 'date facture', 'rechnungsdatum', 'invoice date', 'data', 'data fattura', 'date document', 'date du document', 'belegdatum'],
  dueDate: ['echeance', 'date d echeance', 'echeance le', 'fallig', 'fallig am', 'faellig am', 'falligkeit', 'falligkeitsdatum', 'due date', 'due', 'scadenza', 'zahlbar bis', 'payable jusqu au', 'valable jusqu au', 'gultig bis'],
  total: ['total', 'montant', 'montant total', 'total chf', 'total ttc', 'betrag', 'gesamtbetrag', 'total inkl mwst', 'amount', 'importo', 'totale', 'montant ttc', 'brutto', 'betrag brutto', 'total brut'],
  open: ['ouvert', 'montant ouvert', 'solde', 'solde ouvert', 'reste', 'reste a payer', 'offen', 'offener betrag', 'restbetrag', 'open', 'open amount', 'outstanding', 'aperto', 'importo aperto', 'saldo', 'solde du', 'montant du', 'reste du', 'offener saldo', 'offen chf'],
  status: ['statut', 'status', 'stato', 'etat'],
};

export const defaultOpenInvoiceMapping = (headers: string[]) => mapping(invoiceAliases, headers);
export const openInvoiceHeaderIndex = (source: CatalogMappingSource) => bestHeader(source, defaultOpenInvoiceMapping);
export function openInvoiceHeaderScore(headers: string[]): number {
  const fields = defaultOpenInvoiceMapping(headers);
  if (!fields.includes('number') || !fields.includes('client')) return 0;
  return fields.filter((field) => field !== 'ignore').length;
}

/** Statut bexio « payée », « annulée » ou « brouillon » : rien à reprendre. Le partiel reste ouvert. */
export function closedStatus(status: string): boolean {
  const value = normalize(status);
  if (!value || /partiel|teilweise|teilbezahlt|partial|parzial/.test(value)) return false;
  return /^(payee|paye|soldee|reglee|bezahlt|beglichen|erledigt|paid|pagat|annule|storniert|storno|cancel|annullat|brouillon|entwurf|draft|bozza)/.test(value);
}

export type OpenInvoiceRow = {
  line: number;
  number: string;
  clientName: string;
  clientId: string | null;
  title: string;
  issueDate: string;
  dueDate: string;
  totalCents: number | null;
  openCents: number;
  errors: string[];
  /** Raison d'une ligne écartée sans erreur (payée, déjà reprise…). */
  skipped: string | null;
};

const personKey = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function previewOpenInvoices(
  source: CatalogMappingSource,
  header: number,
  map: string[],
  clients: readonly Client[],
  existingNumbers: readonly string[],
  termsDays = 30,
): OpenInvoiceRow[] {
  const headers = catalogHeaders(source, header);
  const mapped = map.filter((value) => value !== 'ignore');
  if (map.length !== headers.length || new Set(mapped).size !== mapped.length || mapped.some((key) => !Object.hasOwn(openInvoiceFields, key))) {
    throw Error('Chaque champ doit correspondre à une seule colonne.');
  }
  if (!mapped.includes('number') || !mapped.includes('client')) throw Error('Choisissez les colonnes N° de facture et Client.');
  if (!mapped.includes('open') && !mapped.includes('total')) throw Error('Choisissez la colonne Montant ouvert ou Total.');
  if (!mapped.includes('issueDate')) throw Error('Choisissez la colonne Date.');
  const byName = new Map<string, Client[]>();
  for (const client of clients) {
    if (client.archivedAt) continue;
    for (const name of new Set([client.name, client.company].filter(Boolean).map(personKey))) {
      byName.set(name, [...(byName.get(name) ?? []), client]);
    }
  }
  const existing = new Set(existingNumbers.map((value) => value.trim().toLowerCase()));
  const seen = new Set<string>();
  const prepared = source.rows
    .slice(header + 1)
    .map((cells, index) => ({ cells, line: header + index + 2 }))
    .filter(({ cells }) => cells.some((cell) => cellText(cell) !== ''));
  if (prepared.length > 5000) throw Error('Importez au maximum 5 000 factures à la fois.');
  return prepared.map(({ cells, line }) => {
    const cell = (key: OpenInvoiceField) => (map.indexOf(key) >= 0 ? cells[map.indexOf(key)] : undefined);
    const text = (key: OpenInvoiceField) => cellText(cell(key));
    const number = text('number');
    const clientName = text('client');
    const issueDate = isoDate(cell('issueDate')) ?? '';
    const dueRaw = cell('dueDate');
    const dueDate = (dueRaw && cellText(dueRaw) ? isoDate(dueRaw) : issueDate ? addDays(issueDate, termsDays) : null) ?? '';
    const totalCents = map.includes('total') ? amountCents(cell('total')) : null;
    const openCents = map.includes('open') ? amountCents(cell('open')) : totalCents;
    const errors: string[] = [];
    let skipped: string | null = null;
    if (map.includes('status') && closedStatus(text('status'))) skipped = 'Payée ou annulée';
    else if (openCents !== null && openCents <= 0) skipped = 'Rien à encaisser';
    else if (existing.has(number.toLowerCase())) skipped = 'Déjà dans Zentra';
    const matches = byName.get(personKey(clientName)) ?? [];
    const client = matches.length === 1 ? matches[0] : null;
    if (!skipped) {
      if (!number || number.length > 60) errors.push('N° de facture manquant');
      else if (seen.has(number.toLowerCase())) errors.push('Facture en double dans le fichier');
      if (!issueDate) errors.push('Date illisible');
      if (!dueDate) errors.push('Échéance illisible');
      else if (issueDate && dueDate < issueDate) errors.push('Échéance avant la date de facture');
      if (openCents === null) errors.push('Montant illisible');
      if (totalCents !== null && openCents !== null && totalCents < openCents) errors.push('Montant ouvert supérieur au total');
      if (!clientName || !matches.length) errors.push('Client introuvable : importez d’abord vos clients');
      else if (matches.length > 1) errors.push('Plusieurs clients portent ce nom');
      else if (!(client!.addressLine1 || '').trim() || !(client!.postalCode || '').trim() || !(client!.city || '').trim()) errors.push('Adresse du client à compléter');
      if (number) seen.add(number.toLowerCase());
    }
    return { line, number, clientName, clientId: client?.id ?? null, title: text('title'), issueDate, dueDate, totalCents, openCents: openCents ?? 0, errors, skipped };
  });
}

export type NativeOpeningReceivable = { line: number; number: string; client_id: string; issue_date: string; due_date: string; open_cents: number; total_cents: number | null; title: string | null };

export function openingReceivableRows(rows: readonly OpenInvoiceRow[]): NativeOpeningReceivable[] {
  return rows
    .filter((row) => !row.skipped && !row.errors.length && row.clientId)
    .map((row) => ({ line: row.line, number: row.number, client_id: row.clientId!, issue_date: row.issueDate, due_date: row.dueDate, open_cents: row.openCents, total_cents: row.totalCents, title: row.title || null }));
}

/* ---------- Bilan d'ouverture ---------- */

export const balanceFields = {
  code: 'N° de compte',
  name: 'Nom du compte',
  balance: 'Solde',
  debit: 'Débit',
  credit: 'Crédit',
} as const;
export type BalanceField = keyof typeof balanceFields;

const balanceAliases: Record<BalanceField, string[]> = {
  code: ['compte', 'n compte', 'no compte', 'n de compte', 'numero de compte', 'konto', 'kontonummer', 'konto nr', 'kto', 'account', 'account number', 'account no', 'conto', 'numero conto', 'n conto', 'numero', 'no', 'nr'],
  name: ['nom', 'nom du compte', 'libelle', 'designation', 'intitule', 'bezeichnung', 'kontobezeichnung', 'kontoname', 'name', 'account name', 'descrizione', 'denominazione', 'description', 'titre'],
  balance: ['solde', 'solde chf', 'solde final', 'solde de cloture', 'montant', 'saldo', 'saldo chf', 'endsaldo', 'schlusssaldo', 'betrag', 'balance', 'closing balance', 'amount', 'importo'],
  debit: ['debit', 'soll', 'dare'],
  credit: ['credit', 'haben', 'avere'],
};

export const defaultBalanceMapping = (headers: string[]) => mapping(balanceAliases, headers);
export const balanceHeaderIndex = (source: CatalogMappingSource) => bestHeader(source, defaultBalanceMapping);
export function balanceHeaderScore(headers: string[]): number {
  const fields = defaultBalanceMapping(headers);
  if (!fields.includes('code') || !(fields.includes('balance') || fields.includes('debit') || fields.includes('credit'))) return 0;
  return fields.filter((field) => field !== 'ignore').length;
}

export type BalanceRow = { line: number; code: string; name: string; balanceCents: number | null; debitCents: number | null; creditCents: number | null; errors: string[] };

export function previewBalance(source: CatalogMappingSource, header: number, map: string[]): BalanceRow[] {
  const headers = catalogHeaders(source, header);
  const mapped = map.filter((value) => value !== 'ignore');
  if (map.length !== headers.length || new Set(mapped).size !== mapped.length || mapped.some((key) => !Object.hasOwn(balanceFields, key))) {
    throw Error('Chaque champ doit correspondre à une seule colonne.');
  }
  if (!mapped.includes('code')) throw Error('Choisissez la colonne N° de compte.');
  const useBalance = mapped.includes('balance');
  if (!useBalance && !mapped.includes('debit') && !mapped.includes('credit')) throw Error('Choisissez la colonne Solde, ou Débit et Crédit.');
  const rows: BalanceRow[] = [];
  source.rows.slice(header + 1).forEach((cells, index) => {
    const line = header + index + 2;
    const cell = (key: BalanceField) => (map.indexOf(key) >= 0 ? cells[map.indexOf(key)] : undefined);
    const code = cellText(cell('code')).replace(/\s+/g, '');
    // Les lignes de titre ou de total (« Actifs », « Total passifs ») n'ont pas de numéro.
    if (!/^\d{3,6}$/.test(code)) return;
    const errors: string[] = [];
    const read = (key: BalanceField) => {
      const raw = cell(key);
      if (!raw || !cellText(raw)) return useBalance ? null : 0;
      const value = amountCents(raw);
      if (value === null) errors.push('Montant illisible');
      return value;
    };
    const balanceCents = useBalance ? read('balance') ?? 0 : null;
    const debitCents = useBalance ? null : read('debit');
    const creditCents = useBalance ? null : read('credit');
    if (!useBalance && ((debitCents ?? 0) < 0 || (creditCents ?? 0) < 0)) errors.push('Débit et crédit doivent être positifs');
    rows.push({ line, code, name: cellText(cell('name')), balanceCents, debitCents, creditCents, errors });
  });
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
  for (const row of rows) if ((counts.get(row.code) ?? 0) > 1) row.errors.push('Compte en double');
  return rows;
}

export type NativeBalanceLine = { line: number; code: string; name: string | null; balance_cents?: number; debit_cents?: number; credit_cents?: number };

export function openingBalanceLines(rows: readonly BalanceRow[]): NativeBalanceLine[] {
  return rows
    .filter((row) => !row.errors.length && (row.balanceCents || row.debitCents || row.creditCents))
    .map((row) => row.balanceCents !== null
      ? { line: row.line, code: row.code, name: row.name || null, balance_cents: row.balanceCents }
      : { line: row.line, code: row.code, name: row.name || null, debit_cents: row.debitCents ?? 0, credit_cents: row.creditCents ?? 0 });
}

/** Premier jour de l'année en cours : la date habituelle d'un bilan d'ouverture. */
export function defaultOpeningDate(today = new Date()): string {
  return `${today.getFullYear()}-01-01`;
}

/** Aperçu calculé par l'app native avant toute écriture. */
export type OpeningBalancePlan = {
  entryDate: string;
  lines: { line: number; code: string; name: string; debitCents: number; creditCents: number; create: boolean; note: string }[];
  opening: { code: string; name: string; debitCents: number; creditCents: number };
  receivablesCents: number;
  /** Écart du bilan repris : il reste sur le compte d'ouverture. */
  differenceCents: number;
};
