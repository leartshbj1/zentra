import { recurringCalendarPreview } from './recurrenceCalendar';
import type { RecurringDocumentFrequency } from './RecurringDocumentsPanel';
import { formatDate } from './utils';

export function RecurringCalendarPreview({ startDate, nextDate, endDate, frequency, paymentTermsDays, today, catchUpLimit = 12, showCatchUp = true }: {
  startDate: string; nextDate?: string; endDate: string | null; frequency: RecurringDocumentFrequency; paymentTermsDays: number; today: string; catchUpLimit?: number; showCatchUp?: boolean;
}) {
  const preview = recurringCalendarPreview({ startDate, nextDate, endDate, frequency, paymentTermsDays }, today, catchUpLimit);
  if (!preview) return null;
  return <section className="recurring-calendar" aria-label="Aperçu des dates de facturation">
    <div><strong>Voici les prochaines dates</strong><p>Un brouillon par date, à vérifier avant de l’émettre.</p></div>
    {preview.dates.length ? <ol>{preview.dates.map(({ scheduledFor, paymentDueOn }) => <li key={scheduledFor}>
      <span>Brouillon du <time dateTime={scheduledFor}>{formatDate(scheduledFor)}</time></span>
      <small>{paymentDueOn ? <>Paiement prévu avant le <time dateTime={paymentDueOn}>{formatDate(paymentDueOn)}</time></> : 'Date de paiement hors de la plage prise en charge.'}</small>
    </li>)}</ol> : <p>Aucune nouvelle date n’est prévue avant cette fin.</p>}
    {preview.monthEnd && <p>La première date tombe en fin de mois : les suivantes restent au dernier jour du mois.</p>}
    {showCatchUp && preview.dueCount > 0 && <div className="recurring-calendar__due" role="note"><strong>{preview.dueCount} date{preview.dueCount > 1 ? 's' : ''} déjà arrivée{preview.dueCount > 1 ? 's' : ''}</strong><p>À l’activation, Zentra préparera {preview.firstBatchCount} brouillon{preview.firstBatchCount > 1 ? 's' : ''} pour ces dates.{preview.dueCount > preview.firstBatchCount ? ' Vous contrôlerez ce premier lot avant de demander la suite.' : ''} Ils ne seront pas envoyés automatiquement.</p></div>}
  </section>;
}
