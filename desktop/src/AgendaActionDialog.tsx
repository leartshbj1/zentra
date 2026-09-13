import { useRef, useState } from 'react';
import { eventDraft, type AgendaErrorHandler, type AgendaEventDraft } from './agendaForm';
import type { AgendaEvent, Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, formatDate } from './utils';
import './agenda-editor.css';

export function AgendaActionDialog({ event, action, workspace, busy, readOnly, onClose, onSave, onDelete }: {
  event: AgendaEvent; action: 'complete' | 'delete'; workspace: Workspace; busy: boolean; readOnly: boolean;
  onClose: () => void; onSave: (draft: AgendaEventDraft, onError?: AgendaErrorHandler) => Promise<boolean>;
  onDelete: (event: AgendaEvent, onError?: AgendaErrorHandler) => Promise<boolean>;
}) {
  const [reviewed, setReviewed] = useState(event), [error, setError] = useState(''), [saving,setSaving] = useState(false);
  const inFlight = useRef(false);
  const current = workspace.agendaEvents.find(row => row.id === event.id);
  const changed = !!current && current.updatedAt !== reviewed.updatedAt;
  const done = action === 'complete' && current?.status !== 'scheduled';
  const locked = busy || saving;
  async function confirm() {
    if (locked || readOnly || inFlight.current || !current || changed || done) return;
    inFlight.current = true; setSaving(true); setError('');
    let explained = false;
    const failed = (reason: unknown) => { explained = true; setError(errorMessage(reason,'L’action n’a pas abouti. Réessayez.')); };
    try {
      const ok = action === 'delete' ? await onDelete(reviewed,failed) : await onSave({...eventDraft(reviewed),status:'completed'},failed);
      if (ok) onClose(); else if (!explained) setError('L’action n’a pas abouti. Vérifiez le rendez-vous puis réessayez.');
    } catch (reason) { failed(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={action === 'delete' ? 'Supprimer ce rendez-vous ?' : 'Terminer ce rendez-vous ?'} description={action === 'delete' ? 'Le rendez-vous sera retiré de l’agenda. Son projet et ses documents seront conservés.' : 'Il sera classé parmi les rendez-vous terminés. Cette action ne valide ni facture, ni paiement, ni salaire.'} onClose={onClose} dismissible={!locked} className="agenda-action-dialog">
    <div className="agenda-action-summary"><strong>{reviewed.title}</strong><p>{formatDate(reviewed.startDate)}{reviewed.endDate !== reviewed.startDate ? ` – ${formatDate(reviewed.endDate)}` : ''} · {reviewed.allDay ? 'Toute la journée' : `${reviewed.startTime} – ${reviewed.endTime}`}</p>{reviewed.location && <p>{reviewed.location}</p>}{reviewed.notes && <p style={{whiteSpace:'pre-wrap'}}>{reviewed.notes}</p>}</div>
    {error && <div className="agenda-form-notice" role="alert"><strong>L’action n’a pas abouti</strong><p>{error}</p></div>}
    {!current ? <p role="status">Ce rendez-vous n’est plus dans l’agenda. Vous pouvez fermer cette fenêtre.</p> : changed ? <div className="agenda-form-notice" role="alert"><strong>Le rendez-vous a changé</strong><p>Relisez sa version actuelle avant de confirmer cette action.</p><Button variant="secondary" disabled={locked} onClick={() => {setReviewed(current);setError('');}}>Relire le rendez-vous</Button></div> : done ? <p role="status">Ce rendez-vous est déjà terminé ou annulé. Retrouvez-le avec « Afficher terminés / annulés ».</p> : null}
    {readOnly && <p role="status">Mode lecture seule : cette action n’est pas disponible.</p>}
    <div className="form-actions"><Button variant="secondary" disabled={locked} onClick={onClose}>{!current || done ? 'Fermer' : 'Annuler'}</Button><Button disabled={locked || readOnly || !current || changed || done} onClick={() => void confirm()}>{locked ? 'Traitement…' : action === 'delete' ? 'Supprimer le rendez-vous' : 'Marquer comme terminé'}</Button></div>
  </Modal>;
}
