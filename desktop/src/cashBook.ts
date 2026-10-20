// Livre de caisse : lignes avec solde courant, et rappel du comptage du soir.
// Même règle que l'app native pour reconnaître un encaissement en espèces.
import type { CashBookEntry, CashCount, Workspace } from './types';

const CASH_WORDS = new Set(['espèces', 'especes', 'espèce', 'espece', 'cash', 'bargeld', 'bar', 'contanti', 'contante', 'contant', 'caisse', 'kasse', 'cassa']);

export function isCashMethod(method: string | null | undefined): boolean {
  return (method ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => CASH_WORDS.has(word));
}

export type CashBookLine = {
  id: string;
  date: string;
  kind: CashBookEntry['kind'] | 'invoice_payment';
  label: string;
  reference: string;
  amountCents: number;
  balanceCents: number;
};

type Source = Pick<Workspace, 'payments' | 'invoices'> & { cashBookEntries?: readonly CashBookEntry[] };

/** Lignes du livre de caisse, de la plus ancienne à la plus récente, avec le solde après chaque ligne. */
export function cashBookLines(workspace: Source): CashBookLine[] {
  const invoices = new Map(workspace.invoices.map((invoice) => [invoice.id, invoice]));
  type Pending = { line: Omit<CashBookLine, 'balanceCents'>; order: string };
  const pending: Pending[] = [
    ...(workspace.cashBookEntries ?? []).map((entry) => ({ order: entry.createdAt, line: { id: entry.id, date: entry.entryDate, kind: entry.kind, label: entry.description, reference: entry.reference, amountCents: entry.amountCents } })),
    ...workspace.payments
      .filter((payment) => isCashMethod(payment.method) && invoices.get(payment.invoiceId)?.status !== 'cancelled')
      .map((payment) => {
        const invoice = invoices.get(payment.invoiceId);
        return { order: '', line: { id: payment.id, date: payment.date, kind: 'invoice_payment' as const, label: invoice?.number ?? '', reference: payment.reference ?? '', amountCents: payment.amountCents } };
      }),
  ];
  const raw = pending.sort((a, b) => a.line.date.localeCompare(b.line.date) || a.order.localeCompare(b.order)).map((row) => row.line);
  let balance = 0;
  return raw.map((line) => ({ ...line, balanceCents: (balance += line.amountCents) }));
}

/** Solde en fin de journée `date`. */
export function cashBalance(workspace: Source, date: string): number {
  return cashBookLines(workspace).filter((line) => line.date <= date).reduce((sum, line) => sum + line.amountCents, 0);
}

/** Dernier comptage dont l'écart n'a pas encore été corrigé, s'il est le plus récent. */
export function uncorrectedCount(counts: readonly CashCount[] | undefined, entries: readonly CashBookEntry[] | undefined): CashCount | null {
  const latest = [...(counts ?? [])].sort((a, b) => b.countDate.localeCompare(a.countDate) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest || latest.differenceCents === 0) return null;
  return (entries ?? []).some((entry) => entry.countId === latest.id) ? null : latest;
}

/** Rappel du comptage du soir : caisse utilisée, mouvement aujourd'hui, pas encore comptée, après 17 h. */
export function eveningCountDue(workspace: Source & { cashCounts?: readonly CashCount[] }, now: Date): boolean {
  const today = localDate(now);
  if (now.getHours() < 17 || !(workspace.cashBookEntries ?? []).length) return false;
  if ((workspace.cashCounts ?? []).some((count) => count.countDate === today)) return false;
  return cashBookLines(workspace).some((line) => line.date === today);
}

export function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Billets et pièces suisses, en centimes, du plus grand au plus petit. */
export const DENOMINATIONS = [100_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5] as const;

export function countedCents(counts: Readonly<Record<number, number>>): number {
  return DENOMINATIONS.reduce((sum, value) => sum + value * (counts[value] ?? 0), 0);
}
