// Données fictives pour les captures « Terrain et clients » (?erp=terrain). Exclues de la production.
import { desktopApi } from '../src/bridge';
import type { AgendaEvent, Workspace } from '../src/types';

const now = '2026-10-20T08:00:00Z';
const day = (offset: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
/** Lundi de la semaine en cours, pour remplir le planning de la semaine affichée. */
const monday = () => { const offset = (new Date().getDay() + 6) % 7; return -offset; };

export function installTerrainFixture(getData: () => Workspace) {
  const data = getData();
  const clientBase = data.clients[0] ?? ({} as Workspace['clients'][number]);
  const client = (id: string, name: string, company: string, phone: string, address: string, postalCode: string, city: string) =>
    ({ ...clientBase, id, name, company, phone, email: `${id}@example.invalid`, address: `${address}\n${postalCode} ${city}`, addressLine1: address, postalCode, city, archivedAt: null });
  data.clients = [
    client('c-keller', 'Famille Keller', '', '+41 79 555 01 12', 'Rue du Lac 4', '1260', 'Nyon'),
    client('c-rochat', 'Claire Rochat', '', '+41 78 555 22 40', 'Chemin des Vignes 12', '1110', 'Morges'),
    client('c-favre', 'Menuiserie Favre Sàrl', 'Menuiserie Favre Sàrl', '+41 21 555 33 90', 'Route de Genève 88', '1004', 'Lausanne'),
    client('c-morel', 'Alex Morel', '', '+41 22 555 44 18', 'Rue de Carouge 21', '1205', 'Genève'),
  ] as never;
  const projectBase = data.projects[0] ?? ({} as Workspace['projects'][number]);
  const project = (id: string, clientId: string, name: string, address: string, status: string) =>
    ({ ...projectBase, id, clientId, name, address, status, plannedStart: day(monday() + 1), plannedEnd: day(monday() + 20), archivedAt: null });
  data.projects = [
    project('p-cuisine', 'c-rochat', 'Rénovation cuisine Rochat', 'Chemin des Vignes 12, 1110 Morges', 'in_progress'),
    project('p-atelier', 'c-favre', 'Agrandissement de l’atelier', 'Route de Genève 88, 1004 Lausanne', 'in_progress'),
    project('p-sdb', 'c-morel', 'Salle de bain à l’étage', 'Rue de Carouge 21, 1205 Genève', 'planned'),
    project('p-toit', 'c-keller', 'Isolation des combles Keller', 'Rue du Lac 4, 1260 Nyon', 'planned'),
  ] as never;
  const employeeBase = data.employees[0] ?? ({} as Workspace['employees'][number]);
  data.employees = [
    { ...employeeBase, id: 'emp-marc', name: 'Marc Rochat', role: 'Installateur', employmentStart: '2020-03-01', employmentEnd: '' },
    { ...employeeBase, id: 'emp-lea', name: 'Léa Bonvin', role: 'Installatrice', employmentStart: '2022-08-01', employmentEnd: '' },
    { ...employeeBase, id: 'emp-tom', name: 'Tom Girard', role: 'Apprenti', employmentStart: '2025-08-01', employmentEnd: '' },
  ] as never;
  data.absences = [{ id: 'ab-lea', employeeId: 'emp-lea', kind: 'vacation', startDate: day(monday() + 3), endDate: day(monday() + 4), days: 2, incapacityPercent: 100,
    certificate: false, note: '', ijmDeclaredAt: null }];
  const event = (id: string, title: string, offset: number, start: string | null, end: string | null, employeeId: string | null, projectId: string | null, location: string, kind: AgendaEvent['kind'] = 'visit'): AgendaEvent =>
    ({ id, title, startDate: day(monday() + offset), endDate: day(monday() + offset), allDay: !start, startTime: start, endTime: end, kind, status: 'scheduled',
      location, notes: '', projectId, employeeId, createdAt: now, updatedAt: now });
  data.agendaEvents = [
    event('ev-1', 'Chantier · Rénovation cuisine Rochat', 0, null, null, 'emp-marc', 'p-cuisine', 'Morges', 'other'),
    event('ev-2', 'Chantier · Rénovation cuisine Rochat', 1, null, null, 'emp-marc', 'p-cuisine', 'Morges', 'other'),
    event('ev-3', 'Métré atelier Favre', 0, '08:00', '09:30', 'emp-lea', 'p-atelier', 'Lausanne'),
    event('ev-4', 'Dépannage chauffe-eau', 1, '13:30', '15:00', 'emp-lea', null, 'Rolle'),
    event('ev-5', 'Visite salle de bain Morel', 2, '10:00', '11:00', 'emp-tom', 'p-sdb', 'Genève'),
    event('ev-6', 'Livraison matériel', 2, '07:30', '08:30', null, 'p-atelier', 'Lausanne', 'appointment'),
    event('ev-7', 'Chantier · Agrandissement de l’atelier', 3, null, null, 'emp-marc', 'p-atelier', 'Lausanne', 'other'),
    event('ev-8', 'Chantier · Agrandissement de l’atelier', 4, null, null, 'emp-tom', 'p-atelier', 'Lausanne', 'other'),
  ];
  data.installedEquipment = [
    { id: 'eq-keller', clientId: 'c-keller', projectId: null, kind: 'Chaudière', brand: 'Viessmann', model: 'Vitodens 200-W', serialNumber: '7720-1144', installedOn: '2022-11-20',
      warrantyUntil: '2027-11-20', location: 'Sous-sol, Rue du Lac 4, Nyon', serviceIntervalMonths: 12, lastServiceOn: day(30 - 365), notes: '', archivedAt: null, createdAt: now, updatedAt: now },
    { id: 'eq-rochat', clientId: 'c-rochat', projectId: 'p-cuisine', kind: 'Pompe à chaleur', brand: 'Hoval', model: 'Belaria SRM 8', serialNumber: 'HV-55891', installedOn: '2024-04-12',
      warrantyUntil: day(40), location: 'Jardin, Chemin des Vignes 12, Morges', serviceIntervalMonths: 24, lastServiceOn: '2025-05-02', notes: '', archivedAt: null, createdAt: now, updatedAt: now },
    { id: 'eq-favre', clientId: 'c-favre', projectId: 'p-atelier', kind: 'Porte sectionnelle', brand: 'Hörmann', model: 'SPU F42', serialNumber: '', installedOn: '2021-06-01',
      warrantyUntil: '2023-06-01', location: 'Atelier, Route de Genève 88, Lausanne', serviceIntervalMonths: 12, lastServiceOn: day(-20), notes: '', archivedAt: null, createdAt: now, updatedAt: now },
    { id: 'eq-morel', clientId: 'c-morel', projectId: null, kind: 'Adoucisseur d’eau', brand: 'BWT', model: 'Perla Seta', serialNumber: 'BW-2210', installedOn: '2023-02-14',
      warrantyUntil: '2025-02-14', location: 'Cave, Rue de Carouge 21, Genève', serviceIntervalMonths: 6, lastServiceOn: day(-160), notes: '', archivedAt: null, createdAt: now, updatedAt: now },
  ];
  data.equipmentServices = [];
  // Positions déjà trouvées : la capture ne dépend pas du service de recherche.
  try {
    localStorage.setItem('zentra.planning.geocode.v1', JSON.stringify({
      'chemin des vignes 12, 1110 morges': { lat: 46.5136, lon: 6.4931 },
      'route de genève 88, 1004 lausanne': { lat: 46.5235, lon: 6.6105 },
      'rue de carouge 21, 1205 genève': { lat: 46.1953, lon: 6.1424 },
      'rue du lac 4, 1260 nyon': { lat: 46.3831, lon: 6.2391 },
    }));
  } catch { /* capture sans carte */ }

  desktopApi.saveAgendaEvent = async input => {
    const current = getData();
    const event: AgendaEvent = { id: input.id, title: input.title, startDate: input.startDate, endDate: input.endDate, allDay: input.allDay, startTime: input.allDay ? null : input.startTime,
      endTime: input.allDay ? null : input.endTime, kind: input.kind, status: input.status, location: input.location, notes: input.notes, projectId: input.projectId, employeeId: input.employeeId,
      createdAt: now, updatedAt: new Date().toISOString() };
    current.agendaEvents = [...current.agendaEvents.filter(row => row.id !== event.id), event];
    return structuredClone(current);
  };
  desktopApi.planEquipmentService = async input => {
    const current = getData();
    const serviceId = `svc-${Date.now()}`, agendaEventId = `ev-svc-${Date.now()}`;
    const item = current.installedEquipment?.find(row => row.id === input.equipmentId);
    current.agendaEvents = [...current.agendaEvents, { id: agendaEventId, title: input.title, startDate: input.date, endDate: input.date, allDay: false, startTime: input.startTime, endTime: input.endTime,
      kind: 'visit', status: 'scheduled', location: item?.location ?? '', notes: '', projectId: item?.projectId ?? null, employeeId: input.employeeId, createdAt: now, updatedAt: now }];
    current.equipmentServices = [...(current.equipmentServices ?? []), { id: serviceId, equipmentId: input.equipmentId, status: 'planned', serviceDate: input.date, agendaEventId, notes: '' }];
    return { serviceId, agendaEventId, workspace: structuredClone(current) };
  };
  desktopApi.cancelEquipmentService = async serviceId => {
    const current = getData();
    const service = current.equipmentServices?.find(row => row.id === serviceId);
    current.equipmentServices = (current.equipmentServices ?? []).filter(row => row.id !== serviceId);
    current.agendaEvents = current.agendaEvents.filter(row => row.id !== service?.agendaEventId);
    return structuredClone(current);
  };
}
