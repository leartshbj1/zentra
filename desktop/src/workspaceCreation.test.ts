import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { WorkspaceCreationOutcomeUnknownError } from './workspaceCreation';
import type { EntityKind, Workspace } from './types';

const entities: [EntityKind, string][] = [['clients','clients'],['suppliers','suppliers'],['catalogItems','catalog_items'],['employees','employees'],['timeEntries','time_entries'],['expenses','expenses'],['projects','projects'],['quotes','quotes'],['invoices','invoices'],['payslips','payslips']];
describe('identifier une création après une réponse native perdue', () => {
  beforeEach(() => { invoke.mockReset(); vi.stubGlobal('window', { dispatchEvent: vi.fn() }); });
  afterEach(() => vi.unstubAllGlobals());
  it.each(entities)('%s peut retrouver son identifiant exact sans réécrire', async (entity, backend) => {
    const nativeFailure = new Error('Réponse perdue');
    let persisted: Record<string, unknown> | undefined;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'create_record') { expect(args.entity).toBe(backend); persisted = structuredClone(args.data); throw nativeFailure; }
      if (command === 'get_app_state') return { onboarding_completed: true };
      if (command === 'get_workspace') return { [backend]: [persisted] };
      throw new Error(`Unexpected ${command}`);
    });
    const data = { name: 'Création conservée', notes: 'Première ligne\nSeconde ligne' };
    const failure = await desktopApi.createEntity(entity, data).catch(reason => reason);
    expect(failure).toBeInstanceOf(WorkspaceCreationOutcomeUnknownError);
    expect(failure.mutationCause).toBe(nativeFailure);
    expect(failure.recordId).toMatch(/^[a-f0-9-]{36}$/);
    expect(persisted).toMatchObject({ ...data, id: failure.recordId });
    expect(data).not.toHaveProperty('id');
    expect(failure.wasRecorded(await desktopApi.loadWorkspace())).toBe(true);
    expect(invoke.mock.calls.filter(([name]) => name === 'create_record')).toHaveLength(1);
  });
  it('un homonyme ou un même identifiant dans une autre catégorie ne prouve pas la création', async () => {
    invoke.mockRejectedValue(new Error('Validation refusée'));
    const failure = await desktopApi.createEntity('clients', { name: 'Camille' }).catch(reason => reason);
    const workspace = { onboardingCompleted: true, clients: [{ id: 'other', name: 'Camille' }], suppliers: [{ id: failure.recordId }] } as Workspace;
    expect(failure.wasRecorded(workspace)).toBe(false);
    expect(() => failure.wasRecorded({ ...workspace, onboardingCompleted: false })).toThrow('base de votre entreprise');
    expect(() => failure.wasRecorded({ onboardingCompleted: true })).toThrow('base de votre entreprise');
  });
  it('conserve l’identifiant du client rapide après avoir vérifié son absence', async () => {
    invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: true } : {});
    await desktopApi.createEntity('clients', { id: 'quick-client', company: 'Atelier', contactPerson: 'Camille' });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['get_app_state','get_workspace','create_record','get_app_state','get_workspace']);
    expect(invoke.mock.calls[2][1]).toEqual({ entity: 'clients', data: { id: 'quick-client', company: 'Atelier', contact_person: 'Camille' } });
  });
  it.each(['existing', 'unreadable'])('ne crée rien si un identifiant fourni est %s', async mode => {
    invoke.mockImplementation(async command => {
      if (mode === 'unreadable') throw new Error('Lecture indisponible');
      if (command === 'get_app_state') return { onboarding_completed: true };
      if (command === 'get_workspace') return { clients: [{ id: 'existing', name: 'Saisie précédente' }] };
      throw new Error('Aucune création attendue');
    });
    await expect(desktopApi.createEntity('clients', { id: 'existing', name: 'Autre saisie' })).rejects.toThrow(mode === 'existing' ? 'existe déjà' : 'Lecture indisponible');
    expect(invoke.mock.calls.some(([name]) => name === 'create_record')).toBe(false);
  });
  it('permet deux créations volontaires identiques avec des identifiants distincts', async () => {
    invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: true } : {});
    await desktopApi.createEntity('clients', { name: 'Homonyme' });
    await desktopApi.createEntity('clients', { name: 'Homonyme' });
    const calls = invoke.mock.calls.filter(([name]) => name === 'create_record');
    expect(calls).toHaveLength(2);
    expect(calls[0][1].data.id).not.toBe(calls[1][1].data.id);
  });
});
