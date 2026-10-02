import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));
import { desktopApi } from './bridge';
import { createProjectFileSessions } from './projectFileSessions';
import type { Workspace } from './types';
import { recentDiagnosticEvents, resolveErrorIncident } from './diagnostics';

const readers: FakeReader[] = [];
class FakeReader {
  result: string | null = null;
  onload?: () => void; onabort?: () => void; onerror?: () => void;
  constructor() { readers.push(this); }
  readAsDataURL = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  finish() { this.result = 'data:text/plain;base64,YWJj'; this.onload?.(); }
}
const file = { name: 'plan.txt', size: 3 } as File;
beforeEach(() => { readers.length = 0; native.invoke.mockReset().mockResolvedValue({ id: 'stored' }); vi.stubGlobal('FileReader', FakeReader); vi.stubGlobal('window', new EventTarget()); });
afterEach(() => vi.unstubAllGlobals());
describe('arrêt d’une lecture de document avant la commande native', () => {
  it('journalise le refus de format avant invocation sans enregistrer le nom privé', async () => {
    const before = recentDiagnosticEvents().length;
    await expect(desktopApi.addProjectDocument('project', { name: 'private-customer.exe', size: 3 } as File)).rejects.toThrow('n’est pas pris en charge');
    expect(readers).toHaveLength(0); expect(native.invoke).not.toHaveBeenCalled();
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['file.read_base64', 'start'], ['file.read_base64', 'failure']]);
    expect(events[0].id).toBe(events[1].id);
    expect(JSON.stringify(events)).not.toMatch(/private|customer|exe/);
  });
  it('journalise un échec FileReader et rattache son code sans contenu de document', async () => {
    const before = recentDiagnosticEvents().length;
    const pending = desktopApi.addProjectDocument('project', { name: 'private-customer.txt', size: 3 } as File);
    readers[0].onerror?.();
    const error = await pending.catch(reason => reason);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected the original file read failure.');
    expect(error.message).toBe('Impossible de lire private-customer.txt.');
    expect(native.invoke).not.toHaveBeenCalled();
    const events = recentDiagnosticEvents().slice(before);
    expect(events.map(event => event.phase)).toEqual(['start', 'failure']);
    expect(resolveErrorIncident(error).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/private|customer|txt|YWJj/);
  });

  it('ne lit ni ne transmet un fichier dont l’espace est déjà fermé', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(desktopApi.addProjectDocument('project', file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(readers).toHaveLength(0); expect(native.invoke).not.toHaveBeenCalled();
  });
  it('interrompt la lecture en cours sans démarrer la commande native', async () => {
    const controller = new AbortController();
    const pending = desktopApi.addProjectDocument('project', file, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readers[0].abort).toHaveBeenCalledTimes(1); expect(native.invoke).not.toHaveBeenCalled();
  });
  it('recontrôle le contexte entre lecture complète et transmission', async () => {
    const controller = new AbortController();
    const pending = desktopApi.addProjectDocument('project', file, controller.signal);
    readers[0].finish(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('transmet les octets et notifie la synchronisation après la confirmation native', async () => {
    const changed = vi.fn(); window.addEventListener('zentra-project-documents-changed', changed);
    const pending = desktopApi.addProjectDocument('project', file);
    expect(native.invoke).not.toHaveBeenCalled(); readers[0].finish();
    await expect(pending).resolves.toEqual({ id: 'stored' });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('add_project_document', { input: { project_id: 'project', original_name: 'plan.txt', content_base64: 'YWJj' } });
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('conserve un fichier interrompu par la lecture seule et permet de le reprendre', async () => {
    const workspace = { attachments: [] } as unknown as Workspace;
    const sessions = createProjectFileSessions({ add: desktopApi.addProjectDocument, remove: async () => workspace, load: async () => workspace }, vi.fn());
    const session = sessions.forProject('project'); session.setFiles([file]);
    const pending = session.upload();
    expect(readers).toHaveLength(1);
    sessions.setWritable(false); await pending;
    expect(readers[0].abort).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(session.getSnapshot().files).toEqual([file]);
    expect(session.getSnapshot().uploadFailures).toEqual([]);
    expect(session.getSnapshot().notice).toContain('en lecture seule');
    sessions.setWritable(true);
    const resumed = session.upload(); readers[1].finish(); await resumed;
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().files).toEqual([]);
  });
});
