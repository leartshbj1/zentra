// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
import './languageTestPacks';
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectForm, ProjectsScreen } from './WorkspaceApp';
import { setAppLanguage } from './language';
import { initialOnboardingSettings } from './onboardingDraft';
import { createProjectFileSessions } from './projectFileSessions';
import type { Attachment, Project, Workspace } from './types';
import { FormDraftIdentityProvider } from './useFormDraft';

// Only native transport is replaced. The language loader, screen, folder,
// planning panel, file sessions, buttons and their handlers are real components.
const native = vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  return { invoke: vi.fn() };
});
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: native.invoke, isTauri: () => false, convertFileSrc: (path: string) => path }));

const project = (id: string, name: string, status: Project['status']): Project => ({
  id, name, status, clientId: 'client', address: 'Rue Vue d’ensemble {name}',
  plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '',
  budgetCents: 0, plannedMinutes: 0, notes: 'Notes conservées du client',
});
const customerProject = project('planned', 'Vue d’ensemble {name}', 'planned');
const attachment: Attachment = {
  id: 'file', projectId: 'planned', entityId: 'planned', entityType: 'project',
  originalName: 'Modifier {name}.txt', mimeType: 'text/plain', sizeBytes: 2048,
  sha256: 'fixture', createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-01T08:00:00Z',
};
const data = {
  settings: initialOnboardingSettings,
  clients: [{ id: 'client', name: 'Nom du client', company: 'Modifier' }],
  projects: [customerProject, project('active', 'Supprimer le projet', 'in_progress')],
  attachments: [attachment],
  projectTasks: [{ id: 'task', projectId: 'planned', milestoneId: null, employeeId: null,
    title: 'Créer un projet {title}', description: 'Texte du client', dueDate: '', status: 'todo',
    priority: 'normal', sortOrder: 0, completedAt: null, createdAt: '', updatedAt: '' }],
  projectMilestones: [], employees: [], timeEntries: [], invoices: [], payments: [], expenses: [],
  supplierInvoices: [], supplierCreditNotes: [], salesOrders: [], workNotes: [],
  quotes: [{ id: 'quote', number: 'DEV-42', clientId: 'client', projectId: 'planned',
    title: 'Vue d’ensemble', issueDate: '2026-10-01', validUntil: '', currency: 'CHF', status: 'draft',
    lines: [], notes: 'Notes de document', terms: '', createdAt: '2026-10-01T08:00:00Z' }],
} as unknown as Workspace;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  native.invoke.mockClear();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  await setAppLanguage('fr');
  vi.unstubAllGlobals();
});

function props(readOnly = false) {
  const api = { add: vi.fn(async () => undefined), remove: vi.fn(async () => data), load: vi.fn(async () => data) };
  const fileSessions = createProjectFileSessions(api, () => undefined);
  return { api, screen: {
    workspace: data, folderId: null as string | null, fileSessions, query: '', busy: false, readOnly,
    onFolderChange: vi.fn(), onClearSearch: vi.fn(), onOpenTime: vi.fn(), onOpenNotes: vi.fn(),
    onEdit: vi.fn(), onCreate: vi.fn(), onArchive: vi.fn(), onWorkspaceChange: vi.fn(),
    onOpenDocument: vi.fn(), onOpenExpense: vi.fn(), onCreateDocument: vi.fn(),
    onSaveTask: vi.fn(async () => true), onSaveMilestone: vi.fn(async () => true),
    onSetTaskStatus: vi.fn(async () => true), onDeleteTask: vi.fn(async () => true), onDeleteMilestone: vi.fn(async () => true),
    agendaPlanningTarget: null, onAgendaPlanningTargetHandled: vi.fn(),
  } satisfies ComponentProps<typeof ProjectsScreen> };
}
async function mount(screen: ComponentProps<typeof ProjectsScreen>) {
  function Harness() {
    const [folderId, setFolderId] = useState<string | null>(screen.folderId);
    return <ProjectsScreen {...screen} folderId={folderId} onFolderChange={id => { screen.onFolderChange(id); setFolderId(id); }} />;
  }
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  await rendered(() => Boolean(host.querySelector('.project-collection, .project-folder')));
}
async function rendered(check: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!check() && performance.now() < deadline)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(check(), host.textContent ?? '').toBe(true);
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find(item => item.textContent?.trim() === text);
async function click(text: string) {
  const target = button(text);
  expect(target, `Missing button: ${text}`).toBeDefined();
  await act(async () => target!.click());
}

