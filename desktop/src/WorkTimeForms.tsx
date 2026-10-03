import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Clock3 } from 'lucide-react';
import { desktopApi } from './bridge';
import { payrollDecimal } from './payrollSalaryEntry';
import { initialTimeEntryDraft, timeEntryInput, timeEntryIssue, workedMinutes, type TimeEntryDraft, type TimeEntryIssue } from './timeEntryForm';
import type { TimeEntry, Workspace } from './types';
import { Button, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatMinutes, formatMoney, todayIso } from './utils';
import { FormDraftNotice, useFormDraft, useFormDraftScope } from './useFormDraft';
import { draftStrings, formDraftFingerprint } from './formDrafts';
import { WorkspaceCreationOutcomeUnknownError } from './workspaceCreation';
import { ErrorDetails, ErrorGuidance } from './ErrorGuidance';
import { useAppLanguage, type AppLanguage } from './language';
import './work-time-forms.css';

type Props = {
  item?: TimeEntry; workspace: Workspace; busy: boolean; close: () => void;
  act: (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
};
export function TimeForm(props: Props) { return <WorkTimeForm {...props} timer={false} />; }
export function TimerForm(props: Props) { return <WorkTimeForm {...props} timer />; }
const timeDraftFields = ['projectId', 'taskId', 'employeeId', 'date', 'hours', 'minutes', 'breakMinutes', 'billable', 'billingRate', 'costRate', 'status', 'note'] as const;
const validTimeDraft = (value: unknown): value is TimeEntryDraft => draftStrings(value, timeDraftFields, 5000) && Object.keys(value).length === timeDraftFields.length && ['', 'yes', 'no'].includes(value.billable);
type CreationTimeDraft = TimeEntryDraft & { creationId?: string };
const creationUuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const validCreationTimeDraft = (value: unknown): value is CreationTimeDraft => {
  if (validTimeDraft(value)) return true; // Preserve legacy fields, but never silently assign a new identity.
  return draftStrings(value, timeDraftFields, 5000) && Object.keys(value).length === timeDraftFields.length + 1 &&
    ['', 'yes', 'no'].includes(value.billable) && typeof value.creationId === 'string' && creationUuid.test(value.creationId);
};
const TIME_CREATION_UNCONFIRMED = 'La création des heures n’est pas confirmée.';
const timeCreationRecovery: Record<AppLanguage, { title: string; message: string; instruction: string }> = {
  fr: {
    title: 'Enregistrement des heures à vérifier',
    message: 'La création de ces heures n’a pas été confirmée. Votre brouillon est conservé.',
    instruction: 'Vérifiez l’historique des heures avant toute nouvelle saisie. Si ces heures sont déjà enregistrées, ouvrez leur fiche pour les contrôler ou les modifier.',
  },
  de: {
    title: 'Zeiterfassung prüfen',
    message: 'Die Erstellung dieses Zeiteintrags wurde nicht bestätigt. Ihr Entwurf bleibt gespeichert.',
    instruction: 'Prüfen Sie die erfassten Zeiten vor einem neuen Eintrag. Wenn diese Stunden bereits gespeichert sind, öffnen Sie den Eintrag, um ihn zu prüfen oder zu bearbeiten.',
  },
  it: {
    title: 'Verifica la registrazione delle ore',
    message: 'La creazione di queste ore non è stata confermata. La bozza è conservata.',
    instruction: 'Controlla lo storico delle ore prima di una nuova registrazione. Se queste ore sono già registrate, apri la loro scheda per verificarle o modificarle.',
  },
  en: {
    title: 'Check the time entry',
    message: 'The creation of this time entry has not been confirmed. Your draft is retained.',
    instruction: 'Check the time entry history before creating another entry. If these hours are already recorded, open their entry to review or edit them.',
  },
};

function WorkTimeForm({ item, workspace, busy, close, act, timer }: Props & { timer: boolean }) {
  const recovery = timeCreationRecovery[useAppLanguage()];
  const current = item ? workspace.timeEntries.find(row => row.id === item.id) : undefined;
  const manualCreation = !timer && !item;
  const [creationId] = useState(() => manualCreation ? createId() : undefined);
  const initial: CreationTimeDraft = { ...initialTimeEntryDraft(current), date: current?.date || todayIso(), ...(manualCreation ? { creationId } : {}) };
  const persisted = useFormDraft<CreationTimeDraft>({ scope: useFormDraftScope(workspace, timer ? 'timer' : 'time', item?.id),
    initial, fingerprint: current ? formDraftFingerprint(current) : item ? 'missing' : 'new', validate: manualCreation ? validCreationTimeDraft : validTimeDraft });
  const draft = persisted.value, setDraft = persisted.setValue;
  const legacyCreation = manualCreation && !draft.creationId;
  const closeForm = () => persisted.close(close);
  const [issue, setIssue] = useState<TimeEntryIssue>();
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false), formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  const change = (field: keyof TimeEntryDraft, value: string) => setDraft(current => ({ ...current, [field]: value }));
  const prepareNewLegacyCreation = () => {
    if (!legacyCreation || !creationId || locked || persisted.pending || persisted.conflict || persisted.invalid) return;
    // This explicit choice follows the history notice. The token is attached once,
    // then remains unchanged for every retry, edit and restored creation draft.
    setDraft(previous => ({ ...previous, creationId }));
    setSaveError(''); setIssue(undefined);
  };
  const fieldError = (field: keyof TimeEntryDraft) => issue?.field === field ? issue.message : undefined;
  const focusIssue = (field: keyof TimeEntryDraft) => {
    const input = formRef.current?.elements.namedItem(field);
    if (input instanceof HTMLElement) { input.focus(); input.scrollIntoView({ block: 'nearest' }); }
  };
  useEffect(() => {
    if (locked) return;
    if (saveError && errorRef.current) {
      errorRef.current.focus(); errorRef.current.scrollIntoView({ block: 'nearest' });
    } else if (issue) focusIssue(issue.field);
  }, [saveError, issue, locked]);
  const duration = workedMinutes(draft.hours, draft.minutes);
  const cost = payrollDecimal(draft.costRate), rate = payrollDecimal(draft.billingRate);
  const tasks = workspace.projectTasks.filter(task => task.projectId === draft.projectId && (!['done', 'cancelled'].includes(task.status) || task.id === item?.taskId));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || inFlight.current || persisted.pending || persisted.conflict || persisted.invalid || legacyCreation || (item && !current)) return;
    const originWorkspaceScope = workspace.workNotesScope;
    if (manualCreation && persisted.storageError) {
      setSaveError('Cette nouvelle saisie ne peut pas être conservée sur cet appareil. Réessayez sa sauvegarde locale avant d’enregistrer les heures.');
      return;
    }
    const problem = timeEntryIssue(draft, workspace, item, timer);
    setIssue(problem); setSaveError('');
    if (problem) return;
    inFlight.current = true; setSaving(true);
    try {
      const data = timeEntryInput(draft);
      const saved = await act(() => timer ? desktopApi.startTimer({
        projectId: data.projectId, taskId: data.taskId, employeeId: data.employeeId,
        billable: data.billable, billingRateCents: data.billingRateCents, costRateCents: data.costRateCents, note: data.note,
      }) : item ? desktopApi.updateEntity('timeEntries', item.id, data, originWorkspaceScope) : desktopApi.createEntity('timeEntries', { ...data, id: draft.creationId! }, originWorkspaceScope).catch(reason => {
        if (reason instanceof WorkspaceCreationOutcomeUnknownError) {
          // WorkspaceApp can resolve this generic error by ID alone. A delayed
          // attempt may have different fields, so keep this manual draft intact.
          throw new Error(TIME_CREATION_UNCONFIRMED, { cause: reason });
        }
        throw reason;
      }),
      timer ? 'Le pointage a démarré.' : item ? 'La saisie de temps a été mise à jour.' : 'Les heures ont été enregistrées.', true,
      reason => setSaveError(errorMessage(reason, 'Les heures n’ont pas pu être enregistrées. Vos informations sont conservées.')));
      persisted.complete(saved);
      if (!saved) setSaveError(current => current || 'L’enregistrement n’est pas disponible pour le moment. Vos informations sont conservées ; réessayez après avoir terminé l’action en cours.');
    } catch (reason) {
      setSaveError(errorMessage(reason, 'L’enregistrement a été interrompu. Vos informations sont conservées.'));
    } finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={timer ? 'Démarrer un pointage' : item ? 'Modifier les heures' : 'Saisir des heures'} description={timer ? 'Le chronomètre mesure le temps. Vous pourrez vérifier les heures après l’arrêt.' : 'Choisissez qui a travaillé, indiquez la durée et vérifiez le montant.'} onClose={closeForm} dismissible={!locked} className="work-time-modal">
    <form ref={formRef} onSubmit={submit} noValidate>
      <FormDraftNotice draft={persisted} disabled={locked} currentValues={current ? [{ label: 'Projet', value: workspace.projects.find(row => row.id === current.projectId)?.name || current.projectId }, { label: 'Collaborateur', value: workspace.employees.find(row => row.id === current.employeeId)?.name || current.employeeId }, { label: 'Date', value: current.date }, { label: 'Durée', value: formatMinutes(current.minutes) }, { label: 'Pause', value: String(current.breakMinutes) }, { label: 'Travail effectué', value: current.note }, { label: 'Coût entreprise', value: formatMoney(current.hourlyCostCents) }, { label: 'Prix pour le client', value: formatMoney(current.billingRateCents ?? 0) }, { label: 'Statut', value: current.status }] : undefined} />
      {legacyCreation && !persisted.pending && <div className="work-time-error" role="status"><p>Ce brouillon ne permet pas de retrouver une ancienne création. Vérifiez l’historique des heures avant de préparer une nouvelle saisie.</p><Button type="button" disabled={locked || persisted.conflict || persisted.invalid || !creationId} onClick={prepareNewLegacyCreation}>Préparer une nouvelle saisie</Button></div>}
      {saveError && <div ref={errorRef} tabIndex={-1} className="work-time-error">{saveError === TIME_CREATION_UNCONFIRMED
        ? <div className="error-panel error-guidance error-guidance--compact"><div role="alert" data-time-creation-recovery><strong>{recovery.title}</strong><p>{recovery.message}</p><p className="error-guidance__recovery">{recovery.instruction}</p></div><ErrorDetails error={saveError} /></div>
        : <ErrorGuidance error={saveError} operation="mutation" compact />}</div>}
      {issue && <div className="work-time-error" role="alert"><strong>Un point à compléter</strong><p>{issue.message}</p><Button type="button" variant="secondary" size="small" onClick={() => focusIssue(issue.field)}>Corriger ce champ</Button></div>}
      <fieldset disabled={locked || !!persisted.pending || persisted.conflict || persisted.invalid || legacyCreation || !!(item && !current)} className="work-time-fields">
        <section className="work-time-section"><h3>Qui a travaillé ?</h3><div className="form-grid">
          <Field label="Projet" required wide error={fieldError('projectId')}><select name="projectId" value={draft.projectId} onChange={event => setDraft(current => ({ ...current, projectId: event.target.value, taskId: '' }))} required autoFocus><option value="">Choisir un projet</option>{workspace.projects.filter(project => project.status !== 'closed' || project.id === item?.projectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
          <Field label="Collaborateur" required wide error={fieldError('employeeId')}><select name="employeeId" value={draft.employeeId} onChange={event => {
            const employee = workspace.employees.find(row => row.id === event.target.value);
            setDraft(current => ({ ...current, employeeId: event.target.value, costRate: employee?.hourlyCostCents ? (employee.hourlyCostCents / 100).toFixed(2) : '' }));
          }} required><option value="">Choisir un collaborateur</option>{workspace.employees.filter(employee => employee.active || employee.id === item?.employeeId).map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></Field>
          {(tasks.length > 0 || draft.taskId) && <Field label="Tâche liée" hint="Facultatif : pour retrouver ce travail dans le planning." wide error={fieldError('taskId')}><select name="taskId" value={draft.taskId} onChange={event => change('taskId', event.target.value)}><option value="">Sans tâche précise</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></Field>}
        </div></section>
        {!timer && <section className="work-time-section"><h3>Combien de temps ?</h3><p>Indiquez le temps effectivement travaillé, hors pause. Par exemple : 7 heures et 30 minutes.</p><div className="form-grid">
          <Field label="Date du travail" required wide error={fieldError('date')}><input name="date" type="date" value={draft.date} onChange={event => change('date', event.target.value)} required /></Field>
          <Field label="Heures travaillées" error={fieldError('hours')}><input name="hours" inputMode="numeric" value={draft.hours} placeholder="0" onChange={event => change('hours', event.target.value)} /></Field>
          <Field label="Minutes supplémentaires" hint="De 0 à 59 minutes." error={fieldError('minutes')}><input name="minutes" inputMode="numeric" value={draft.minutes} onChange={event => change('minutes', event.target.value)} /></Field>
          <Field label="Pause (minutes)" hint="La pause est conservée séparément. Laissez 0 si aucune pause n’a été prise." error={fieldError('breakMinutes')} wide><input name="breakMinutes" inputMode="numeric" value={draft.breakMinutes} onChange={event => change('breakMinutes', event.target.value)} /></Field>
        </div></section>}
        <section className="work-time-section"><h3>Coût et facturation</h3><div className="form-grid">
          <Field label="Facturer ce temps au client ?" required wide error={fieldError('billable')}><select name="billable" value={draft.billable} onChange={event => change('billable', event.target.value)} required><option value="">Choisir</option><option value="yes">Oui, à facturer au client</option><option value="no">Non, travail interne</option></select></Field>
          {draft.billable === 'yes' && <Field label="Prix pour le client (CHF/h)" required hint="Le tarif de vente pour une heure, hors TVA." error={fieldError('billingRate')} wide><input name="billingRate" inputMode="decimal" placeholder="Ex. 95,50" value={draft.billingRate} onChange={event => change('billingRate', event.target.value)} /></Field>}
          <Field label="Coût pour l’entreprise (CHF/h)" required hint="Prérempli si le coût est renseigné sur la fiche du collaborateur. Ajustez-le si nécessaire ; ce montant sert à calculer votre rentabilité." error={fieldError('costRate')} wide><input name="costRate" inputMode="decimal" placeholder="Ex. 45,00" value={draft.costRate} onChange={event => change('costRate', event.target.value)} /></Field>
          {!timer && <Field label="Vérification des heures" required wide hint={draft.status === 'entered' ? 'Vous pouvez enregistrer maintenant et vérifier plus tard. Ces heures ne seront pas encore proposées à la facturation.' : draft.status === 'approved' ? 'Les heures facturables avec un tarif seront proposées pour créer une facture.' : 'Ces heures restent exclues de la facturation tant qu’elles sont verrouillées.'} error={fieldError('status')}><select name="status" value={draft.status} onChange={event => change('status', event.target.value)}><option value="entered">À vérifier</option><option value="approved">Approuvées</option><option value="locked">Verrouillées</option></select></Field>}
          <Field label="Travail effectué" wide hint="Facultatif : une description utile pour vous et pour la facture." error={fieldError('note')}><textarea name="note" rows={3} maxLength={5000} value={draft.note} onChange={event => change('note', event.target.value)} /></Field>
        </div></section>
      </fieldset>
      {!timer && duration !== undefined && <section className="work-time-summary" aria-label="Résumé des heures" aria-live="polite"><div><Clock3 size={18} /><strong>{formatMinutes(duration)}</strong><span>à enregistrer</span></div>{cost !== undefined && Number.isSafeInteger(duration * cost + 30) && <div><span>Coût entreprise</span><strong>{formatMoney(Math.round(duration * cost / 60))}</strong></div>}{draft.billable === 'yes' && rate !== undefined && Number.isSafeInteger(duration * rate + 30) && <div><span>À facturer hors TVA</span><strong>{formatMoney(Math.round(duration * rate / 60))}</strong></div>}</section>}
      <FormActions onCancel={closeForm} busy={locked} disabled={!!persisted.pending || persisted.conflict || persisted.invalid || legacyCreation || manualCreation && persisted.storageError || !!(item && !current)} submitLabel={timer ? 'Démarrer le chronomètre' : 'Enregistrer les heures'} />
    </form>
  </Modal>;
}
