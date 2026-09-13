import { useEffect, useMemo, useState } from 'react';
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
  countUpcomingAgendaItems,
  formatAgendaItemRange,
  itemOccursOn,
  millisecondsUntilNextLocalDay,
  monthKeyFromDate,
  monthLabel,
  shiftDate,
  shiftMonth,
  weekDates,
  type AgendaCategory,
  type AgendaItem,
} from './agenda';
import type { AgendaEvent, Workspace } from './types';
import { Button, EmptyState, ReadOnlyFormScope, StatusBadge } from './ui';
import { AgendaEditor } from './AgendaEditor';
import { AgendaActionDialog } from './AgendaActionDialog';
import { eventDraft, type AgendaEventDraft, type AgendaErrorHandler } from './agendaForm';
export type { AgendaEventDraft } from './agendaForm';
import { formatDate, todayIso } from './utils';

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

function eventDraftFromAgendaItem(item: AgendaItem): AgendaEventDraft | null {
  return item.event ? eventDraft(item.event) : null;
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
  onSave: (draft: AgendaEventDraft, onError?: AgendaErrorHandler) => Promise<boolean>;
  onDelete: (event: AgendaEvent, onError?: AgendaErrorHandler) => Promise<boolean>;
  onNavigate: (item: AgendaItem) => void;
}) {
  const [today, setToday] = useState(() => todayIso());
  const [month, setMonth] = useState(monthKeyFromDate(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [display, setDisplay] = useState<AgendaDisplay>('month');
  const [category, setCategory] = useState<AgendaCategory | 'all'>('all');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [editor, setEditor] = useState<AgendaEventDraft | null>(null);
  const [action, setAction] = useState<{ event: AgendaEvent; kind: 'complete' | 'delete' } | null>(null);
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
  const todayCount = items.filter((item) => itemOccursOn(item, today)).length;
  const nextCount = countUpcomingAgendaItems(items, today, 7);
  const overdueCount = items.filter(
    (item) => item.status === 'active' && item.endDate < today,
  ).length;

  useEffect(() => {
    let timer = 0;
    const refreshToday = () => setToday(todayIso());
    const scheduleNextDay = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refreshToday();
        scheduleNextDay();
      }, millisecondsUntilNextLocalDay(new Date()));
    };
    scheduleNextDay();
    window.addEventListener('focus', refreshToday);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshToday);
    };
  }, []);

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
                  onComplete={() => { if (item.event && !busy && !readOnly) setAction({event:item.event,kind:'complete'}); }}
                  onDelete={() => { if (item.event && !busy && !readOnly) setAction({event:item.event,kind:'delete'}); }}
                  onNavigate={() => item.route && onNavigate(item)}
                  showDate={display !== 'day'}
                  visibleDate={display === 'day' ? selectedDate : undefined}
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
        <ReadOnlyFormScope readOnly={readOnly}>
        <AgendaEditor
          draft={editor}
          workspace={workspace}
          busy={busy}
          readOnly={readOnly}
          onClose={() => setEditor(null)}
          onSave={onSave}
        />
        </ReadOnlyFormScope>
      ) : null}
      {action && <AgendaActionDialog event={action.event} action={action.kind} workspace={workspace} busy={busy} readOnly={readOnly} onClose={() => setAction(null)} onSave={onSave} onDelete={onDelete} />}
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
  visibleDate,
}: {
  item: AgendaItem;
  busy: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onNavigate: () => void;
  showDate: boolean;
  visibleDate?: string;
}) {
  return (
    <article className={`agenda-row agenda-row--${item.category} ${item.status !== 'active' ? 'is-closed' : ''}`}>
      <div className="agenda-row__time">
        <Clock3 size={15} />
        <span>{formatAgendaItemRange(item, showDate, visibleDate)}</span>
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
