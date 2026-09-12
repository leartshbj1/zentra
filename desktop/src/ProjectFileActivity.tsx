import { useState, useSyncExternalStore } from 'react';
import type { Project } from './types';
import type { ProjectFileSessions } from './projectFileSessions';
import { Button } from './ui';

export function ProjectFileActivity({ sessions, projects, currentProjectId, onOpen, disabled = false }: {
  sessions: ProjectFileSessions; projects: Project[]; currentProjectId: string | null; onOpen: (id: string) => void; disabled?: boolean;
}) {
  const activity = useSyncExternalStore(sessions.subscribe, sessions.getActivity, sessions.getActivity);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const other = activity.filter(item => item.projectId !== currentProjectId || !projects.some(project => project.id === item.projectId));
  if (!other.length) return null;
  return <aside className="project-file-activity" aria-label="Documents de projet en cours">{other.map(({ projectId, state }) => {
    const project = projects.find(project => project.id === projectId);
    const destination = destinations[projectId] || '';
    return <div key={projectId} className="info-strip">
      <div role="status"><strong>{project?.name || 'Projet indisponible'}</strong><p>{state.saving ? state.progress || 'Enregistrement des documents…' : state.refreshPending ? 'Documents du projet · liste à actualiser' : `${state.files.length} fichier${state.files.length > 1 ? 's' : ''} à ajouter · sélection conservée`}</p></div>
      {project ? <Button variant="secondary" size="small" onClick={() => onOpen(projectId)}>Retrouver les documents</Button> : <div className="project-file-activity__recovery">
        <p>Ce projet n’apparaît plus dans votre espace. Les fichiers sélectionnés sont conservés pendant cette session.</p>
        {!!state.files.length && <details><summary>Voir les fichiers conservés</summary><ul>{state.files.map((file, index) => <li key={index}>{file.name}</li>)}</ul></details>}
        {state.refreshPending ? <><p>{state.error}</p><Button variant="secondary" disabled={state.saving} onClick={() => void sessions.forProject(projectId).refresh()}>Actualiser la liste des projets</Button></> : <>
          <label>Récupérer la sélection dans un projet<select aria-label="Récupérer la sélection dans un projet" value={destination} disabled={disabled || state.saving} onChange={event => { setDestinations(values => ({ ...values, [projectId]: event.target.value })); setError(''); }}><option value="">Choisir un projet</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <Button variant="secondary" disabled={disabled || state.saving || !projects.some(item => item.id === destination)} onClick={() => {
            if (sessions.moveSelection(projectId, destination)) { setError(''); onOpen(destination); }
            else setError('Terminez l’opération en cours dans le projet choisi, puis réessayez. Vos fichiers restent conservés.');
          }}>Déplacer la sélection</Button>
          {!projects.length && <p>Créez un projet dans la rubrique Projets, puis retrouvez ici votre sélection.</p>}
          <small>Les fichiers seront ajoutés seulement lorsque vous choisirez de les enregistrer.</small>
        </>}
      </div>}
    </div>;
  })}{error && <p role="alert">{error}</p>}</aside>;
}
