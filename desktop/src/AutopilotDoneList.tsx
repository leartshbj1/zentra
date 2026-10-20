import { Check } from 'lucide-react';
import { canUndo, doneAt, doneToday, type JournalEntry } from './autopilotJournal';
import { autopilotCopy } from './autopilotPresentation';
import { getAppLocale, t, useAppLanguage } from './language';

/**
 * "Fait aujourd'hui": each card the person validated, folded into a check once
 * its work really exists (created, saved, or accepted by the mail server).
 * A new row mounts when a card leaves the list above, so the fold can be animated.
 */
export function AutopilotDoneList({ entries, onUndo, disabled = false, now }: { entries: readonly JournalEntry[];
  onUndo?: (entry: JournalEntry) => void; disabled?: boolean; now?: Date }) {
  const copy = autopilotCopy(useAppLanguage());
  const done = doneToday(entries, now);
  if (!done.length) return null;
  const time = (iso: string) => new Intl.DateTimeFormat(getAppLocale(), { timeStyle: 'short' }).format(new Date(iso));
  return <section className="quote-autopilot__done" aria-label={copy.doneListTitle}>
    <h3>{copy.doneTodayCount.replace('{n}', String(done.length))}</h3>
    <ol>
      {done.map((entry) => <li key={entry.id} data-state="done">
        <Check size={18} aria-hidden="true" />
        <span><strong>{entry.actionLabel}</strong>{entry.title ? ` · ${entry.title}` : ''}</span>
        <time dateTime={doneAt(entry)}>{time(doneAt(entry))}</time>
        {onUndo && canUndo(entry) ? <button type="button" disabled={disabled} onClick={() => onUndo(entry)}>{t('Annuler')}</button> : null}
      </li>)}
    </ol>
  </section>;
}
