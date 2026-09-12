import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RecurringDocumentOrder, RecurringDocumentSchedule, RecurringDocumentScheduleUpdateInput } from './RecurringDocumentsPanel';
import { recurringEndDateIssue, recurringEndDateOutcome } from './recurrenceCalendar';
import { RecurringCalendarPreview } from './RecurringCalendarPreview';
import { Button, Field, FormActions, Modal } from './ui';
import { createId, errorMessage, formatDate } from './utils';

export function RecurringScheduleEditor({ mode, order, schedule, today, busy, readOnly, onClose, onSave }: {
  mode: 'endDate' | 'finish'; order: RecurringDocumentOrder; schedule: RecurringDocumentSchedule; today: string; busy: boolean; readOnly: boolean;
  onClose: () => void; onSave: (input: RecurringDocumentScheduleUpdateInput) => Promise<void> | void;
}) {
  const [endDate, setEndDate] = useState(schedule.endDate || '');
  const [error, setError] = useState(''), [showIssue, setShowIssue] = useState(false), [saving, setSaving] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null), inFlight = useRef(false), errorRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const locked = busy || saving;
  const issue = mode === 'endDate' ? recurringEndDateIssue(schedule, endDate) : null;
  const outcome = recurringEndDateOutcome(schedule, endDate || null);
  const completes = mode === 'finish' || outcome.completed;
  const unchanged = mode === 'endDate' && (endDate || null) === schedule.endDate;
  useEffect(() => {
    if (!locked && error) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: 'nearest' }); }
    else if (!locked && showIssue && issue) { inputRef.current?.focus(); inputRef.current?.closest('.field')?.scrollIntoView({ block: 'center' }); }
  }, [error, showIssue, issue?.message, locked]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || readOnly || unchanged || inFlight.current) return;
    setError(''); setShowIssue(true);
    if (issue) return;
    if (schedule.status === 'completed' || schedule.sourceSalesOrderId !== order.id) { setError('Cette planification a changé. Fermez cette fenêtre pour vérifier son état.'); return; }
    const payload = { scheduleId: schedule.id, status: mode === 'finish' ? 'completed' as const : outcome.status, endDate: mode === 'finish' ? schedule.endDate : endDate || null };
    const key = JSON.stringify(payload);
    if (request.current?.key !== key) request.current = { key, id: createId() };
    inFlight.current = true; setSaving(true);
    try { await onSave({ ...payload, requestId: request.current.id }); onClose(); }
    catch (reason) { setError(errorMessage(reason, 'La modification n’a pas été enregistrée. Votre choix reste présent ; réessayez.')); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={mode === 'finish' ? 'Terminer cette planification' : 'Modifier la date de fin'} description={`${order.number} · ${order.clientName}`} className="recurring-editor-modal" dismissible={!locked} onClose={onClose}>
    <form className="recurring-editor" onSubmit={submit} noValidate>
      {error && <div role="alert" tabIndex={-1} ref={errorRef} className="recurring-editor__error"><strong>Vérifions ce point</strong><p>{error}</p></div>}
      <fieldset disabled={locked || readOnly}>
        {mode === 'endDate' && <><Field label="Dernière date autorisée" hint="Laissez vide pour continuer sans date de fin. Les dates sont incluses jusqu’à ce jour." error={showIssue ? issue?.message : undefined}><input ref={inputRef} name="recurringEndDate" type="date" value={endDate} onChange={event => { setEndDate(event.target.value); setShowIssue(false); setError(''); }} /></Field>
          {showIssue && issue?.minimum && <Button variant="secondary" onClick={() => { setEndDate(issue.minimum!); setShowIssue(false); }}>Utiliser le {formatDate(issue.minimum)}</Button>}
        </>}
        {completes ? <div className="recurring-editor__outcome" role="note"><strong>La planification sera terminée définitivement.</strong><p>Aucun nouveau brouillon ne sera préparé. L’historique des {schedule.occurrences.length} facture{schedule.occurrences.length !== 1 ? 's' : ''} déjà préparée{schedule.occurrences.length !== 1 ? 's' : ''} reste disponible, avec leur état actuel.</p><p>{schedule.status === 'active' ? 'Pour une interruption temporaire, annulez cette fenêtre puis choisissez « Mettre en pause ».' : 'Annulez cette fenêtre pour conserver l’état actuel de la planification.'}</p></div> : <p className="recurring-editor__outcome">{outcome.status === 'paused' ? 'La planification restera en pause. Vous pourrez la reprendre après avoir contrôlé les factures.' : endDate ? 'La planification restera active jusqu’à la date choisie.' : 'La planification restera active sans date de fin.'} Les factures déjà préparées restent présentes.</p>}
        {mode === 'endDate' && !issue && <RecurringCalendarPreview startDate={schedule.startDate} nextDate={schedule.nextOccurrenceOn || undefined} endDate={endDate || null} frequency={schedule.frequency} paymentTermsDays={schedule.paymentTermsDays} today={today} showCatchUp={false} />}
      </fieldset>
      <FormActions onCancel={onClose} busy={locked || readOnly} disabled={unchanged} submitLabel={mode === 'finish' ? 'Terminer la planification' : completes ? 'Enregistrer et terminer' : 'Enregistrer la date de fin'} />
    </form>
  </Modal>;
}
