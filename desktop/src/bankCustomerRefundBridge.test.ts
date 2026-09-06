import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { bankAccountingReady, bankWorkspaceFromRaw, filterBankMovements } from './bank';
import type { Workspace } from './types';

describe('customer bank refunds transport', () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => vi.unstubAllGlobals());
  it('sends the reviewed amount, date and optional original file to the atomic command', async () => {
    vi.stubGlobal('FileReader', class {
      result = ''; onload: (() => void) | null = null;
      readAsDataURL(file: File) { void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`; this.onload?.(); }); }
    });
    const receipt = new File([new Uint8Array([0, 255, 128, 42])], 'confirmation.png', { type: 'image/png' });
    const input = { requestId: 'request', movementId: 'debit', customerCreditNoteId: 'credit', amountCents: 2703, date: '2026-03-15', reference: 'REMBOURSEMENT-15', reason: 'Prestation annulée', receipt };
    await desktopApi.createBankCustomerCreditRefund(input);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('create_bank_customer_credit_refund', { input: { request_id: 'request', movement_id: 'debit', customer_credit_note_id: 'credit', expected_amount_cents: 2703, expected_date: '2026-03-15', reference: 'REMBOURSEMENT-15', reason: 'Prestation annulée', attachment: { original_name: 'confirmation.png', content_base64: 'AP+AKg==' } } });
    invokeMock.mockReset();
    await desktopApi.createBankCustomerCreditRefund({ ...input, receipt: null });
    expect(invokeMock.mock.calls[0][1].input.attachment).toBeNull();
  });
  it('keeps match and unlink separate from the financial creation and propagates failures', async () => {
    await desktopApi.matchBankCustomerCreditRefund('request', 'debit', 'refund', 'Date de valeur différente');
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('match_bank_customer_credit_refund', { input: { request_id: 'request', movement_id: 'debit', refund_id: 'refund', date_difference_reason: 'Date de valeur différente' } });
    invokeMock.mockReset(); invokeMock.mockRejectedValueOnce(new Error('Déjà dissocié'));
    await expect(desktopApi.unmatchBankCustomerCreditRefund('unlink', 'match', 'Autre association')).rejects.toThrow('Déjà dissocié');
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('unmatch_bank_customer_credit_refund', { input: { request_id: 'unlink', match_id: 'match', reason: 'Autre association' } });
  });
  it('retains the customer identity, immutable history and proof warning for search and navigation', () => {
    const proof = { id: 'match', refund_id: 'refund', customer_credit_note_id: 'credit', customer_name: 'Atelier Lausanne', reference: 'REMBOURSEMENT', amount_cents: 2703, payment_date: '2026-03-15', integrity_issue: 'Preuve à vérifier' };
    const bank = bankWorkspaceFromRaw({ movements: [{ id: 'debit', credit_debit: 'DBIT', status: 'BOOK', amount_cents: 2703, currency: 'CHF', refund_match: proof, refund_history: [{ ...proof, id: 'old', customer_name: 'Ancien client', reason: 'Lien corrigé' }] }] });
    expect(bank.movements[0].refundMatch).toMatchObject({ customerCreditNoteId: 'credit', customerName: 'Atelier Lausanne', integrityIssue: 'Preuve à vérifier' });
    expect(filterBankMovements(bank.movements, 'unreconciled')).toHaveLength(0);
    expect(filterBankMovements(bank.movements, 'reconciled', 'Atelier Lausanne')).toHaveLength(1);
    expect(filterBankMovements(bank.movements, 'all', 'Ancien client')).toHaveLength(1);
  });
  it('allows banking without payroll but requires payroll mappings for active or posted payroll', () => {
    const workspace = { settings: { payroll: { enabled: false } }, payslips: [], accountingSettings: { enabled: true, arAccountId: 'ar', revenueAccountId: 'revenue', vatPayableAccountId: 'vat', bankAccountId: 'bank', expenseAccountId: 'expense', vatReceivableAccountId: 'input-vat', supplierPayableAccountId: 'supplier' } } as unknown as Workspace;
    expect(bankAccountingReady(workspace)).toBe(true);
    workspace.settings!.payroll.enabled = true; expect(bankAccountingReady(workspace)).toBe(false);
    workspace.settings!.payroll.enabled = false;
    workspace.payslips = [{ status: 'posted' }] as Workspace['payslips']; expect(bankAccountingReady(workspace)).toBe(false);
    Object.assign(workspace.accountingSettings!, { wagesExpenseAccountId: 'wages', wagesPayableAccountId: 'wages-due', socialExpenseAccountId: 'social', socialPayableAccountId: 'social-due' }); expect(bankAccountingReady(workspace)).toBe(true);
    workspace.accountingSettings!.bankAccountId = ''; expect(bankAccountingReady(workspace)).toBe(false);
  });
});
