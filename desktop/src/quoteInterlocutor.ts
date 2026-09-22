import type { Quote } from './types';

export function quoteInterlocutor(quote: Quote, companyContact: string): string {
  // Already-issued documents keep their original identity, including old PDFs
  // which did not yet contain an interlocutor.
  if (quote.snapshot) return quote.snapshot.document.contactName?.trim() || '';
  if (quote.creator?.id) return quote.creator.name.includes('@') ? '' : quote.creator.name.trim();
  return companyContact.trim();
}
