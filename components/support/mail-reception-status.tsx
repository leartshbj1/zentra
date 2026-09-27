import type { SupportState } from './model';
import { schedulerHealthCopy } from '@/lib/scheduler-health-copy';

export function MailReceptionStatus({
  health,
}: {
  health: SupportState['mailSync'];
}) {
  const copy = schedulerHealthCopy(health);
  const finished = health?.lastFinishedAt
    ? new Date(health.lastFinishedAt)
    : null;
  const valid = finished && Number.isFinite(finished.getTime());
  return (
    <div
      className={
        copy.attention
          ? `support-notice${health?.state === 'failed' ? ' support-error' : ''}`
          : 'support-small'
      }
      role="status"
    >
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.detail}</p>
        {valid && (
          <p className="support-small">
            Dernier passage du serveur :{' '}
            <time dateTime={finished.toISOString()}>
              {new Intl.DateTimeFormat('fr-CH', {
                dateStyle: 'short',
                timeStyle: 'short',
                timeZone: 'Europe/Zurich',
              }).format(finished)}
            </time>
            .
          </p>
        )}
      </div>
    </div>
  );
}
