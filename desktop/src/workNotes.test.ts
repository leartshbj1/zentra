import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkNote, WorkNoteDraft } from './types';
import { filterWorkNotes, noteChecklist, notePreview, noteTitle, persistNoteDrafts, readNoteDrafts, sortWorkNotes, toggleNoteChecklist, WorkNotesStore } from './workNotes';

const originalTime = '2026-09-30T08:00:00.000Z';
const savedTime = '2026-09-30T08:01:00.000Z';
const finalTime = '2026-09-30T08:02:00.000Z';
type DraftRecord = { note: WorkNote; baseline: WorkNote | null };

function note(patch: Partial<WorkNote> = {}): WorkNote {
  return { id: 'note-1', title: 'Relevé', body: 'Mesures du projet', projectId: 'project-1', pinned: false,
    authorName: 'Élodie', createdByMemberId: 'member-1', createdAt: originalTime, updatedAt: originalTime, ...patch };
}

function result(draft: WorkNoteDraft, updatedAt = savedTime): WorkNote {
  return note({ id: draft.id, title: draft.title, body: draft.body, projectId: draft.projectId, pinned: draft.pinned, updatedAt });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ConstructorParameters<typeof WorkNotesStore>[0]> = {}) {
  const deps = {
    save: vi.fn(async (draft: WorkNoteDraft) => result(draft)),
    remove: vi.fn(async (_id: string, _expectedUpdatedAt: string) => {}),
    saved: vi.fn((_note: WorkNote) => {}),
    removed: vi.fn((_id: string) => {}),
    persist: vi.fn((_drafts: DraftRecord[]) => {}),
    ...overrides,
  };
  return { deps, store: new WorkNotesStore(deps) };
}

