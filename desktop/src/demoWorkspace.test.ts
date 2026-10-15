// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The seed only receives an injected API in these tests; never load the native bridge.
vi.mock('./bridge', () => ({ desktopApi: {} }));

import { contactFormIssue } from './contactFormValidation';
import {
  DEMO_FLAG_KEY,
  clearDemoWorkspaceFlag,
  demoCompanySettings,
  isDemoWorkspace,
  markDemoWorkspace,
  seedDemoWorkspace,
  type DemoSeedApi,
} from './demoWorkspace';
import { demoTranslations } from './translationsDemo';
import { documentLinesValidationError } from './documentUi';
import { initialOnboardingSettings } from './onboardingDraft';
import { validateOnboarding } from './onboardingValidation';
import type { AppSettings, DocumentLine, NogaCatalog, Workspace } from './types';
import { documentTotals } from './utils';
import { WorkspaceOriginChangedError } from './workspaceOrigin';
import demoWorkspaceSource from './demoWorkspace.ts?raw';

const catalog: NogaCatalog = {
  version: '2025',
  source: 'local-test',
  sections: [
    { code: 'A', label: 'Agriculture', divisions: [] },
    { code: 'C', label: 'Industrie manufacturière', divisions: [{ code: '10', label: 'Industries alimentaires' }] },
    { code: 'F', label: 'Construction', divisions: [{ code: '41', label: 'Construction de bâtiments' }, { code: '43', label: 'Travaux de construction spécialisés' }] },
  ],
};
const catalogWithoutConstruction: NogaCatalog = { ...catalog, sections: catalog.sections.filter((section) => section.code !== 'F') };

describe('demoCompanySettings', () => {
  it('prepares the fictional company so that the essential onboarding validates without any issue', () => {
    const settings = demoCompanySettings(initialOnboardingSettings, catalog);
    expect(validateOnboarding(settings, catalog, false, 'essential')).toEqual([]);
    expect(settings.organization).toMatchObject({
      legalName: 'Atelier Démo Sàrl', contactName: 'Camille Démo', email: 'demo@example.invalid', vatRegistered: false,
      address: { city: 'Lausanne', canton: 'VD', country: 'CH' },
    });
    expect(settings.business).toMatchObject({ nogaSection: 'F', nogaDivision: '43' });
    expect(settings.business.activityDescription).toMatch(/peinture/i);
  });

  it('falls back to the first section that has a division', () => {
    const settings = demoCompanySettings(initialOnboardingSettings, catalogWithoutConstruction);
    expect(settings.business).toMatchObject({ nogaSection: 'C', nogaDivision: '10' });
    expect(validateOnboarding(settings, catalogWithoutConstruction, false, 'essential')).toEqual([]);
  });

  it('keeps every other section from the base settings and never mutates the base', () => {
    const base = structuredClone(initialOnboardingSettings);
    const snapshot = JSON.stringify(base);
    const settings = demoCompanySettings(base, catalog);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(settings.billing).toEqual(base.billing);
    expect(settings.work).toEqual(base.work);
    expect(settings.payroll).toEqual(base.payroll);
    expect(settings.backup).toEqual(base.backup);
  });
});

const now = new Date(2026, 9, 15, 8, 0, 0); // Thursday 15 October 2026, local time.
const scope = 'scope-demo';

function workspaceWith(patch: Partial<Workspace> = {}): Workspace {
  const settings: AppSettings = demoCompanySettings(initialOnboardingSettings, catalog);
  return {
    onboardingCompleted: true, settings, workNotesScope: scope,
    clients: [], catalogItems: [], projects: [], quotes: [], invoices: [],
    ...patch,
  } as unknown as Workspace;
}

function fakeApi(workspace = workspaceWith()) {
  const calls: string[] = [];
  let projects = 0;
  const mocks = {
    loadWorkspace: vi.fn(async (..._args: unknown[]) => { calls.push('loadWorkspace'); return workspace; }),
    createEntity: vi.fn(async (entity: string, ..._args: unknown[]) => { calls.push(entity); return workspace; }),
    saveCatalogItem: vi.fn(async (..._args: unknown[]) => { calls.push('catalogItems'); return workspace; }),
    saveProject: vi.fn(async (..._args: unknown[]) => { calls.push('projects'); projects += 1; return `project-${projects}`; }),
    saveDocument: vi.fn(async (entity: string, ..._args: unknown[]) => { calls.push(entity); return workspace; }),
    saveWorkNote: vi.fn(async (..._args: unknown[]) => { calls.push('workNotes'); return {}; }),
    saveAgendaEvent: vi.fn(async (..._args: unknown[]) => { calls.push('agendaEvents'); return workspace; }),
  };
  return { api: mocks as unknown as DemoSeedApi, mocks, calls };
}

const mutationCount = (mocks: ReturnType<typeof fakeApi>['mocks']) =>
  mocks.createEntity.mock.calls.length + mocks.saveCatalogItem.mock.calls.length + mocks.saveProject.mock.calls.length
  + mocks.saveDocument.mock.calls.length + mocks.saveWorkNote.mock.calls.length + mocks.saveAgendaEvent.mock.calls.length;

