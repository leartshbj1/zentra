import type { AgendaEvent, Workspace } from './types';
import { isValidIsoCalendarDate } from './payrollImportQuality';
import { createId, errorMessage, formatDate, todayIso } from './utils';
import { shiftDate } from './agenda';

export type AgendaEventDraft = Omit<AgendaEvent, 'createdAt' | 'updatedAt'> & { isNew: boolean; expectedUpdatedAt: string | null };
export type AgendaErrorHandler = (reason: unknown) => void;
export type AgendaField = 'title' | 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'kind' | 'status' | 'location' | 'notes' | 'projectId' | 'employeeId';
export type AgendaFormIssue = { field: AgendaField; message: string };

export function eventDraft(event?: AgendaEvent, date = todayIso()): AgendaEventDraft {
  if (event) {
    const { createdAt: _created, updatedAt, ...fields } = event;
    return { ...fields, isNew: false, expectedUpdatedAt: updatedAt };
  }
  return { id: createId(), isNew: true, expectedUpdatedAt: null, title: '', startDate: date, endDate: date, allDay: false, startTime: '09:00', endTime: '10:00', kind: 'appointment', status: 'scheduled', location: '', notes: '', projectId: null, employeeId: null };
}

const validTime = (value: string | null) => !!value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function agendaFormIssue(draft: AgendaEventDraft, workspace: Workspace, original: AgendaEventDraft): AgendaFormIssue | undefined {
  if (!draft.title.trim() || [...draft.title.trim()].length > 200) return { field: 'title', message: 'Donnez un titre de 1 à 200 caractères, par exemple « Visite chez le client ».' };
  if (!draft.startDate || !isValidIsoCalendarDate(draft.startDate)) return { field: 'startDate', message: 'Choisissez la date de début dans le calendrier.' };
  if (!draft.endDate || !isValidIsoCalendarDate(draft.endDate)) return { field: 'endDate', message: 'Choisissez la date de fin. Pour un seul jour, reprenez la date de début.' };
  if (draft.endDate < draft.startDate) return { field: 'endDate', message: 'La fin est avant le début. Choisissez le même jour ou une date plus tardive.' };
  if (!draft.allDay) {
    if (!validTime(draft.startTime)) return { field: 'startTime', message: 'Indiquez l’heure de début, par exemple 09:00, ou cochez « Toute la journée ».' };
    if (!validTime(draft.endTime)) return { field: 'endTime', message: 'Indiquez l’heure de fin, ou choisissez une durée juste en dessous.' };
    if (draft.startDate === draft.endDate && draft.endTime! <= draft.startTime!) return { field: 'endTime', message: 'La fin doit être après le début. Si le rendez-vous finit le lendemain, changez aussi la date de fin.' };
  }
  if (!['appointment', 'visit', 'deadline', 'other'].includes(draft.kind)) return { field: 'kind', message: 'Choisissez le type de rendez-vous dans la liste.' };
  if (!['scheduled', 'completed', 'cancelled'].includes(draft.status)) return { field: 'status', message: 'Choisissez « Planifié », « Terminé » ou « Annulé ».' };
  if ([...draft.location.trim()].length > 500) return { field: 'location', message: 'Raccourcissez le lieu à 500 caractères au maximum.' };
  if ([...draft.notes.trim()].length > 20000) return { field: 'notes', message: 'Raccourcissez les notes à 20 000 caractères au maximum.' };
  if (draft.projectId && !workspace.projects.some(row => row.id === draft.projectId && (row.status !== 'closed' || row.id === original.projectId))) return { field: 'projectId', message: 'Ce projet n’est plus disponible. Choisissez un projet ouvert ou « Aucun projet ».' };
  if (draft.employeeId && !workspace.employees.some(row => row.id === draft.employeeId && (row.active || row.id === original.employeeId))) return { field: 'employeeId', message: 'Cette personne n’est plus disponible. Choisissez un collaborateur actif ou « Non attribué ».' };
}

export function changeAgendaStartDate(draft: AgendaEventDraft, date: string): AgendaEventDraft {
  return { ...draft, startDate: date, endDate: draft.startDate === draft.endDate ? date : draft.endDate };
}

export function agendaDuration(draft: AgendaEventDraft, minutes: number): AgendaEventDraft | null {
  if (!draft.startDate || !isValidIsoCalendarDate(draft.startDate) || !validTime(draft.startTime) || ![15,30,60,120].includes(minutes)) return null;
  const [hour, minute] = draft.startTime!.split(':').map(Number);
  const end = hour * 60 + minute + minutes;
  return { ...draft, allDay: false, endDate: shiftDate(draft.startDate, Math.floor(end / 1440)), endTime: `${String(Math.floor(end / 60) % 24).padStart(2,'0')}:${String(end % 60).padStart(2,'0')}` };
}

