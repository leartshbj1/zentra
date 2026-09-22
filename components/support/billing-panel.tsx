'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, CreditCard, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SUPPORT_PLANS,
  SUPPORT_LEGAL_VERSION,
  type SupportBillingState,
} from '@/lib/support/plans';
import type { Mutate } from './model';

export function SupportPrices({
  onChoose,
  disabled = false,
}: {
  onChoose?: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="support-prices">
      {SUPPORT_PLANS.map((plan) => (
        <article
          key={plan.id}
          className={`support-price-card ${plan.id === 'team' ? 'support-price-featured' : ''}`}
        >
          <span className="support-eyebrow">{plan.name}</span>
          <h3>
            {plan.priceChfCents / 100}
            <small> CHF / mois</small>
          </h3>
          <p>{plan.description}</p>
          <strong>
            Jusqu’à {plan.analyses.toLocaleString('fr-CH')} analyses / mois avec Automation
          </strong>
          <ul>
            <li>
              <Check size={16} /> Réception et traitement manuel des tickets
            </li>
            <li>
              <Check size={16} /> Équipe incluse, sans prix par personne
            </li>
            <li>
              <Check size={16} /> Connexions et historique partagés
            </li>
          </ul>
          <p className="support-small">Automation en option : +15 CHF/mois par espace pour le tri et le routage automatiques.</p>
          {onChoose ? (
            <Button
              className="support-primary"
              disabled={disabled}
              onClick={() => onChoose(plan.id)}
            >
              Choisir {plan.name}
            </Button>
          ) : (
            <a
              className="sp-button sp-button-dark"
              href={`/support/espace?section=billing&plan=${plan.id}`}
            >
              Choisir {plan.name}
              <ArrowUpRight size={16} />
            </a>
          )}
        </article>
      ))}
    </div>
  );
}
export function BillingPanel({
  billing,
  owner,
  busy,
  mutate,
  demo = false,
}: {
  billing?: SupportBillingState;
  owner: boolean;
  busy: boolean;
  mutate: Mutate;
  demo?: boolean;
}) {
  const [accepted, setAccepted] = useState(false),
    [working, setWorking] = useState(false),
    [message, setMessage] = useState('');
  const checked = useRef(false);
  async function action(body: Record<string, unknown>) {
    setWorking(true);
    setMessage('');
    try {
      const result = await mutate(body);
      if (typeof result?.url === 'string') window.location.assign(result.url);
      return result;
    } finally {
      setWorking(false);
    }
  }
  useEffect(() => {
    if (demo || !owner || checked.current) return;
    checked.current = true;
    const session = new URLSearchParams(window.location.search).get(
      'session_id',
    );
    if (session)
      void mutate({ action: 'refreshPayment', sessionId: session }).then(
        (result) => {
          if (result) {
            setMessage('Paiement vérifié. Votre espace est activé.');
            const url = new URL(window.location.href);
            url.searchParams.delete('session_id');
            window.history.replaceState(null, '', url);
          }
        },
      );
    // Verify once on the Stripe return. Subsequent status refreshes are explicit.
  }, [owner, demo, mutate]);
  const disabled = busy || working || demo;
  return (
    <div className="support-panels">
      <div className="support-section-heading">
        <div>
          <p className="support-eyebrow">ABONNEMENT</p>
          <h2>Un prix pour toute votre équipe.</h2>
          <p>
            Le volume qui vous convient. Vérifiez la disponibilité de votre
            outil dans Connexions avant de souscrire. Aucun dépassement facturé
            automatiquement.
          </p>
        </div>
        <CreditCard size={28} />
      </div>
      {message && <output className="support-notice">{message}</output>}
      {billing?.ownerAccess && (
        <p className="support-notice">
          Votre accès propriétaire est actif. Les abonnements ci-dessous sont
          destinés à vos clients.
        </p>
      )}
      {billing?.testMode && (
        <p className="support-notice">
          Paiement de test privé. Aucune vente réelle n’est ouverte.
        </p>
      )}
      {billing?.offeredAccess && (
        <p className="support-notice">
          Zentra vous offre cet accès jusqu’au{' '}
          {new Date(billing.offeredUntil! * 1000).toLocaleDateString('fr-CH')}.
          Aucun paiement ni renouvellement automatique. Le quota se renouvelle
          chaque mois à partir de la première attribution.
        </p>
      )}
      {billing?.plan && (
        <section className="support-card">
          <h3>
            {SUPPORT_PLANS.find((p) => p.id === billing.plan)?.name} ·{' '}
            {billing.active ? 'Accès actif' : 'Paiement à actualiser'}
          </h3>
          <p>
            {billing.used.toLocaleString('fr-CH')} /{' '}
            {billing.limit.toLocaleString('fr-CH')} analyses utilisées pour la
            {billing.offeredAccess ? 'période offerte.' : 'période payée.'}
          </p>
          <progress
            max={billing.limit}
            value={billing.used}
            aria-label="Analyses utilisées"
          />
          <p>
            {billing.offeredAccess
              ? 'Période offerte jusqu’au'
              : billing.cancelAtPeriodEnd
                ? 'Fin du renouvellement demandée. Accès jusqu’au'
                : 'Période payée jusqu’au'}{' '}
            {billing.periodEnd
              ? new Date(billing.periodEnd * 1000).toLocaleDateString('fr-CH')
              : '—'}
            .
          </p>
        </section>
      )}
      {!owner ? (
        <p className="support-notice">
          Le titulaire de cet espace gère l’abonnement pour toute l’équipe.
        </p>
      ) : (
        <>
          {billing?.hasSubscription ||
          (billing?.plan && !billing.offeredAccess) ? (
            <div className="support-actions">
              <Button
                disabled={disabled}
                onClick={() => action({ action: 'billingPortal' })}
              >
                Gérer mon abonnement <ArrowUpRight size={16} />
              </Button>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => action({ action: 'refreshPayment' })}
              >
                Actualiser le paiement
              </Button>
            </div>
          ) : null}
          {!billing?.hasSubscription && !billing?.active && (
            <label className="support-terms">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />{' '}
              <span>
                J’accepte les{' '}
                <a href="/support/conditions" target="_blank" rel="noreferrer">
                  conditions de Zentra Support
                </a>{' '}
                et le renouvellement mensuel, résiliable pour la prochaine
                échéance.
              </span>
            </label>
          )}
          {!billing?.ready && !demo && (
            <p className="support-notice">
              Les tarifs sont prêts. L’ouverture des paiements est en cours de
              finalisation.
            </p>
          )}
          <SupportPrices
            disabled={
              disabled ||
              !accepted ||
              !billing?.ready ||
              !!billing?.hasSubscription ||
              !!billing?.active
            }
            onChoose={(plan) =>
              action({
                action: 'checkout',
                plan,
                acceptTerms: accepted,
                legalVersion: SUPPORT_LEGAL_VERSION,
              })
            }
          />
        </>
      )}
      {owner && !billing?.hasSubscription && !billing?.active && (
        <Button
          variant="link"
          disabled={disabled}
          onClick={() =>
            action({ action: 'cancelCheckout' }).then((r) => {
              if (r)
                setMessage(
                  'Le paiement en attente est annulé. Vous pouvez choisir une autre formule.',
                );
            })
          }
        >
          Annuler un paiement en attente / changer de formule
        </Button>
      )}
      <p className="support-small">
        Chaque analyse IA terminée compte, y compris une nouvelle analyse
        demandée sur un ticket modifié. Les échecs techniques et les validations
        humaines ne consomment pas d’analyse. Le volume se renouvelle à chaque
        période payée ; les analyses inutilisées ne sont pas reportées.
        L’abonnement de votre logiciel de support reste séparé.
      </p>
      <p className="support-small">
        Factures, moyen de paiement et résiliation dans « Gérer mon abonnement
        ». Pour changer de formule, contactez info@zentraapp.ch avant votre
        prochaine échéance. L’éditeur n’est pas assujetti à la TVA suisse.
      </p>
    </div>
  );
}
