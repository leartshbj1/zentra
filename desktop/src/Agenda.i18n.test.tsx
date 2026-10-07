// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
import './languageTestPacks';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgendaEditor } from './AgendaEditor';
import { AgendaActionDialog } from './AgendaActionDialog';
import { AgendaScreen } from './AgendaScreen';
import { buildAgendaItems, shiftDate, shiftMonth, weekDates } from './agenda';
import { agendaGroupText, eventDraft, type AgendaEventDraft, type AgendaErrorHandler } from './agendaForm';
import { setAppLanguage, t, type AppLanguage } from './language';
import type { AgendaEvent, Workspace } from './types';

// Exercise the real controls, form logic and language loader, without a native bridge.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false, Channel: class {} }));
vi.mock('./assistantContext', () => ({ AssistantHelpButton: () => null, useAssistantScreen: () => {} }));

const languages = ['fr', 'de', 'it', 'en'] as const;
const saveAction = () => vi.fn(async (_draft: AgendaEventDraft, _onError?: AgendaErrorHandler) => true);
const title = 'Visite client {count} – été 客戶';
const location = 'Rue française {name}, Lausanne';
const notes = 'À préparer : devis {start}\nNe pas traduire cette note.';
const stored: AgendaEvent = {
  id: 'agenda-i18n', title, location, notes, startDate: '2026-10-07', endDate: '2026-10-08',
  allDay: false, startTime: '23:45', endTime: '00:15', kind: 'visit', status: 'scheduled',
  projectId: null, employeeId: null, createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-02T08:00:00Z',
};
const visible = {
  fr: { create: 'Nouveau rendez-vous', edit: 'Modifier le rendez-vous', remove: 'Supprimer ce rendez-vous ?', full: 'Journée entière', invalidDate: 'Choisissez la date de début dans le calendrier.' },
  de: { create: 'Neuer Termin', edit: 'Termin bearbeiten', remove: 'Diesen Termin löschen?', full: 'Ganzer Tag', invalidDate: 'Wählen Sie das Startdatum im Kalender.' },
  it: { create: 'Nuovo appuntamento', edit: 'Modifica appuntamento', remove: 'Eliminare questo appuntamento?', full: 'Intera giornata', invalidDate: 'Scegli la data di inizio nel calendario.' },
  en: { create: 'New appointment', edit: 'Edit appointment', remove: 'Delete this appointment?', full: 'Full day', invalidDate: 'Choose the start date in the calendar.' },
};

