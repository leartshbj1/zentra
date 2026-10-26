import { describe, expect, it } from 'vitest';
import { addMonths, equipmentFromRaw, lastService, nextServiceDue, plannedService, servicesToPlan, suggestedServiceSlot, warrantiesEnding, type EquipmentService, type InstalledEquipment } from './installedEquipment';
import type { AgendaEvent } from './types';

const boiler = (patch: Partial<InstalledEquipment> = {}): InstalledEquipment => ({
  id: 'b1', clientId: 'c1', projectId: null, kind: 'Chaudière', brand: 'Viessmann', model: 'Vitodens 200', serialNumber: '7720', installedOn: '2023-11-20',
  warrantyUntil: '2026-11-20', location: 'Sous-sol', serviceIntervalMonths: 12, lastServiceOn: '2025-11-25', notes: '', archivedAt: null, createdAt: '', updatedAt: '', ...patch,
});
const event = (id: string, patch: Partial<AgendaEvent> = {}): AgendaEvent => ({
  id, title: 'Visite', startDate: '2026-11-24', endDate: '2026-11-24', allDay: false, startTime: '08:00', endTime: '09:00', kind: 'visit', status: 'scheduled',
  location: '', notes: '', projectId: null, employeeId: null, createdAt: '', updatedAt: '', ...patch,
});

describe('installed equipment', () => {
  it('adds months without overflowing short months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-11-25', 12)).toBe('2026-11-25');
    expect(addMonths('2026-10-15', 24)).toBe('2028-10-15');
  });

  it('takes the latest known service, then the installation date', () => {
    const done: EquipmentService[] = [{ id: 's1', equipmentId: 'b1', status: 'done', serviceDate: '2026-01-05', agendaEventId: null, notes: '' }];
    expect(lastService(boiler(), done)).toBe('2026-01-05');
    expect(lastService(boiler({ lastServiceOn: null }), [])).toBe('2023-11-20');
    expect(nextServiceDue(boiler({ serviceIntervalMonths: null }), [])).toBeNull();
    expect(nextServiceDue(boiler({ archivedAt: '2026-01-01' }), [])).toBeNull();
  });

  it('proposes a service within 30 days once, until it is planned', () => {
    expect(servicesToPlan([boiler()], [], [], '2026-10-25')).toEqual([]);
    expect(servicesToPlan([boiler()], [], [], '2026-10-26')).toMatchObject([{ due: '2026-11-25', days: 30 }]);
    expect(servicesToPlan([boiler()], [], [], '2026-12-10')).toMatchObject([{ days: -15 }]);
    const planned: EquipmentService[] = [{ id: 's2', equipmentId: 'b1', status: 'planned', serviceDate: '2026-11-24', agendaEventId: 'e1', notes: '' }];
    expect(servicesToPlan([boiler()], planned, [event('e1')], '2026-11-01')).toEqual([]);
    expect(plannedService(boiler(), planned, [event('e1', { status: 'cancelled' })])).toBeNull();
    expect(servicesToPlan([boiler()], planned, [event('e1', { status: 'cancelled' })], '2026-11-01')).toHaveLength(1);
  });

  it('suggests the due day, skipping weekends and busy hours', () => {
    // 2026-11-28 est un samedi : lundi 30 novembre.
    expect(suggestedServiceSlot('2026-11-28', '2026-11-01', [])).toEqual({ date: '2026-11-30', startTime: '08:00', endTime: '09:00' });
    expect(suggestedServiceSlot('2026-11-24', '2026-11-01', [event('e1'), event('e2', { startTime: '09:00', endTime: '10:30' })])).toEqual({ date: '2026-11-24', startTime: '11:00', endTime: '12:00' });
    // Échéance passée : dès le prochain jour ouvrable.
    expect(suggestedServiceSlot('2026-10-01', '2026-10-23', []).date).toBe('2026-10-26');
  });

  it('lists warranties that end soon and reads raw rows', () => {
    expect(warrantiesEnding([boiler()], '2026-10-25').map(row => row.id)).toEqual(['b1']);
    expect(warrantiesEnding([boiler()], '2026-11-21')).toEqual([]);
    expect(equipmentFromRaw({ id: 'x', client_id: 'c', kind: 'Pompe', service_interval_months: 24, project_id: null })).toMatchObject({ id: 'x', serviceIntervalMonths: 24, projectId: null, brand: '' });
  });
});
