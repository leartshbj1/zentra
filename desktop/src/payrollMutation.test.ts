import { beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { PayslipPostingRefreshError } from './payrollMutation';

describe('acknowledged payroll writes', () => {
  beforeEach(() => { invokeMock.mockReset(); });
  it.each([
    ['save_payslip_with_contributions', () => desktopApi.savePayslipWithContributions({ employeeId: 'e', status: 'incomplete' }, [{ id: 'l', label: 'Salaire', kind: 'earning', amountCents: 500000 }], undefined, '2026-09', [])],
    ['pay_payslip', () => desktopApi.payPayslip('salary', '2026-09-30', 'REF-09')],
    ['create_record', () => desktopApi.createEntity('employees', { name: 'Élodie' })],
    ['update_record', () => desktopApi.updateEntity('employees', 'e', { name: 'Élodie' })],
  ] as const)('classifies only a failed read after %s as an acknowledged write', async (command, mutation) => {
    invokeMock.mockImplementation(async (name: string) => { if (name === command) return { id: 'saved' }; if (name === 'get_app_state') return { onboarding_completed: true }; throw new Error('Lecture interrompue'); });
    await expect(mutation()).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invokeMock.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([name]) => name === 'get_workspace')).toHaveLength(1);
  });
  it('preserves accounting fallbacks after an acknowledged posting and a failed read', async () => {
    const fallback = { contribution: 'AVS', field: 'liability_account_id', account_id: '2270', reason: 'Compte général' };
    invokeMock.mockImplementation(async (name: string) => { if (name === 'post_payslip') return { journal: { accounting_fallbacks: [fallback] } }; throw new Error('Lecture interrompue'); });
    const error = await desktopApi.postPayslip('salary').catch((reason) => reason);
    expect(error).toBeInstanceOf(PayslipPostingRefreshError);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(error.accountingFallbacks).toEqual([{ contribution: 'AVS', field: 'liability_account_id', accountId: '2270', reason: 'Compte général' }]);
    expect(invokeMock.mock.calls.filter(([name]) => name === 'post_payslip')).toHaveLength(1);
  });
  it('never turns a native refusal into acknowledged success', async () => {
    const refusal = new Error('Compte bancaire inactif');
    invokeMock.mockRejectedValue(refusal);
    await expect(desktopApi.payPayslip('salary', '2026-09-30')).rejects.toBe(refusal);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
