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
}: {
  workspace: Workspace;
  readOnly: boolean;
  onAction: (action: GettingStartedAction) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const journey = buildGettingStartedJourney(workspace);
  const action = journey.nextAction;

  return (
    <section
      className={`panel getting-started ${journey.complete ? 'is-complete' : ''}`}
      aria-labelledby="getting-started-title"
    >
      <header className="getting-started__header">
        <div>
          <p className="eyebrow">Premiers pas</p>
          <h2 id="getting-started-title">
            {journey.complete
              ? 'Votre chaîne initiale est opérationnelle'
              : 'Avancez avec vos données réelles'}
          </h2>
          <p>
            {journey.complete
              ? 'Le premier cycle client, facture, comptabilité et sauvegarde est prouvé.'
              : 'Zentra vous montre uniquement la prochaine action utile. Rien n’est simulé.'}
          </p>
        </div>
        <div className="getting-started__score" aria-hidden="true">
          <strong>{journey.completedCount}/{journey.totalCount}</strong>
          <span>terminées</span>
        </div>
      </header>

      <div
        className="getting-started__progress"
        role="progressbar"
        aria-label="Progression des premiers pas"
        aria-valuemin={0}
        aria-valuemax={journey.totalCount}
        aria-valuenow={journey.completedCount}
        aria-valuetext={`${journey.completedCount} étape${journey.completedCount === 1 ? '' : 's'} terminée${journey.completedCount === 1 ? '' : 's'} sur ${journey.totalCount}`}
      >
        <span style={{ width: `${journey.percent}%` }} />
      </div>

      <button className="mobile-checklist-toggle" type="button" aria-expanded={expanded} aria-controls={stepsId} onClick={() => setExpanded(!expanded)}>{expanded ? 'Masquer les étapes' : `Voir les ${journey.totalCount} étapes`}</button>
      <ol id={stepsId} className={`getting-started__steps ${expanded ? '' : 'is-mobile-collapsed'}`}>
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
                <strong>{step.title}</strong>
                <small>{step.description}</small>
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
            <small>Prochaine action</small>
            <strong>{readOnly ? action.readOnlyLabel : action.label}</strong>
            <p>
              {readOnly
                ? 'La licence est en lecture seule. Vous pouvez consulter cette étape sans modifier les données.'
                : action.description}
            </p>
          </div>
          <Button
            type="button"
            variant={readOnly ? 'secondary' : 'primary'}
            onClick={() => onAction(action)}
            data-getting-started-action={action.kind}
          >
            {readOnly ? action.readOnlyLabel : action.label} <ArrowRight size={16} />
          </Button>
        </footer>
      ) : (
        <div className="getting-started__complete" role="status">
          <Check size={18} aria-hidden="true" />
          Toutes les étapes ont été confirmées par les données de cet espace.
        </div>
      )}
    </section>
  );
}
