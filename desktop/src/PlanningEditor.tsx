import { t, useAppLanguage } from './language';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProjectMilestone, ProjectTask, Workspace } from './types';
import type { ProjectMilestoneDraft, ProjectTaskDraft } from './ProjectPlanningPanel';
import { initialPlanningDraft, planningFormIssue, planningSaveError, type PlanningErrorHandler, type PlanningFormDraft, type PlanningFormIssue } from './planningForm';
import { Button, Field, FormActions, Modal } from './ui';
import { formatDate } from './utils';
import './planning-editor.css';

export function PlanningEditor({ kind, item, defaultProjectId, workspace, busy, readOnly, onClose, onSave }: {
  kind: 'task' | 'milestone'; item?: ProjectTask | ProjectMilestone; defaultProjectId?: string; workspace: Workspace; busy: boolean; readOnly: boolean;
  onClose: () => void; onSave: (input: ProjectTaskDraft & { status: ProjectMilestoneDraft['status'] }, onError?: PlanningErrorHandler) => Promise<boolean>;
}) {
  useAppLanguage();
  const [draft, setDraft] = useState(() => initialPlanningDraft(workspace, item, defaultProjectId));
  const [issue, setIssue] = useState<PlanningFormIssue>(), [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false), [more, setMore] = useState(Boolean(item?.description || (item?.priority && item.priority !== 'normal')));
  const inFlight = useRef(false), formRef = useRef<HTMLFormElement>(null), errorRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  const change = (field: keyof PlanningFormDraft, value: string) => setDraft(current => ({ ...current, [field]: value, ...(field === 'projectId' ? { milestoneId: '' } : {}) }));
  const fieldError = (field: keyof PlanningFormDraft) => issue?.field === field ? issue.message : undefined;
  useEffect(() => {
    if (locked) return;
    if (saveError) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: 'nearest' }); }
    else if (issue) {
      if (['priority', 'description'].includes(issue.field) && !more) { setMore(true); return; }
      const input = formRef.current?.elements.namedItem(issue.field);
      if (input instanceof HTMLElement) {
        input.focus({ preventScroll: true });
        const field = input.closest('.planning-date-field') || input.closest('.field') || input;
        field.scrollIntoView({ block: 'nearest' });
        // The mobile actions stay pinned over the scrolling body; native
        // scrollIntoView does not reserve their height for a correction button.
        const body = input.closest<HTMLElement>('.modal__body');
        const footer = formRef.current?.querySelector('.form-actions');
        if (body && footer) {
          const bottom = Math.min(body.getBoundingClientRect().bottom, footer.getBoundingClientRect().top);
          body.scrollTop += Math.max(0, field.getBoundingClientRect().bottom - bottom + 12);
        }
      }
    }
  }, [issue, saveError, locked, more]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || readOnly || inFlight.current) return;
    const problem = planningFormIssue(draft, kind, workspace, item); setIssue(problem); setSaveError('');
    if (problem) return;
    inFlight.current = true; setSaving(true);
    try {
      const ok = await onSave({ id: item?.id, projectId: draft.projectId, title: draft.title.trim(), milestoneId: kind === 'task' ? draft.milestoneId || null : null, employeeId: draft.employeeId || null, dueDate: draft.dueDate || null, description: draft.description.trim(), priority: draft.priority, sortOrder: item?.sortOrder ?? 0, status: item?.status ?? 'todo' }, reason => setSaveError(planningSaveError(reason, t("L’enregistrement n’a pas abouti. Vos informations sont conservées."))));
      if (!ok) setSaveError(current => current || t("L’enregistrement est momentanément indisponible. Vos informations sont conservées ; réessayez après la fin de l’action en cours."));
    } catch (reason) { setSaveError(planningSaveError(reason, t("Vos informations sont conservées. Réessayez l’enregistrement."))); }
    finally { inFlight.current = false; setSaving(false); }
  }
  const milestones = workspace.projectMilestones.filter(row => row.projectId === draft.projectId && (['todo', 'in_progress'].includes(row.status) || row.id === draft.milestoneId));
  return <Modal title={item ? (kind === 'task' ? t("Modifier la tâche") : t("Modifier l’étape")) : kind === 'task' ? t("Nouvelle tâche") : t("Nouvelle étape clé")} description={kind === 'task' ? t("Indiquez l’action et son projet. Le reste est facultatif.") : t("Une étape clé regroupe les tâches d’un projet.")} onClose={onClose} dismissible={!locked} className="planning-editor-modal">
    <form ref={formRef} onSubmit={submit} noValidate className="planning-editor">
      {saveError && <div className="planning-form-error" role="alert" tabIndex={-1} ref={errorRef}><strong>{t("L’enregistrement n’a pas abouti")}</strong><p>{saveError}</p></div>}
      <fieldset disabled={locked || readOnly}>
        <div className="form-grid">
          <Field label={kind === 'task' ? t("Que faut-il faire ?") : t("Nom de l’étape")} required wide error={fieldError('title')}><input name="title" value={draft.title} onChange={event => change('title', event.target.value)} maxLength={200} placeholder={kind === 'task' ? t("Ex. Vérifier les mesures") : t("Ex. Livraison au client")} autoFocus /></Field>
          <Field label={t("Projet")} required wide error={fieldError('projectId')}><select name="projectId" value={draft.projectId} disabled={Boolean(item)} onChange={event => change('projectId', event.target.value)}><option value="">{t("Choisir un projet")}</option>{workspace.projects.filter(row => row.status !== 'closed' || row.id === item?.projectId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
          <Field label={t("Personne responsable")} hint={t("Facultatif. Vous pourrez attribuer cette action plus tard.")} wide error={fieldError('employeeId')}><select name="employeeId" value={draft.employeeId} onChange={event => change('employeeId', event.target.value)}><option value="">{t("À attribuer plus tard")}</option>{workspace.employees.filter(row => row.active || row.id === item?.employeeId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
          {kind === 'task' && <Field label={t("Étape du projet")} hint={t("Facultatif. Choisissez une étape pour regrouper ses tâches.")} wide error={fieldError('milestoneId')}><select name="milestoneId" value={draft.milestoneId} onChange={event => change('milestoneId', event.target.value)} disabled={!draft.projectId}><option value="">{t("Sans étape")}</option>{milestones.map(row => <option key={row.id} value={row.id}>{row.title}{['done', 'cancelled'].includes(row.status) ? t(" · à rouvrir") : ''}</option>)}</select></Field>}
          <div className="planning-date-field"><Field label={t("À terminer pour le")} hint={fieldError('dueDate') ? undefined : t("Facultatif. Laissez vide si la date n’est pas encore décidée.")} wide error={fieldError('dueDate')}><input name="dueDate" type="date" value={draft.dueDate} onChange={event => change('dueDate', event.target.value)} /></Field>
          {issue?.suggestedDate && <Button className="planning-date-suggestion" type="button" variant="secondary" onClick={() => { change('dueDate', issue.suggestedDate!); setIssue(undefined); }}>{t('Utiliser le {date}', { date: formatDate(issue.suggestedDate) })}</Button>}</div>
        </div>
        <details open={more} onToggle={event => setMore(event.currentTarget.open)} className="planning-editor-more"><summary>{t("Priorité et précisions")}</summary><div className="form-grid"><Field label={t("Priorité")} wide error={fieldError('priority')}><select name="priority" value={draft.priority} onChange={event => change('priority', event.target.value)}><option value="low">{t("Basse")}</option><option value="normal">{t("Normale")}</option><option value="high">{t("Haute")}</option><option value="urgent">{t("Urgente")}</option></select></Field><Field label={t("Précisions utiles")} wide error={fieldError('description')}><textarea name="description" rows={4} maxLength={20000} value={draft.description} onChange={event => change('description', event.target.value)} placeholder={t("Consignes, matériel à prévoir…")} /></Field></div></details>
      </fieldset>
      <FormActions onCancel={onClose} busy={locked} disabled={readOnly} submitLabel={(kind === 'task' ? t("Enregistrer la tâche") : t("Enregistrer l’étape"))} />
    </form>
  </Modal>;
}
