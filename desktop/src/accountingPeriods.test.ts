import { describe, expect, it, vi } from 'vitest';
import { calendarYearDraft, closedThrough, isPeriodDate, nextPeriodDay, periodDraftIssue, type PeriodDraft } from './accountingPeriods';
import type { AccountingPeriod } from './types';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
const draft: PeriodDraft = { id: '260c6c0c-3170-4169-b6b8-6b6f1c7b2162', name: 'Exercice 2026', dateFrom: '2026-01-01', dateTo: '2026-12-31' };
const period = (patch: Partial<AccountingPeriod> = {}): AccountingPeriod => ({ ...draft, status: 'open', closedAt: '', createdAt: '', updatedAt: '', ...patch });

describe('exercices comptables guidés', () => {
  it.each(['', '2026-02-29', '2026-04-31', '2026-2-01', '0000-01-01', '10000-01-01', '2026-01-00'])('refuse une date non réelle ou non canonique : %s', value => expect(isPeriodDate(value)).toBe(false));
  it.each(['2028-02-29', '2000-02-29', '0001-01-01', '9999-12-31'])('accepte la date réelle %s', value => expect(isPeriodDate(value)).toBe(true));
  it('propose une année sans remplacer un nom personnalisé ni changer l’identifiant', () => {
    expect(calendarYearDraft(draft, 2027)).toEqual({ ...draft, name: 'Exercice 2027', dateFrom: '2027-01-01', dateTo: '2027-12-31' });
    expect(calendarYearDraft({ ...draft, name: 'Premier exercice de l’atelier' }, 2027).name).toBe('Premier exercice de l’atelier');
    expect(calendarYearDraft(draft, 10000)).toBe(draft);
  });
  it('garde les exercices personnalisés et les périodes d’un jour', () => {
    expect(periodDraftIssue({ ...draft, dateFrom: '2026-07-01', dateTo: '2027-06-30' }, [])).toBeNull();
    expect(periodDraftIssue({ ...draft, dateTo: draft.dateFrom }, [])).toBeNull();
  });
  it('explique le nom, les dates manquantes et leur ordre', () => {
    expect(periodDraftIssue({ ...draft, name: ' ' }, [])?.field).toBe('name');
    expect(periodDraftIssue({ ...draft, name: 'A'.repeat(121) }, [])?.field).toBe('name');
    expect(periodDraftIssue({ ...draft, dateFrom: '' }, [])?.field).toBe('dateFrom');
    expect(periodDraftIssue({ ...draft, dateTo: '2025-12-31' }, [])?.field).toBe('dateTo');
  });
  it('exclut l’exercice en cours de modification mais refuse le chevauchement inclusif', () => {
    expect(periodDraftIssue(draft, [period()])).toBeNull();
    const existing = period({ id: 'other', name: 'Premier semestre', dateTo: '2026-06-30' });
    expect(periodDraftIssue({ ...draft, dateFrom: '2026-06-30' }, [existing])).toMatchObject({ field: 'dateFrom', overlappingId: 'other', message: expect.stringContaining('Premier semestre') });
    expect(periodDraftIssue({ ...draft, dateFrom: '2026-07-01' }, [existing])).toBeNull();
  });
  it('respecte la limite cumulative même sans chevauchement avec un exercice fermé', () => {
    const closed = period({ id: 'closed', name: 'Exercice clôturé', dateFrom: '2025-01-01', dateTo: '2025-12-31', status: 'closed' });
    expect(closedThrough([closed, period()])).toBe('2025-12-31');
    expect(periodDraftIssue({ ...draft, dateFrom: '2024-01-01', dateTo: '2024-12-31' }, [closed])).toMatchObject({ field: 'dateFrom', message: expect.stringContaining('verrouillés') });
    expect(periodDraftIssue({ ...draft, dateFrom: '2025-12-31' }, [closed])?.suggestedStart).toBe('2026-01-01');
    expect(periodDraftIssue(draft, [closed])).toBeNull();
    expect(periodDraftIssue({ ...draft, id: closed.id }, [closed])?.message).toContain('déjà clôturé');
  });
  it('calcule le premier jour disponible sans décalage de fuseau ni erreur bissextile', () => {
    expect(nextPeriodDay('2028-02-28')).toBe('2028-02-29');
    expect(nextPeriodDay('2026-02-28')).toBe('2026-03-01');
    expect(nextPeriodDay('2026-12-31')).toBe('2027-01-01');
    expect(nextPeriodDay('0001-01-01')).toBe('0001-01-02');
    expect(nextPeriodDay('9999-12-31')).toBeUndefined();
  });
  it('transmet le même identifiant de création après un refus natif', async () => {
    invokeMock.mockReset(); invokeMock.mockRejectedValueOnce(new Error('Refus de recette')).mockResolvedValueOnce({});
    await expect(desktopApi.upsertAccountingPeriod(draft)).rejects.toThrow('Refus');
    await desktopApi.upsertAccountingPeriod(draft);
    const expected = ['upsert_accounting_period', { input: { id: draft.id, name: draft.name, date_from: draft.dateFrom, date_to: draft.dateTo } }];
    expect(invokeMock.mock.calls).toEqual([expected, expected]);
  });
});
