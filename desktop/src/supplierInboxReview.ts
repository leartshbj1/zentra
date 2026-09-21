import type { Workspace } from './types';
import type { MailInvoice } from './supplierInbox';
import { purchaseDecimal } from './supplierInvoicePreparation';

const normalized = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
export const inboxCategoryLabels: Record<string,string> = { materials:'Matériel et marchandises', software:'Logiciels', telecom:'Télécommunications', rent:'Loyer', insurance:'Assurances', transport:'Transport', services:'Prestations de services', other:'Autres charges' };

/** Only reuse a unique supplier and an unambiguous, already validated classification. */
export function mailboxInvoiceDefaults(item: MailInvoice, workspace: Workspace) {
  const name = normalized(item.extraction.supplierName || '');
  const matched = workspace.suppliers.filter(s => !s.archivedAt && name && normalized(s.name) === name && s.email.trim().toLowerCase() === item.sender.trim().toLowerCase());
  const supplierId = matched.length === 1 ? matched[0].id : '';
  const history = workspace.supplierInvoices.filter(i => i.supplierId === supplierId && i.documentStatus === 'validated').flatMap(i => i.lines);
  const categories = [...new Set(history.map(l => l.category).filter(Boolean))];
  const accounts = [...new Set(history.map(l => l.postedExpenseAccountId).filter((id): id is string => !!id && workspace.accounts.some(a => a.id === id && a.active && a.accountType === 'expense')))];
  const category = inboxCategoryLabels[item.extraction.category || ''] || (categories.length === 1 ? categories[0] : '');
  const sameCategory = categories.length === 1 && normalized(categories[0]) === normalized(category);
  return { supplierId, category, accountId: sameCategory && accounts.length === 1 ? accounts[0] : '' };
}

export function mailboxInvoiceAmounts(net: string, vat: string) {
  const netCents = purchaseDecimal(net, 2, 1_000_000_000);
  const vatBp = purchaseDecimal(vat, 2, 10000);
  if (netCents === null || netCents <= 0 || vatBp === null) return null;
  const vatCents = Number((BigInt(netCents) * BigInt(vatBp) + 5000n) / 10000n);
  return { netCents, vatBp, vatCents, totalCents: netCents + vatCents };
}
