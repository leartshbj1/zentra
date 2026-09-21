import { expect, it } from 'vitest';
import { filterMailInvoices } from './supplierInboxQueue';
import type { MailInvoice } from './supplierInbox';
const invoice = (id: string, state: string, createdAt: number) => ({ id, state, createdAt, fileName: 'facture.pdf', sender: 'info@example.test', extraction: { supplierName: 'Électricité Démo', reference: `F-${id}` } }) as MailInvoice;
it('keeps unfinished and recovering imports visible, newest first, without changing source order', () => {
  const items = [invoice('a','needs_review',1), invoice('b','imported',4), invoice('c','processing',3), invoice('d','ready',2), invoice('e','ignored',5)];
  expect(filterMailInvoices(items,'pending').map(i=>i.id)).toEqual(['c','d','a']);
  expect(items.map(i=>i.id)).toEqual(['a','b','c','d','e']);
  expect(filterMailInvoices(items,'imported').map(i=>i.id)).toEqual(['b']);
});
it('finds suppliers without accents, references and senders within the selected queue', () => {
  const items = [invoice('a','needs_review',1), invoice('b','imported',4)];
  expect(filterMailInvoices(items,'pending',' electricite ').map(i=>i.id)).toEqual(['a']);
  expect(filterMailInvoices(items,'imported','F-b').map(i=>i.id)).toEqual(['b']);
  expect(filterMailInvoices(items,'pending','F-b')).toEqual([]);
  expect(filterMailInvoices(items,'pending','EXAMPLE.TEST')).toHaveLength(1);
});