describe('work note autosave and recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-30T09:00:00.000Z'); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('debounces typing and serializes the newer text behind an unfinished native save', async () => {
    const first = deferred<WorkNote>(), second = deferred<WorkNote>();
    const save = vi.fn<(draft: WorkNoteDraft) => Promise<WorkNote>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { store, deps } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { body: 'Première frappe' });
    await vi.advanceTimersByTimeAsync(649);
    expect(save).not.toHaveBeenCalled();
    store.edit('note-1', { body: 'Texte avant enregistrement' });
    await vi.advanceTimersByTimeAsync(650);
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: 'note-1', title: 'Relevé', body: 'Texte avant enregistrement', projectId: 'project-1', pinned: false, expectedUpdatedAt: originalTime });

    store.edit('note-1', { body: 'Texte saisi pendant l’enregistrement', pinned: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenLastCalledWith([{ note: expect.objectContaining({ body: 'Texte saisi pendant l’enregistrement', pinned: true }), baseline: note() }]);

    first.resolve(result(save.mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ body: 'Texte saisi pendant l’enregistrement', pinned: true, expectedUpdatedAt: savedTime });
    expect(store.getSnapshot()[0].note.body).toBe('Texte saisi pendant l’enregistrement');
    second.resolve(result(save.mock.calls[1][0], finalTime));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'saved', isNew: false, note: { body: 'Texte saisi pendant l’enregistrement', pinned: true, updatedAt: finalTime } });
    expect(deps.persist).toHaveBeenLastCalledWith([]);
    expect(deps.saved).toHaveBeenCalledTimes(2);
  });

  it('flushes immediately when an editor leaves, independently of its subscription', async () => {
    const pending = deferred<WorkNote>();
    const save = vi.fn((_draft: WorkNoteDraft) => pending.promise);
    const { store, deps } = setup({ save });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.merge([note()]);
    store.edit('note-1', { body: 'Texte avant de changer d’écran' });
    const flushing = store.flush('note-1');
    unsubscribe();
    const notificationsBeforeUnmount = listener.mock.calls.length;
    expect(save).toHaveBeenCalledTimes(1);
    pending.resolve(result(save.mock.calls[0][0]));
    expect(await flushing).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeUnmount);
    expect(deps.saved).toHaveBeenCalledWith(expect.objectContaining({ body: 'Texte avant de changer d’écran' }));
    expect(deps.persist).toHaveBeenLastCalledWith([]);
  });

  it('persists a stopped debounce and recovers its text with the original optimistic baseline', async () => {
    let durableDrafts: DraftRecord[] = [];
    const { store, deps } = setup({ persist: drafts => { durableDrafts = structuredClone(drafts); } });
    store.merge([note()]);
    store.edit('note-1', { body: 'Texte à récupérer après fermeture' });
    store.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.save).not.toHaveBeenCalled();
    expect(await store.flush('note-1')).toBe(false);
    expect(durableDrafts).toEqual([{ note: note({ body: 'Texte à récupérer après fermeture' }), baseline: note() }]);

    const recovered = setup();
    recovered.store.merge([note()]);
    recovered.store.restore(durableDrafts);
    await vi.advanceTimersByTimeAsync(650);
    expect(recovered.deps.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: 'Texte à récupérer après fermeture', expectedUpdatedAt: originalTime }));
    expect(recovered.store.getSnapshot()[0].state).toBe('saved');
  });

  it('keeps text typed during a save recoverable when the workspace stops before completion', async () => {
    const first = deferred<WorkNote>();
    const save = vi.fn<(draft: WorkNoteDraft) => Promise<WorkNote>>()
      .mockReturnValueOnce(first.promise).mockImplementation(async draft => result(draft, finalTime));
    const { store, deps } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { body: 'Premier texte' });
    const flushing = store.flush('note-1');
    store.edit('note-1', { body: 'Texte conservé après fermeture' });
    store.stop();
    first.resolve(result(save.mock.calls[0][0]));
    expect(await flushing).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(deps.saved).not.toHaveBeenCalled();
    expect(deps.persist).toHaveBeenLastCalledWith([{ note: expect.objectContaining({ body: 'Texte conservé après fermeture' }), baseline: expect.objectContaining({ body: 'Premier texte', updatedAt: savedTime }) }]);
    store.start();
    await vi.advanceTimersByTimeAsync(650);
    expect(save.mock.calls[1][0]).toMatchObject({ body: 'Texte conservé après fermeture', expectedUpdatedAt: savedTime });
    expect(store.getSnapshot()[0].state).toBe('saved');
  });

  it('retains text after a failed write and retries only when requested', async () => {
    const save = vi.fn(async (draft: WorkNoteDraft) => result(draft)).mockRejectedValueOnce(new Error('Disque indisponible'));
    const { store, deps } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { title: 'Mesures finales', body: 'Ne perdre aucun détail' });
    expect(await store.flush('note-1')).toBe(false);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', error: 'Disque indisponible', note: { title: 'Mesures finales', body: 'Ne perdre aucun détail' } });
    expect(deps.persist).toHaveBeenLastCalledWith([{ note: expect.objectContaining({ body: 'Ne perdre aucun détail' }), baseline: note() }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await store.flush('note-1')).toBe(true);
    expect(save.mock.calls[1][0]).toMatchObject({ title: 'Mesures finales', body: 'Ne perdre aucun détail', expectedUpdatedAt: originalTime });
    expect(deps.persist).toHaveBeenLastCalledWith([]);
  });

  it('reports one failed write to all concurrent flush callers without multiplying retries', async () => {
    const pending = deferred<WorkNote>();
    const save = vi.fn<(draft: WorkNoteDraft) => Promise<WorkNote>>()
      .mockReturnValueOnce(pending.promise).mockImplementation(async draft => result(draft));
    const { store } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { body: 'Texte à garder après un seul échec' });
    const flushes = [store.flush('note-1'), store.flush('note-1'), store.flush('note-1')];
    pending.reject(new Error('Disque indisponible'));
    expect(await Promise.all(flushes)).toEqual([false, false, false]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', note: { body: 'Texte à garder après un seul échec' } });
    expect(await store.flush('note-1')).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('preserves the latest local text and its baseline after a colleague update conflicts', async () => {
    const pending = deferred<WorkNote>();
    const save = vi.fn((_draft: WorkNoteDraft) => pending.promise);
    const { store, deps } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { body: 'Texte local en cours' });
    const flushing = store.flush('note-1');
    store.edit('note-1', { body: 'Dernier texte local à conserver' });
    store.merge([note({ body: 'Correction d’un collègue', updatedAt: savedTime })]);
    pending.reject(new Error('Cette note a été modifiée par un collègue.'));
    expect(await flushing).toBe(false);
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', note: { body: 'Dernier texte local à conserver', updatedAt: originalTime } });
    expect(deps.persist).toHaveBeenLastCalledWith([{ note: expect.objectContaining({ body: 'Dernier texte local à conserver' }), baseline: note() }]);
    expect(deps.saved).not.toHaveBeenCalled();
  });

  it('can save a separate copy of conflicted text without overwriting the existing note', async () => {
    const save = vi.fn(async (draft: WorkNoteDraft) => result(draft)).mockRejectedValueOnce(new Error('Version obsolète'));
    const { store } = setup({ save });
    store.merge([note({ pinned: true })]);
    store.edit('note-1', { body: 'Texte personnel à conserver' });
    expect(await store.flush('note-1')).toBe(false);
    const copyId = store.copy('note-1');
    expect(copyId).toBeTruthy();
    expect(copyId).not.toBe('note-1');
    expect(await store.flush(copyId!)).toBe(true);
    expect(save.mock.calls[1][0]).toEqual({ id: copyId, title: 'Relevé', body: 'Texte personnel à conserver', projectId: 'project-1', pinned: true, expectedUpdatedAt: null });
    expect(store.getSnapshot().find(entry => entry.note.id === 'note-1')).toMatchObject({ state: 'error', note: { body: 'Texte personnel à conserver' } });
  });

  it('makes read-only edits and removals inert and holds recovered drafts until writing is allowed', async () => {
    const { store, deps } = setup();
    store.merge([note()]);
    store.setWritable(false);
    store.edit('note-1', { body: 'Modification interdite' });
    expect(store.getSnapshot()[0].note).toEqual(note());
    expect(() => store.create()).toThrow('lecture seule');
    expect(store.copy('note-1')).toBeNull();
    expect(store.getSnapshot()).toHaveLength(1);
    await expect(store.remove('note-1')).rejects.toThrow('lecture seule');
    store.restore([{ note: note({ body: 'Brouillon avant passage en lecture seule' }), baseline: note() }]);
    expect(await store.flush('note-1')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
    store.setWritable(true);
    await vi.advanceTimersByTimeAsync(650);
    expect(deps.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: 'Brouillon avant passage en lecture seule', expectedUpdatedAt: originalTime }));
  });

  it('does not create an empty native record when a new blank editor is closed', async () => {
    const { store, deps } = setup();
    const id = store.create();
    store.edit(id, { title: '  ', body: '\n\t' });
    expect(await store.flush(id)).toBe(true);
    store.discardBlank(id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.save).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual([]);
    expect(deps.persist).toHaveBeenLastCalledWith([]);
  });

  it('saves pending text before deleting with the saved version', async () => {
    const pending = deferred<WorkNote>();
    const save = vi.fn((_draft: WorkNoteDraft) => pending.promise);
    const { store, deps } = setup({ save });
    store.merge([note()]);
    store.edit('note-1', { body: 'Dernière modification avant suppression' });
    const deleting = store.remove('note-1');
    expect(deps.remove).not.toHaveBeenCalled();
    pending.resolve(result(save.mock.calls[0][0]));
    await deleting;
    expect(deps.remove).toHaveBeenCalledExactlyOnceWith('note-1', savedTime);
    expect(deps.removed).toHaveBeenCalledExactlyOnceWith('note-1');
    expect(store.getSnapshot()).toEqual([]);
  });

  it('blocks deletion when saving fails and retains the editable text', async () => {
    const { store, deps } = setup({ save: vi.fn(async () => { throw new Error('Version obsolète'); }) });
    store.merge([note()]);
    store.edit('note-1', { body: 'Texte conservé malgré la suppression demandée' });
    await expect(store.remove('note-1')).rejects.toThrow('Enregistrez');
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.removed).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'error', note: { body: 'Texte conservé malgré la suppression demandée' } });
  });

  it('retains a note when optimistic deletion fails', async () => {
    const { store, deps } = setup({ remove: vi.fn(async () => { throw new Error('Le collègue a modifié la note'); }) });
    store.merge([note()]);
    await expect(store.remove('note-1')).rejects.toThrow('Le collègue');
    expect(deps.remove).toHaveBeenCalledWith('note-1', originalTime);
    expect(deps.removed).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0].note).toEqual(note());
  });

  it('locks the note while native deletion is pending so late typing cannot be lost', async () => {
    const pending = deferred<void>();
    const remove = vi.fn((_id: string, _expectedUpdatedAt: string) => pending.promise);
    const { store, deps } = setup({ remove });
    store.merge([note()]);
    const deleting = store.remove('note-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith('note-1', originalTime);
    store.edit('note-1', { body: 'Frappe reçue pendant la suppression' });
    expect(store.getSnapshot()[0].note.body).toBe('Mesures du projet');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.save).not.toHaveBeenCalled();
    pending.resolve();
    await deleting;
    expect(store.getSnapshot()).toEqual([]);
  });

  it('unlocks editing after native deletion fails', async () => {
    const pending = deferred<void>();
    const { store } = setup({ remove: vi.fn(() => pending.promise) });
    store.merge([note()]);
    const deleting = store.remove('note-1');
    const rejection = expect(deleting).rejects.toThrow('Version obsolète');
    await vi.advanceTimersByTimeAsync(0);
    pending.reject(new Error('Version obsolète'));
    await rejection;
    store.edit('note-1', { body: 'Texte après annulation de la suppression' });
    expect(store.getSnapshot()[0]).toMatchObject({ state: 'pending', note: { body: 'Texte après annulation de la suppression' } });
  });

  it('merges incoming versions only for clean notes and preserves unsaved new drafts', () => {
    const { store } = setup();
    store.merge([note(), note({ id: 'removed-note' })]);
    const draftId = store.create('project-2');
    store.edit(draftId, { body: 'Nouveau brouillon' });
    store.merge([note({ title: 'Titre du collègue', updatedAt: savedTime })]);
    expect(store.getSnapshot().find(entry => entry.note.id === 'note-1')?.note.title).toBe('Titre du collègue');
    expect(store.getSnapshot().find(entry => entry.note.id === 'removed-note')).toBeUndefined();
    expect(store.getSnapshot().find(entry => entry.note.id === draftId)?.note.body).toBe('Nouveau brouillon');
  });
});

