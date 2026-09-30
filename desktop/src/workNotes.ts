import type { WorkNote, WorkNoteDraft } from './types';

export type NoteSaveState = 'saved' | 'pending' | 'saving' | 'error';
export type NoteSession = { note: WorkNote; state: NoteSaveState; error: string | null; isNew: boolean };
type Entry = { snapshot: NoteSession; baseline: WorkNote | null; generation: number; timer?: ReturnType<typeof setTimeout>; task?: Promise<void> };
type Dependencies = {
  save: (draft: WorkNoteDraft) => Promise<WorkNote>;
  remove: (id: string, expectedUpdatedAt: string) => Promise<unknown>;
  saved: (note: WorkNote) => void;
  removed: (id: string) => void;
  persist?: (notes: Array<{ note: WorkNote; baseline: WorkNote | null }>) => void;
};

export function notePreview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 160);
}
export function noteChecklist(body: string) {
  return body.split('\n').flatMap((line, index) => {
    const match = line.match(/^([ \t]*)([☐☑])\s+(.*)$/);
    return match && match[3].trim() ? [{ index, text: match[3], checked: match[2] === '☑' }] : [];
  });
}
export function toggleNoteChecklist(body: string, index: number) {
  return body.split('\n').map((line, row) => row === index ? line.replace(/^([ \t]*)([☐☑])(?=\s)/, (_, indent: string, mark: string) => `${indent}${mark === '☑' ? '☐' : '☑'}`) : line).join('\n');
}
export function noteTitle(note: Pick<WorkNote, 'title' | 'body'>, fallback: string): string {
  return note.title.trim() || note.body.split('\n').find(line => line.trim())?.trim().slice(0, 100) || fallback;
}
export function sortWorkNotes(notes: WorkNote[]): WorkNote[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
export function filterWorkNotes(notes: WorkNote[], query: string, projectId: string): WorkNote[] {
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const needle = normalize(query.trim());
  return sortWorkNotes(notes.filter(note => (!projectId || note.projectId === projectId) &&
    (!needle || normalize(`${note.title}\n${note.body}\n${note.authorName}`).includes(needle))));
}

/** Owns writes outside the editor, so changing screens cannot cancel an autosave. */
export class WorkNotesStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshot: NoteSession[] = [];
  private writable = true;
  private active = true;
  private deleting = new Set<string>();
  constructor(private readonly deps: Dependencies, active = true) { this.active = active; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish() {
    this.snapshot = sortWorkNotes([...this.entries.values()].map(entry => entry.snapshot.note)).map(note => this.entries.get(note.id)!.snapshot);
    this.deps.persist?.([...this.entries.values()].filter(entry => entry.snapshot.state !== 'saved').map(entry => ({ note: entry.snapshot.note, baseline: entry.baseline })));
    this.listeners.forEach(listener => listener());
  }
  merge(notes: WorkNote[]) {
    let changed = false;
    const ids = new Set(notes.map(note => note.id));
    for (const note of notes) {
      const entry = this.entries.get(note.id);
      if (!entry) { this.entries.set(note.id, { snapshot: { note, state: 'saved', error: null, isNew: false }, baseline: note, generation: 0 }); changed = true; }
      else if (entry.snapshot.state === 'saved' && note.updatedAt !== entry.baseline?.updatedAt) {
        entry.baseline = note; entry.snapshot = { note, state: 'saved', error: null, isNew: false }; changed = true;
      }
    }
    for (const [id, entry] of this.entries) if (!ids.has(id) && entry.snapshot.state === 'saved') { this.entries.delete(id); changed = true; }
    if (changed) this.publish();
  }
  restore(drafts: Array<{ note: WorkNote; baseline: WorkNote | null }>) {
    for (const draft of drafts) {
      if (this.entries.get(draft.note.id)?.snapshot.state !== 'saved' && this.entries.has(draft.note.id)) continue;
      this.entries.set(draft.note.id, { snapshot: { note: draft.note, state: 'pending', error: null, isNew: !draft.baseline }, baseline: draft.baseline, generation: 0 });
      this.schedule(draft.note.id);
    }
    this.publish();
  }
  setWritable(value: boolean) { this.writable = value; if (value) for (const entry of this.snapshot) if (entry.state === 'pending') this.schedule(entry.note.id); }
  start() { this.active = true; for (const entry of this.snapshot) if (entry.state === 'pending') this.schedule(entry.note.id); }
  stop() { this.active = false; for (const entry of this.entries.values()) clearTimeout(entry.timer); }
  create(projectId: string | null = null): string {
    if (!this.writable) throw new Error('Les notes sont en lecture seule.');
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const note: WorkNote = { id, title: '', body: '', projectId, pinned: false, authorName: '', createdByMemberId: null, createdAt: now, updatedAt: now };
    this.entries.set(id, { snapshot: { note, state: 'pending', error: null, isNew: true }, baseline: null, generation: 0 });
    this.publish(); return id;
  }
  edit(id: string, patch: Partial<Pick<WorkNote, 'title' | 'body' | 'projectId' | 'pinned'>>) {
    if (!this.writable || this.deleting.has(id)) return;
    const entry = this.entries.get(id); if (!entry) return;
    entry.generation++;
    entry.snapshot = { ...entry.snapshot, note: { ...entry.snapshot.note, ...patch }, state: 'pending', error: null };
    this.publish(); this.schedule(id);
  }
  private schedule(id: string) {
    const entry = this.entries.get(id); if (!entry || !this.active || !this.writable) return;
    clearTimeout(entry.timer); entry.timer = setTimeout(() => void this.flush(id), 650);
  }
  async flush(id: string): Promise<boolean> {
    const entry = this.entries.get(id); if (!entry) return true;
    clearTimeout(entry.timer);
    if (entry.task) { await entry.task; return entry.snapshot.state === 'error' ? false : this.flush(id); }
    if (entry.snapshot.state === 'saved') return true;
    if (!this.active || !this.writable) return false;
    // A blank new editor is not an empty company record.
    if (!entry.baseline && !entry.snapshot.note.title.trim() && !entry.snapshot.note.body.trim()) return true;
    const generation = entry.generation, note = entry.snapshot.note;
    entry.snapshot = { ...entry.snapshot, state: 'saving', error: null }; this.publish();
    entry.task = (async () => {
      try {
        const saved = await this.deps.save({ id, title: note.title, body: note.body, projectId: note.projectId, pinned: note.pinned, expectedUpdatedAt: entry.baseline?.updatedAt ?? null });
        entry.baseline = saved;
        entry.snapshot = { note: generation === entry.generation ? saved : { ...entry.snapshot.note, updatedAt: saved.updatedAt, createdAt: saved.createdAt, authorName: saved.authorName, createdByMemberId: saved.createdByMemberId }, state: generation === entry.generation ? 'saved' : 'pending', error: null, isNew: false };
        if (this.active) this.deps.saved(saved);
      } catch (reason) {
        entry.snapshot = { ...entry.snapshot, state: 'error', error: reason instanceof Error ? reason.message : String(reason) };
      } finally { entry.task = undefined; this.publish(); }
    })();
    await entry.task;
    if (entry.snapshot.state === 'pending') return this.flush(id);
    return entry.snapshot.state === 'saved';
  }
  discardBlank(id: string) {
    const entry = this.entries.get(id);
    if (entry && !entry.baseline && !entry.snapshot.note.title.trim() && !entry.snapshot.note.body.trim()) { clearTimeout(entry.timer); this.entries.delete(id); this.publish(); }
  }
  async remove(id: string) {
    if (!this.writable) throw new Error('Les notes sont en lecture seule.');
    if (this.deleting.has(id)) return;
    this.deleting.add(id);
    try {
    if (!await this.flush(id)) throw new Error('Enregistrez la note avant de la supprimer.');
    const entry = this.entries.get(id); if (!entry) return;
    if (entry.baseline) await this.deps.remove(id, entry.baseline.updatedAt);
    this.entries.delete(id); if (this.active) this.deps.removed(id); this.publish();
    } finally { this.deleting.delete(id); }
  }
  copy(id: string): string | null {
    if (!this.writable) return null;
    const source = this.entries.get(id)?.snapshot.note; if (!source) return null;
    const next = this.create(source.projectId); this.edit(next, { title: source.title, body: source.body, pinned: source.pinned }); return next;
  }
}

export function readNoteDrafts(scope: string): Array<{ note: WorkNote; baseline: WorkNote | null }> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`zentra.notes.drafts.${scope}`) || '[]');
    if (!Array.isArray(value)) return [];
    const validNote = (note: unknown): note is WorkNote => {
      if (!note || typeof note !== 'object') return false;
      const row = note as WorkNote;
      return typeof row.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.id) && typeof row.title === 'string' && row.title.length <= 200 && typeof row.body === 'string' && row.body.length <= 100000 && typeof row.authorName === 'string' && typeof row.pinned === 'boolean' &&
        typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) &&
        (row.projectId === null || typeof row.projectId === 'string') && (row.createdByMemberId === null || typeof row.createdByMemberId === 'string');
    };
    return value.filter(item => item && validNote(item.note) && (item.baseline === null || validNote(item.baseline) && item.baseline.id === item.note.id));
  } catch { return []; }
}
export function persistNoteDrafts(scope: string, drafts: Array<{ note: WorkNote; baseline: WorkNote | null }>) {
  try { if (drafts.length) localStorage.setItem(`zentra.notes.drafts.${scope}`, JSON.stringify(drafts)); else localStorage.removeItem(`zentra.notes.drafts.${scope}`); } catch { /* SQLite autosave remains the primary persistence. */ }
}
