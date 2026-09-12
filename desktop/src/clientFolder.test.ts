import { expect, it } from 'vitest';
import { clientFolderDocuments } from './clientFolder';
import type { Invoice, Quote } from './types';
const line = { id: 'line', description: 'Service', quantity: 1, unit: 'h', unitPriceCents: 10000, discountBp: 0, vatRateBp: 810 };
const quotes = [{ id: 'q', clientId: 'c', title: 'Devis antidaté', createdAt: '2026-09-12 10:00:00', issueDate: '2026-01-01', number: 'D-2', currency: 'CHF', lines: [line] }, { id: 'other', clientId: 'other-client', number: 'SECRET', lines: [line] }] as Quote[];
const invoices = [{ id: 'f', clientId: 'c', title: 'Facture', createdAt: '2026-09-11T10:00:00Z', issueDate: '2026-12-01', number: 'F-1', type: 'standard', currency: 'EUR', lines: [line] }, { id: 'a', clientId: 'c', title: 'Avoir', createdAt: '2026-09-10T10:00:00Z', issueDate: '2026-09-10', number: 'A-1', type: 'credit_note', currency: 'CHF', lines: [line] }] as Invoice[];
it('orders complete history by creation while preserving entity and currency', () => {
  const docs = clientFolderDocuments('c', { quotes, invoices });
  expect(docs.map(row => [row.id, row.entity, row.currency])).toEqual([['q','quotes','CHF'], ['f','invoices','EUR'], ['a','invoices','CHF']]);
  expect(docs[0].totalCents).toBe(10810); expect(docs[2].kind).toBe('Avoir');
  expect(quotes.map(row => row.id)).toEqual(['q', 'other']);
});
it('finds old documents without showing another client', () => {
  expect(clientFolderDocuments('c', { quotes, invoices }, 'F-1').map(row => row.id)).toEqual(['f']);
  expect(clientFolderDocuments('c', { quotes, invoices }, '2026-01-01').map(row => row.id)).toEqual(['q']);
  expect(clientFolderDocuments('c', { quotes, invoices }, 'SECRET')).toEqual([]);
});
