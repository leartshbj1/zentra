import { COMPLETE_PLANS, completePlan } from '@/lib/complete/plans';

export function CompleteOffer() {
  return (
    <div className="complete-offer" id="formules">
      <p className="complete-trial-note">Découvrez les trois produits pendant 14 jours : 3 personnes et 250 analyses partagées. <a href="/compte">Commencer sans carte bancaire</a>.</p>
      <div className="complete-compact-plans">
        {COMPLETE_PLANS.map(item => {
          const plan = completePlan(item.id)!;
          return <article className="complete-compact-plan" key={plan.id}>
            <h2>{plan.name}</h2>
            <p className="complete-compact-price"><strong>{plan.priceChfCents / 100}</strong> CHF / mois</p>
            <p className="complete-compact-seats">{plan.seats === 1 ? '1 personne' : `Jusqu’à ${plan.seats} personnes`}<span>Titulaire compris</span></p>
            <p>{plan.analyses.toLocaleString('fr-CH')} analyses Support / mois</p>
            <a className="zentra-primary" href={`/complet/abonnement?formule=${plan.id}`}>Choisir {plan.name}</a>
            <details><summary>Comparer au prix séparé</summary><p>{plan.saving / 100} CHF économisés par mois : Gestion {plan.gestionName}, Support {plan.supportName} et Automation coûtent {plan.separatePrice / 100} CHF séparément.</p></details>
          </article>;
        })}
      </div>
      <p className="complete-terms-note">Abonnement mensuel, renouvelé automatiquement. Résiliation pour la fin de la période payée. Aucun dépassement d’analyses facturé automatiquement. <a href="/complet#deja-client">Déjà client Zentra ?</a></p>
    </div>
  );
}
