import { canUndo, type JournalEntry } from './autopilotJournal';
import { getAppLocale, t, useAppLanguage } from './language';
import './autopilot-journal.css';

/** « Ce qu’Autopilote a fait » : chaque clic, son résultat et l’annulation quand elle existe. */
export function AutopilotJournalList({ entries, onUndo, disabled = false }: { entries: readonly JournalEntry[]; onUndo?: (entry: JournalEntry) => void; disabled?: boolean }) {
  useAppLanguage();
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
