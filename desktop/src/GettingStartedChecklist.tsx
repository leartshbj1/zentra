import { useId, useState } from 'react';
import {
  ArrowRight,
  Check,
  FileCheck2,
  FolderKanban,
  Landmark,
  LockKeyhole,
  Receipt,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import {
  buildGettingStartedJourney,
  type GettingStartedAction,
  type GettingStartedStepId,
} from './gettingStarted';
import type { Workspace } from './types';
import { Button } from './ui';
import { t, useAppLanguage } from './language';

const stepIcons: Record<GettingStartedStepId, LucideIcon> = {
  client: UserRound,
  project: FolderKanban,
  quote: FileCheck2,
  invoice: Receipt,
  payment: Landmark,
  backup: ShieldCheck,
};

export function GettingStartedChecklist({
  workspace,
  readOnly,
  onAction,
  compact = false,
}: {
  workspace: Workspace;
  readOnly: boolean;
  onAction: (action: GettingStartedAction) => void;
  compact?: boolean;
}) {
  useAppLanguage();
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const journey = buildGettingStartedJourney(workspace);
  const action = journey.nextAction;

  if (compact && !expanded && action) return <section className="setup-strip" aria-label={t('Votre prochaine étape')}>
    <span className="setup-strip__count" aria-label={t(journey.completedCount === 1 ? '{count} étape terminée sur {total}' : '{count} étapes terminées sur {total}', { count: journey.completedCount, total: journey.totalCount })}>{journey.completedCount}/{journey.totalCount}</span>
    <div><span>{t('Pour bien démarrer')}</span><strong>{t(readOnly ? action.readOnlyLabel : action.label)}</strong></div>
    <Button type="button" variant="ghost" onClick={() => setExpanded(true)}>{t('Voir les étapes')}</Button>
    <Button type="button" onClick={() => onAction(action)}>{t(readOnly ? 'Consulter' : 'Continuer')} <ArrowRight size={16} /></Button>
  </section>;

  return (
    <section
      className={`panel getting-started ${journey.complete ? 'is-complete' : ''}`}
      aria-labelledby="getting-started-title"
    >
      <header className="getting-started__header">
        <div>
          <p className="eyebrow">{t('Premiers pas')}</p>
          <h2 id="getting-started-title">
            {journey.complete
              ? t('Votre espace est prêt')
              : t('Votre espace prend forme')}
          </h2>
          <p>
            {journey.complete
              ? t('Votre premier cycle de vente et votre sauvegarde sont enregistrés.')
              : t('Retrouvez ici la prochaine étape pour démarrer votre activité.')}
          </p>
        </div>
        <div className="getting-started__score" aria-hidden="true">
          <strong>{journey.completedCount}/{journey.totalCount}</strong>
          <span>{t(journey.completedCount === 1 ? 'terminée' : 'terminées')}</span>
        </div>
      </header>

      <div
        className="getting-started__progress"
        role="progressbar"
        aria-label={t('Progression des premiers pas')}
        aria-valuemin={0}
        aria-valuemax={journey.totalCount}
        aria-valuenow={journey.completedCount}
        aria-valuetext={t(journey.completedCount === 1 ? '{count} étape terminée sur {total}' : '{count} étapes terminées sur {total}', { count: journey.completedCount, total: journey.totalCount })}
      >
        <span style={{ width: `${journey.percent}%` }} />
      </div>

      <button className="checklist-toggle" type="button" aria-expanded={expanded} aria-controls={stepsId} onClick={() => setExpanded(!expanded)}>{expanded ? t('Masquer les étapes') : t('Voir les {total} étapes', { total: journey.totalCount })}</button>
      <ol id={stepsId} className="getting-started__steps" hidden={!expanded}>
        {journey.steps.map((step, index) => {
          const Icon = stepIcons[step.id];
          const current = journey.nextStep?.id === step.id;
          return (
            <li
              key={step.id}
              className={step.complete ? 'is-complete' : current ? 'is-current' : 'is-pending'}
              aria-current={current ? 'step' : undefined}
            >
              <span className="getting-started__step-icon" aria-hidden="true">
                {step.complete ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <span>
                <strong>{t(step.title)}</strong>
                <small>{t(step.description)}</small>
              </span>
              <em aria-hidden="true">{index + 1}</em>
            </li>
          );
        })}
      </ol>

      {action ? (
        <footer className="getting-started__next">
          <span className="getting-started__next-icon" aria-hidden="true">
            {readOnly ? <LockKeyhole size={20} /> : <ArrowRight size={20} />}
          </span>
          <div>
            <small>{t('Prochaine action')}</small>
            <strong>{t(readOnly ? action.readOnlyLabel : action.label)}</strong>
            <p>
              {readOnly
                ? t('La licence est en lecture seule. Vous pouvez consulter cette étape sans modifier les données.')
                : t(action.description)}
            </p>
          </div>
          <Button
            type="button"
            variant={readOnly ? 'secondary' : 'primary'}
            onClick={() => onAction(action)}
            data-getting-started-action={action.kind}
          >
            {t(readOnly ? action.readOnlyLabel : action.label)} <ArrowRight size={16} />
          </Button>
        </footer>
      ) : (
        <div className="getting-started__complete" role="status">
          <Check size={18} aria-hidden="true" />
          {t('Toutes les étapes ont été confirmées par les données de cet espace.')}
        </div>
      )}
    </section>
  );
}