describe('work note presentation', () => {
  it('extracts real Unicode checklist rows with their original line numbers', () => {
    const body = 'Contrôle du projet\n\n  ☐ Vérifier la fenêtre\n\t☑ Mesure relevée\n[ ] Marqueur Markdown\nTexte ☐ inclus dans une phrase\n☑Sans espace\n☐ \t\n☐  Dernier point  ';
    expect(noteChecklist(body)).toEqual([
      { index: 2, text: 'Vérifier la fenêtre', checked: false },
      { index: 3, text: 'Mesure relevée', checked: true },
      { index: 8, text: 'Dernier point  ', checked: false },
    ]);
  });

  it('toggles only the requested checklist marker and preserves indentation, spacing and other note data', () => {
    const body = 'Détails libres\r\n  \t☐ \tVérifier la fenêtre  \r\n\t☑ Mesure relevée\r\nTexte ☐ conservé\r\n';
    const toggled = 'Détails libres\r\n  \t☑ \tVérifier la fenêtre  \r\n\t☑ Mesure relevée\r\nTexte ☐ conservé\r\n';
    expect(toggleNoteChecklist(body, 1)).toBe(toggled);
    expect(toggleNoteChecklist(toggled, 1)).toBe(body);
  });

  it('unchecks the selected checked row without changing neighbouring rows', () => {
    const body = '☑ Réception\n☐ Sol\n\t☑ Murs\n';
    expect(toggleNoteChecklist(body, 2)).toBe('☑ Réception\n☐ Sol\n\t☐ Murs\n');
    expect(noteChecklist(toggleNoteChecklist(body, 2)).filter(item => item.checked)).toEqual([{ index: 0, text: 'Réception', checked: true }]);
  });

  it.each([-1, 0, 1, 2, 3, 50])('leaves unrelated or missing row %s untouched', index => {
    const body = 'Observation\n[ ] Texte Markdown\nPhrase avec ☐ marqueur\n☑Sans espace\n☐ Point réel';
    expect(toggleNoteChecklist(body, index)).toBe(body);
  });

  it('sorts pinned notes first, then recent notes, with a stable tie break and without mutating the input', () => {
    const input = [note({ id: 'z', updatedAt: finalTime }), note({ id: 'b', pinned: true }), note({ id: 'a', updatedAt: finalTime }), note({ id: 'c', pinned: true, updatedAt: savedTime })];
    const originalOrder = input.map(entry => entry.id);
    expect(sortWorkNotes(input).map(entry => entry.id)).toEqual(['c', 'b', 'a', 'z']);
    expect(input.map(entry => entry.id)).toEqual(originalOrder);
  });

  it('searches accents and case across title, body and author while keeping the project filter and sort', () => {
    const notes = [note({ id: 'a', title: 'Réception', body: 'Câble mesuré', authorName: 'Zoé' }),
      note({ id: 'b', title: 'Reception', pinned: true }),
      note({ id: 'c', title: 'Réception', projectId: 'project-2' })];
    expect(filterWorkNotes(notes, '  RECEPTION ', 'project-1').map(entry => entry.id)).toEqual(['b', 'a']);
    expect(filterWorkNotes(notes, 'cable mesure', '').map(entry => entry.id)).toEqual(['a']);
    expect(filterWorkNotes(notes, 'ZOE', '').map(entry => entry.id)).toEqual(['a']);
    expect(filterWorkNotes(notes, '', 'project-2').map(entry => entry.id)).toEqual(['c']);
  });

  it('derives readable titles and bounded plain-text previews for untitled notes', () => {
    expect(noteTitle({ title: '  Mesure  ', body: 'Autre texte' }, 'Sans titre')).toBe('Mesure');
    expect(noteTitle({ title: ' ', body: '\n \t\n  Première observation \nDétails' }, 'Sans titre')).toBe('Première observation');
    expect(noteTitle({ title: '', body: '\n  ' }, 'Sans titre')).toBe('Sans titre');
    expect(notePreview('  Ligne un\n\tligne deux  ')).toBe('Ligne un ligne deux');
    expect(notePreview('a'.repeat(200))).toHaveLength(160);
  });
});

