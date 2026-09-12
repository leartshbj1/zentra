import { useRef, useState } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, LockKeyhole, Plus } from 'lucide-react';
import { desktopApi } from './bridge';
import type { AccountingPeriod } from './types';
import { calendarYearDraft, closedThrough, isPeriodDate, periodDraftIssue, type PeriodDraft } from './accountingPeriods';
import { createId, errorMessage, formatDate, todayIso } from './utils';
import { Button, EmptyState, ErrorPanel, Field, Modal, SectionHeading } from './ui';
import './accounting-periods.css';

export function AccountingPeriodsPanel({ periods, busy, readOnly, onRefresh, onOpenClosing }: {
  periods: AccountingPeriod[]; busy: boolean; readOnly: boolean; onRefresh: (saved: PeriodDraft) => Promise<void>; onOpenClosing: (id: string) => void;
}) {
  const [draft, setDraft] = useState<PeriodDraft | null>(null);
  const [highlight, setHighlight] = useState('');
  const boundary = closedThrough(periods);
  const sorted = [...periods].sort((a, b) => b.dateFrom.localeCompare(a.dateFrom) || a.name.localeCompare(b.name));
  function finish(id?: string) {
    setDraft(null);
    if (!id) return;
    setHighlight(id);
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-accounting-period]')].find(row => row.dataset.accountingPeriod === id);
      row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'center' });
    });
  }
  return <section className="panel accounting-periods">
    <SectionHeading eyebrow="Organiser votre comptabilité" title="Exercices comptables" description="Un exercice définit les dates à examiner ensemble. Sa création permet de préparer les contrôles ; la clôture demandera une confirmation distincte." action={<Button disabled={busy || readOnly} onClick={() => setDraft({ id: createId(), name: '', dateFrom: '', dateTo: '' })}><Plus size={16} /> Nouvel exercice</Button>} />
    <ol className="accounting-periods__guide"><li><span>1</span><div><strong>Choisir les dates</strong><p>Une année civile ou les dates de votre exercice réel.</p></div></li><li><span>2</span><div><strong>Contrôler les comptes</strong><p>Le dossier de clôture réunit les vérifications et l’export provisoire.</p></div></li><li><span>3</span><div><strong>Clôturer quand tout est prêt</strong><p>Une confirmation distincte explique le verrouillage définitif.</p></div></li></ol>
    {boundary && <p className="accounting-periods__boundary"><LockKeyhole size={18} /><span>L’historique est verrouillé jusqu’au <strong>{formatDate(boundary)}</strong>. Un nouvel exercice doit commencer après cette date.</span></p>}
    {sorted.length ? <div className="accounting-periods__list">{sorted.map(period => {
      const editable = period.status === 'open' && (!boundary || period.dateFrom > boundary);
      return <article key={period.id} data-accounting-period={period.id} tabIndex={-1} className={highlight === period.id ? 'is-highlighted' : ''}><div><span className="accounting-periods__status">{period.status === 'closed' ? 'Clôturé' : editable ? 'Ouvert' : 'Historique verrouillé'}</span><h3>{period.name}</h3><p>{formatDate(period.dateFrom)} → {formatDate(period.dateTo)}</p>{period.closedAt && <small>Clôturé le {formatDate(period.closedAt)}</small>}</div><div className="accounting-periods__actions">{editable && <Button variant="ghost" disabled={busy || readOnly} onClick={() => setDraft({ id: period.id, name: period.name, dateFrom: period.dateFrom, dateTo: period.dateTo })}>Modifier les dates ou le nom</Button>}<Button variant="secondary" disabled={busy} onClick={() => onOpenClosing(period.id)}>Ouvrir le dossier <ArrowRight size={16} /></Button></div></article>;
    })}</div> : <EmptyState icon={<CalendarDays />} title="Préparez votre premier exercice" text="Choisissez les dates qui correspondent à votre comptabilité. Vous pourrez ensuite consulter les contrôles et exporter le dossier." />}
    {draft && <PeriodEditor key={draft.id} initial={draft} periods={periods} busy={busy} readOnly={readOnly} onClose={finish} onRefresh={onRefresh} onOpenClosing={onOpenClosing} />}
  </section>;
}

