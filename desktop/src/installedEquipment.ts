import type { AgendaEvent, Client } from './types';

/** Équipement installé chez un client, avec son entretien périodique. */
export type InstalledEquipment = {
  id: string;
  clientId: string;
  projectId: string | null;
  kind: string;
  brand: string;
  model: string;
  serialNumber: string;
  installedOn: string | null;
  warrantyUntil: string | null;
  location: string;
  serviceIntervalMonths: number | null;
  lastServiceOn: string | null;
  notes: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EquipmentService = {
  id: string;
  equipmentId: string;
  status: 'planned' | 'done';
  serviceDate: string;
  agendaEventId: string | null;
  notes: string;
};

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const integer = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);

export function equipmentFromRaw(row: RawRow): InstalledEquipment {
  return {
    id: text(row.id), clientId: text(row.client_id), projectId: text(row.project_id) || null, kind: text(row.kind), brand: text(row.brand), model: text(row.model),
    serialNumber: text(row.serial_number), installedOn: text(row.installed_on) || null, warrantyUntil: text(row.warranty_until) || null, location: text(row.location),
    serviceIntervalMonths: integer(row.service_interval_months), lastServiceOn: text(row.last_service_on) || null, notes: text(row.notes),
    archivedAt: text(row.archived_at) || null, createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  };
}

export function equipmentServiceFromRaw(row: RawRow): EquipmentService {
  return {
    id: text(row.id), equipmentId: text(row.equipment_id), status: row.status === 'done' ? 'done' : 'planned', serviceDate: text(row.service_date),
    agendaEventId: text(row.agenda_event_id) || null, notes: text(row.notes),
  };
}

const day = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Ajoute des mois en restant sur le dernier jour du mois quand il n'existe pas (31 janvier + 1 mois = 28/29 février). */
export function addMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7)) - 1 + months, dayOfMonth = Number(date.slice(8, 10));
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(dayOfMonth, last)));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** Dernier entretien connu : la date saisie ou le dernier entretien fait, sinon la pose. */
export function lastService(equipment: InstalledEquipment, services: readonly EquipmentService[]): string | null {
  const done = services.filter(row => row.equipmentId === equipment.id && row.status === 'done').map(row => row.serviceDate);
  const dates = [equipment.lastServiceOn, ...done].filter((value): value is string => Boolean(value)).sort();
  return dates.at(-1) ?? equipment.installedOn;
}

/** Entretien planifié dont le rendez-vous n'est ni fait ni annulé. */
export function plannedService(equipment: InstalledEquipment, services: readonly EquipmentService[], events: readonly AgendaEvent[]): (EquipmentService & { event: AgendaEvent }) | null {
  for (const service of services) {
    if (service.equipmentId !== equipment.id || service.status !== 'planned' || !service.agendaEventId) continue;
    const event = events.find(row => row.id === service.agendaEventId);
    if (event && event.status === 'scheduled') return { ...service, event };
  }
  return null;
}

export function nextServiceDue(equipment: InstalledEquipment, services: readonly EquipmentService[]): string | null {
  if (!equipment.serviceIntervalMonths || equipment.archivedAt) return null;
  const last = lastService(equipment, services);
  return last ? addMonths(last, equipment.serviceIntervalMonths) : null;
}

export type ServiceDue = { equipment: InstalledEquipment; due: string; days: number };

/** Entretiens à planifier : échéance dans les 30 jours (ou dépassée), sans rendez-vous déjà prévu. */
export function servicesToPlan(equipment: readonly InstalledEquipment[], services: readonly EquipmentService[], events: readonly AgendaEvent[], today: string, horizonDays = 30): ServiceDue[] {
  const rows: ServiceDue[] = [];
  for (const item of equipment) {
    const due = nextServiceDue(item, services);
    if (!due) continue;
    const days = daysBetween(today, due);
    if (days > horizonDays || plannedService(item, services, events)) continue;
    rows.push({ equipment: item, due, days });
  }
  return rows.sort((left, right) => left.due.localeCompare(right.due));
}

/** Garanties qui se terminent dans les 60 jours. */
export function warrantiesEnding(equipment: readonly InstalledEquipment[], today: string, horizonDays = 60) {
  return equipment.filter(item => !item.archivedAt && item.warrantyUntil && item.warrantyUntil >= today && daysBetween(today, item.warrantyUntil) <= horizonDays);
}

const weekday = (date: string) => new Date(day(date)).getUTCDay();

/**
 * Créneau proposé pour l'entretien : le jour d'échéance s'il est à venir,
 * sinon le prochain jour ouvrable ; week-end repoussé au lundi. L'heure est la
 * première heure libre de 8 h à 16 h selon les rendez-vous déjà à l'agenda.
 */
export function suggestedServiceSlot(due: string, today: string, events: readonly AgendaEvent[]): { date: string; startTime: string; endTime: string } {
  let date = due > today ? due : iso(day(today) + 86_400_000);
  while (weekday(date) === 0 || weekday(date) === 6) date = iso(day(date) + 86_400_000);
  const busy = events.filter(event => event.status !== 'cancelled' && !event.allDay && event.startDate <= date && event.endDate >= date && event.startTime && event.endTime);
  for (let hour = 8; hour <= 16; hour++) {
    const start = `${String(hour).padStart(2, '0')}:00`, end = `${String(hour + 1).padStart(2, '0')}:00`;
    if (!busy.some(event => event.startTime! < end && event.endTime! > start)) return { date, startTime: start, endTime: end };
  }
  return { date, startTime: '08:00', endTime: '09:00' };
}

export function clientLabel(client: Pick<Client, 'company' | 'name'> | undefined) {
  return client?.company || client?.name || '';
}

/** « Chaudière Viessmann Vitodens 200 » : type, puis marque et modèle s'ils sont connus. */
export function equipmentLabel(item: Pick<InstalledEquipment, 'kind' | 'brand' | 'model'>) {
  return [item.kind, item.brand, item.model].map(part => part.trim()).filter(Boolean).join(' ');
}

/** Le type dans une phrase : « chaudière » en français et en italien, tel quel en allemand et en anglais. */
export function serviceKind(kind: string, language: string) {
  const value = kind.trim();
  return language === 'fr' || language === 'it' ? value.charAt(0).toLocaleLowerCase() + value.slice(1) : value;
}
