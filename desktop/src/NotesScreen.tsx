import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Check, CheckCheck, ChevronDown, Copy, FolderOpen, NotebookPen, Pin, Plus, Search, Trash2, UserRound, WifiOff } from 'lucide-react';
import { getAppLocale, t, useAppLanguage } from './language';
import { Button } from './ui';
import type { Project, WorkNote } from './types';
import { filterWorkNotes, noteChecklist, toggleNoteChecklist, notePreview, noteTitle, type WorkNotesStore } from './workNotes';
import './notes.css';

export function NotesScreen({ store, projects, readOnly, initialProjectId, onProjectHandled, onEditingChange }: {
  store: WorkNotesStore; projects: Project[]; readOnly: boolean; initialProjectId: string | null; onProjectHandled: () => void; onEditingChange: (editing: boolean) => void;
}) {
  useAppLanguage();
  const sessions = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState(initialProjectId || '');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deletionRunning = useRef(false);
  const mounted = useRef(false);
  const selection = useRef<string | null>(null);
  const currentStore = useRef(store);
  currentStore.current = store;
  const [online, setOnline] = useState(navigator.onLine);
  const body = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLTextAreaElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const surface = useRef<HTMLElement>(null);
  const selected = sessions.find(entry => entry.note.id === selectedId);
  useEffect(() => {
    const field = title.current;
    if (!field) return;
    const fitTitle = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
    fitTitle();
    window.addEventListener('resize', fitTitle);
    let width = field.getBoundingClientRect().width;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; fitTitle(); }
    });
    resize?.observe(field);
    const textSize = typeof MutationObserver === 'undefined' ? null : new MutationObserver(fitTitle);
    textSize?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-text-size'] });
    return () => { window.removeEventListener('resize', fitTitle); resize?.disconnect(); textSize?.disconnect(); };
  }, [selectedId, selected?.note.title]);
  const deleting = selectedId !== null && deletingId === selectedId;
  const notes = useMemo(() => filterWorkNotes(sessions.map(entry => entry.note), query, projectFilter), [sessions, query, projectFilter]);
  const noteGroups = [{ label: 'Épinglées', entries: notes.filter(note => note.pinned) }, { label: 'Notes récentes', entries: notes.filter(note => !note.pinned) }].filter(group => group.entries.length);
  const checklist = selected ? noteChecklist(selected.note.body) : [];
  const selectedProject = selected?.note.projectId ? projects.find(project => project.id === selected.note.projectId)?.name || t('Projet') : t('Sans projet');
  const selectNote = (id: string | null) => { selection.current = id; setSelectedId(id); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onEditingChange(Boolean(selectedId)); return () => onEditingChange(false); }, [selectedId, onEditingChange]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => surface.current?.style.setProperty('--notes-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    update(); viewport?.addEventListener('resize', update);
    return () => viewport?.removeEventListener('resize', update);
  }, []);
  useEffect(() => {
    if (initialProjectId) { setProjectFilter(initialProjectId); selectNote(null); onProjectHandled(); }
  }, [initialProjectId, onProjectHandled]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => { if (selectedId && !selected) { selectNote(null); setDeleteOpen(false); } }, [selectedId, selected]);
  useEffect(() => {
    const flush = () => { if (selectedId) void store.flush(selectedId); };
    document.addEventListener('visibilitychange', flush);
    return () => { document.removeEventListener('visibilitychange', flush); flush(); };
  }, [store, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const frame = requestAnimationFrame(() => { if (store.getSnapshot().find(entry => entry.note.id === selectedId)?.isNew && !readOnly) title.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, store, readOnly]);
  function closeEditor() {
    if (selectedId) { void store.flush(selectedId); store.discardBlank(selectedId); }
    selectNote(null); setDeleteOpen(false); setActionError('');
    requestAnimationFrame(() => { if (mounted.current && selection.current === null) listHeading.current?.focus(); });
  }
  function create() { if (!readOnly) { selectNote(store.create(projectFilter || null)); setDeleteOpen(false); setActionError(''); } }
  function addChecklist() {
    if (!selected || !body.current) return;
    const field = body.current, start = field.selectionStart, end = field.selectionEnd;
    const prefix = start > 0 && field.value[start - 1] !== '\n' ? '\n' : '';
    const text = `${prefix}☐ `;
    store.edit(selected.note.id, { body: field.value.slice(0, start) + text + field.value.slice(end) });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + text.length, start + text.length); });
  }
  async function remove() {
    if (!selected || readOnly || deletionRunning.current || !mounted.current) return;
    const id = selected.note.id;
    const isCurrent = () => mounted.current && currentStore.current === store && selection.current === id;
    deletionRunning.current = true; setDeletingId(id); setActionError('');
    try { await store.remove(id); if (isCurrent()) closeEditor(); }
    catch { if (isCurrent()) setActionError(t('La suppression a échoué. Votre note est conservée. Réessayez.')); }
    finally { deletionRunning.current = false; if (mounted.current && currentStore.current === store) setDeletingId(null); }
  }
  function timestamp(note: WorkNote, full = false) {
    const date = new Date(note.updatedAt);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(getAppLocale(), { day: 'numeric', month: full ? 'long' : 'short', ...(full ? { year: 'numeric' } : {}) });
  }
  return <section ref={surface} className={`notes-workspace notes-workspace--notebook${selected ? ' notes-workspace--editing' : ''}`} aria-label={t('Notes de l’équipe')}>
    <aside className="notes-index" aria-label={t('Toutes les notes')}>
      <header className="notes-index__heading"><div><h2 ref={listHeading} tabIndex={-1}>{t(projectFilter ? 'Notes du projet' : 'Toutes les notes')}</h2><span className="notes-index__count" aria-hidden="true">{notes.length}</span></div><Button variant="ghost" size="icon" className="notes-compose" disabled={readOnly} onClick={create} aria-label={t('Nouvelle note')} title={t('Nouvelle note')}><NotebookPen size={21} strokeWidth={1.65} aria-hidden="true" /><span className="sr-only">{t('Nouvelle note')}</span></Button></header>
      <div className="notes-filters"><label className="notes-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label={t('Rechercher une note')} placeholder={t('Rechercher une note')} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label className="notes-project-filter"><FolderOpen size={16} strokeWidth={1.6} aria-hidden="true" /><span className="sr-only">{t('Filtrer par projet')}</span><select value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="">{t('Tous les projets')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      </div>
      {!online && <p className="notes-offline" role="status"><WifiOff size={16} aria-hidden="true" />{t('Hors ligne · vos notes restent enregistrées sur cet appareil.')}</p>}
      {notes.length ? <div className="notes-groups">{noteGroups.map(group => <section className="notes-group" key={group.label} aria-label={t(group.label)}><h3>{t(group.label)}</h3><ul className="notes-list">{group.entries.map(note => <li key={note.id}><button type="button" className={`notes-list__entry${selectedId === note.id ? ' is-selected' : ''}`} aria-current={selectedId === note.id ? 'true' : undefined} onClick={() => { if (selectedId) void store.flush(selectedId); selectNote(note.id); setDeleteOpen(false); setActionError(''); }}>
        <span className="notes-list__title">{note.pinned && <Pin size={15} aria-label={t('Épinglée')} />}<strong>{noteTitle(note, t('Sans titre'))}</strong></span>
        <span className="notes-list__preview">{notePreview(note.body) || t('Note vide')}</span>
        <span className="notes-list__meta"><time dateTime={note.updatedAt}>{timestamp(note)}</time>{note.projectId && <span>{projects.find(project => project.id === note.projectId)?.name || t('Projet')}</span>}</span>
      </button></li>)}</ul></section>)}</div> : <div className="notes-empty"><NotebookPen size={38} strokeWidth={1.4} aria-hidden="true" /><h3>{t(query || projectFilter ? 'Aucune note trouvée' : 'Une idée, une mesure, un détail.')}</h3><p>{t(query || projectFilter ? 'Essayez une autre recherche ou un autre projet.' : 'Gardez vos observations à portée de main.')}</p>{!query && <Button variant="secondary" disabled={readOnly} onClick={create}><Plus size={17} aria-hidden="true" />{t('Écrire une note')}</Button>}</div>}
    </aside>
    <section className="notes-sheet" aria-label={t('Texte de la note')}>
      {selected ? <>
        <header className="notes-editor__toolbar"><Button variant="ghost" className="notes-back" onClick={closeEditor} aria-label={t('Retour aux notes')}><ArrowLeft size={20} aria-hidden="true" /><span>{t('Notes')}</span></Button>
          <span className={`notes-save-state notes-save-state--${selected.state}`} role="status" aria-live="polite">{selected.state === 'saved' ? <Check size={15} aria-hidden="true" /> : <span className="notes-save-state__mark" aria-hidden="true" />}{t(selected.state === 'saved' ? 'Enregistrée' : selected.state === 'error' ? 'À enregistrer' : selected.state === 'saving' ? 'Enregistrement…' : 'Modifications en cours')}</span>
          <div className="notes-editor__actions"><Button variant="ghost" size="icon" disabled={readOnly} aria-label={t(selected.note.pinned ? 'Désépingler la note' : 'Épingler la note')} aria-pressed={selected.note.pinned} onClick={() => store.edit(selected.note.id, { pinned: !selected.note.pinned })}><Pin size={19} aria-hidden="true" /></Button><Button variant="ghost" size="icon" disabled={readOnly} aria-label={t('Supprimer la note')} aria-expanded={deleteOpen} onClick={() => setDeleteOpen(!deleteOpen)}><Trash2 size={19} aria-hidden="true" /></Button></div>
        </header>
        {deleteOpen && <div className="notes-delete-confirm" role="group" aria-label={t('Confirmer la suppression')}><p>{t('Supprimer cette note pour toute l’équipe ?')}</p><Button variant="secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>{t('Annuler')}</Button><Button variant="danger" disabled={readOnly || deletingId !== null} onClick={() => void remove()}>{t(deleting ? 'Suppression…' : 'Supprimer')}</Button></div>}
        {(selected.state === 'error' || actionError) && <div className="notes-error" role="alert"><p>{actionError || t('La note n’a pas pu être enregistrée. Votre texte est conservé sur cet appareil. Si un collègue l’a modifiée, gardez une copie pour ne rien écraser.')}</p><Button variant="secondary" onClick={() => { if (actionError) void remove(); else void store.flush(selected.note.id); }} disabled={readOnly || deleting}>{t('Réessayer')}</Button><Button variant="ghost" disabled={readOnly} onClick={() => { const id = store.copy(selected.note.id); if (id) selectNote(id); }}><Copy size={16} />{t('Garder une copie')}</Button></div>}
        <div className="notes-editor__content" data-company-receive-safe="true"><div className="notes-editor__heading"><time className="notes-editor__date" dateTime={selected.note.updatedAt}>{timestamp(selected.note, true)}</time><textarea ref={title} rows={1} className="notes-editor__title" aria-label={t('Titre de la note')} placeholder={t('Titre')} value={selected.note.title} maxLength={200} readOnly={readOnly || deleting} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} onChange={event => store.edit(selected.note.id, { title: event.target.value.replace(/[\r\n]+/g, ' ') })} /></div>
          <details className="notes-editor__context" key={selected.note.id}><summary aria-label={t('Détails de la note')}><FolderOpen size={16} strokeWidth={1.6} aria-hidden="true" /><span>{selectedProject}</span><ChevronDown size={15} aria-hidden="true" /></summary><div className="notes-editor__context-fields"><label><span>{t('Projet de la note')}</span><select aria-label={t('Projet de la note')} value={selected.note.projectId || ''} disabled={readOnly || deleting} onChange={event => store.edit(selected.note.id, { projectId: event.target.value || null })}><option value="">{t('Sans projet')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{selected.note.authorName && <span className="notes-editor__author"><UserRound size={16} aria-hidden="true" />{selected.note.authorName}</span>}</div></details>
          {checklist.length > 0 && <details className="notes-checklist"><summary><CheckCheck size={17} strokeWidth={1.6} aria-hidden="true" /><span className="notes-checklist__label">{t('Liste à cocher')}</span><span className="notes-checklist__count">{checklist.filter(item => item.checked).length}/{checklist.length}</span><ChevronDown size={15} aria-hidden="true" /></summary>{checklist.map(item => <label key={item.index}><input type="checkbox" checked={item.checked} disabled={readOnly || deleting} onChange={() => store.edit(selected.note.id, { body: toggleNoteChecklist(selected.note.body, item.index) })} /><span>{item.text}</span></label>)}</details>}
          <textarea ref={body} className="notes-editor__body" aria-label={t('Texte de la note')} placeholder={t('Notez ce que vous avez en tête…')} value={selected.note.body} maxLength={50000} readOnly={readOnly || deleting} onChange={event => store.edit(selected.note.id, { body: event.target.value })} />
        </div>
        <footer className="notes-editor__footer"><Button variant="ghost" disabled={readOnly} onClick={addChecklist}><CheckCheck size={19} aria-hidden="true" />{t('Ajouter une case')}</Button><Button variant="ghost" onClick={closeEditor}><Check size={19} aria-hidden="true" />{t('Terminer')}</Button></footer>
      </> : <div className="notes-sheet__empty"><NotebookPen size={42} strokeWidth={1.2} aria-hidden="true" /><h3>{t('Une idée, une mesure, un détail.')}</h3><p>{t('Choisissez une note ou écrivez-en une nouvelle.')}</p><Button variant="secondary" disabled={readOnly} onClick={create}><Plus size={17} aria-hidden="true" />{t('Écrire une note')}</Button></div>}
    </section>
  </section>;
}
