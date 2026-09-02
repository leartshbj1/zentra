import { useMemo, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  buildAgendaItems,
  calendarDays,
  itemOccursOn,
  monthKeyFromDate,
  monthLabel,
  shiftDate,
  shiftMonth,
  weekDates,
  type AgendaCategory,
  type AgendaItem,
  type AgendaRoute,
} from './agenda';
import type { AgendaEvent, Workspace } from './types';
import { Button, EmptyState, Field, FormActions, Modal, StatusBadge } from './ui';
import { formatDate, todayIso } from './utils';

export type AgendaEventDraft = {
  id?: string;
  title: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  kind: AgendaEvent['kind'];
  status: AgendaEvent['status'];
  location: string;
  notes: string;
  projectId: string | null;
  employeeId: string | null;
};

const weekDays = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
type AgendaDisplay = 'day' | 'week' | 'month';
const categoryLabels: Record<AgendaCategory, string> = {
  agenda: 'Rendez-vous',
  projects: 'Projets',
  deadlines: 'Échéances',
  payroll: 'Salaires',
};
const sourceLabels: Record<AgendaItem['source'], string> = {
  event: 'Agenda',
  task: 'Tâche',
  milestone: 'Jalon',
  project: 'Projet',
  invoice: 'Facture client',
  quote: 'Devis',
  supplier_invoice: 'Facture fournisseur',
  payslip: 'Salaire',
};

function eventDraft(event?: AgendaEvent, date = todayIso()): AgendaEventDraft {
  return event
    ? {
        id: event.id,
        title: event.title,
        startDate: event.startDate,
        endDate: event.endDate,
        allDay: event.allDay,
        startTime: event.startTime,
        endTime: event.endTime,
        kind: event.kind,
        status: event.status,
        location: event.location,
        notes: event.notes,
        projectId: event.projectId,
        employeeId: event.employeeId,
      }
    : {
        title: '',
        startDate: date,
        endDate: date,
        allDay: false,
        startTime: '09:00',
        endTime: '10:00',
        kind: 'appointment',
        status: 'scheduled',
        location: '',
        notes: '',
        projectId: null,
        employeeId: null,
      };
}

function eventDraftFromAgendaItem(item: AgendaItem): AgendaEventDraft | null {
  return item.event ? eventDraft(item.event) : null;
}

function dateTimeLabel(item: AgendaItem, showDate: boolean) {
  const time = !item.time
    ? item.date === item.endDate
      ? 'Toute la journée'
      : 'Plusieurs jours'
    : `${item.time}${item.endTime ? `–${item.endTime}` : ''}`;
  return showDate ? `${formatDate(item.date)} · ${time}` : time;
}

function filteredItems(
  items: AgendaItem[],
  category: AgendaCategory | 'all',
  includeClosed: boolean,
) {
  return items.filter(
    (item) =>
      (category === 'all' || item.category === category) &&
      (includeClosed || item.status === 'active'),
  );
}

