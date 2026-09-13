import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { translations } from './translations';
import { supplierPaymentTranslations } from './translationsSupplierPayments';
import { creditAmountInput } from './creditAllocationWorkflow';
import { supplierPaymentInput } from './purchaseFormValidation';
import { runSupplierPaymentMutation, supplierPaymentWasRecorded, SupplierPaymentOutcomeUnknownError, SupplierPaymentRefreshError, supplierPaymentProblem, supplierPaymentReviewKey, type SupplierPaymentIntent, type SupplierPaymentDraft } from './supplierPaymentWorkflow';
import type { SupplierInvoice, Workspace } from './types';

const draft: SupplierPaymentDraft = { amount: '50,25', date: '2026-09-06', method: 'bank_transfer', reference: ' Réf {name} ', notes: ' Ligne 1\nLigne 2 ' };
const intent: SupplierPaymentIntent = { ...draft, requestId: 'request', supplierInvoiceId: 'invoice', amountCents: 5025 };
const invoice = { id: 'invoice', documentStatus: 'validated', documentDate: '2026-09-01', reference: 'INV 1', supplierName: 'Fournisseur {name}', totalCents: 10810, balanceCents: 10810, paidCents: 0, creditedCents: 0, payments: [] } as unknown as SupplierInvoice;
const workspace = { onboardingCompleted: true, settings: {}, accounts: [{ id: 'bank', active: true, code: '1020', name: 'Banque', accountType: 'asset' }], accountingSettings: { enabled: true, bankAccountId: 'bank' }, supplierInvoices: [invoice] } as unknown as Workspace;
function stored(): Workspace { const next = structuredClone(workspace); next.supplierInvoices[0].payments = [{ ...intent, id: 'payment', journalEntryId: 'journal', createdAt: '', reference: intent.reference.trim(), notes: intent.notes.trim() }]; return next; }

describe('guided supplier payments', () => {
  it('parses cents exactly even near the safe integer boundary', () => {
    expect(supplierPaymentInput('90071992547409.91', draft.date, invoice.documentDate, Number.MAX_SAFE_INTEGER).amountCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(creditAmountInput(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(supplierPaymentInput('90071992547409.92', draft.date, invoice.documentDate, Number.MAX_SAFE_INTEGER).error).not.toBe('');
  });
  it('links amount, date, metadata, invoice and account problems to the correct correction', () => {
    expect(supplierPaymentProblem(invoice, workspace, draft, '2026-09-06')).toBeNull();
    expect(supplierPaymentProblem(invoice, workspace, { ...draft, amount: '108.11' }, '2026-09-06')?.field).toBe('amount');
    expect(supplierPaymentProblem(invoice, workspace, { ...draft, date: '2026-09-07' }, '2026-09-06')?.field).toBe('date');
    expect(supplierPaymentProblem(invoice, workspace, { ...draft, reference: 'x'.repeat(201) }, '2026-09-06')?.field).toBe('reference');
    expect(supplierPaymentProblem(invoice, workspace, { ...draft, notes: '\0' }, '2026-09-06')?.field).toBe('notes');
    expect(supplierPaymentProblem(undefined, workspace, draft, '2026-09-06')?.field).toBe('record');
    expect(supplierPaymentProblem({ ...invoice, balanceCents: 0 }, workspace, draft, '2026-09-06')?.field).toBe('record');
    expect(supplierPaymentProblem(invoice, { ...workspace, accounts: [] }, draft, '2026-09-06')?.section).toBe('accounts');
  });
  it('requires a new review when the balance, document or payment account changes', () => {
    const before = supplierPaymentReviewKey(invoice, workspace, draft);
    expect(supplierPaymentReviewKey({ ...invoice, balanceCents: 7000 }, workspace, draft)).not.toBe(before);
    expect(supplierPaymentReviewKey(invoice, { ...workspace, accounts: workspace.accounts.map(row => ({ ...row, active: false })) }, draft)).not.toBe(before);
    expect(supplierPaymentReviewKey(invoice, workspace, { ...draft, reference: 'corrected' })).not.toBe(before);
  });
  it('finds the complete request after a lost response and never resends on its own', async () => {
    const write = vi.fn().mockRejectedValue(Error('response lost')), load = vi.fn();
    const failure = await runSupplierPaymentMutation(intent, write, load).catch(reason => reason);
    expect(failure).toBeInstanceOf(SupplierPaymentOutcomeUnknownError);
    expect(load).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
    expect(failure.wasRecorded(stored())).toBe(true);
    expect(failure.wasRecorded(workspace)).toBe(false);
  });
  it('does not interpret missing data, collisions or a missing accounting link as a failed write', () => {
    expect(() => supplierPaymentWasRecorded({ ...workspace, onboardingCompleted: false }, intent)).toThrow();
    expect(() => supplierPaymentWasRecorded({ ...workspace, supplierInvoices: [] }, intent)).toThrow();
    for (const patch of [{ amountCents: 5026 }, { date: '2026-09-07' }, { method: 'cash' }, { reference: 'changed' }, { notes: 'changed' }, { journalEntryId: '' }, { supplierInvoiceId: 'elsewhere' }]) {
      const next = stored(); Object.assign(next.supplierInvoices[0].payments[0], patch);
      expect(() => supplierPaymentWasRecorded(next, intent)).toThrow();
    }
    const duplicate = stored(); duplicate.supplierInvoices[0].payments.push(duplicate.supplierInvoices[0].payments[0]);
    expect(() => supplierPaymentWasRecorded(duplicate, intent)).toThrow();
  });
  it('holds an acknowledged write until a complete matching read is available', async () => {
    const write = vi.fn().mockResolvedValue({});
    const failure = await runSupplierPaymentMutation(intent, write, async () => workspace).catch(reason => reason);
    expect(failure).toBeInstanceOf(SupplierPaymentRefreshError);
    expect(() => failure.validateRead(workspace)).toThrow();
    expect(() => failure.validateRead(stored())).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    await expect(runSupplierPaymentMutation(intent, async () => ({}), async () => stored())).resolves.toEqual(stored());
  });
  it('has translations for the payment interface, field problems and correction actions', () => {
    const keys = new Set<string>(), raw: string[] = [];
    for (const file of ['SupplierPaymentForm.tsx', 'supplierPaymentWorkflow.ts']) {
      const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isJsxText(node) && /[A-Za-zÀ-ÿ]/.test(node.text)) raw.push(node.text.trim());
        if (ts.isStringLiteral(node) && ((ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === 't') || (ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === 'message'))) keys.add(node.text);
        ts.forEachChild(node, visit);
      } visit(ast);
    }
    expect(raw).toEqual([]); expect([...keys].filter(key => !translations[key.trim()])).toEqual([]);
    for (const [key, values] of Object.entries(supplierPaymentTranslations)) for (const value of values) expect([...value.matchAll(/\{\w+\}/g)].map(row => row[0]).sort()).toEqual([...key.matchAll(/\{\w+\}/g)].map(row => row[0]).sort());
  });
});
