import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { desktopApi } from './bridge';
import { localDate } from './cashBook';
import { clientLabel, equipmentLabel, servicesToPlan, type ServiceDue } from './installedEquipment';
import { serviceTitle } from './InstalledEquipmentScreen';
import { getAppLocale, t, useAppLanguage } from './language';
import { SiteMap, type MapSite } from './SiteMap';
import { absenceOn, activeEmployees, dayPosition, eventsOn, moveConflict, movedEvent, planningRange, projectsToPlan, shiftPlanning, timeAtRatio, UNASSIGNED, visibleDays } from './teamPlanning';
import type { Absence, AgendaEvent, Project, Workspace } from './types';
import { useCompactLayout } from './MobileDetails';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate } from './utils';
import './terrain.css';

const ABSENCE_LABEL: Record<Absence['kind'], string> = {
  vacation: 'Vacances', sick: 'Maladie', accident: 'Accident', military: 'Service militaire ou civil', maternity: 'Congé maternité',
  paternity: 'Congé paternité', training: 'Formation', other: 'Autre absence',
};
const FIRST_HOUR = 7, LAST_HOUR = 19;

type Dragged = { type: 'event'; event: AgendaEvent } | { type: 'project'; project: Project } | { type: 'service'; due: ServiceDue };
type Pending = { dragged: Dragged; x: number; y: number; moved: boolean; label: string };
type Undo = { before: AgendaEvent; label: string } | null;

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

