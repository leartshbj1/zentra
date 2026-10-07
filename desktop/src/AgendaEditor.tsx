import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Workspace } from './types';
import { agendaDuration, agendaFormIssue, agendaGroupText, agendaMerge, agendaNativeIssue, changeAgendaStartDate, eventDraft, type AgendaErrorHandler, type AgendaEventDraft, type AgendaField, type AgendaFormIssue, type AgendaMergeChoice } from './agendaForm';
import { Button, Field, FormActions, Modal } from './ui';
import { errorMessage, formatDate } from './utils';
import './agenda-editor.css';
import { ErrorGuidance } from './ErrorGuidance';
import { t, useAppLanguage } from './language';

export function AgendaEditor({ draft: initial, workspace, busy, readOnly, onClose, onSave }: {
  draft: AgendaEventDraft; workspace: Workspace; busy: boolean; readOnly: boolean; onClose: () => void;
  onSave: (draft: AgendaEventDraft, onError?: AgendaErrorHandler) => Promise<boolean>;
}) {
  useAppLanguage();
  const [base, setBase] = useState(initial), [draft, setDraft] = useState(initial);
  const [issue, setIssue] = useState<AgendaFormIssue>(), [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false), [more, setMore] = useState(Boolean(initial.projectId || initial.employeeId || initial.kind !== 'appointment' || initial.status !== 'scheduled'));
  const [choices, setChoices] = useState<{ revision: string; values: AgendaMergeChoice }>({ revision: '', values: {} });
  const inFlight = useRef(false), formRef = useRef<HTMLFormElement>(null), errorRef = useRef<HTMLDivElement>(null);
  const current = workspace.agendaEvents.find(row => row.id === draft.id);
  const changed = !!current && (base.isNew || current.updatedAt !== base.expectedUpdatedAt);
  const missing = !base.isNew && !current;
  const merge = changed ? agendaMerge(base, draft, current!, choices.revision === current!.updatedAt ? choices.values : {}) : null;
  const locked = busy || saving;
  const disabled = locked || readOnly || changed || missing;
  const fieldError = (field: AgendaField) => issue?.field === field ? t(issue.message) : undefined;
  const change = <K extends keyof AgendaEventDraft>(field: K, value: AgendaEventDraft[K]) => {
    if (disabled) return;
    setDraft(current => field === 'startDate' ? changeAgendaStartDate(current, value as string) : { ...current, [field]: value });
    setIssue(undefined); setSaveError('');
  };
  useEffect(() => {
    if (locked) return;
    if (saveError || changed || missing) { errorRef.current?.focus({preventScroll:true}); errorRef.current?.scrollIntoView({block:'nearest'}); }
    else if (issue) {
      if (['kind','status','projectId','employeeId'].includes(issue.field) && !more) { setMore(true); return; }
      const field = formRef.current?.elements.namedItem(issue.field);
      if (field instanceof HTMLElement) {
        field.focus({preventScroll:true});
        const container = field.closest('.field') || field;
        container.scrollIntoView({block:'nearest'});
        const body = field.closest<HTMLElement>('.modal__body'), footer = formRef.current?.querySelector('.form-actions');
        if (body && footer) body.scrollTop += Math.max(0, container.getBoundingClientRect().bottom - Math.min(body.getBoundingClientRect().bottom, footer.getBoundingClientRect().top) + 12);
      }
    }
  }, [issue, saveError, locked, more, changed, missing]);

  function receiveError(reason: unknown) {
    const problem = agendaNativeIssue(reason);
    setIssue(problem); setSaveError(problem ? '' : errorMessage(reason, 'L’enregistrement n’a pas abouti. Vos informations restent présentes.'));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current) return;
    const problem = agendaFormIssue(draft, workspace, base); setIssue(problem); setSaveError('');
    if (problem) return;
    inFlight.current = true; setSaving(true);
    let explained = false;
    try {
      const ok = await onSave({ ...draft, title: draft.title.trim(), location: draft.location.trim(), notes: draft.notes.trim() }, reason => { explained = true; receiveError(reason); });
      if (ok) onClose();
      else if (!explained) setSaveError('L’enregistrement n’a pas abouti. Vos informations restent présentes ; réessayez après la fin de l’action en cours.');
    } catch (reason) { receiveError(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }

  return <Modal title={t(base.isNew ? 'Nouveau rendez-vous' : 'Modifier le rendez-vous')} description={t('Titre, date et horaire. Le reste est facultatif.')} onClose={onClose} dismissible={!locked} className="agenda-editor-modal">
    <form ref={formRef} className="agenda-guided-editor" onSubmit={submit} noValidate>
      {(changed || missing) && <div className="agenda-form-notice" role="alert" tabIndex={-1} ref={errorRef}>
        <strong>{t(missing ? 'Ce rendez-vous n’existe plus' : changed ? 'Le rendez-vous a changé depuis son ouverture' : 'L’enregistrement n’a pas abouti')}</strong>
        <p>{t(missing ? 'Vos informations restent affichées. Fermez cette fenêtre pour retrouver l’agenda actualisé.' : changed ? 'Votre saisie reste présente. Pour chaque point modifié des deux côtés, choisissez la valeur à conserver.' : saveError)}</p>
        {changed && merge && current && <div className="agenda-merge">
          {merge.conflicts.map(({group,label}) => <fieldset key={`${current.updatedAt}-${group}`} disabled={locked || readOnly}>
            <legend>{t('{label} à conserver', {label:t(label)})}</legend>
            {(['mine','saved'] as const).map(value => <label key={value}><input type="radio" name={`merge-${group}`} checked={choices.revision === current.updatedAt && choices.values[group] === value} onChange={() => setChoices(previous => ({ revision:current.updatedAt, values:{ ...(previous.revision === current.updatedAt ? previous.values : {}), [group]:value } }))} /><span><strong>{t(value === 'mine' ? 'Ma saisie' : 'Version enregistrée')}</strong><span>{agendaGroupText(value === 'mine' ? draft : eventDraft(current),group,workspace)}</span></span></label>)}
          </fieldset>)}
          {!merge.conflicts.length && <p>{t('Vos changements peuvent être réunis avec la version enregistrée.')}</p>}
          <small>{t('Vous pourrez relire le formulaire avant d’enregistrer. Aucun changement n’est envoyé par ce bouton.')}</small>
        </div>}
      </div>}
      {saveError && !changed && !missing && <div tabIndex={-1} ref={errorRef}><ErrorGuidance error={saveError} operation="mutation" compact /></div>}
      <fieldset disabled={disabled} className="agenda-editor-fields">
        <section className="agenda-editor-section"><h3>{t('Votre rendez-vous')}</h3><div className="form-grid">
          <Field label={t('Titre')} required wide error={fieldError('title')}><input name="title" autoFocus maxLength={200} value={draft.title} onChange={event => change('title',event.target.value)} placeholder={t('Ex. Visite chez le client')} /></Field>
          <Field label={t('Lieu')} wide hint={t('Facultatif : adresse, téléphone ou lien de visioconférence.')} error={fieldError('location')}><input name="location" maxLength={500} value={draft.location} onChange={event => change('location',event.target.value)} /></Field>
        </div></section>
        <section className="agenda-editor-section"><h3>{t('Quand ?')}</h3><div className="form-grid">
          <Field label={t('Début')} required error={fieldError('startDate')}><input name="startDate" type="date" value={draft.startDate} onChange={event => change('startDate',event.target.value)} /></Field>
          <Field label={t('Fin')} required hint={t('Gardez le même jour pour un rendez-vous d’une journée.')} error={fieldError('endDate')}><input name="endDate" type="date" value={draft.endDate} onChange={event => change('endDate',event.target.value)} /></Field>
          <label className="agenda-all-day field--wide"><input name="allDay" type="checkbox" checked={draft.allDay} onChange={event => change('allDay',event.target.checked)} /><span>{t('Toute la journée')}</span></label>
          {!draft.allDay && <><Field label={t('Heure de début')} required error={fieldError('startTime')}><input name="startTime" type="time" value={draft.startTime || ''} onChange={event => change('startTime',event.target.value)} /></Field><Field label={t('Heure de fin')} required error={fieldError('endTime')}><input name="endTime" type="time" value={draft.endTime || ''} onChange={event => change('endTime',event.target.value)} /></Field><div className="agenda-duration field--wide" role="group" aria-label={t('Définir la durée')}><span>{t('Durée depuis le début')}</span>{([15,30,60,120] as const).map(minutes => <Button type="button" key={minutes} variant="secondary" size="small" onClick={() => { const next = agendaDuration(draft,minutes); if (next) { setDraft(next); setIssue(undefined); setSaveError(''); } else setIssue({field:'startTime',message:'Renseignez la date et l’heure de début avant de choisir une durée.'}); }}>{minutes < 60 ? `${minutes} min` : `${minutes/60} h`}</Button>)}</div></>}
        </div><p className="agenda-time-summary">{draft.allDay ? t('Journée entière') : `${draft.startTime || t('Heure à compléter')} – ${draft.endTime || t('heure à compléter')}`}{draft.startDate && draft.endDate && draft.startDate !== draft.endDate ? ` · ${t('du {start} au {end}', {start:formatDate(draft.startDate),end:formatDate(draft.endDate)})}` : ''}</p></section>
        <section className="agenda-editor-section"><Field label={t('Notes')} wide error={fieldError('notes')} hint={t('Facultatif. Les retours à la ligne sont conservés.')}><textarea name="notes" rows={3} maxLength={20000} value={draft.notes} onChange={event => change('notes',event.target.value)} placeholder={t('À préparer, matériel à apporter…')} /></Field></section>
        <details open={more} onToggle={event => setMore(event.currentTarget.open)} className="agenda-editor-more"><summary>{t('Projet, responsable et autres options')}</summary><div className="form-grid">
          <Field label={t('Projet lié')} error={fieldError('projectId')}><select name="projectId" value={draft.projectId || ''} onChange={event => change('projectId',event.target.value || null)}><option value="">{t('Aucun projet')}</option>{draft.projectId && !workspace.projects.some(row => row.id === draft.projectId) && <option value={draft.projectId}>{t('Projet indisponible · à corriger')}</option>}{workspace.projects.filter(row => row.status !== 'closed' || row.id === draft.projectId).map(row => <option key={row.id} value={row.id}>{row.name}{row.status === 'closed' ? ` · ${t('fermé')}` : ''}</option>)}</select></Field>
          <Field label={t('Responsable')} error={fieldError('employeeId')}><select name="employeeId" value={draft.employeeId || ''} onChange={event => change('employeeId',event.target.value || null)}><option value="">{t('Non attribué')}</option>{draft.employeeId && !workspace.employees.some(row => row.id === draft.employeeId) && <option value={draft.employeeId}>{t('Personne indisponible · à corriger')}</option>}{workspace.employees.filter(row => row.active || row.id === draft.employeeId).map(row => <option key={row.id} value={row.id}>{row.name}{row.active ? '' : ` · ${t('inactif')}`}</option>)}</select></Field>
          <Field label={t('Type')} error={fieldError('kind')}><select name="kind" value={draft.kind} onChange={event => change('kind',event.target.value as AgendaEventDraft['kind'])}><option value="appointment">{t('Rendez-vous')}</option><option value="visit">{t('Visite / intervention')}</option><option value="deadline">{t('Échéance personnelle')}</option><option value="other">{t('Autre')}</option></select></Field>
          <Field label={t('État')} error={fieldError('status')}><select name="status" value={draft.status} onChange={event => change('status',event.target.value as AgendaEventDraft['status'])}><option value="scheduled">{t('Planifié')}</option><option value="completed">{t('Terminé')}</option><option value="cancelled">{t('Annulé')}</option></select></Field>
        </div></details>
      </fieldset>
      {changed && merge && current ? <div className="form-actions agenda-merge-actions">
        {!merge.resolved && <p role="status">{t('Choisissez une valeur pour chaque point, puis continuez.')}</p>}
        <Button type="button" variant="secondary" disabled={locked} onClick={onClose}>{t('Annuler')}</Button>
        <Button type="button" disabled={locked || readOnly || !merge.resolved} onClick={() => { setBase(eventDraft(current)); setDraft(merge.merged); setChoices({revision:'',values:{}}); setSaveError(''); setIssue(undefined); }}>{t('Utiliser ces informations')}</Button>
      </div> : <FormActions onCancel={onClose} busy={locked} disabled={readOnly || missing} submitLabel="Enregistrer le rendez-vous" />}
    </form>
  </Modal>;
}
