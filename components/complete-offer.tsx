'use client';

import { useState } from 'react';
import { ArrowRight, Check, Users } from 'lucide-react';
import {
  COMPLETE_PLANS,
  completePlan,
  type CompletePlanId,
} from '@/lib/complete/plans';

export function CompleteOffer() {
  const [selected, setSelected] = useState<CompletePlanId>('team');
  const plan = completePlan(selected)!;
  return (
    <div className="complete-offer" id="formules">
      <fieldset className="complete-plan-options">
        <legend>Choisissez la taille de votre équipe.</legend>
        {COMPLETE_PLANS.map((item) => {
          const p = completePlan(item.id)!;
          return (
            <label
              key={p.id}
              className={selected === p.id ? 'is-selected' : ''}
            >
              <input
                type="radio"
                name="complete-plan"
                value={p.id}
                checked={selected === p.id}
                onChange={() => setSelected(p.id)}
              />
              <span className="complete-plan-top">
                <strong>{p.name}</strong>
                {p.id === 'team' && <span>Notre conseil</span>}
              </span>
              <span className="complete-plan-seat">
                {p.seats === 1 ? '1 personne' : `Jusqu’à ${p.seats} personnes`}
              </span>
              <span className="complete-plan-price">
                {p.priceChfCents / 100}
                <small> CHF / mois</small>
              </span>
              <span className="complete-plan-volume">
                {p.analyses.toLocaleString('fr-CH')} analyses Support / mois
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="complete-selection" aria-live="polite" aria-atomic="true">
        <div className="complete-selection-copy">
          <div className="complete-selection-heading">
            <Users size={22} aria-hidden="true" />
            <h2>Zentra Complet {plan.name}</h2>
          </div>
          <p>{plan.description}</p>
          <ul>
            <li>
              <Check size={18} aria-hidden="true" /> Gestion {plan.gestionName}
            </li>
            <li>
              <Check size={18} aria-hidden="true" /> Support {plan.supportName}
            </li>
            <li>
              <Check size={18} aria-hidden="true" /> Automation incluse
            </li>
          </ul>
          <p className="complete-saving">
            {plan.saving / 100} CHF économisés chaque mois{' '}
            <span>
              par rapport aux produits séparés ({plan.separatePrice / 100} CHF).
            </span>
          </p>
        </div>
        <div className="complete-selection-action">
          <p>
            <strong>{plan.priceChfCents / 100}</strong> CHF / mois
          </p>
          <a
            className="zentra-primary"
            href={`/complet/abonnement?formule=${plan.id}`}
          >
            Choisir {plan.name}
            <ArrowRight size={18} aria-hidden="true" />
          </a>
          <span>Pour une entreprise · titulaire compris</span>
          <a href="/complet#deja-client">Déjà client Zentra ?</a>
        </div>
      </div>
      <p className="complete-terms-note">
        Abonnement mensuel, renouvelé automatiquement. Résiliation pour la fin
        de la période payée. Aucun dépassement d’analyses facturé
        automatiquement.
      </p>
    </div>
  );
}
