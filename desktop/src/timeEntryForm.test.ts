import { describe, expect, it } from 'vitest';
import { initialTimeEntryDraft, timeEntryInput, timeEntryIssue, workedMinutes } from './timeEntryForm';
import { readyTimeEntries } from './timeBilling';
import type { TimeEntry, Workspace } from './types';

const entry = { id: 'time', projectId: 'project', employeeId: 'employee', date: '2026-09-12', minutes: 61, breakMinutes: 30, billable: true, billingRateCents: 9550, hourlyCostCents: 4500, status: 'approved', note: '', billingStatus: 'unbilled' } as TimeEntry;
const workspace = { clients: [{ id: 'client' }], projects: [{ id: 'project', clientId: 'client', status: 'planned' }], projectTasks: [], employees: [{ id: 'employee', active: true }], timeEntries: [entry] } as unknown as Workspace;
describe('saisie des heures compréhensible et exacte', () => {
  for (const minutes of [1, 59, 61, 449, 1441]) it(`modifie ${minutes} minutes sans arrondi ni retrait de la pause`, () => {
    const draft = initialTimeEntryDraft({ ...entry, minutes });
    expect(timeEntryIssue(draft, workspace, entry)).toBeUndefined();
    expect(timeEntryInput(draft).minutes).toBe(minutes);
    expect(timeEntryInput(draft).breakMinutes).toBe(30);
  });
  it('accepte les minutes seules et distingue les unités', () => {
    expect(workedMinutes('', '45')).toBe(45);
    expect(workedMinutes('1', '30')).toBe(90);
    expect(workedMinutes('1,5', '0')).toBeUndefined();
    expect(workedMinutes('1', '60')).toBeUndefined();
    expect(workedMinutes('0', '0')).toBeUndefined();
    expect(workedMinutes('-1', '30')).toBeUndefined();
    expect(workedMinutes('99999999999999999', '0')).toBeUndefined();
  });
  it('guide vers le champ des minutes et accepte les montants avec virgule', () => {
    const draft = { ...initialTimeEntryDraft(entry), minutes: '90', billingRate: '95,50', costRate: '45,00' };
    expect(timeEntryIssue(draft, workspace)?.field).toBe('minutes');
    draft.minutes = '1';
    expect(timeEntryIssue(draft, workspace)).toBeUndefined();
    expect(timeEntryInput(draft)).toMatchObject({ minutes: 61, billingRateCents: 9550, costRateCents: 4500 });
  });
  it('ne transforme pas les montants manquants ou mal saisis en zéro', () => {
    const draft = initialTimeEntryDraft(entry);
    expect(timeEntryIssue({ ...draft, costRate: '' }, workspace)?.field).toBe('costRate');
    expect(timeEntryIssue({ ...draft, costRate: '1,234' }, workspace)?.field).toBe('costRate');
    expect(timeEntryIssue({ ...draft, costRate: '0' }, workspace)).toBeUndefined();
    expect(timeEntryIssue({ ...draft, billingRate: '0' }, workspace)?.field).toBe('billingRate');
    expect(timeEntryInput({ ...draft, billable: 'no', billingRate: '95,50' }).billingRateCents).toBe(0);
  });
  it('vérifie les liens vivants et conserve les liens historiques lors de la modification', () => {
    const draft = initialTimeEntryDraft(entry);
    const closed = { ...workspace, projects: [{ ...workspace.projects[0], status: 'closed' as const }] };
    expect(timeEntryIssue(draft, closed)?.field).toBe('projectId');
    expect(timeEntryIssue(draft, closed, entry)).toBeUndefined();
    expect(timeEntryIssue({ ...draft, taskId: 'missing' }, workspace)?.field).toBe('taskId');
    expect(timeEntryIssue({ ...draft, employeeId: 'missing' }, workspace)?.field).toBe('employeeId');
    expect(timeEntryIssue({ ...draft, date: '2026-02-30' }, workspace)?.field).toBe('date');
  });
  it('démarre le chronomètre sans demander de durée mais avec un coût explicite', () => {
    const draft = { ...initialTimeEntryDraft(entry), hours: '', minutes: '', date: '', breakMinutes: '' };
    expect(timeEntryIssue(draft, workspace, undefined, true)).toBeUndefined();
    expect(timeEntryIssue({ ...draft, costRate: '' }, workspace, undefined, true)?.field).toBe('costRate');
  });
  it('compte seulement les heures appartenant à un projet lié à un client existant', () => {
    expect(readyTimeEntries(workspace)).toHaveLength(1);
    expect(readyTimeEntries({ ...workspace, clients: [] })).toHaveLength(0);
    expect(readyTimeEntries({ ...workspace, projects: [] })).toHaveLength(0);
    expect(readyTimeEntries({ ...workspace, timeEntries: [{ ...entry, billingStatus: 'reserved' }] })).toHaveLength(0);
  });
});
