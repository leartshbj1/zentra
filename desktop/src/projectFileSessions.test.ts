import { describe, expect, it, vi } from 'vitest';
import { createProjectFileSessions } from './projectFileSessions';
import type { Workspace } from './types';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

const workspace = { attachments: [] } as unknown as Workspace;
const file = (name: string) => ({ name, size: 12 }) as File;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const api = { add: vi.fn(async (_id: string, _file: File, _signal?: AbortSignal) => {}), remove: vi.fn(async (_id: string) => workspace), load: vi.fn(async () => workspace) };
  const onWorkspace = vi.fn();
  return { api, onWorkspace, sessions: createProjectFileSessions(api, onWorkspace) };
}
describe('sélections et ajouts de documents pendant la navigation', () => {
  function scopedFixture() {
    let current = { ...workspace, workNotesScope: 'space-a', clients: [] } as Workspace;
    const api = { add: vi.fn(async () => {}), remove: vi.fn(async () => current), load: vi.fn(async () => current) };
    const onWorkspace = vi.fn((next: Workspace) => { current = next; });
    const sessions = createProjectFileSessions(api, onWorkspace, { current: () => current, scope: () => current.workNotesScope || '' });
    return { api, onWorkspace, sessions, getCurrent: () => current, publishLocal: (next: Workspace) => { current = next; } };
  }
  it('relit un ajout confirmé si une publication locale intervient pendant sa lecture', async () => {
    const f = scopedFixture(), old = f.getCurrent(), hold = deferred<Workspace>();
    f.api.load.mockImplementationOnce(() => hold.promise);
    const session = f.sessions.forProject('a'); session.setFiles([file('plan.pdf')]);
    const job = session.upload(); await vi.waitFor(() => expect(f.api.load).toHaveBeenCalledTimes(1));
    const newer = { ...old, clients: [{ id: 'new-client' }] } as Workspace;
    f.publishLocal(newer); hold.resolve(old); await job;
    expect(f.onWorkspace).toHaveBeenCalledTimes(1);
    expect(f.onWorkspace).toHaveBeenCalledWith(newer);
    expect(f.api.load).toHaveBeenCalledTimes(2);
    expect(f.api.add).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().files).toEqual([]);
  });
  it('borne les relectures conflictuelles sans rejouer un ajout confirmé', async () => {
    const f = scopedFixture(), session = f.sessions.forProject('a');
    f.api.load.mockImplementation(async () => {
      const before = f.getCurrent(); f.publishLocal({ ...before }); return before;
    });
    session.setFiles([file('plan.pdf')]); await session.upload();
    expect(f.api.load).toHaveBeenCalledTimes(2);
    expect(f.onWorkspace).not.toHaveBeenCalled();
    expect(session.getSnapshot().refreshPending).toBe(true);
    expect(session.getSnapshot().notice).toContain('enregistré');
    expect(session.getSnapshot().files).toEqual([]);
    await session.upload(); expect(f.api.add).toHaveBeenCalledTimes(1);
    f.api.load.mockImplementation(async () => f.getCurrent()); await session.refresh();
    expect(session.getSnapshot().refreshPending).toBe(false);
    expect(f.api.add).toHaveBeenCalledTimes(1);
  });
  it('ne publie pas la réponse de suppression antérieure à une modification locale', async () => {
    const f = scopedFixture(), old = f.getCurrent(), hold = deferred<Workspace>();
    f.api.remove.mockImplementationOnce(() => hold.promise);
    const job = f.sessions.forProject('a').remove('plan');
    const newer = { ...old, clients: [{ id: 'new-client' }] } as Workspace;
    f.publishLocal(newer); hold.resolve(old);
    expect(await job).toBe(true);
    expect(f.onWorkspace).toHaveBeenCalledTimes(1);
    expect(f.onWorkspace).toHaveBeenCalledWith(newer);
    expect(f.api.remove).toHaveBeenCalledTimes(1);
    expect(f.api.load).toHaveBeenCalledTimes(1);
  });
  it('ignore une lecture terminée dans un autre espace de la même entreprise', async () => {
    const f = scopedFixture(), old = f.getCurrent(), hold = deferred<Workspace>();
    f.api.load.mockImplementationOnce(() => hold.promise);
    const job = f.sessions.forProject('a').refresh();
    f.publishLocal({ ...old, workNotesScope: 'space-b' }); hold.resolve(old); await job;
    expect(f.onWorkspace).not.toHaveBeenCalled();
    expect(f.api.load).toHaveBeenCalledTimes(1);
  });
  it('refuse une réponse qui contient une portée différente de l’espace courant', async () => {
    const f = scopedFixture(), session = f.sessions.forProject('a');
    f.api.load.mockResolvedValue({ ...f.getCurrent(), workNotesScope: 'space-b' });
    await session.refresh();
    expect(f.onWorkspace).not.toHaveBeenCalled();
    expect(f.api.load).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().refreshPending).toBe(true);
  });
  it('conserve les fichiers par projet après désabonnement et ne lance qu’un ajout', async () => {
    const { api, sessions, onWorkspace } = fixture();
    const a = sessions.forProject('a'), b = sessions.forProject('b');
    const first = file('plan.pdf'), second = file('photo.jpg');
    a.setFiles([first]); b.setFiles([second]);
    const subscriber = vi.fn(), unsubscribe = a.subscribe(subscriber);
    const hold = deferred<void>(); api.add.mockImplementationOnce(() => hold.promise);
    const job = a.upload();
    unsubscribe();
    expect(sessions.forProject('a')).toBe(a);
    expect(b.getSnapshot().files).toEqual([second]);
    a.setFiles([]); await a.upload();
    expect(a.getSnapshot().files).toEqual([first]);
    expect(api.add).toHaveBeenCalledTimes(1);
    hold.resolve(); await job;
    expect(a.getSnapshot().files).toEqual([]);
    expect(onWorkspace).toHaveBeenCalledTimes(1);
    expect(sessions.getActivity().map(item => item.projectId)).toEqual(['b']);
  });
  it('garde uniquement les échecs, puis relit sans réenvoyer les fichiers confirmés', async () => {
    const { api, sessions } = fixture();
    const a = sessions.forProject('a'), first = file('plan.pdf'), second = file('illisible.jpg');
    a.setFiles([first, second]);
    api.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Copie illisible'));
    api.load.mockRejectedValueOnce(new Error('Lecture interrompue'));
    await a.upload();
    expect(a.getSnapshot().files).toEqual([second]);
    expect(a.getSnapshot().uploadFailures).toEqual([{ file: second, message: 'Copie illisible' }]);
    expect(a.getSnapshot().refreshPending).toBe(true);
    await a.upload(); expect(api.add).toHaveBeenCalledTimes(2);
    await a.refresh(); expect(api.add).toHaveBeenCalledTimes(2);
    await a.upload();
    expect(api.add.mock.calls.map(call => call[1].name)).toEqual(['plan.pdf', 'illisible.jpg', 'illisible.jpg']);
    expect(a.getSnapshot().files).toEqual([]);
  });
  it('arrête les fichiers suivants quand le droit d’écriture change', async () => {
    const { api, sessions } = fixture();
    const a = sessions.forProject('a'), second = file('second.pdf');
    a.setFiles([file('premier.pdf'), second]);
    const hold = deferred<void>(); api.add.mockImplementationOnce(() => hold.promise);
    const job = a.upload(); sessions.setWritable(false); hold.resolve(); await job;
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(a.getSnapshot().files).toEqual([second]);
    await a.upload(); expect(api.add).toHaveBeenCalledTimes(1);
    expect(a.getSnapshot().notice).toContain('en pause tant que l’application est en lecture seule');
    sessions.setWritable(true); await a.upload(); expect(api.add).toHaveBeenCalledTimes(2);
  });
  it('ignore une réponse d’un espace fermé et libère sa sélection', async () => {
    const { api, sessions, onWorkspace } = fixture();
    const a = sessions.forProject('a'); a.setFiles([file('premier.pdf'), file('second.pdf')]);
    const hold = deferred<void>(); api.add.mockImplementationOnce(() => hold.promise);
    const job = a.upload(); sessions.stop(); sessions.start(); hold.resolve(); await job;
    expect(api.add.mock.calls[0][2]?.aborted).toBe(true);
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.load).not.toHaveBeenCalled();
    expect(onWorkspace).not.toHaveBeenCalled();
    expect(a.getSnapshot().files).toEqual([]);
    expect(a.getSnapshot().saving).toBe(false);
    expect(sessions.getActivity()).toEqual([]);
  });
  it('ne remplace pas une lecture récente par une réponse plus ancienne', async () => {
    const { api, sessions, onWorkspace } = fixture();
    const old = deferred<Workspace>(), fresh = deferred<Workspace>();
    api.load.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const first = sessions.forProject('a').refresh(), second = sessions.forProject('b').refresh();
    const latest = { ...workspace, schemaVersion: 59 };
    fresh.resolve(latest); await second;
    old.resolve(workspace); await first;
    expect(onWorkspace).toHaveBeenCalledTimes(1);
    expect(onWorkspace).toHaveBeenCalledWith(latest);
  });
  it('reprend une suppression confirmée avec une lecture et conserve le refus natif', async () => {
    const { api, sessions } = fixture(); const a = sessions.forProject('a');
    api.remove.mockRejectedValueOnce(new Error('Fichier utilisé')).mockRejectedValueOnce(new WorkspaceRefreshAfterMutationError(new Error('Relecture interrompue')));
    expect(await a.remove('file')).toBe(false);
    expect(a.getSnapshot().error).toBe('Fichier utilisé');
    expect(await a.remove('file')).toBe(true);
    expect(a.getSnapshot().refreshPending).toBe(true);
    expect(await a.remove('file')).toBe(false);
    await a.refresh(); expect(api.remove).toHaveBeenCalledTimes(2);
    expect(a.getSnapshot().refreshPending).toBe(false);
  });
  it('affiche une suppression terminée après la lecture d’un autre projet', async () => {
    const { api, sessions, onWorkspace } = fixture();
    const before = { ...workspace, attachments: [{ id: 'plan' }] } as Workspace;
    const after = { ...workspace, attachments: [] };
    const hold = deferred<Workspace>();
    api.remove.mockImplementationOnce(() => hold.promise);
    api.load.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const deletion = sessions.forProject('a').remove('plan');
    await sessions.forProject('b').refresh();
    hold.resolve(after);
    expect(await deletion).toBe(true);
    expect(onWorkspace).toHaveBeenLastCalledWith(after);
    expect(sessions.forProject('a').getSnapshot().refreshPending).toBe(false);
  });
  it('reprend une lecture refusée après une suppression concurrente sans supprimer à nouveau', async () => {
    const { api, sessions, onWorkspace } = fixture();
    const a = sessions.forProject('a');
    const hold = deferred<Workspace>(); api.remove.mockImplementationOnce(() => hold.promise);
    api.load.mockResolvedValueOnce(workspace).mockRejectedValueOnce(new Error('Lecture temporairement refusée'));
    const deletion = a.remove('plan');
    await sessions.forProject('b').refresh(); hold.resolve(workspace);
    expect(await deletion).toBe(true);
    expect(a.getSnapshot().refreshPending).toBe(true);
    expect(a.getSnapshot().notice).toContain('supprimé');
    expect(await a.remove('plan')).toBe(false);
    await a.refresh();
    expect(a.getSnapshot().refreshPending).toBe(false);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(onWorkspace).toHaveBeenLastCalledWith(workspace);
  });
  it('déplace une sélection explicitement sans envoi et conserve les fichiers homonymes', () => {
    const { api, sessions } = fixture();
    const a = sessions.forProject('a'), b = sessions.forProject('b');
    const original = file('plan.pdf'), other = file('plan.pdf');
    a.setFiles([original]); b.setFiles([other]);
    expect(sessions.moveSelection('a', 'b')).toBe(true);
    expect(a.getSnapshot().files).toEqual([]);
    expect(b.getSnapshot().files).toHaveLength(2);
    expect(b.getSnapshot().files[0]).toBe(other);
    expect(b.getSnapshot().files[1]).toBe(original);
    expect(api.add).not.toHaveBeenCalled();
    expect(sessions.getActivity().map(item => item.projectId)).toEqual(['b']);
  });
  it('ne déplace pas une sélection pendant une opération ou en lecture seule', async () => {
    const { api, sessions } = fixture();
    const a = sessions.forProject('a'), b = sessions.forProject('b');
    const original = file('plan.pdf'); a.setFiles([original]); b.setFiles([file('photo.jpg')]);
    const hold = deferred<void>(); api.add.mockImplementationOnce(() => hold.promise);
    const job = b.upload();
    expect(sessions.moveSelection('a', 'b')).toBe(false);
    api.load.mockRejectedValueOnce(new Error('Lecture interrompue'));
    hold.resolve(); await job;
    expect(sessions.moveSelection('a', 'b')).toBe(false);
    await b.refresh();
    sessions.setWritable(false);
    expect(sessions.moveSelection('a', 'b')).toBe(false);
    expect(a.getSnapshot().files).toEqual([original]);
    sessions.setWritable(true);
    expect(sessions.moveSelection('a', 'b')).toBe(true);
  });
});
