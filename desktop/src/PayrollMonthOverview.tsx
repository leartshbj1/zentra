import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from './ui';
import type { PayrollPreparationTask } from './payrollPreparationTasks';

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
  const ready = !loading && !unavailable && !tasks.length && hasContributions && !needsBasis;
  return <section className="payroll-month-overview" aria-label="La prochaine étape">
    <div className="payroll-month-overview__heading">
      {ready && <CheckCircle2 size={20} aria-hidden="true" />}
      <strong>{loading ? 'Vos réglages se chargent…'
        : unavailable ? 'Reprenons la lecture des réglages'
          : ready ? 'Vous pouvez calculer le net'
            : tasks.length ? `${tasks.length} point${tasks.length > 1 ? 's' : ''} à compléter`
              : needsBasis ? 'Un montant d’assurance reste à vérifier'
                : 'Préparons les retenues sur ce salaire'}</strong>
    </div>
    <p>{loading ? 'Vous pouvez déjà renseigner le montant du mois.'
      : unavailable ? 'Votre salaire est conservé. Utilisez « Réessayer le chargement » au-dessus pour continuer.'
        : ready ? 'Les cotisations sont reprises de vos réglages. Cliquez sur « Vérifier le salaire » pour voir ce qui sera versé à la personne.'
          : tasks[0] ? `Commençons par : ${tasks[0].title.toLocaleLowerCase('fr-CH')}. Le guide ouvre le bon champ, puis vous ramène à cette fiche.`
            : needsBasis ? 'Le guide demandera le salaire soumis à chaque assurance. Aucun montant inconnu ne sera remplacé par zéro.'
              : 'Le guide reprend les cotisations enregistrées et vous aide à compléter celles qui manquent.'}</p>
    {!ready && !loading && !unavailable && <Button type="button" variant="secondary" disabled={busy} onClick={onPrepare}>
      {needsBasis && !tasks.length && hasContributions ? 'Vérifier les montants avec le guide' : 'Compléter avec le guide'} <ArrowRight size={16} />
    </Button>}
  </section>;
}
