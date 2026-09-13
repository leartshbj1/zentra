import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { SupplierInvoice, SupplierCreditNote } from './types';
import { supplierInvoiceHistory, supplierInvoiceDetailState } from './supplierInvoiceHistory';
import { supplierDetailTranslations } from './translationsSupplierDetail';
import { translations } from './translations';

const invoice = { id: 'invoice', documentStatus: 'validated', totalCents: 21620, paidCents: 6025, creditedCents: 3000, balanceCents: 12595, payments: [
  { id: 'early', date: '2026-09-06', createdAt: '2026-09-10T12:00:00Z', amountCents: 5025 },
  { id: 'late', date: '2026-09-08', createdAt: '2026-09-08T12:00:00Z', amountCents: 1000 },
] } as SupplierInvoice;
const credit = { id: 'credit', reference: 'Client {name}', number: 'AV-1', allocations: [
  { id: 'apply', supplierInvoiceId: 'invoice', eventType: 'apply', amountCents: 4000, effectiveDate: '2026-09-07', createdAt: '2026-09-10T12:00:00Z' },
  { id: 'reverse', supplierInvoiceId: 'invoice', eventType: 'reverse', amountCents: 1000, effectiveDate: '2026-09-09', createdAt: '2026-09-11T12:00:00Z' },
  { id: 'other', supplierInvoiceId: 'other', eventType: 'apply', amountCents: 3000, effectiveDate: '2026-09-10', createdAt: '2026-09-10T12:00:00Z' },
] } as SupplierCreditNote;

it('orders payments and credit events by actual settlement date without changing saved data', () => {
  const before = JSON.stringify([invoice, credit]);
  const history = supplierInvoiceHistory(invoice, [credit]);
  expect(history.map(row => row.id)).toEqual(['credit-reverse', 'payment-late', 'credit-apply', 'payment-early']);
  expect(history[0]).toMatchObject({ kind: 'credit_reversal', amountCents: 1000, creditId: 'credit' });
  expect(JSON.stringify([invoice, credit])).toBe(before);
});
it('keeps unknown settlement dates unknown and places those events after dated events', () => {
  const legacy = structuredClone(credit); legacy.allocations[1].effectiveDate = null;
  const rows = supplierInvoiceHistory(invoice, [legacy]);
  expect(rows.at(-1)).toMatchObject({ id: 'credit-reverse', date: null, createdAt: '2026-09-11T12:00:00Z' });
  legacy.allocations[0].effectiveDate = '2026-02-30';
  expect(supplierInvoiceHistory(invoice, [legacy]).find(row => row.id === 'credit-apply')?.date).toBeNull();
});
it('shows net credits after reversal separately from cash payments', () => {
  expect(supplierInvoiceDetailState(invoice, [credit])).toMatchObject({ validBalance: true, historyComplete: true, settled: false });
  const creditOnlyInvoice = { ...invoice, payments: [], paidCents: 0, totalCents: 3000, creditedCents: 3000, balanceCents: 0 };
  const fullCredit = { ...credit, allocations: [{ ...credit.allocations[0], amountCents: 3000 }] };
  expect(supplierInvoiceDetailState(creditOnlyInvoice, [fullCredit])).toMatchObject({ historyComplete: true, settled: true });
  expect(supplierInvoiceDetailState({ ...creditOnlyInvoice, documentStatus: 'draft' }, [fullCredit]).settled).toBe(false);
});
it('detects a missing event, an inconsistent balance and unsafe amounts instead of presenting them as complete', () => {
  expect(supplierInvoiceDetailState(invoice, []).historyComplete).toBe(false);
  expect(supplierInvoiceDetailState({ ...invoice, payments: [] }, [credit]).historyComplete).toBe(false);
  expect(supplierInvoiceDetailState({ ...invoice, balanceCents: 12596 }, [credit]).validBalance).toBe(false);
  expect(supplierInvoiceDetailState({ ...invoice, totalCents: Number.MAX_SAFE_INTEGER + 1 }, [credit]).validBalance).toBe(false);
  const bad = structuredClone(credit); bad.allocations[0].amountCents = -1;
  expect(supplierInvoiceDetailState(invoice, [bad]).historyComplete).toBe(false);
});
it('covers the consultation copy and preserves every translation parameter', () => {
  const keys = new Set(['Résumé', 'Documents', 'Historique']);
  const ast = ts.createSourceFile('SupplierInvoiceDetail.tsx', readFileSync(new URL('SupplierInvoiceDetail.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const raw: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxText(node) && /[A-Za-zÀ-ÿ]/.test(node.text)) raw.push(node.text.trim());
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 't') {
      function strings(child: ts.Node) { if (ts.isStringLiteral(child) && /[A-ZÀ-ÿ]/.test(child.text)) keys.add(child.text); ts.forEachChild(child, strings); }
      node.arguments.forEach(strings);
    }
    ts.forEachChild(node, visit);
  } visit(ast);
  expect(raw).toEqual([]); expect([...keys].filter(key => !translations[key])).toEqual([]);
  for (const [key, values] of Object.entries(supplierDetailTranslations)) for (const value of values) expect([...value.matchAll(/\{\w+\}/g)].map(row => row[0]).sort()).toEqual([...key.matchAll(/\{\w+\}/g)].map(row => row[0]).sort());
});
