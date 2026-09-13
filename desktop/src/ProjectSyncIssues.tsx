import { projectFileSyncIssue } from './projectSyncPresentation';
import type { ProjectSyncStatus } from './projectSync';
import type { Attachment } from './types';
import { Button } from './ui';
import './ProjectSyncIssues.css';

export function ProjectSyncIssues({ sync, projectId, files, readOnly, busy, onRepair }: {
  sync: ProjectSyncStatus; projectId: string; files: Attachment[]; readOnly: boolean; busy: boolean; onRepair: () => void;
}) {
  const issues = sync.documents.filter(item => item.project_id === projectId && item.state !== 'synced' && item.last_error);
  if (!issues.length) return null;
  return <details className="project-sync-issues" open>
    <summary>{issues.length} document{issues.length > 1 ? 's' : ''} à vérifier</summary>
    <ul>{issues.map(item => {
      const file = files.find(file => file.id === item.document_id);
      const issue = projectFileSyncIssue(item.last_error!);
      return <li key={item.document_id}>
        <strong>{file?.originalName || (item.state === 'delete' ? 'Suppression d’un document' : 'Document du projet')}</strong>
        <span>{item.state === 'delete' ? 'Suppression à transmettre' : issue.title}</span>
        <p>{issue.explanation}</p>
        {issue.repair && item.state === 'upload' && <>{readOnly
          ? <p>Demandez à une personne autorisée à modifier ce dossier de réimporter l’original.</p>
          : <Button variant="secondary" size="small" disabled={busy} onClick={onRepair}>Ajouter le fichier original</Button>}</>}
      </li>;
    })}</ul>
  </details>;
}
