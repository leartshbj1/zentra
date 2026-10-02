import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));
import { desktopApi } from './bridge';

const readers: FakeReader[] = [];
class FakeReader {
  result = 'data:text/plain;base64,YWJj';
  onload?: () => void;
  constructor() { readers.push(this); }
  readAsDataURL() {}
  finish() { this.onload?.(); }
}
const file = { name: 'synthetic.txt', size: 3 } as File;
beforeEach(() => {
  readers.length = 0;
  native.invoke.mockReset().mockImplementation(async command => command === 'read_project_document' ? 'YWJj' : {});
  vi.stubGlobal('FileReader', FakeReader);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe('portée physique des IPC de fichiers de projet', () => {
  it('conserve la portée passée avant la première lecture de fichier', async () => {
    let currentScope = 'synthetic-origin';
    const pending = desktopApi.addProjectDocument('project', file, undefined, currentScope);
    expect(native.invoke).not.toHaveBeenCalled();
    currentScope = 'synthetic-restored';
    readers[0].finish(); await pending;
    expect(currentScope).toBe('synthetic-restored');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('add_project_document', {
      expectedWorkspaceScope: 'synthetic-origin',
      input: { project_id: 'project', original_name: 'synthetic.txt', content_base64: 'YWJj' },
    });
  });
  it('transmet la portée top-level à la lecture de fichier', async () => {
    await expect(desktopApi.readProjectDocument('document', 'synthetic-origin')).resolves.toBe('YWJj');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('read_project_document', { id: 'document', expectedWorkspaceScope: 'synthetic-origin' });
  });
  it('transmet la portée top-level à la suppression sans modifier son reçu', async () => {
    await desktopApi.deleteProjectDocument('document', 'synthetic-origin');
    expect(native.invoke.mock.calls[0]).toEqual(['delete_project_document', { id: 'document', expectedWorkspaceScope: 'synthetic-origin' }]);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'delete_project_document')).toHaveLength(1);
  });
  it('garde l’ancien contrat add/read/delete quand la portée est omise', async () => {
    const pending = desktopApi.addProjectDocument('project', file);
    readers[0].finish(); await pending;
    await desktopApi.readProjectDocument('document');
    await desktopApi.deleteProjectDocument('document');
    const calls = native.invoke.mock.calls.filter(([command]) => ['add_project_document', 'read_project_document', 'delete_project_document'].includes(command));
    expect(calls).toEqual([
      ['add_project_document', { input: { project_id: 'project', original_name: 'synthetic.txt', content_base64: 'YWJj' } }],
      ['read_project_document', { id: 'document' }],
      ['delete_project_document', { id: 'document' }],
    ]);
  });
});
