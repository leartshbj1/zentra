import { useEffect, useRef, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import { desktopApi } from './bridge';
import { holdBusinessActivity } from './businessWorkspaceLock';
import { Button, ErrorPanel, Field } from './ui';
import { createId, errorMessage, formatDate, formatMinutes, formatMoney } from './utils';
import type { PreservedTimer, TimerAssignment, TimerRecoveryState } from './timerRecovery';
import type { Workspace } from './types';
import './TimerRecoveryPanel.css';

type Act = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
export function TimerRecoveryPanel({ workspace, disabled, act }: { workspace: Workspace; disabled: boolean; act: Act }) {
  const [state, setState] = useState<TimerRecoveryState>();
  const [loadedFor, setLoadedFor] = useState<{ workspace: Workspace; attempt: number }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState<{ id: string; sha: string }>();
  const [editing, setEditing] = useState<PreservedTimer>();
  const [assignment, setAssignment] = useState<TimerAssignment>({ projectId: '', taskId: null, employeeId: null });
  const inFlight = useRef(false);
  const loading = loadedFor?.workspace !== workspace || loadedFor?.attempt !== attempt;
  useEffect(() => {
    let current = true;
    desktopApi.getTimerRecoveryState().then(next => {
      if (current) {
        setState(next); setLoadError('');
        if (!next.active || !next.resolutionPending) setConfirm(undefined);
        setEditing(previous => previous && next.pending.some(item => item.id === previous.id) ? previous : undefined);
      }
    }).catch(cause => {
      if (current) setLoadError(errorMessage(cause, 'Les pointages conservés ne peuvent pas être chargés.'));
    }).finally(() => { if (current) setLoadedFor({ workspace, attempt }); });
    return () => { current = false; };
  }, [workspace, attempt]);
  useEffect(() => {
    if (confirm || editing || working) return holdBusinessActivity();
  }, [confirm, editing, working]);
  const unavailable = disabled || loading || working || Boolean(loadError);
  const run = async (action: () => Promise<Workspace>, message: string) => {
    if (unavailable || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError('');
    try {
      if (await act(action, message, false, cause => setError(errorMessage(cause, 'Le pointage reste conservé. Réessayez.')))) {
        setConfirm(undefined);
        setEditing(undefined);
      }
    } finally {
      setWorking(false);
      inFlight.current = false;
      setAttempt(value => value + 1);
    }
  };
  const select = (item: PreservedTimer) => {
    setEditing(item);
    const projectId = workspace.projects.some(p => p.id === item.originalProjectId && p.status !== 'closed') ? item.originalProjectId : '';
    setAssignment({ projectId,
      taskId: workspace.projectTasks.some(t => t.id === item.originalTaskId && t.projectId === projectId) ? item.originalTaskId : null,
      employeeId: workspace.employees.some(e => e.id === item.originalEmployeeId) ? item.originalEmployeeId : null });
  };
  const needsPreservation = state?.resolutionPending && state.active;
  if (!error && !loadError && !needsPreservation && !state?.pending.length) return null;
  const projects = workspace.projects.filter(p => p.status !== 'closed');
  const validProject = projects.some(p => p.id === assignment.projectId);
  const tasks = workspace.projectTasks.filter(t => t.projectId === assignment.projectId);
  const currency = workspace.settings?.billing.currency ?? 'CHF';
  return <section className="panel timer-recovery" aria-label="Pointages conservés" aria-busy={working || loading}>
    <header><Clock3 size={22} aria-hidden="true" /><div><h2>Pointages conservés</h2><p>Retrouvez le temps mis en attente pendant une résolution.</p></div>
      <Button variant="secondary" size="small" disabled={loading || working} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} /> Actualiser</Button>
    </header>
    {error && <ErrorPanel message={error} />}
    {loadError && <ErrorPanel message={loadError} />}
    {needsPreservation && <div className="timer-recovery__notice">
      <strong>Un chronomètre accompagne la résolution en cours</strong>
      <p>{workspace.projects.find(project => project.id === state.active?.projectId)?.name ?? 'Projet du pointage'} · depuis le {formatDate(state.active!.startedAt.slice(0, 10))}</p>
      <p>Arrêtez-le et conservez sa durée, sa note et ses tarifs ici. Vous pourrez ensuite affecter ces heures au projet retenu.</p>
      {confirm ? <div className="timer-recovery__confirmation"><p>Le chronomètre s’arrêtera à la confirmation. Son pointage restera enregistré sur cet appareil.</p>
        {confirm.sha !== state.active?.sha256 && <output>Le chronomètre a changé. Annulez cette confirmation pour relire le pointage.</output>}
        <div className="form-actions"><Button disabled={unavailable || confirm.sha !== state.active?.sha256} onClick={() => void run(() => desktopApi.preserveActiveTimer(confirm.id, confirm.sha), 'Pointage arrêté et conservé. Vous pourrez l’affecter après la résolution.')}>Arrêter et conserver</Button><Button variant="secondary" disabled={working} onClick={() => setConfirm(undefined)}>Annuler</Button></div>
      </div> : <Button variant="secondary" disabled={unavailable} onClick={() => setConfirm({ id: createId(), sha: state.active!.sha256 })}>Conserver le pointage en attente</Button>}
    </div>}
    {state?.pending.map(item => <article className="timer-recovery__item" key={item.id}>
      <div className="timer-recovery__identity"><div><strong>{item.projectName}</strong><span>{formatDate(item.startedAt.slice(0, 10))}{item.employeeName ? ` · ${item.employeeName}` : ''}{item.taskTitle ? ` · ${item.taskTitle}` : ''}</span></div><strong>{formatMinutes(item.minutes)}</strong></div>
      {item.note && <p className="timer-recovery__note">{item.note}</p>}
      <dl><div><dt>Facturation</dt><dd>{item.billable ? `${formatMoney(item.billingRateCents, currency)} / h` : 'Non facturable'}</dd></div><div><dt>Coût horaire</dt><dd>{formatMoney(item.costRateCents, currency)}</dd></div>{item.breakMinutes > 0 && <div><dt>Pause déduite</dt><dd>{formatMinutes(item.breakMinutes)}</dd></div>}</dl>
      {state.resolutionPending ? <p className="timer-recovery__hint">Terminez la résolution avant d’affecter ces heures.</p> : editing?.id === item.id ? <form onSubmit={event => { event.preventDefault(); if (validProject && !state.resolutionPending) void run(() => desktopApi.assignPreservedTimer(item.id, assignment), 'Pointage affecté au projet.'); }}>
        <div className="timer-recovery__fields">
          <Field label="Projet du pointage" required><select aria-label="Projet du pointage" required value={validProject ? assignment.projectId : ''} disabled={unavailable} onChange={event => setAssignment(previous => ({ ...previous, projectId: event.target.value, taskId: null }))}><option value="">Choisir un projet</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Tâche"><select aria-label="Tâche du pointage" value={assignment.taskId ?? ''} disabled={unavailable || !validProject} onChange={event => setAssignment(previous => ({ ...previous, taskId: event.target.value || null }))}><option value="">Sans tâche</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
          <Field label="Collaborateur"><select aria-label="Collaborateur du pointage" value={assignment.employeeId ?? ''} disabled={unavailable} onChange={event => setAssignment(previous => ({ ...previous, employeeId: event.target.value || null }))}><option value="">Sans collaborateur</option>{workspace.employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : ' (inactif)'}</option>)}</select></Field>
        </div>
        {!projects.length && <p>Créez ou rouvrez un projet pour y affecter ce pointage. Il reste conservé ici.</p>}
        <div className="form-actions"><Button type="submit" disabled={unavailable || !validProject}>Enregistrer les heures</Button><Button variant="secondary" disabled={working} onClick={() => setEditing(undefined)}>Annuler</Button></div>
      </form> : <Button variant="secondary" disabled={unavailable || Boolean(editing)} onClick={() => select(item)}>Affecter à un projet</Button>}
    </article>)}
  </section>;
}