function workspace(events: AgendaEvent[] = []): Workspace {
  return {
    agendaEvents: events, projects: [], employees: [], clients: [], projectTasks: [], projectMilestones: [],
    invoices: [], quotes: [], supplierInvoices: [], payslips: [],
  } as unknown as Workspace;
}
function addMilestone(data: Workspace) {
  data.projectMilestones = [{ id: 'milestone', projectId: 'project', title, description: '', dueDate: '2026-10-07', status: 'todo', priority: 'normal', sortOrder: 0, employeeId: null, completedAt: null, createdAt: stored.createdAt, updatedAt: stored.updatedAt }];
}
let host: HTMLDivElement, root: Root;
let originalScroll: PropertyDescriptor | undefined;
beforeEach(() => {
  originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  await act(async () => { await setAppLanguage('fr'); });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
  else delete (Element.prototype as Partial<Element>).scrollIntoView;
});
async function render(language: AppLanguage, node: ReactNode) {
  await act(async () => { await setAppLanguage(language); root.render(node); });
}
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(name: string): T {
  const node = document.querySelector<T>(`[name="${name}"]`); expect(node, name).toBeTruthy(); return node!;
}
async function change(name: string, value: string) {
  const node = field(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function click(source: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.trim() === t(source));
  expect(node, source).toBeTruthy(); await act(async () => node!.click());
}

describe('calendar language and raw appointment values', () => {
  it.each(languages)('creates an appointment in %s with unchanged ISO dates, enums and user text', async language => {
    const onSave = saveAction(), onClose = vi.fn();
    await render(language, <AgendaEditor draft={eventDraft(undefined, '2026-10-07')} workspace={workspace()} busy={false} readOnly={false} onSave={onSave} onClose={onClose} />);
    expect(document.querySelector('.modal h2')?.textContent).toBe(visible[language].create);
    await change('title', title); await change('location', location); await change('notes', notes);
    await change('startTime', '23:45'); await click('30 min');
    expect(field('endDate').value).toBe('2026-10-08'); expect(field('endTime').value).toBe('00:15');
    await change('kind', 'visit'); await submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ title, location, notes, startDate: '2026-10-07', endDate: '2026-10-08', startTime: '23:45', endTime: '00:15', kind: 'visit', status: 'scheduled', allDay: false, isNew: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(languages)('edits an appointment in %s without replacing its identity or user content', async language => {
    const onSave = saveAction();
    await render(language, <AgendaEditor draft={eventDraft(stored)} workspace={workspace([stored])} busy={false} readOnly={false} onSave={onSave} onClose={vi.fn()} />);
    expect(document.querySelector('.modal h2')?.textContent).toBe(visible[language].edit);
    expect(field('title').value).toBe(title); expect(field('notes').value).toBe(notes);
    await change('endDate', '2026-10-09'); await change('endTime', '08:30'); await submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: stored.id, expectedUpdatedAt: stored.updatedAt, isNew: false, title, location, notes, startDate: '2026-10-07', endDate: '2026-10-09', endTime: '08:30', kind: 'visit', status: 'scheduled' });
    expect(stored.endDate).toBe('2026-10-08');
  });

  it.each(languages)('validates and retains source messages in %s, including a language change with an open error', async language => {
    const onSave = vi.fn(async () => true);
    await render(language, <AgendaEditor draft={eventDraft(stored)} workspace={workspace([stored])} busy={false} readOnly={false} onSave={onSave} onClose={vi.fn()} />);
    await change('startDate', ''); await submit();
    expect(document.querySelector('.field__error')?.textContent).toBe(visible[language].invalidDate);
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { await setAppLanguage('en'); });
    expect(document.querySelector('.field__error')?.textContent).toBe(visible.en.invalidDate);
    expect(field('title').value).toBe(title); expect(field('notes').value).toBe(notes);
  });

  it.each(languages)('confirms deletion in %s with the exact reviewed event', async language => {
    const onDelete = vi.fn(async () => true), onSave = vi.fn(async () => true), onClose = vi.fn();
    await render(language, <AgendaActionDialog event={stored} action="delete" workspace={workspace([stored])} busy={false} readOnly={false} onDelete={onDelete} onSave={onSave} onClose={onClose} />);
    expect(document.querySelector('.modal h2')?.textContent).toBe(visible[language].remove);
    expect(document.body.textContent).toContain(title); expect(document.body.textContent).toContain(notes);
    await click('Supprimer le rendez-vous');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(stored, expect.any(Function));
    expect(onSave).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(languages)('completes an appointment in %s without modifying the schedule or arbitrary text', async language => {
    const onSave = saveAction(), onDelete = vi.fn(async () => true);
    await render(language, <AgendaActionDialog event={stored} action="complete" workspace={workspace([stored])} busy={false} readOnly={false} onDelete={onDelete} onSave={onSave} onClose={vi.fn()} />);
    await click('Marquer comme terminé');
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: stored.id, expectedUpdatedAt: stored.updatedAt, title, location, notes, startDate: stored.startDate, endDate: stored.endDate, status: 'completed', kind: 'visit' });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('updates the same open form without resetting values, focus, options or all-day state', async () => {
    await render('fr', <AgendaEditor draft={eventDraft(stored)} workspace={workspace([stored])} busy={false} readOnly={false} onSave={vi.fn(async () => true)} onClose={vi.fn()} />);
    await change('title', `${title} modifié`); await act(async () => field('allDay').click());
    const titleField = field('title'); titleField.focus();
    for (const language of ['de', 'it', 'en', 'fr'] as const) {
      await act(async () => { await setAppLanguage(language); });
      expect(document.querySelector('.modal h2')?.textContent).toBe(visible[language].edit);
      expect(document.querySelector('.agenda-time-summary')?.textContent).toContain(visible[language].full);
      expect(titleField.value).toBe(`${title} modifié`); expect(field('notes').value).toBe(notes);
      expect(field('kind').value).toBe('visit'); expect(field('allDay').checked).toBe(true);
      expect(field('startDate').value).toBe(stored.startDate); expect(document.activeElement).toBe(titleField);
    }
  });

  it.each(languages)('localizes derived titles and conflict summaries in %s while preserving customer tokens', async language => {
    await act(async () => { await setAppLanguage(language); });
    const data = workspace([stored]);
    addMilestone(data);
    const items = buildAgendaItems(data);
    expect(items.find(row => row.source === 'event')?.title).toBe(title);
    expect(items.find(row => row.source === 'milestone')?.title).toBe(t('Jalon · {title}', { title }));
    expect(agendaGroupText({ ...eventDraft(stored), allDay: true }, 'schedule', data)).toContain(t('Toute la journée'));
    expect(agendaGroupText(eventDraft(stored), 'notes', data)).toBe(notes);
    expect(agendaGroupText(eventDraft(stored), 'kind', data)).toBe(t('Visite / intervention'));
    expect(data.projectMilestones[0]?.title).toBe(title);
  });

  it.each([
    ['fr', 'Tâche', 'Jalon'],
    ['de', 'Aufgabe', 'Meilenstein'],
    ['it', 'Attività', 'Traguardo'],
    ['en', 'Task', 'Milestone'],
  ] as const)('localizes task and milestone source badges in %s while preserving matching customer titles', async (language, taskLabel, milestoneLabel) => {
    const data = workspace([stored]);
    addMilestone(data);
    data.projectMilestones[0]!.title = 'Jalon';
    data.projectTasks = [{ ...data.projectMilestones[0]!, id: 'task', milestoneId: null, title: 'Tâche' }];
    await render(language, <AgendaScreen workspace={data} busy={false} readOnly={false} initialEventId={stored.id} onSave={vi.fn(async () => true)} onDelete={vi.fn(async () => true)} onNavigate={vi.fn()} />);
    const rows = [...host.querySelectorAll('.agenda-row--projects')].map(row => ({
      title: row.querySelector('.agenda-row__content strong')?.textContent,
      source: row.querySelector('.agenda-row__content small')?.textContent,
    }));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      { title: 'Tâche', source: taskLabel },
      { title: `${milestoneLabel} · Jalon`, source: milestoneLabel },
    ]));
    expect(data.projectTasks[0]?.title).toBe('Tâche');
    expect(data.projectMilestones[0]?.title).toBe('Jalon');
    expect(stored.title).toBe(title);
  });

  it.each(languages)('switches day, week and month in %s and retains the selected date across a language update', async language => {
    const data = workspace([stored]);
    addMilestone(data);
    await render(language, <AgendaScreen workspace={data} busy={false} readOnly={false} initialEventId={stored.id} onSave={vi.fn(async () => true)} onDelete={vi.fn(async () => true)} onNavigate={vi.fn()} />);
    expect(host.querySelector('.agenda-main-grid')?.getAttribute('data-display')).toBe('day');
    expect(host.querySelector('.agenda-list')?.textContent).toContain(t('Jalon · {title}', { title }));
    await click('Semaine'); expect(host.querySelector('.agenda-main-grid')?.getAttribute('data-display')).toBe('week');
    expect(host.querySelector('.agenda-day.is-selected')?.textContent).toContain('7');
    await click('Mois'); expect(host.querySelectorAll('.agenda-day')).toHaveLength(42);
    expect(host.querySelector('.agenda-main-grid')?.getAttribute('data-display')).toBe('month');
    await click('Jour');
    const selected = host.querySelector('.agenda-day-view strong')?.textContent;
    await act(async () => { await setAppLanguage(language === 'en' ? 'de' : 'en'); });
    expect(host.querySelector('.agenda-day-view strong')?.textContent).not.toBe(selected);
    expect(host.querySelector('.agenda-list')?.textContent).toContain(title);
    expect(host.querySelector('.agenda-list')?.textContent).toContain(t('Jalon · {title}', { title }));
    expect(stored.startDate).toBe('2026-10-07');
  });

  it('keeps ISO navigation stable at year, leap-day and daylight-saving boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDate('2026-10-25', 1)).toBe('2026-10-26');
    expect(weekDates('2026-12-31')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });
});