describe('seedDemoWorkspace', () => {
  it('creates the demo records through the bridge in dependency order', async () => {
    const { api, mocks, calls } = fakeApi();
    await seedDemoWorkspace(api, { now });

    expect(calls).toEqual([
      'loadWorkspace',
      'clients', 'clients', 'clients',
      'catalogItems', 'catalogItems', 'catalogItems', 'catalogItems',
      'projects', 'projects',
      'quotes', 'quotes',
      'workNotes', 'workNotes',
      'agendaEvents', 'agendaEvents',
    ]);

    const clients = mocks.createEntity.mock.calls.map(([entity, data, workspaceScope]) => {
      expect(entity).toBe('clients');
      expect(workspaceScope).toBe(scope);
      return data as Record<string, string>;
    });
    expect(new Set(clients.map((client) => client.canton))).toEqual(new Set(['VD', 'GE', 'FR']));
    expect(clients.filter((client) => !client.company)).toHaveLength(1); // the private person
    for (const client of clients) {
      expect(client.email).toMatch(/@example\.invalid$/);
      expect(client.name).toBe(client.company || client.contactPerson);
      expect(contactFormIssue('client', {
        company: client.company, contactPerson: client.contactPerson, email: client.email,
        street: client.addressLine1, buildingNumber: client.addressLine2, postalCode: client.postalCode,
        city: client.city, canton: client.canton, country: client.country,
      })).toBeNull();
    }
    const clientIds = clients.map((client) => client.id);
    expect(new Set(clientIds).size).toBe(3);

    const catalogIds = mocks.saveCatalogItem.mock.calls.map(([id, data, expectedUpdatedAt, workspaceScope]) => {
      const item = data as Record<string, unknown>;
      expect(expectedUpdatedAt).toBeUndefined(); // creation, not an update
      expect(workspaceScope).toBe(scope);
      expect(Object.keys(item).sort()).toEqual(['description', 'kind', 'name', 'purchaseCostCents', 'reorderLevelMilli', 'salesPriceCents', 'sku', 'stockQuantityMilli', 'trackStock', 'unit', 'vatBp']);
      expect(item.vatBp).toBe(0);
      expect(Number.isSafeInteger(item.salesPriceCents) && (item.salesPriceCents as number) > 0).toBe(true);
      return id as string;
    });
    const kinds = mocks.saveCatalogItem.mock.calls.map(([, data]) => `${(data as { kind: string }).kind}/${(data as { unit: string }).unit}`);
    expect(kinds.filter((kind) => kind === 'service/heure')).toHaveLength(2);
    expect(kinds.filter((kind) => kind.startsWith('product/'))).toHaveLength(2);

    const projects = mocks.saveProject.mock.calls.map(([data, id, workspaceScope]) => {
      expect(id).toBeUndefined();
      expect(workspaceScope).toBe(scope);
      return data as Record<string, unknown>;
    });
    for (const project of projects) expect(clientIds).toContain(project.clientId);
    expect(projects.map((project) => project.status)).toContain('in_progress');

    const quotes = mocks.saveDocument.mock.calls.map(([entity, data, lines, existing, workspaceScope]) => {
      expect(entity).toBe('quotes');
      expect(existing).toBeUndefined();
      expect(workspaceScope).toBe(scope);
      const quote = data as Record<string, unknown>;
      const documentLines = lines as DocumentLine[];
      expect(quote.status).toBe('draft');
      expect(clientIds).toContain(quote.clientId);
      expect(documentLinesValidationError(documentLines)).toBe('');
      for (const line of documentLines) expect(catalogIds).toContain(line.catalogItemId);
      expect(quote.totalCents).toBe(documentTotals(documentLines).totalCents);
      expect(quote.issueDate).toBe('2026-10-15');
      expect(String(quote.validUntil) > String(quote.issueDate)).toBe(true);
      return quote;
    });
    expect(quotes[0].projectId).toBe('project-1');
    expect(quotes[1].projectId).toBeNull();

    for (const [note] of mocks.saveWorkNote.mock.calls) {
      expect(note).toMatchObject({ expectedUpdatedAt: null, expectedWorkspaceScope: scope });
      expect(['project-1', 'project-2']).toContain((note as { projectId: string }).projectId);
    }

    const events = mocks.saveAgendaEvent.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.map((event) => event.startDate)).toEqual(['2026-10-19', '2026-10-20']); // next working days
    for (const event of events) {
      expect(event).toMatchObject({ isNew: true, expectedUpdatedAt: null, status: 'scheduled', allDay: false, employeeId: null });
      expect(event.endDate).toBe(event.startDate);
      expect(String(event.endTime) > String(event.startTime)).toBe(true);
    }
    expect(events[0].projectId).toBe('project-2');
  });

  it('stops at the first failure and keeps what was already created', async () => {
    const { api, mocks } = fakeApi();
    const cause = new Error('disque plein');
    mocks.saveProject.mockRejectedValueOnce(cause);
    const failure = await seedDemoWorkspace(api, { now }).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Les données de démonstration sont incomplètes : « Rénovation de la cage d’escalier » n’a pas pu être créé. Les éléments déjà ajoutés restent dans votre espace.',
    );
    expect((failure as Error).cause).toBe(cause);
    expect(mocks.createEntity).toHaveBeenCalledTimes(3);
    expect(mocks.saveCatalogItem).toHaveBeenCalledTimes(4);
    expect(mocks.saveProject).toHaveBeenCalledTimes(1);
    expect(mocks.saveDocument).not.toHaveBeenCalled();
    expect(mocks.saveWorkNote).not.toHaveBeenCalled();
    expect(mocks.saveAgendaEvent).not.toHaveBeenCalled();
  });

  it('does not continue after a failed first client', async () => {
    const { api, mocks } = fakeApi();
    mocks.createEntity.mockRejectedValueOnce(new Error('refus natif'));
    await expect(seedDemoWorkspace(api, { now })).rejects.toThrow('« Boulangerie du Bourg Exemple SA »');
    expect(mutationCount(mocks)).toBe(1);
  });

  it('refuses a company that already contains data, before any creation', async () => {
    const { api, mocks } = fakeApi(workspaceWith({ clients: [{ id: 'existing' }] } as unknown as Partial<Workspace>));
    await expect(seedDemoWorkspace(api, { now })).rejects.toThrow('Cet espace contient déjà des données.');
    expect(mutationCount(mocks)).toBe(0);
  });

  it('requires a completed company', async () => {
    const { api, mocks } = fakeApi(workspaceWith({ onboardingCompleted: false, settings: null }));
    await expect(seedDemoWorkspace(api, { now })).rejects.toThrow('Créez d’abord votre entreprise');
    expect(mutationCount(mocks)).toBe(0);
  });

  it('reports an unreadable workspace without creating anything', async () => {
    const { api, mocks } = fakeApi();
    mocks.loadWorkspace.mockRejectedValueOnce(new Error('lecture impossible'));
    await expect(seedDemoWorkspace(api, { now })).rejects.toThrow('Aucune donnée de démonstration n’a été ajoutée.');
    expect(mutationCount(mocks)).toBe(0);
  });

  it('binds every mutation to a supplied mutation origin and refuses another company', async () => {
    const origin = { workspaceScope: scope, memberContextNonce: 'a'.repeat(32) };
    const bound = fakeApi();
    await seedDemoWorkspace(bound.api, { now, origin });
    expect(bound.mocks.loadWorkspace).toHaveBeenCalledWith(scope, origin.memberContextNonce);
    for (const call of bound.mocks.createEntity.mock.calls) expect(call.slice(2)).toEqual([scope, origin.memberContextNonce]);
    for (const call of bound.mocks.saveDocument.mock.calls) expect(call.slice(4)).toEqual([scope, origin.memberContextNonce]);

    const other = fakeApi(workspaceWith({ workNotesScope: 'another-company' }));
    await expect(seedDemoWorkspace(other.api, { now, origin })).rejects.toBeInstanceOf(WorkspaceOriginChangedError);
    expect(mutationCount(other.mocks)).toBe(0);
  });

  it('translates every interface message it can show, with the same placeholders', () => {
    for (const [source, translated] of Object.entries(demoTranslations)) {
      const placeholders = (text: string) => (text.match(/\{[a-zA-Z]\w*\}/g) ?? []).sort().join();
      for (const text of translated) {
        expect(text.trim()).not.toBe('');
        expect(placeholders(text)).toBe(placeholders(source));
      }
    }
    const source = ts.createSourceFile('demoWorkspace.ts', demoWorkspaceSource, ts.ScriptTarget.Latest, true);
    const messages: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
        messages.push(node.arguments[0].text.trim());
      ts.forEachChild(node, visit);
    };
    visit(source);
    // The dictionary also holds the demo banner and first-run copy.
    expect(messages.filter(message => !Object.hasOwn(demoTranslations, message))).toEqual([]);
  });
});

describe('demo workspace flag', () => {
  afterEach(() => { vi.restoreAllMocks(); try { localStorage.removeItem(DEMO_FLAG_KEY); } catch { /* ignore */ } });

  it('marks, reads and clears the local flag', () => {
    expect(isDemoWorkspace()).toBe(false);
    expect(markDemoWorkspace()).toBe(true);
    expect(localStorage.getItem(DEMO_FLAG_KEY)).toBe('1');
    expect(isDemoWorkspace()).toBe(true);
    expect(clearDemoWorkspaceFlag()).toBe(true);
    expect(isDemoWorkspace()).toBe(false);
  });

  it('never throws when the storage is unavailable', () => {
    const blocked = () => { throw new Error('stockage bloqué'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    expect(markDemoWorkspace()).toBe(false);
    expect(isDemoWorkspace()).toBe(false);
    expect(clearDemoWorkspaceFlag()).toBe(false);
  });
});
