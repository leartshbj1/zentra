import type { MailInvoice } from './supplierInbox';

/** The pending queue includes recoverable imports; never hides an unfinished document. */
export function filterMailInvoices(items: MailInvoice[], filter: 'pending' | 'imported', query = '') {
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const search = normalize(query.trim());
  return items.filter(item => item.state !== 'ignored' && (filter === 'imported' ? item.state === 'imported' : item.state !== 'imported'))
    .filter(item => !search || normalize([item.extraction.supplierName, item.extraction.reference, item.sender, item.fileName].join(' ')).includes(search))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
