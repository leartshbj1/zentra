import type { Workspace } from './types';
import type { MailInvoice, SupplierHabit } from './supplierInbox';
import { purchaseDecimal } from './supplierInvoicePreparation';

export const normalizedSupplier = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const normalized=normalizedSupplier;
export const inboxCategoryLabels: Record<string,string> = { materials:'Matériel et marchandises', software:'Logiciels', telecom:'Télécommunications', rent:'Loyer', insurance:'Assurances', transport:'Transport', services:'Prestations de services', other:'Autres charges' };

/** Confidence in vendor identity is independent from totals, dates and category. */
export function canPrepareMailboxSupplier(item: MailInvoice) {
  const e = item.extraction;
  const nameConfidence = e.fieldConfidence?.supplierName ?? e.confidence;
  return !!normalized(e.supplierName || '')
    && (e.supplierName?.length || 0) <= 200
    && Number.isFinite(nameConfidence) && nameConfidence >= .95;
}

/** Only reuse a unique supplier and an unambiguous, already validated classification. */
export function mailboxInvoiceDefaults(item: MailInvoice, workspace: Workspace, habits: SupplierHabit[] = []) {
  const name = normalized(item.extraction.supplierName || '');
  const candidates=workspace.suppliers.filter(s=>!s.archivedAt&&name&&normalized(s.name)===name);
  const exact=candidates.filter(s=>s.email.trim().toLowerCase()===item.sender.trim().toLowerCase());
  const matched=exact.length?exact:candidates;
  const habit = habits.find(h => h.sender === item.sender.trim().toLowerCase() && h.supplierName === name && workspace.suppliers.some(s => s.id === h.supplierId && !s.archivedAt));
  const supplierId = habit?.supplierId || (matched.length === 1 ? matched[0].id : '');
  const history = workspace.supplierInvoices.filter(i => i.supplierId === supplierId && i.documentStatus === 'validated').flatMap(i => i.lines);
  const categories = [...new Set(history.map(l => l.category).filter(Boolean))];
  const accounts = [...new Set(history.map(l => l.postedExpenseAccountId).filter((id): id is string => !!id && workspace.accounts.some(a => a.id === id && a.active && a.accountType === 'expense')))];
  const category = habit?.category || inboxCategoryLabels[item.extraction.category || ''] || (categories.length === 1 ? categories[0] : '');
  const sameCategory = categories.length === 1 && normalized(categories[0]) === normalized(category);
  const learnedAccount = habit?.accountId && workspace.accounts.some(a => a.id === habit.accountId && a.active && a.accountType === 'expense') ? habit.accountId : '';
  return { supplierId, category, accountId: learnedAccount || (sameCategory && accounts.length === 1 ? accounts[0] : '') };
}

export function mailboxInvoiceAmounts(net: string, vat: string) {
  const netCents = purchaseDecimal(net, 2, 1_000_000_000);
  const vatBp = purchaseDecimal(vat, 2, 10000);
  if (netCents === null || netCents <= 0 || vatBp === null) return null;
  const vatCents = Number((BigInt(netCents) * BigInt(vatBp) + 5000n) / 10000n);
  return { netCents, vatBp, vatCents, totalCents: netCents + vatCents };
}
