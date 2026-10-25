import { describe, expect, it } from 'vitest';
import { absenceOn, activeEmployees, dayPosition, eventsOn, moveConflict, movedEvent, planningRange, projectsToPlan, timeAtRatio, visibleDays } from './teamPlanning';
import type { Absence, AgendaEvent, Employee, Project } from './types';

const event = (id: string, patch: Partial<AgendaEvent> = {}): AgendaEvent => ({
  id, title: id, startDate: '2026-11-03', endDate: '2026-11-03', allDay: false, startTime: '08:00', endTime: '10:00', kind: 'visit', status: 'scheduled',
  location: '', notes: '', projectId: null, employeeId: 'marc', createdAt: '', updatedAt: '', ...patch,
});
const absence = (patch: Partial<Absence> = {}): Absence => ({ id: 'a1', employeeId: 'lea', kind: 'vacation', startDate: '2026-11-04', endDate: '2026-11-06', days: 3,
  incapacityPercent: 0, certificate: false, note: '', ijmDeclaredAt: null, ...patch });

describe('team planning', () => {
  it('shows a Monday-to-Sunday week or one day', () => {
    expect(planningRange('week', '2026-11-04').dates).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(planningRange('day', '2026-11-04').dates).toEqual(['2026-11-04']);
  });

  it('keeps people still employed, by name', () => {
    const people = [{ id: 'z', name: 'Zoé', employmentStart: '2020-01-01', employmentEnd: '' }, { id: 'a', name: 'Alain', employmentStart: '', employmentEnd: '2026-01-31' },
      { id: 'b', name: 'Bruno', employmentStart: '2027-01-01', employmentEnd: '' }] as Employee[];
    expect(activeEmployees(people, '2026-11-03').map(row => row.id)).toEqual(['z']);
  });

  it('moves an appointment to another day and person, keeping its length', () => {
    expect(movedEvent(event('e'), { employeeId: 'lea', date: '2026-11-05' })).toMatchObject({ startDate: '2026-11-05', endDate: '2026-11-05', employeeId: 'lea', startTime: '08:00', endTime: '10:00' });
    expect(movedEvent(event('e', { endDate: '2026-11-04', allDay: true, startTime: null, endTime: null }), { employeeId: '', date: '2026-11-10' })).toMatchObject({ startDate: '2026-11-10', endDate: '2026-11-11', employeeId: null });
    expect(movedEvent(event('e'), { employeeId: 'marc', date: '2026-11-03', startTime: '13:07' })).toMatchObject({ startTime: '13:00', endTime: '15:00' });
    expect(movedEvent(event('e'), { employeeId: 'marc', date: '2026-11-03' })).toBeNull();
    expect(movedEvent(event('e'), { employeeId: 'marc', date: '2026-11-03', startTime: '23:00' })).toBeNull();
  });

  it('refuses a day when the person is away', () => {
    expect(absenceOn([absence()], 'lea', '2026-11-05')?.kind).toBe('vacation');
    expect(moveConflict({ startDate: '2026-11-03', endDate: '2026-11-04' }, 'lea', [absence()])?.id).toBe('a1');
    expect(moveConflict({ startDate: '2026-11-03', endDate: '2026-11-03' }, 'lea', [absence()])).toBeNull();
    expect(moveConflict({ startDate: '2026-11-05', endDate: '2026-11-05' }, '', [absence()])).toBeNull();
  });

  it('lists rows, open chantiers to plan and day positions', () => {
    const events = [event('late', { startTime: '14:00', endTime: '15:00' }), event('early'), event('all', { allDay: true, startTime: null, endTime: null }), event('free', { employeeId: null }), event('off', { status: 'cancelled' })];
    expect(eventsOn(events, 'marc', '2026-11-03').map(row => row.id)).toEqual(['all', 'early', 'late']);
    expect(eventsOn(events, '', '2026-11-03').map(row => row.id)).toEqual(['free']);
    const projects = [{ id: 'p1', name: 'Cuisine Rochat', status: 'in_progress', plannedStart: '' }, { id: 'p2', name: 'Toiture', status: 'planned', plannedStart: '2026-11-01' },
      { id: 'p3', name: 'Fini', status: 'completed', plannedStart: '' }] as Project[];
    expect(projectsToPlan(projects, [event('x', { projectId: 'p1' })], ['2026-11-02', '2026-11-08']).map(row => row.id)).toEqual(['p2']);
    expect(dayPosition(event('e'), 7, 19)).toEqual({ left: (60 / 720) * 100, width: (120 / 720) * 100 });
    expect(dayPosition(event('e', { allDay: true }), 7, 19)).toBeNull();
    expect(timeAtRatio(0.5, 7, 19)).toBe('13:00');
    expect(timeAtRatio(1, 7, 19)).toBe('18:45');
  });
});

describe('visible days', () => {
  it('hides an empty weekend', () => {
    const week = planningRange('week', '2026-11-04').dates;
    expect(visibleDays(week, [], [])).toHaveLength(5);
    expect(visibleDays(week, [event('sat', { startDate: '2026-11-07', endDate: '2026-11-07' })], [])).toEqual([...week.slice(0, 5), '2026-11-07']);
    expect(visibleDays(['2026-11-07'], [], [])).toEqual(['2026-11-07']);
  });
});
