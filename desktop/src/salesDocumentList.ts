import type { Invoice, Quote } from './types';
import { invoiceOpenBalance, searchText } from './utils';
import type { Payment } from './types';

export function documentCreatorKey(document: Quote | Invoice): string {
  return document.creator?.id ? `user:${document.creator.id}` : document.creator?.installationId ? `device:${document.creator.installationId}` : 'unknown';
}
export function documentCreatorLabel(document: Quote | Invoice): string {
  return document.creator?.name || 'Créateur non renseigné';
}
export function documentCreators(documents: (Quote | Invoice)[]) {
  const authors=new Map<string,string>();
  for(const document of documents) authors.set(documentCreatorKey(document),documentCreatorLabel(document));
  return [...authors].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
}
export function matchesDocumentCreator(document:Quote|Invoice,creator:string):boolean {
  return creator==='all'||documentCreatorKey(document)===creator;
}

export function matchesSalesDocumentSearch(document: Quote | Invoice, clientName: string, query: string): boolean {
  if (searchText([document.number, document.title, clientName, document.creator?.name || ''], query)) return true;
  const reference = 'qrBill' in document ? document.qrBill?.input.reference : '';
  const compactQuery = query.replace(/\s/g, '').toUpperCase();
  return Boolean(reference && compactQuery && reference.replace(/\s/g, '').toUpperCase().includes(compactQuery));
}

export function matchesSalesDocumentStatus(document: Quote | Invoice, status: string, invoices: Invoice[], payments: Payment[], today: string): boolean {
  if (status === 'all') return true;
  if (status !== 'overdue' && status !== 'open') return document.status === status;
  if (!('dueDate' in document) || document.type === 'credit_note' || ['draft', 'cancelled'].includes(document.status)) return false;
  if (invoiceOpenBalance(document, invoices, payments) <= 0) return false;
  return status === 'open' || Boolean(document.dueDate && document.dueDate < today);
}
