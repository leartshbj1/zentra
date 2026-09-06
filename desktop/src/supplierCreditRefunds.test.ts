import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { supplierCreditAvailable, supplierRefundAmount, supplierRefundDateError } from './supplierCreditRefunds';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

describe('règlement des avoirs fournisseurs', () => {
  it('retire du solde les remboursements actifs et les compensations', async () => {
    invokeMock.mockImplementation(async (command) => command === 'get_app_state' ? {onboarding_completed:true} : {
      supplier_credit_notes:[{id:'credit',total_cents:10000}],
      supplier_credit_allocations:[{id:'a',supplier_credit_note_id:'credit',event_type:'apply',amount_cents:3000}],
      supplier_credit_refunds:[{id:'r',supplier_credit_note_id:'credit',event_type:'refund',amount_cents:2000,reference:'Virement',date:'2026-05-15',journal_entry_id:'journal'}, {id:'x',supplier_credit_note_id:'credit',event_type:'reverse',reverses_id:'r',amount_cents:2000}, {id:'r2',supplier_credit_note_id:'credit',event_type:'refund',amount_cents:1500}],
    });
    const credit=(await desktopApi.loadWorkspace()).supplierCreditNotes[0];
    expect(credit).toMatchObject({allocatedCents:3000,refundedCents:1500});
    expect(credit.refunds[0]).toMatchObject({reference:'Virement',journalEntryId:'journal'});
    expect(credit.refunds[1].reversesId).toBe('r');
    expect(supplierCreditAvailable(credit)).toBe(5500);
  });
  it('conserve la clé de demande et distingue une lecture échouée après écriture', async () => {
    const input={requestId:'same-request',supplierCreditNoteId:'credit',date:'2026-05-15',amountCents:1500,reference:' Virement ',reason:' Retour marchandise '};
    invokeMock.mockImplementation(async (command) => { if(command==='record_supplier_credit_refund') return {idempotent:false}; throw Error('Lecture indisponible'); });
    await expect(desktopApi.recordSupplierCreditRefund(input)).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invokeMock).toHaveBeenCalledWith('record_supplier_credit_refund',{input:{request_id:'same-request',supplier_credit_note_id:'credit',date:'2026-05-15',amount_cents:1500,reference:'Virement',reason:'Retour marchandise'}});
  });
  it('accepte les centimes exacts et refuse les montants ambigus', () => {
    expect(supplierRefundAmount(' 10,05 ')).toBe(1005);
    for(const value of ['', '0', '-1', '1.001', '1e2', 'Infinity', '999999999999999999']) expect(supplierRefundAmount(value)).toBeNull();
  });
  it('refuse les dates impossibles, futures et antérieures au règlement original', () => {
    for(const date of ['2026-02-30','2026-5-15','2026-04-30','2026-06-01']) expect(supplierRefundDateError(date,'2026-05-01','2026-05-31')).not.toBe('');
    expect(supplierRefundDateError('2026-05-31','2026-05-01','2026-05-31')).toBe('');
  });
});