export function agendaNativeIssue(reason: unknown): AgendaFormIssue | undefined {
  const text = errorMessage(reason, '');
  const match = [
    ['start_date', 'startDate', 'Choisissez une date de début réelle dans le calendrier.'],
    ['end_date|date de fin', 'endDate', 'Vérifiez la date de fin : elle doit être au même jour que le début ou après.'],
    ['start_time', 'startTime', 'Indiquez une heure de début valide, par exemple 09:00.'],
    ['end_time|heure de fin', 'endTime', 'Indiquez une heure de fin après le début, en tenant compte de la date de fin.'],
    ['project_id|projet/', 'projectId', 'Le projet lié est introuvable. Choisissez un autre projet ou « Aucun projet ».'],
    ['employee_id|collaborateur/', 'employeeId', 'Le collaborateur lié est introuvable. Choisissez une autre personne ou « Non attribué ».'],
    ['\\btitle\\b', 'title', 'Donnez un titre de 1 à 200 caractères.'],
    ['\\blocation\\b', 'location', 'Raccourcissez le lieu à 500 caractères au maximum.'],
    ['\\bnotes\\b', 'notes', 'Raccourcissez les notes à 20 000 caractères au maximum.'],
  ].find(([pattern]) => new RegExp(pattern, 'i').test(text));
  return match ? { field: match[1] as AgendaField, message: match[2] } : undefined;
}

export function requireAgendaWorkspace(value: Workspace) {
  if (!value.onboardingCompleted || !value.settings || !Array.isArray(value.agendaEvents)) throw new Error('L’agenda n’a pas pu être chargé. Réessayez l’actualisation.');
}

const groups = {
  title: { label: 'Titre', fields: ['title'] },
  schedule: { label: 'Dates et horaires', fields: ['startDate','endDate','allDay','startTime','endTime'] },
  location: { label: 'Lieu', fields: ['location'] },
  notes: { label: 'Notes', fields: ['notes'] },
  projectId: { label: 'Projet', fields: ['projectId'] },
  employeeId: { label: 'Responsable', fields: ['employeeId'] },
  kind: { label: 'Type', fields: ['kind'] },
  status: { label: 'État', fields: ['status'] },
} as const;
export type AgendaMergeGroup = keyof typeof groups;
export type AgendaMergeChoice = Partial<Record<AgendaMergeGroup, 'mine' | 'saved'>>;
const groupValues = (draft: AgendaEventDraft, group: AgendaMergeGroup) => groups[group].fields.map(field => {
  if ((field === 'startTime' || field === 'endTime') && draft.allDay) return null;
  const value = draft[field]; return typeof value === 'string' ? value.trim() : value;
});
export function agendaMerge(original: AgendaEventDraft, mine: AgendaEventDraft, saved: AgendaEvent, choices: AgendaMergeChoice = {}) {
  const current = eventDraft(saved), merged = { ...current };
  const conflicts: Array<{ group: AgendaMergeGroup; label: string }> = [];
  for (const group of Object.keys(groups) as AgendaMergeGroup[]) {
    const before = JSON.stringify(groupValues(original, group)), edited = JSON.stringify(groupValues(mine, group)), after = JSON.stringify(groupValues(current, group));
    const conflict = before !== edited && before !== after && edited !== after;
    if (conflict) conflicts.push({ group, label: groups[group].label });
    const chosen = conflict ? choices[group] === 'mine' ? mine : current : before !== edited ? mine : current;
    for (const field of groups[group].fields) Object.assign(merged, { [field]: chosen[field] });
  }
  return { merged, conflicts, resolved: conflicts.every(({group}) => !!choices[group]) };
}
export function agendaGroupText(draft: AgendaEventDraft, group: AgendaMergeGroup, workspace: Workspace): string {
  if (group === 'schedule') return `${formatDate(draft.startDate)} – ${formatDate(draft.endDate)} · ${draft.allDay ? 'Toute la journée' : `${draft.startTime || '…'} – ${draft.endTime || '…'}`}`;
  if (group === 'projectId') return workspace.projects.find(row => row.id === draft.projectId)?.name || (draft.projectId ? 'Projet indisponible' : 'Aucun projet');
  if (group === 'employeeId') return workspace.employees.find(row => row.id === draft.employeeId)?.name || (draft.employeeId ? 'Personne indisponible' : 'Non attribué');
  if (group === 'kind') return { appointment: 'Rendez-vous', visit: 'Visite / intervention', deadline: 'Échéance personnelle', other: 'Autre' }[draft.kind];
  if (group === 'status') return { scheduled: 'Planifié', completed: 'Terminé', cancelled: 'Annulé' }[draft.status];
  return draft[group] || 'Non renseigné';
}