describe('Projects interface language and retained customer data', () => {
  it('translates the real edit form while preserving unsaved names, client selection, notes and field values', async () => {
    const close = vi.fn();
    const save = vi.fn(async () => false);
    root = createRoot(host);
    await act(async () => root!.render(<FormDraftIdentityProvider companyId="project-i18n-form" memberId="local-user" ready>
      <ProjectForm workspace={data} item={customerProject} busy={false} close={close} act={save} />
    </FormDraftIdentityProvider>));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector<HTMLInputElement>('[name="name"]')!;
    const retainedName = 'Vue d’ensemble modifiée {name}';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, retainedName);
      name.dispatchEvent(new Event('input', { bubbles: true }));
      name.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (const [language, title, nameLabel, optional, choose, planned] of [
      ['fr', 'Modifier le projet', 'Nom du projet', 'Adresse, dates, budget et notes', 'Choisir un client', 'Planifié'],
      ['de', 'Projekt bearbeiten', 'Projektname', 'Adresse, Termine, Budget und Notizen', 'Kunden auswählen', 'Geplant'],
      ['it', 'Modifica il progetto', 'Nome del progetto', 'Indirizzo, date, budget e note', 'Scegli un cliente', 'Pianificato'],
      ['en', 'Edit project', 'Project name', 'Address, dates, budget and notes', 'Choose a client', 'Planned'],
    ] as const) {
      await act(async () => { await setAppLanguage(language); });
      expect(dialog.querySelector('h2')?.textContent).toBe(title);
      expect(name.closest('label')?.querySelector('.field__label')?.textContent).toContain(nameLabel);
      expect(dialog.querySelector('.project-optional-details summary')?.textContent).toBe(optional);
      const clients = dialog.querySelector<HTMLSelectElement>('[name="clientId"]')!;
      expect(clients.options[0].textContent).toBe(choose);
      expect(clients.value).toBe('client');
      expect(clients.options[1].textContent?.trim()).toBe('Modifier');
      expect(dialog.querySelector<HTMLSelectElement>('[name="status"]')?.selectedOptions[0].textContent).toBe(planned);
      expect(name.value).toBe(retainedName);
      expect(dialog.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value).toBe(customerProject.notes);
      expect(dialog.querySelector<HTMLTextAreaElement>('[name="address"]')?.value).toBe(customerProject.address);
      expect(save).not.toHaveBeenCalled();
      expect(customerProject.name).toBe('Vue d’ensemble {name}');
    }
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    await act(async () => cancel!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('changes real overview/filter/planning controls in all four languages without translating customer content', async () => {
    const { screen } = props();
    const original = structuredClone(data);
    await mount(screen);
    for (const [language, overview, planning, filter, all, planned, count, single, edit] of [
      ['fr', 'Vue d’ensemble', 'Tâches & jalons', 'État du projet', 'Tous les projets (2)', 'Planifiés (1)', '2 projets affichés', '1 projet affiché', 'Modifier'],
      ['de', 'Übersicht', 'Aufgaben & Meilensteine', 'Projektstatus', 'Alle Projekte (2)', 'Geplant (1)', '2 Projekte angezeigt', '1 Projekt angezeigt', 'Bearbeiten'],
      ['it', 'Panoramica', 'Attività e traguardi', 'Stato del progetto', 'Tutti i progetti (2)', 'Pianificati (1)', '2 progetti visualizzati', '1 progetto visualizzato', 'Modifica'],
      ['en', 'Overview', 'Tasks & milestones', 'Project status', 'All projects (2)', 'Planned (1)', '2 projects shown', '1 project shown', 'Edit'],
    ] as const) {
      await act(async () => { await setAppLanguage(language); });
      await click(overview);
      const select = host.querySelector<HTMLSelectElement>('#project-status-filter')!;
      if (select.value !== 'all') await act(async () => { select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.querySelector('label')?.textContent).toBe(filter);
      expect([...select.options].map(item => item.textContent)).toContain(all);
      expect([...select.options].map(item => item.textContent)).toContain(planned);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(count);
      expect(host.querySelectorAll('.project-card')).toHaveLength(2);
      expect(host.querySelector('.project-name-link')?.textContent).toBe(customerProject.name);
      expect(host.querySelector('.project-card header p')?.textContent).toBe('Modifier');
      await act(async () => { select.value = 'planned'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.querySelectorAll('.project-card')).toHaveLength(1);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(single);
      await click(edit);
      expect(screen.onEdit).toHaveBeenLastCalledWith(customerProject);
      await click(planning);
      await rendered(() => Boolean(host.textContent?.includes('Créer un projet {title}')));
      expect(host.textContent).toContain('Créer un projet {title}');
      expect(host.querySelector('#project-status-filter')).toBeNull();
      expect(data).toEqual(original);
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('opens the actual folder and document tabs in each language with unchanged project/document identities', async () => {
    const { screen } = props(true);
    await mount(screen);
    for (const [language, open, back, contents, files, quotes, newQuote] of [
      ['fr', 'Ouvrir le dossier', 'Projets', 'Contenu du projet', 'Documents', 'Devis', 'Nouveau devis'],
      ['de', 'Ordner öffnen', 'Projekte', 'Projektinhalt', 'Dokumente', 'Offerten', 'Neue Offerte'],
      ['it', 'Apri la cartella', 'Progetti', 'Contenuto del progetto', 'Documenti', 'Preventivi', 'Nuovo preventivo'],
      ['en', 'Open folder', 'Projects', 'Project contents', 'Documents', 'Quotes', 'New quote'],
    ] as const) {
      await act(async () => { await setAppLanguage(language); });
      await click(open);
      await rendered(() => Boolean(host.querySelector('.project-folder')));
      expect(screen.onFolderChange).toHaveBeenLastCalledWith('planned');
      expect(host.querySelector('h2')?.textContent).toBe(customerProject.name);
      expect(host.querySelector('.project-folder__header p')?.textContent).toBe('Modifier');
      expect(host.querySelector('.project-folder__tabs')?.getAttribute('aria-label')).toBe(contents);
      expect(host.textContent).toContain(attachment.originalName);
      await click(`${files} 1`);
      expect(host.querySelector('.project-folder__tabs [aria-current="page"]')?.textContent).toBe(`${files} 1`);
      await click(`${quotes} 1`);
      expect(host.textContent).not.toContain(attachment.originalName);
      expect(button(newQuote)?.disabled).toBe(true);
      const quote = [...host.querySelectorAll<HTMLButtonElement>('.project-document-list__open')].find(item => item.querySelector('strong')?.textContent === 'DEV-42 · Vue d’ensemble');
      expect(quote).toBeDefined();
      await act(async () => quote!.click());
      expect(screen.onOpenDocument).toHaveBeenLastCalledWith('quotes', data.quotes[0]);
      expect(screen.onCreateDocument).not.toHaveBeenCalled();
      await click(back);
      expect(screen.onFolderChange).toHaveBeenLastCalledWith(null);
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('retains file names and selections through locale changes, then translates the same saved notice at display time', async () => {
    const { screen, api } = props();
    const pending = new File(['customer contents'], 'Documents {name}.txt', { type: 'text/plain' });
    const session = screen.fileSessions.forProject('planned');
    session.setFiles([pending]);
    screen.folderId = 'planned';
    await mount(screen);
    for (const [language, save, add, remove] of [
      ['fr', 'Enregistrer 1 fichier', 'Ajouter des documents', 'Retirer Documents {name}.txt'],
      ['de', '1 Datei speichern', 'Dokumente hinzufügen', 'Documents {name}.txt entfernen'],
      ['it', 'Salva 1 file', 'Aggiungi documenti', 'Rimuovi Documents {name}.txt'],
      ['en', 'Save 1 file', 'Add documents', 'Remove Documents {name}.txt'],
    ] as const) {
      await act(async () => { await setAppLanguage(language); });
      expect(button(save)).toBeDefined();
      expect(button(add)).toBeDefined();
      expect(buttons().find(item => item.getAttribute('aria-label') === remove)).toBeDefined();
      expect(host.querySelector('.project-pending-files strong')?.textContent).toBe(pending.name);
      expect(session.getSnapshot().files).toEqual([pending]);
    }
    await click('Save 1 file');
    expect(api.add).toHaveBeenCalledExactlyOnceWith('planned', pending, expect.any(AbortSignal));
    expect(session.getSnapshot().files).toEqual([]);
    for (const [language, notice] of [
      ['fr', '1 fichier enregistré sur cet appareil.'], ['de', '1 Datei auf diesem Gerät gespeichert.'],
      ['it', '1 file salvato su questo dispositivo.'], ['en', '1 file saved on this device.'],
    ] as const) {
      await act(async () => { await setAppLanguage(language); });
      expect(host.querySelector('.project-file-notice')?.textContent).toBe(notice);
    }
    expect(pending.name).toBe('Documents {name}.txt');
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['automation_request']);
  });
});