function PeriodEditor({ initial, periods, busy, readOnly, onClose, onRefresh, onOpenClosing }: {
  initial: PeriodDraft; periods: AccountingPeriod[]; busy: boolean; readOnly: boolean; onClose: (id?: string) => void; onRefresh: (saved: PeriodDraft) => Promise<void>; onOpenClosing: (id: string) => void;
}) {
  const [draft, setDraft] = useState(initial), [showIssue, setShowIssue] = useState(false), [error, setError] = useState('');
  const [working, setWorking] = useState(false), [saved, setSaved] = useState<PeriodDraft | null>(null), [complete, setComplete] = useState(false);
  const inFlight = useRef(false), acknowledged = useRef<PeriodDraft | null>(null), form = useRef<HTMLFormElement>(null);
  const editing = periods.some(period => period.id === initial.id);
  const locked = busy || working;
  const issue = periodDraftIssue(draft, periods);
  const year = Number(todayIso().slice(0, 4));
  async function save() {
    if (locked || inFlight.current || complete || (readOnly && !acknowledged.current)) return;
    if (!acknowledged.current && issue) { setShowIssue(true); requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>(`[name=${issue.field}]`)?.focus()); return; }
    inFlight.current = true; setWorking(true); setError('');
    try {
      if (!acknowledged.current) {
        const submission = { ...draft, name: draft.name.trim() };
        await desktopApi.upsertAccountingPeriod(submission);
        acknowledged.current = submission; setSaved(submission);
      }
      await onRefresh(acknowledged.current); setComplete(true);
    } catch (reason) { setError(errorMessage(reason, acknowledged.current ? 'L’affichage des exercices n’a pas pu être actualisé.' : 'L’exercice n’a pas pu être enregistré. Vos dates sont conservées.')); }
    finally { inFlight.current = false; setWorking(false); }
  }
  const knownOverlap = showIssue && issue?.overlappingId ? periods.find(period => period.id === issue.overlappingId) : undefined;
  return <Modal title={saved ? complete ? 'L’exercice est enregistré' : 'Enregistré, affichage à actualiser' : editing ? 'Modifier cet exercice' : 'Créer un exercice'} onClose={() => onClose(saved?.id)} dismissible={!locked && (!saved || complete)} className="accounting-period-editor">
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="accounting-period-editor__form">
      {error && <ErrorPanel title={saved ? 'Vos dates sont enregistrées' : 'Vérifions ce point'} message={error} reveal />}
      {!saved ? <>
        {!editing && <div className="accounting-period-editor__presets"><strong>Votre exercice suit l’année civile ?</strong><p>Choisissez une année pour proposer ses dates. Vous pourrez les ajuster ci-dessous.</p><div>{[year - 1, year, year + 1].filter(value => value >= 1 && value <= 9999).map(value => <Button key={value} type="button" variant="secondary" disabled={locked || readOnly} onClick={() => { setDraft(current => calendarYearDraft(current, value)); setShowIssue(false); }}>{value}</Button>)}</div></div>}
        <p>Si votre exercice commence en cours d’année ou couvre une autre durée, saisissez directement ses dates réelles.</p>
        <fieldset disabled={locked || readOnly}><Field label="Nom de l’exercice" required error={showIssue && issue?.field === 'name' ? issue.message : undefined}><input name="name" value={draft.name} placeholder="Exercice 2026" onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field><div className="accounting-period-editor__dates"><Field label="Premier jour" required error={showIssue && issue?.field === 'dateFrom' ? issue.message : undefined}><input name="dateFrom" type="date" value={draft.dateFrom} onChange={event => setDraft({ ...draft, dateFrom: event.target.value })} /></Field><Field label="Dernier jour inclus" required error={showIssue && issue?.field === 'dateTo' ? issue.message : undefined}><input name="dateTo" type="date" value={draft.dateTo} onChange={event => setDraft({ ...draft, dateTo: event.target.value })} /></Field></div></fieldset>
        {showIssue && issue?.suggestedStart && <Button type="button" variant="secondary" disabled={locked || readOnly} onClick={() => setDraft(current => ({ ...current, dateFrom: issue.suggestedStart! }))}>Commencer le {formatDate(issue.suggestedStart)}</Button>}
        {knownOverlap && <p className="accounting-period-editor__help">Vous pouvez annuler cette création puis ouvrir « {knownOverlap.name} » dans la liste pour le consulter ou le modifier.</p>}
        {isPeriodDate(draft.dateFrom) && isPeriodDate(draft.dateTo) && draft.dateFrom <= draft.dateTo && <p className="accounting-period-editor__summary"><CalendarDays size={19} /><span>Du <strong>{formatDate(draft.dateFrom)}</strong> au <strong>{formatDate(draft.dateTo)}</strong>, ces deux jours compris. L’enregistrement ne verrouille aucune écriture.</span></p>}
        {readOnly && <p>La création et la modification sont indisponibles en lecture seule. Vos informations restent présentes.</p>}
      </> : <div className="accounting-period-editor__saved"><CheckCircle2 size={26} /><h3>{saved.name}</h3><p>{formatDate(saved.dateFrom)} → {formatDate(saved.dateTo)}</p><p>{complete ? 'Vous pouvez revenir aux exercices ou ouvrir le dossier pour préparer les contrôles. Aucune clôture n’a été effectuée.' : 'L’enregistrement a réussi. Actualiser les données relit uniquement les exercices et les états ; cette action ne crée pas un autre exercice.'}</p></div>}
      <div className="form-actions">{!saved ? <Button type="button" variant="secondary" disabled={locked} onClick={() => onClose()}>Annuler</Button> : complete ? <Button type="button" variant="secondary" onClick={() => onClose(saved.id)}>Voir mes exercices</Button> : null}{complete && saved ? <Button type="button" onClick={() => { onClose(saved.id); onOpenClosing(saved.id); }}>Ouvrir le dossier</Button> : <Button type="submit" disabled={locked || (readOnly && !saved)}>{locked ? 'En cours…' : saved ? 'Actualiser les données' : editing ? 'Enregistrer les modifications' : 'Créer cet exercice'}</Button>}</div>
    </form>
  </Modal>;
}
