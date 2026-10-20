import { canUndo, doneToday, type JournalEntry } from './autopilotJournal';
import { getAppLocale, t, useAppLanguage } from './language';
import './autopilot-journal.css';

/** « Ce qu’Autopilote a fait » : chaque clic, son résultat et l’annulation quand elle existe. */
export function AutopilotJournalList({ entries: all, onUndo, disabled = false, now }: { entries: readonly JournalEntry[]; onUndo?: (entry: JournalEntry) => void; disabled?: boolean; now?: Date }) {
  useAppLanguage();
  // Today's done work is already listed under "Fait aujourd'hui": the history keeps the rest
  // (earlier days, today's failures, opened screens, ignored or postponed cards).
  const shownAbove = new Set(doneToday(all, now).map((entry) => entry.id));
  const entries = all.filter((entry) => !shownAbove.has(entry.id));
  if (!entries.length) return null;
  const time = (iso: string) => new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return <details className="quote-autopilot__journal">
    <summary>{t('Ce qu’Autopilote a fait ({count})', { count: entries.length })}</summary>
    <ol>
      {entries.map((entry) => <li key={entry.id}>
        <div>
          <strong>{entry.actionLabel ? `${entry.actionLabel} · ${entry.title}` : entry.title}</strong>
          <small>{time(entry.at)}{entry.ok === false ? ` · ${t('Non abouti')}` : ''}{entry.undoneAt ? ` · ${t('Annulé')}` : ''}</small>
        </div>
        {onUndo && canUndo(entry) ? <button type="button" disabled={disabled} onClick={() => onUndo(entry)}>{t('Annuler')}</button> : null}
      </li>)}
    </ol>
  </details>;
}