/** Planning des équipes : collaborateurs en lignes, rendez-vous et chantiers à glisser. */
export function PlanningScreen({ workspace, readOnly, onWorkspace, onOpenEvent }: { workspace: Workspace; readOnly: boolean; onWorkspace: (next: Workspace) => void; onOpenEvent: (id: string) => void }) {
  useAppLanguage();
  const compact = useCompactLayout();
  const today = localDate(new Date());
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [undo, setUndo] = useState<Undo>(null);
  const [editing, setEditing] = useState<{ event: AgendaEvent; date: string; startTime: string; employeeId: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const range = planningRange(compact ? 'day' : mode, date);
  const employees = activeEmployees(workspace.employees, range.dates[0]);
  const absences = workspace.absences ?? [];
  const days = visibleDays(range.dates, workspace.agendaEvents, absences);
  const events = workspace.agendaEvents;
  const rows = [...employees.map(employee => ({ id: employee.id, name: employee.name })), { id: UNASSIGNED, name: t('À attribuer') }];
  const projects = useMemo(() => projectsToPlan(workspace.projects, events, range.dates), [workspace.projects, events, range.dates.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dueServices = useMemo(() => servicesToPlan(workspace.installedEquipment ?? [], workspace.equipmentServices ?? [], events, today), [workspace.installedEquipment, workspace.equipmentServices, events, today]);
  const clientName = (id: string) => clientLabel(workspace.clients.find(client => client.id === id));
  const projectName = (id: string | null) => (id ? workspace.projects.find(project => project.id === id)?.name ?? '' : '');
  const locked = readOnly || busy;

  async function run(action: () => Promise<Workspace>, message: string, nextUndo: Undo = null) {
    setBusy(true);
    setError('');
    setWarning('');
    try {
      onWorkspace(await action());
      setNotice(message);
      setUndo(nextUndo);
    } catch (reason) {
      setError(errorMessage(reason, t('Le planning n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }

  const saveEvent = (event: AgendaEvent, expectedUpdatedAt: string) => desktopApi.saveAgendaEvent({ ...event, isNew: false, expectedUpdatedAt });

  function moveEvent(event: AgendaEvent, target: { employeeId: string; date: string; startTime?: string | null }) {
    const next = movedEvent(event, target);
    if (!next) return;
    const absence = moveConflict(next, target.employeeId, absences);
    if (absence) {
      const name = employees.find(row => row.id === target.employeeId)?.name ?? '';
      setWarning(t('{name} n’est pas disponible ce jour-là ({reason}). Choisissez un autre jour ou un autre collaborateur.', { name, reason: t(ABSENCE_LABEL[absence.kind]) }));
      return;
    }
    const who = rows.find(row => row.id === target.employeeId)?.name ?? '';
    void run(() => saveEvent(next, event.updatedAt), t('« {title} » déplacé au {date} · {name}', { title: event.title, date: formatDate(next.startDate), name: who }), { before: event, label: event.title });
  }

  function dropOn(dragged: Dragged, employeeId: string, day: string, startTime: string | null) {
    if (dragged.type === 'event') { moveEvent(dragged.event, { employeeId, date: day, startTime }); return; }
    const absence = employeeId ? absenceOn(absences, employeeId, day) : null;
    if (absence) {
      setWarning(t('{name} n’est pas disponible ce jour-là ({reason}). Choisissez un autre jour ou un autre collaborateur.', { name: employees.find(row => row.id === employeeId)?.name ?? '', reason: t(ABSENCE_LABEL[absence.kind]) }));
      return;
    }
    if (dragged.type === 'project') {
      const project = dragged.project;
      void run(() => desktopApi.saveAgendaEvent({ id: uuid(), isNew: true, expectedUpdatedAt: null, title: t('Chantier · {name}', { name: project.name }), startDate: day, endDate: day,
        allDay: !startTime, startTime: startTime, endTime: startTime ? shiftTime(startTime, 240) : null, kind: 'other', status: 'scheduled', location: project.address ?? '', notes: '',
        projectId: project.id, employeeId: employeeId || null }), t('Chantier « {name} » planifié le {date}', { name: project.name, date: formatDate(day) }));
      return;
    }
    const { equipment } = dragged.due;
    const start = startTime ?? '08:00';
    void run(async () => (await desktopApi.planEquipmentService({ equipmentId: equipment.id, date: day, startTime: start, endTime: shiftTime(start, 60), employeeId: employeeId || null,
      title: serviceTitle(equipment, clientName(equipment.clientId)) })).workspace, t('Entretien planifié le {date}', { date: formatDate(day) }));
  }

  // Glisser-déposer au pointeur : souris, stylet et doigt. Un simple clic ouvre le formulaire.
  useEffect(() => {
    if (!pending) return;
    const target = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]') ?? null;
    const move = (event: PointerEvent) => {
      const moved = pending.moved || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 6;
      if (moved !== pending.moved) setPending({ ...pending, moved });
      if (ghost.current) ghost.current.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
      setHover(moved ? target(event.clientX, event.clientY)?.dataset.drop ?? null : null);
    };
    const up = (event: PointerEvent) => {
      const cell = pending.moved ? target(event.clientX, event.clientY) : null;
      setPending(null);
      setHover(null);
      if (!pending.moved) {
        if (pending.dragged.type === 'event') openEditor(pending.dragged.event);
        return;
      }
      if (!cell) return;
      const [employeeId, day] = (cell.dataset.drop ?? '').split('|');
      let startTime: string | null = null;
      if (cell.dataset.track === 'day') {
        const box = cell.getBoundingClientRect();
        startTime = timeAtRatio((event.clientX - box.left) / box.width, FIRST_HOUR, LAST_HOUR);
      }
      dropOn(pending.dragged, employeeId, day, startTime);
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPending(null); setHover(null); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', cancel); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const grab = (dragged: Dragged, label: string) => (event: ReactPointerEvent) => {
    // Sur téléphone, le doigt fait défiler la page ; le formulaire remplace le glisser.
    if (locked || compact || event.button !== 0) return;
    event.preventDefault();
    setPending({ dragged, x: event.clientX, y: event.clientY, moved: false, label });
  };
  function openEditor(event: AgendaEvent) {
    setError('');
    setWarning('');
    setEditing({ event, date: event.startDate, startTime: event.startTime ?? '', employeeId: event.employeeId ?? UNASSIGNED });
  }

  const dayLabel = (day: string) => new Intl.DateTimeFormat(getAppLocale(), { weekday: 'short', day: 'numeric', month: compact ? 'long' : 'numeric' }).format(new Date(`${day}T12:00:00`));
  const rangeLabel = range.dates.length === 1
    ? new Intl.DateTimeFormat(getAppLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${range.dates[0]}T12:00:00`))
    : `${formatDate(range.dates[0])} – ${formatDate(range.dates[6])}`;
  const chip = (event: AgendaEvent, style?: CSSProperties) => {
    // Le projet en détail, sauf s'il est déjà dans le titre : le lieu est alors plus utile.
    const project = projectName(event.projectId), detail = project && !event.title.includes(project) ? project : event.location;
    const time = event.allDay ? t('Journée') : `${event.startTime}–${event.endTime}`;
    return <button key={event.id} type="button" className={`planning-chip${event.status === 'completed' ? ' is-done' : ''}${pending?.moved && pending.dragged.type === 'event' && pending.dragged.event.id === event.id ? ' is-dragging' : ''}`}
      style={style} disabled={readOnly} onPointerDown={grab({ type: 'event', event }, event.title)} onClick={compact ? () => openEditor(event) : undefined}
      onKeyDown={keyboard => { if (keyboard.key === 'Enter' || keyboard.key === ' ') { keyboard.preventDefault(); openEditor(event); } }}
      aria-label={t('{title}, {time}. Ouvrir pour déplacer', { title: event.title, time })}>
      <span className="planning-chip__time">{time}</span>
      <span className="planning-chip__title">{event.title}</span>
      {detail ? <span className="planning-chip__detail">{detail}</span> : null}
    </button>;
  };

  const cell = (rowId: string, day: string) => {
    const absence = rowId ? absenceOn(absences, rowId, day) : null;
    const key = `${rowId}|${day}`;
    const list = eventsOn(events, rowId, day);
    if (range.mode === 'day') {
      const timed = list.filter(event => !event.allDay);
      return <div key={key} className={`planning-track${hover === key ? ' is-target' : ''}${absence ? ' is-absent' : ''}`} data-drop={key} data-track="day">
        {absence ? <span className="planning-absence">{t(ABSENCE_LABEL[absence.kind])}</span> : null}
        {list.filter(event => event.allDay).map(event => <div key={event.id} className="planning-track__allday">{chip(event)}</div>)}
        {timed.map(event => {
          const position = dayPosition(event, FIRST_HOUR, LAST_HOUR);
          return position ? chip(event, { position: 'absolute', left: `${position.left}%`, width: `${position.width}%` }) : null;
        })}
      </div>;
    }
    return <div key={key} className={`planning-cell${hover === key ? ' is-target' : ''}${absence ? ' is-absent' : ''}${day === today ? ' is-today' : ''}`} data-drop={key}>
      {absence ? <span className="planning-absence">{t(ABSENCE_LABEL[absence.kind])}</span> : null}
      {list.map(event => chip(event))}
    </div>;
  };

  const sites: MapSite[] = useMemo(() => {
    const ids = new Set(events.filter(event => event.projectId && event.status !== 'cancelled' && event.startDate <= range.dates[range.dates.length - 1] && event.endDate >= range.dates[0]).map(event => event.projectId!));
    for (const project of projects) ids.add(project.id);
    return workspace.projects.filter(project => ids.has(project.id)).map(project => ({ id: project.id, label: project.name, detail: clientName(project.clientId), address: project.address ?? '' }));
  }, [events, projects, workspace.projects, range.dates.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return <section className="team-planning" aria-labelledby="team-planning-title">
    <header className="team-planning__header">
      <div>
        <h2 id="team-planning-title" className="sr-only">{t('Planning des équipes')}</h2>
        <p>{compact ? t('Touchez un rendez-vous pour changer le jour, l’heure ou le collaborateur.') : t('Glissez un rendez-vous ou un chantier vers un jour et un collaborateur. Les absences viennent de l’équipe.')}</p>
      </div>
      <div className="team-planning__controls">
        {!compact ? <div className="planning-switch" role="group" aria-label={t('Vue du planning')}>
          <button type="button" aria-pressed={mode === 'day'} onClick={() => setMode('day')}>{t('Jour')}</button>
          <button type="button" aria-pressed={mode === 'week'} onClick={() => setMode('week')}>{t('Semaine')}</button>
        </div> : null}
        <div className="planning-nav">
          <button type="button" aria-label={t('Période précédente')} onClick={() => setDate(shiftPlanning(range.mode, date, -1))}>‹</button>
          <button type="button" onClick={() => setDate(today)}>{t('Aujourd’hui')}</button>
          <button type="button" aria-label={t('Période suivante')} onClick={() => setDate(shiftPlanning(range.mode, date, 1))}>›</button>
        </div>
      </div>
    </header>
    <p className="team-planning__range">{rangeLabel}</p>
    {error ? <ErrorPanel message={error} /> : null}
    {warning ? <p className="team-planning__warning" role="alert">{warning}</p> : null}
    {notice ? <p className="team-planning__notice" role="status">{notice}{undo ? <> · <button type="button" disabled={locked} onClick={() => {
      const current = events.find(row => row.id === undo.before.id);
      if (current) void run(() => saveEvent(undo.before, current.updatedAt), t('Déplacement annulé.'));
    }}>{t('Annuler')}</button></> : null}</p> : null}
    {editing ? <div className="erp-register__form team-planning__editor" role="group" aria-label={t('Déplacer le rendez-vous')}>
      <p className="erp-register__wide"><strong>{editing.event.title}</strong></p>
      <Field label={t('Date')}><input type="date" value={editing.date} disabled={locked} onChange={event => setEditing({ ...editing, date: event.target.value })} /></Field>
      {!editing.event.allDay ? <Field label={t('Début')}><input type="time" value={editing.startTime} disabled={locked} onChange={event => setEditing({ ...editing, startTime: event.target.value })} /></Field> : null}
      <Field label={t('Collaborateur')}>
        <select value={editing.employeeId} disabled={locked} onChange={event => setEditing({ ...editing, employeeId: event.target.value })}>
          {rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </Field>
      <div className="erp-register__actions">
        <Button disabled={locked || !editing.date} onClick={() => { const { event, ...target } = editing; setEditing(null); moveEvent(event, { ...target, startTime: event.allDay ? null : target.startTime }); }}>{t('Déplacer')}</Button>
        <Button variant="secondary" onClick={() => { onOpenEvent(editing.event.id); setEditing(null); }}>{t('Ouvrir dans l’agenda')}</Button>
        <Button variant="ghost" onClick={() => setEditing(null)}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    <div className="team-planning__layout">
      {compact ? <div className="planning-list">
        {rows.map(row => {
          const day = range.dates[0], absence = row.id ? absenceOn(absences, row.id, day) : null, list = eventsOn(events, row.id, day);
          return <section key={row.id || 'unassigned'} className="planning-list__row" aria-label={row.name}>
            <h3>{row.name}{absence ? <small> · {t(ABSENCE_LABEL[absence.kind])}</small> : null}</h3>
            {list.length ? list.map(event => chip(event)) : <p>{absence ? t('Absence') : t('Libre')}</p>}
          </section>;
        })}
      </div> : <div className={`planning-board planning-board--${range.mode}`} style={{ ['--planning-columns' as string]: String(days.length) }} role="grid" aria-label={t('Planning des équipes')}>
        <div className="planning-board__head" role="row">
          <span className="planning-board__corner" role="columnheader">{t('Collaborateur')}</span>
          {range.mode === 'week'
            ? days.map(day => <span key={day} role="columnheader" className={day === today ? 'is-today' : ''}>{dayLabel(day)}</span>)
            : <span role="columnheader" className="planning-hours">{Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, index) => <span key={index}>{`${FIRST_HOUR + index}h`}</span>)}</span>}
        </div>
        {rows.map(row => <div key={row.id || 'unassigned'} className="planning-board__row" role="row">
          <span className="planning-board__name" role="rowheader">{row.name}</span>
          {days.map(day => cell(row.id, day))}
        </div>)}
        {!employees.length ? <p className="planning-board__empty">{t('Ajoutez vos collaborateurs dans Équipe & salaires pour les voir en lignes.')}</p> : null}
      </div>}
      <aside className="planning-backlog" aria-labelledby="planning-backlog-title">
        <h3 id="planning-backlog-title">{t('À planifier')}</h3>
        {!projects.length && !dueServices.length ? <p>{t('Rien à planifier pour cette période.')}</p> : null}
        {projects.length ? <>
          <h4>{t('Chantiers sans rendez-vous')}</h4>
          <ul>{projects.slice(0, 12).map(project => <li key={project.id}>
            <button type="button" className="planning-chip planning-chip--backlog" disabled={readOnly || compact} onPointerDown={grab({ type: 'project', project }, project.name)}>
              <span className="planning-chip__title">{project.name}</span>
              <span className="planning-chip__detail">{[clientName(project.clientId), project.address].filter(Boolean).join(' · ')}</span>
            </button>
          </li>)}</ul>
        </> : null}
        {dueServices.length ? <>
          <h4>{t('Entretiens à prévoir')}</h4>
          <ul>{dueServices.slice(0, 12).map(due => <li key={due.equipment.id}>
            <button type="button" className="planning-chip planning-chip--backlog" disabled={readOnly || compact} onPointerDown={grab({ type: 'service', due }, equipmentLabel(due.equipment))}>
              <span className="planning-chip__title">{equipmentLabel(due.equipment)}</span>
              <span className="planning-chip__detail">{t('{client} · avant le {date}', { client: clientName(due.equipment.clientId), date: formatDate(due.due) })}</span>
            </button>
          </li>)}</ul>
        </> : null}
        {compact && (projects.length || dueServices.length) ? <p>{t('Sur ordinateur, glissez ces éléments dans le planning.')}</p> : null}
      </aside>
    </div>
    <SiteMap sites={sites} />
    {pending?.moved ? <div ref={ghost} className="planning-ghost" aria-hidden="true">{pending.label}</div> : null}
  </section>;
}

function shiftTime(time: string, minutes: number) {
  const total = Math.min(23 * 60 + 45, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

