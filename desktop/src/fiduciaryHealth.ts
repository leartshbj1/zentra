// État du dossier pour la fiduciaire : des nombres et des dates calculés ici,
// jamais un montant, un nom ou une pièce. L'app ne publie ce résumé que si
// l'entreprise a activé le partage.
import type { AccountingPeriod, Attachment, Expense, SupplierInvoice, VatReturnExport } from './types';

export type HealthSummary = {
  version: 1;
  computedAt: string;
  missingReceipts: number;
  unreconciledBank: number;
  vatFiledThrough: string | null;
  closedThrough: string | null;
  accountingEnabled: boolean;
};

type Inputs = {
  expenses: readonly Pick<Expense, 'id' | 'date'>[];
  supplierInvoices: readonly Pick<SupplierInvoice, 'id' | 'documentStatus' | 'attachments'>[];
  attachments: readonly Pick<Attachment, 'entityType' | 'entityId'>[];
  unreconciledBank: number;
  vatExports: readonly Pick<VatReturnExport, 'dateTo'>[];
  periods: readonly Pick<AccountingPeriod, 'dateTo' | 'status'>[];
  accountingEnabled: boolean;
  now: Date;
};

const latest = (values: readonly string[]) => values.reduce<string | null>((best, value) => (!best || value > best ? value : best), null);

export function computeHealthSummary(input: Inputs): HealthSummary {
  const since = new Date(input.now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const attached = new Set(input.attachments.filter((file) => file.entityId).map((file) => `${file.entityType}:${file.entityId}`));
  const expenses = input.expenses.filter((expense) => expense.date >= since && !attached.has(`expense:${expense.id}`)).length;
  const invoices = input.supplierInvoices.filter((invoice) => invoice.documentStatus === 'validated' && !(invoice.attachments ?? []).length && !attached.has(`supplier_invoice:${invoice.id}`)).length;
  return {
    version: 1,
    computedAt: input.now.toISOString(),
    missingReceipts: expenses + invoices,
    unreconciledBank: Math.max(0, Math.trunc(input.unreconciledBank)),
    vatFiledThrough: latest(input.vatExports.map((item) => item.dateTo).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))),
    closedThrough: latest(input.periods.filter((period) => period.status === 'closed').map((period) => period.dateTo)),
    accountingEnabled: input.accountingEnabled,
  };
}

const storageKey = (scope: string | undefined) => `zentra.fiduciarySharing.v1:${scope ?? 'local'}`;

/** Partage activé sur cet appareil pour cette entreprise (confort local, l'action reste journalisée). */
export function readSharing(scope: string | undefined): boolean {
  try { return window.localStorage.getItem(storageKey(scope)) === 'on'; } catch { return false; }
}

export function writeSharing(scope: string | undefined, on: boolean) {
  try { window.localStorage.setItem(storageKey(scope), on ? 'on' : 'off'); } catch { /* Le partage reste visible dans le journal. */ }
}
