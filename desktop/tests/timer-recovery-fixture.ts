import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Workspace } from '../src/types';
import type { PreservedTimer, TimerRecoveryState } from '../src/timerRecovery';

// Synthetic UI fixture; never imported by the production entry point.
export function installTimerRecoveryFixture(workspace: () => Workspace) {
  const originalProject = workspace().projects[0];
  workspace().employees.push({ id: 'employee-previous', name: 'Camille Martin', active: false } as Workspace['employees'][number]);
  const item: PreservedTimer = { id: '', projectName: originalProject.name, taskTitle: 'Intervention et relevé sur place', employeeName: 'Camille Martin', originalProjectId: originalProject.id,
    originalTaskId: null, originalEmployeeId: 'employee-previous', startedAt: '2026-09-10T08:00:00Z', endedAt: '2026-09-10T08:37:10Z', minutes: 30, breakMinutes: 10, billable: false, billingRateCents: 9700, costRateCents: 4300, note: 'Intervention sur place\nConditions et relevé conservés.' };
  const state: TimerRecoveryState = { resolutionPending: true, active: { sha256: 'a'.repeat(64), projectId: item.originalProjectId, startedAt: item.startedAt }, pending: [] };
  workspace().activeTimer = { projectId: item.originalProjectId, taskId: null, employeeId: '', startedAt: item.startedAt, note: item.note };
  const calls: Array<{ action: string; id: string }> = [];
  Object.assign(window, {
    __qaFinishTimerResolution: () => { state.resolutionPending = false; workspace().projects = workspace().projects.filter(p => p.id !== item.originalProjectId); },
    __qaChangeTimer: () => { if (state.active) state.active.sha256 = 'b'.repeat(64); },
    __qaTimerCalls: calls,
  });
  desktopApi.getTimerRecoveryState = async () => {
    if (sessionStorage.getItem('timer-state-error') === '1') throw new Error('Lecture des pointages indisponible.');
    return structuredClone(state);
  };
  desktopApi.preserveActiveTimer = async (id, sha) => {
    calls.push({ action: 'preserve', id });
    if (sha !== state.active?.sha256) throw new Error('Le chronomètre a changé.');
    state.pending = [{ ...item, id }]; state.active = null; workspace().activeTimer = null;
    return structuredClone(workspace());
  };
  desktopApi.assignPreservedTimer = async (id, assignment) => {
    calls.push({ action: 'assign', id });
    if (sessionStorage.getItem('timer-assignment-error') === '1') throw new Error('Affectation indisponible. Le pointage est conservé.');
    if (state.resolutionPending) throw new Error('Terminez la résolution.');
    if (!workspace().projects.some(p => p.id === assignment.projectId)) throw new Error('Projet introuvable.');
    if (state.pending.length) {
      workspace().timeEntries.push({ id: 'preserved-time-entry', projectId: assignment.projectId, taskId: assignment.taskId, employeeId: assignment.employeeId ?? '', date: item.startedAt.slice(0, 10), minutes: item.minutes, breakMinutes: item.breakMinutes,
        billable: item.billable, billingRateCents: item.billingRateCents, hourlyCostCents: item.costRateCents, note: item.note, status: 'approved', billingStatus: 'unbilled', billingBatchId: null, billingInvoiceId: null, billingInvoiceNumber: null, createdAt: item.endedAt });
      state.pending = [];
    }
    return refreshWorkspaceAfterMutation(async () => {
      if (sessionStorage.getItem('timer-refresh-error') === '1') throw new Error('Actualisation interrompue après enregistrement.');
      return structuredClone(workspace());
    });
  };
}
