import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from './ui';
import type { PayrollPreparationTask } from './payrollPreparationTasks';
import { t, useAppLanguage } from './language';

/** Presentation of existing checks; it never infers insurance rates or eligibility. */
export function PayrollMonthOverview({ tasks, hasContributions, needsBasis, loading, unavailable, busy, onPrepare }: {
  tasks: PayrollPreparationTask[];
  hasContributions: boolean;
  needsBasis: boolean;
  loading: boolean;
  unavailable: boolean;
  busy: boolean;
  onPrepare: () => void;
}) {
  useAppLanguage();
  const ready = !loading && !unavailable && !tasks.length && hasContributions && !needsBasis;
  return <section className="payroll-month-overview" aria-label={t('La prochaine étape')}>
    <div className="payroll-month-overview__heading">
      {ready && <CheckCircle2 size={20} aria-hidden="true" />}
      <strong>{loading ? t('Vos réglages se chargent…')
        : unavailable ? t('Reprenons la lecture des réglages')
          : ready ? t('Vous pouvez calculer le net')
            : tasks.length ? t(tasks.length > 1 ? '{count} points à compléter' : '{count} point à compléter', { count: tasks.length })
              : needsBasis ? t('Un montant d’assurance reste à vérifier')
                : t('Préparons les retenues sur ce salaire')}</strong>
    </div>
    <p>{loading ? t('Vous pouvez déjà renseigner le montant du mois.')
      : unavailable ? t('Votre salaire est conservé. Utilisez « Réessayer le chargement » au-dessus pour continuer.')
        : ready ? t('Les cotisations sont reprises de vos réglages. Cliquez sur « Vérifier le salaire » pour voir ce qui sera versé à la personne.')
          : tasks[0] ? t('Commençons par « {title} ». Le guide ouvre le bon champ, puis vous ramène à cette fiche.', { title: t(tasks[0].title) })
            : needsBasis ? t('Le guide demandera le salaire soumis à chaque assurance. Aucun montant inconnu ne sera remplacé par zéro.')
              : t('Le guide reprend les cotisations enregistrées et vous aide à compléter celles qui manquent.')}</p>
    {!ready && !loading && !unavailable && <Button type="button" variant="secondary" disabled={busy} onClick={onPrepare}>
      {t(needsBasis && !tasks.length && hasContributions ? 'Vérifier les montants avec le guide' : 'Compléter avec le guide')} <ArrowRight size={16} />
    </Button>}
  </section>;
}