describe('persisted work note draft integrity', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips only the selected workspace and removes cleared recovery data', () => {
    const drafts = [{ note: note({ body: 'Brouillon' }), baseline: note() }, { note: note({ id: 'new-note' }), baseline: null }];
    persistNoteDrafts('workspace-a', drafts);
    persistNoteDrafts('workspace-b', [{ note: note({ id: 'other-note' }), baseline: null }]);
    expect(readNoteDrafts('workspace-a')).toEqual(drafts);
    persistNoteDrafts('workspace-a', []);
    expect(storage.has('zentra.notes.drafts.workspace-a')).toBe(false);
    expect(readNoteDrafts('workspace-b')).toHaveLength(1);
  });

  it.each(['broken JSON', '{}', 'null', '"draft"'])('ignores unusable recovery storage: %s', raw => {
    storage.set('zentra.notes.drafts.company', raw);
    expect(readNoteDrafts('company')).toEqual([]);
  });

  it.each([
    ['missing optimistic timestamp', { id: 'note-1' }],
    ['invalid optimistic timestamp', note({ updatedAt: 'invalid-date' })],
    ['another note identity', note({ id: 'some-other-note' })],
    ['false baseline', false],
    ['numeric baseline', 0],
    ['empty string baseline', ''],
  ])('rejects a %s instead of treating the note as a new record', (_label, baseline) => {
    storage.set('zentra.notes.drafts.company', JSON.stringify([{ note: note({ body: 'Texte à protéger' }), baseline }]));
    expect(readNoteDrafts('company')).toEqual([]);
  });

  it.each([
    ['empty identity', { id: '' }],
    ['invalid updated timestamp', { updatedAt: 'invalid-date' }],
    ['invalid creation timestamp', { createdAt: 'invalid-date' }],
    ['missing author name', { authorName: undefined }],
    ['invalid creator identity', { createdByMemberId: 123 }],
    ['invalid title', { title: null }],
    ['invalid project', { projectId: 123 }],
    ['invalid pinned flag', { pinned: 'true' }],
  ])('rejects a draft with %s while retaining the valid entries', (_label, patch) => {
    const valid = { note: note({ id: 'valid-note' }), baseline: null };
    storage.set('zentra.notes.drafts.company', JSON.stringify([{ note: { ...note(), ...patch }, baseline: null }, valid]));
    expect(readNoteDrafts('company')).toEqual([valid]);
  });

  it('does not throw when browser recovery storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => { throw new Error('Storage blocked'); } });
    expect(readNoteDrafts('company')).toEqual([]);
    expect(() => persistNoteDrafts('company', [{ note: note(), baseline: null }])).not.toThrow();
    expect(() => persistNoteDrafts('company', [])).not.toThrow();
  });
});