export function AgendaScreen({
  workspace,
  busy,
  readOnly,
  onSave,
  onDelete,
  onNavigate,
}: {
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  onSave: (draft: AgendaEventDraft) => Promise<boolean>;
  onDelete: (event: AgendaEvent) => Promise<boolean>;
  onNavigate: (route: AgendaRoute) => void;
}) {
  const today = todayIso();
  const [month, setMonth] = useState(monthKeyFromDate(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [display, setDisplay] = useState<AgendaDisplay>('month');
  const [category, setCategory] = useState<AgendaCategory | 'all'>('all');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [editor, setEditor] = useState<AgendaEventDraft | null>(null);
  const allItems = useMemo(() => buildAgendaItems(workspace), [workspace]);
  const items = useMemo(
    () => filteredItems(allItems, category, includeClosed),
    [allItems, category, includeClosed],
  );
  const days = useMemo(() => calendarDays(month), [month]);
  const monthStart = `${month}-01`;
  const nextMonthStart = `${shiftMonth(month, 1)}-01`;
  const monthItems = items.filter(
    (item) => item.date < nextMonthStart && item.endDate >= monthStart,
  );
  const displayedWeek = weekDates(selectedDate);
  const visibleItems =
    display === 'day'
      ? items.filter((item) => itemOccursOn(item, selectedDate))
      : display === 'week'
        ? items.filter(
            (item) =>
              item.date <= displayedWeek[6] && item.endDate >= displayedWeek[0],
          )
        : monthItems;
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekIso = [
    nextWeek.getFullYear(),
    String(nextWeek.getMonth() + 1).padStart(2, '0'),
    String(nextWeek.getDate()).padStart(2, '0'),
  ].join('-');
  const todayCount = items.filter((item) => itemOccursOn(item, today)).length;
  const nextCount = items.filter(
    (item) =>
      item.status === 'active' && item.date <= nextWeekIso && item.endDate >= today,
  ).length;
  const overdueCount = items.filter(
    (item) => item.status === 'active' && item.endDate < today,
  ).length;

  function goToMonth(next: string) {
    setMonth(next);
    setSelectedDate(`${next}-01`);
  }

  function movePeriod(amount: number) {
    if (display === 'month') {
      goToMonth(shiftMonth(month, amount));
      return;
    }
    const next = shiftDate(selectedDate, amount * (display === 'week' ? 7 : 1));
    setSelectedDate(next);
    setMonth(monthKeyFromDate(next));
  }

  return (
    <div className="agenda-layout">
      <section className="agenda-summary" aria-label="Résumé de l’agenda">
        <AgendaMetric label="Aujourd’hui" value={todayCount} />
        <AgendaMetric label="7 prochains jours" value={nextCount} />
        <AgendaMetric label="À vérifier en retard" value={overdueCount} alert={overdueCount > 0} />
      </section>

      <section className="agenda-toolbar panel">
        <div className="agenda-month-controls">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => movePeriod(-1)}
            aria-label="Période précédente"
          >
            <ChevronLeft size={18} />
          </Button>
          <div>
            <span>{display === 'day' ? 'Journée' : display === 'week' ? 'Semaine' : 'Planning réel'}</span>
            <strong>
              {display === 'month'
                ? monthLabel(month)
                : display === 'week'
                  ? `${formatDate(displayedWeek[0])} – ${formatDate(displayedWeek[6])}`
                  : formatDate(selectedDate)}
            </strong>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => movePeriod(1)}
            aria-label="Période suivante"
          >
            <ChevronRight size={18} />
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              setMonth(monthKeyFromDate(today));
              setSelectedDate(today);
            }}
          >
            Aujourd’hui
          </Button>
        </div>
        <div className="agenda-filters">
          <div className="agenda-display-switch" role="group" aria-label="Vue de l’agenda">
            {([
              ['day', 'Jour'],
              ['week', 'Semaine'],
              ['month', 'Mois'],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={display === value ? 'is-active' : ''}
                aria-pressed={display === value}
                onClick={() => {
                  setDisplay(value);
                  setMonth(monthKeyFromDate(selectedDate));
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <label>
            <span>Afficher</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as AgendaCategory | 'all')}
            >
              <option value="all">Tout</option>
              {Object.entries(categoryLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="agenda-closed-toggle">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(event) => setIncludeClosed(event.target.checked)}
            />
            <span>Afficher terminés / annulés</span>
          </label>
          <Button
            disabled={busy || readOnly}
            onClick={() => setEditor(eventDraft(undefined, selectedDate))}
          >
            <Plus size={16} /> Ajouter
          </Button>
        </div>
      </section>

      <div className="agenda-main-grid">
        <section className={`agenda-calendar agenda-calendar--${display} panel`} aria-label={`Calendrier ${monthLabel(month)}`}>
          {display === 'month' ? (
            <>
              <div className="agenda-weekdays" aria-hidden="true">
                {weekDays.map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="agenda-days">
                {days.map((day) => {
                  const dayItems = items.filter((item) => itemOccursOn(item, day.date));
                  return (
                    <AgendaDayButton
                      key={day.date}
                      date={day.date}
                      day={day.day}
                      dayItems={dayItems}
                      today={today}
                      outside={!day.currentMonth}
                      selected={false}
                      onSelect={() => {
                        setSelectedDate(day.date);
                        setMonth(monthKeyFromDate(day.date));
                        setDisplay('day');
                      }}
                    />
                  );
                })}
              </div>
            </>
          ) : display === 'week' ? (
            <div className="agenda-week-view">
              {displayedWeek.map((date, index) => (
                <AgendaDayButton
                  key={date}
                  date={date}
                  day={Number(date.slice(-2))}
                  label={weekDays[index]}
                  dayItems={items.filter((item) => itemOccursOn(item, date))}
                  today={today}
                  outside={monthKeyFromDate(date) !== month}
                  selected={selectedDate === date}
                  onSelect={() => {
                    setSelectedDate(date);
                    setMonth(monthKeyFromDate(date));
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="agenda-day-view">
              <CalendarDays size={25} />
              <span>{new Intl.DateTimeFormat('fr-CH', { weekday: 'long' }).format(new Date(`${selectedDate}T12:00:00`))}</span>
              <strong>{formatDate(selectedDate)}</strong>
              <small>{visibleItems.length} élément{visibleItems.length > 1 ? 's' : ''}</small>
            </div>
          )}
        </section>

        <section className="agenda-list-panel panel">
          <header>
            <div>
              <span>{display === 'day' ? 'Journée sélectionnée' : display === 'week' ? 'Vue de la semaine' : 'Vue du mois'}</span>
              <strong>{display === 'day' ? formatDate(selectedDate) : display === 'week' ? `${formatDate(displayedWeek[0])} – ${formatDate(displayedWeek[6])}` : monthLabel(month)}</strong>
            </div>
            {display !== 'month' ? (
              <Button variant="ghost" size="small" onClick={() => setDisplay('month')}>Voir le mois</Button>
            ) : null}
          </header>
          {visibleItems.length ? (
            <div className="agenda-list">
              {visibleItems.map((item) => (
                <AgendaRow
                  key={item.id}
                  item={item}
                  busy={busy}
                  readOnly={readOnly}
                  onEdit={() => {
                    const draft = eventDraftFromAgendaItem(item);
                    if (draft) setEditor(draft);
                  }}
                  onComplete={async () => {
                    const draft = eventDraftFromAgendaItem(item);
                    if (!draft) return;
                    await onSave({ ...draft, status: 'completed' });
                  }}
                  onDelete={async () => {
                    if (!item.event) return;
                    if (!window.confirm(`Supprimer le rendez-vous « ${item.title} » ?`)) return;
                    await onDelete(item.event);
                  }}
                  onNavigate={() => item.route && onNavigate(item.route)}
                  showDate={display !== 'day'}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<CalendarDays />}
              title="Rien de prévu ici"
              text="Les échéances de vos projets, factures et salaires apparaissent automatiquement. Ajoutez seulement les rendez-vous qui vous sont propres."
              actionLabel="Ajouter un rendez-vous"
              onAction={() => setEditor(eventDraft(undefined, selectedDate))}
              disabled={busy || readOnly}
            />
          )}
        </section>
      </div>

      <div className="agenda-legend" aria-label="Légende">
        {Object.entries(categoryLabels).map(([value, label]) => (
          <span key={value}><i className={`agenda-dot agenda-dot--${value}`} /> {label}</span>
        ))}
      </div>

      {editor ? (
        <AgendaEditor
          draft={editor}
          workspace={workspace}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={async (draft) => {
            if (await onSave(draft)) setEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function AgendaMetric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <article className={alert ? 'is-alert' : ''}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AgendaDayButton({
  date,
  day,
  label,
  dayItems,
  today,
  outside,
  selected,
  onSelect,
}: {
  date: string;
  day: number;
  label?: string;
  dayItems: AgendaItem[];
  today: string;
  outside: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        'agenda-day',
        outside ? 'is-outside' : '',
        date === today ? 'is-today' : '',
        selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      aria-pressed={selected}
      aria-label={`${formatDate(date)} · ${dayItems.length} élément${dayItems.length > 1 ? 's' : ''}`}
      onClick={onSelect}
    >
      {label ? <small className="agenda-day__label">{label}</small> : null}
      <span>{day}</span>
      <div>
        {dayItems.slice(0, 3).map((item) => (
          <i
            key={item.id}
            className={`agenda-dot agenda-dot--${item.category}`}
            title={item.title}
          />
        ))}
        {dayItems.length > 3 ? <small>+{dayItems.length - 3}</small> : null}
      </div>
    </button>
  );
}

function AgendaRow({
  item,
  busy,
  readOnly,
  onEdit,
  onComplete,
  onDelete,
  onNavigate,
  showDate,
}: {
  item: AgendaItem;
  busy: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onComplete: () => Promise<void>;
  onDelete: () => Promise<void>;
  onNavigate: () => void;
  showDate: boolean;
}) {
  return (
    <article className={`agenda-row agenda-row--${item.category} ${item.status !== 'active' ? 'is-closed' : ''}`}>
      <div className="agenda-row__time">
        <Clock3 size={15} />
        <span>{dateTimeLabel(item, showDate)}</span>
      </div>
      <div className="agenda-row__content">
        <div>
          <small>{sourceLabels[item.source]}</small>
          <strong>{item.title}</strong>
        </div>
        {item.subtitle ? (
          <p><MapPin size={13} /> {item.subtitle}</p>
        ) : null}
      </div>
      <div className="agenda-row__actions">
        {item.status !== 'active' ? <StatusBadge status={item.status === 'done' ? 'completed' : 'cancelled'} /> : null}
        {item.event ? (
          <>
            {item.status === 'active' ? (
              <Button
                variant="ghost"
                size="icon"
                disabled={busy || readOnly}
                onClick={() => void onComplete()}
                title="Marquer terminé"
                aria-label={`Marquer « ${item.title} » terminé`}
              >
                <Check size={16} />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              disabled={busy || readOnly}
              onClick={onEdit}
              title="Modifier"
              aria-label={`Modifier « ${item.title} »`}
            >
              <Pencil size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy || readOnly}
              onClick={() => void onDelete()}
              title="Supprimer"
              aria-label={`Supprimer « ${item.title} »`}
            >
              <Trash2 size={15} />
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="small" onClick={onNavigate}>
            Ouvrir <ExternalLink size={14} />
          </Button>
        )}
      </div>
    </article>
  );
}

function AgendaEditor({
  draft: initial,
  workspace,
  busy,
  onClose,
  onSave,
}: {
  draft: AgendaEventDraft;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: AgendaEventDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');

  async function submit() {
    if (!draft.title.trim()) {
      setError('Donnez un titre au rendez-vous.');
      return;
    }
    if (draft.endDate < draft.startDate) {
      setError('La fin doit être identique ou postérieure au début.');
      return;
    }
    if (!draft.allDay && (!draft.startTime || !draft.endTime)) {
      setError('Indiquez une heure de début et de fin, ou choisissez toute la journée.');
      return;
    }
    if (
      !draft.allDay &&
      draft.startDate === draft.endDate &&
      draft.endTime! <= draft.startTime!
    ) {
      setError('L’heure de fin doit être postérieure à l’heure de début.');
      return;
    }
    setError('');
    await onSave(draft);
  }

  return (
    <Modal
      title={draft.id ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous'}
      description="Une seule fiche claire. Les autres échéances sont déjà reprises automatiquement par Zentra."
      onClose={onClose}
    >
      <form
        className="form-grid agenda-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Titre" required wide>
          <input
            autoFocus
            maxLength={200}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="Ex. Rendez-vous avec le client"
          />
        </Field>
        <Field label="Début" required>
          <input
            type="date"
            value={draft.startDate}
            onChange={(event) =>
              setDraft({
                ...draft,
                startDate: event.target.value,
                endDate: draft.endDate < event.target.value ? event.target.value : draft.endDate,
              })
            }
          />
        </Field>
        <Field label="Fin" required>
          <input
            type="date"
            min={draft.startDate}
            value={draft.endDate}
            onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
          />
        </Field>
        <label className="agenda-all-day field--wide">
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })}
          />
          <span>Toute la journée</span>
        </label>
        {!draft.allDay ? (
          <>
            <Field label="Heure de début" required>
              <input
                type="time"
                value={draft.startTime ?? ''}
                onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
              />
            </Field>
            <Field label="Heure de fin" required>
              <input
                type="time"
                value={draft.endTime ?? ''}
                onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
              />
            </Field>
          </>
        ) : null}
        <Field label="Type">
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as AgendaEvent['kind'] })}
          >
            <option value="appointment">Rendez-vous</option>
            <option value="visit">Visite / intervention</option>
            <option value="deadline">Échéance personnelle</option>
            <option value="other">Autre</option>
          </select>
        </Field>
        <Field label="État">
          <select
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value as AgendaEvent['status'] })}
          >
            <option value="scheduled">Planifié</option>
            <option value="completed">Terminé</option>
            <option value="cancelled">Annulé</option>
          </select>
        </Field>
        <Field label="Projet lié">
          <select
            value={draft.projectId ?? ''}
            onChange={(event) => setDraft({ ...draft, projectId: event.target.value || null })}
          >
            <option value="">Aucun</option>
            {workspace.projects
              .filter((project) => project.status !== 'closed')
              .map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>
        <Field label="Responsable">
          <select
            value={draft.employeeId ?? ''}
            onChange={(event) => setDraft({ ...draft, employeeId: event.target.value || null })}
          >
            <option value="">Non attribué</option>
            {workspace.employees
              .filter((employee) => employee.active)
              .map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </Field>
        <Field label="Lieu" wide>
          <input
            maxLength={500}
            value={draft.location}
            onChange={(event) => setDraft({ ...draft, location: event.target.value })}
            placeholder="Adresse, téléphone ou visioconférence"
          />
        </Field>
        <Field label="Notes" wide>
          <textarea
            rows={3}
            maxLength={20_000}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            placeholder="Informations utiles, sans champs inutiles"
          />
        </Field>
        {error ? <p className="agenda-editor__error field--wide" role="alert">{error}</p> : null}
        <FormActions onCancel={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
