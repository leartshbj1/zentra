import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkNote } from './types';
const runtime = vi.hoisted(() => ({ host: null as any }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.useState(...args),
  useRef: (...args: any[]) => runtime.host.useRef(...args),
  useMemo: (call: () => unknown) => call(),
  useEffect: (...args: any[]) => runtime.host.useEffect(...args),
  useSyncExternalStore: (subscribe: any, get: any) => {
    runtime.host.useEffect(() => subscribe(() => { runtime.host.dirty = true; }), [subscribe]); return get();
  },
}));
vi.mock('./ui', () => ({ Button: () => null }));
import { NotesScreen } from './NotesScreen';
import { WorkNotesStore } from './workNotes';
import { Button } from './ui';
type Element = { type: unknown; props: any };
type Props = Parameters<typeof NotesScreen>[0];
class Host {
  slots: any[] = []; index = 0; dirty = false; mounted = true; writes = 0; unmountedWrites = 0; effects: Array<() => void> = []; tree: any;
  constructor(public props: Props) { this.render(); }
  useState(initial: any) {
    const index = this.index++; const slot = this.slots[index] ??= {value: typeof initial === 'function' ? initial() : initial};
    return [slot.value, (next: any) => { this.writes++; if (!this.mounted) this.unmountedWrites++;
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (!Object.is(value, slot.value)) { slot.value = value; this.dirty = true; }
    }];
  }
  useRef(value: unknown) { return this.slots[this.index++] ??= {current: value}; }
  useEffect(effect: any, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = {deps, cleanup: effect()};
    });
  }
  render() { this.index = 0; this.dirty = false; this.effects = []; runtime.host = this;
    this.tree = NotesScreen(this.props); this.effects.forEach(effect => effect()); this.flush(); }
  flush() { if (this.dirty && this.mounted) this.render(); }
  unmount() { this.slots.forEach(slot => slot.cleanup?.()); this.mounted = false; }
}
function walk(tree: any): Element[] { return Array.isArray(tree) ? tree.flatMap(walk) : tree && typeof tree === 'object' ? [tree, ...walk(tree.props?.children)] : []; }
function text(tree: any): string { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree); }
function one(host: Host, predicate: (element: Element) => boolean) { const matches = walk(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0]; }
function click(host: Host, predicate: (element: Element) => boolean) { one(host, predicate).props.onClick(); host.flush(); }
async function settle(host: Host) { for (let i = 0; i < 20; i++) { await Promise.resolve(); host.flush(); } }
function deferred() { let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
const note = (id: string): WorkNote => ({id, title: `Synthetic ${id}`, body: `Retained ${id}`, pinned: false, projectId: null,
  createdByMemberId: null, authorName: '', createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z'});
function setup() {
  vi.stubGlobal('navigator', {onLine: true});
  vi.stubGlobal('window', {innerHeight: 844, addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('document', {addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const deletion = deferred(), remove = vi.fn(() => deletion.promise), removed = vi.fn();
  const store = new WorkNotesStore({save: vi.fn(async draft => ({...note(draft.id), ...draft})), remove, saved: vi.fn(), removed});
  store.merge([note('a'), note('b')]);
  const host = new Host({store, projects: [], readOnly: false, initialProjectId: null, onProjectHandled: vi.fn(), onEditingChange: vi.fn()});
  return {host, store, deletion, remove, removed};
}
function select(host: Host, id: string) { click(host, e => e.type === 'button' && e.props.className?.includes('notes-list__entry') && text(e).includes(`Synthetic ${id}`)); }
function beginDelete(host: Host) {
  click(host, e => e.type === Button && e.props['aria-label'] === 'Supprimer la note');
  click(host, e => e.type === Button && text(e) === 'Supprimer');
}
function selectedTitle(host: Host) { return walk(host.tree).find(e => e.type === 'input' && e.props['aria-label'] === 'Titre de la note')?.props.value; }
afterEach(() => {vi.unstubAllGlobals(); runtime.host = null;});
describe('NotesScreen deletion lifecycle with the real note store', () => {
  it.each(['resolve', 'reject'] as const)('keeps B open when deleting A later %s', async outcome => {
    const {host, store, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    expect(remove).toHaveBeenCalledExactlyOnceWith('a', note('a').updatedAt);
    select(host, 'b'); expect(selectedTitle(host)).toBe('Synthetic b');
    if (outcome === 'resolve') deletion.resolve(); else deletion.reject(new Error('Synthetic old A refusal'));
    await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic b');
    expect(text(host.tree)).not.toContain('La suppression a échoué');
    expect(store.getSnapshot().find(row => row.note.id === 'b')?.note.body).toBe('Retained b');
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'] as const)('does not publish after unmount when deletion %s', async outcome => {
    const {host, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host); host.unmount();
    const before = host.writes;
    if (outcome === 'resolve') deletion.resolve(); else deletion.reject(new Error('Synthetic old A refusal'));
    await settle(host); expect(host.writes).toBe(before); expect(host.unmountedWrites).toBe(0); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('closes the same note only after a confirmed deletion', async () => {
    const {host, store, deletion, remove, removed} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic a'); deletion.resolve(); await settle(host);
    expect(selectedTitle(host)).toBeUndefined(); expect(store.getSnapshot().map(row => row.note.id)).toEqual(['b']);
    expect(remove).toHaveBeenCalledTimes(1); expect(removed).toHaveBeenCalledExactlyOnceWith('a');
  });
  it('shows a current refusal and keeps both stored notes', async () => {
    const {host, store, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    deletion.reject(new Error('Synthetic current A refusal')); await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic a'); expect(text(host.tree)).toContain('La suppression a échoué');
    expect(store.getSnapshot()).toHaveLength(2); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('keeps the note open when the same confirmation is pressed twice before rendering', async () => {
    const {host, deletion, remove} = setup(); select(host, 'a');
    click(host, e => e.type === Button && e.props['aria-label'] === 'Supprimer la note');
    const confirm = one(host, e => e.type === Button && text(e) === 'Supprimer').props.onClick;
    confirm(); confirm(); await settle(host);
    expect(remove).toHaveBeenCalledTimes(1); expect(selectedTitle(host)).toBe('Synthetic a');
    deletion.resolve(); await settle(host); expect(selectedTitle(host)).toBeUndefined();
  });
  it('retries a refused deletion only after the explicit retry action', async () => {
    const {host, store, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    deletion.reject(new Error('Synthetic current refusal')); await settle(host);
    expect(remove).toHaveBeenCalledTimes(1); expect(store.getSnapshot()).toHaveLength(2);
    const retry = deferred(); remove.mockImplementationOnce(() => retry.promise);
    click(host, e => e.type === Button && text(e) === 'Réessayer'); await settle(host);
    expect(remove).toHaveBeenCalledTimes(2); expect(selectedTitle(host)).toBe('Synthetic a');
    retry.resolve(); await settle(host);
    expect(store.getSnapshot().map(row => row.note.id)).toEqual(['b']); expect(selectedTitle(host)).toBeUndefined();
  });
  it('disables a pending confirmation when the workspace becomes read only', async () => {
    const {host, remove} = setup(); select(host, 'a');
    click(host, e => e.type === Button && e.props['aria-label'] === 'Supprimer la note');
    host.props = {...host.props, readOnly: true}; host.render();
    const confirm = one(host, e => e.type === Button && text(e) === 'Supprimer');
    expect(confirm.props.disabled).toBe(true); confirm.props.onClick(); await settle(host);
    expect(remove).not.toHaveBeenCalled(); expect(selectedTitle(host)).toBe('Synthetic a');
  });
  it('keeps B editable while deleting A', async () => {
    const {host, store, deletion} = setup(); select(host, 'a'); beginDelete(host); await settle(host); select(host, 'b');
    const input = one(host, e => e.type === 'input' && e.props['aria-label'] === 'Titre de la note');
    expect(input.props.readOnly).toBe(false); input.props.onChange({target: {value: 'Retained B edit'}}); host.flush();
    expect(selectedTitle(host)).toBe('Retained B edit');
    deletion.resolve(); await settle(host);
    expect(selectedTitle(host)).toBe('Retained B edit'); expect(store.getSnapshot().find(row => row.note.id === 'b')?.note.title).toBe('Retained B edit');
    store.stop();
  });
  it.each(['resolve', 'reject'] as const)('preserves B confirmation after A %s', async outcome => {
    const {host, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host); select(host, 'b');
    click(host, e => e.type === Button && e.props['aria-label'] === 'Supprimer la note');
    if (outcome === 'resolve') deletion.resolve(); else deletion.reject(new Error('Synthetic old A refusal'));
    await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic b');
    expect(walk(host.tree).filter(e => e.props?.className === 'notes-delete-confirm')).toHaveLength(1);
    expect(one(host, e => e.type === Button && text(e) === 'Supprimer').props.disabled).toBe(false);
    expect(text(host.tree)).not.toContain('La suppression a échoué'); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('preserves a new note opened before the previous deletion settles', async () => {
    const {host, store, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    click(host, e => e.type === Button && text(e).includes('Nouvelle note'));
    const title = one(host, e => e.type === 'input' && e.props['aria-label'] === 'Titre de la note');
    title.props.onChange({target: {value: 'Synthetic new note'}}); host.flush();
    deletion.resolve(); await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic new note'); expect(store.getSnapshot().some(row => row.note.title === 'Synthetic new note')).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1); store.stop();
  });
  it('handles selecting B and confirming A in the same event batch', async () => {
    const {host, deletion, remove} = setup(); select(host, 'a'); beginDelete(host); await settle(host);
    const chooseB = one(host, e => e.type === 'button' && e.props.className?.includes('notes-list__entry') && text(e).includes('Synthetic b')).props.onClick;
    chooseB(); deletion.resolve(); await settle(host);
    expect(selectedTitle(host)).toBe('Synthetic b'); expect(remove).toHaveBeenCalledTimes(1);
  });
  it('does not start a deletion from a detached screen', async () => {
    const {host, remove} = setup(); select(host, 'a');
    click(host, e => e.type === Button && e.props['aria-label'] === 'Supprimer la note');
    const confirm = one(host, e => e.type === Button && text(e) === 'Supprimer').props.onClick;
    host.unmount(); const before = host.writes; confirm(); await settle(host);
    expect(remove).not.toHaveBeenCalled(); expect(host.writes).toBe(before); expect(host.unmountedWrites).toBe(0);
  });
});
