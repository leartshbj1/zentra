'use client';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  completePlan,
  COMPLETE_TERMS_VERSION,
  type CompletePlanId,
} from '@/lib/complete/plans';

export function CompleteCheckout({
  planId,
  signedIn,
}: {
  planId: CompletePlanId;
  signedIn: boolean;
}) {
  const plan = completePlan(planId)!;
  const [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(false);
  const login =
    '/connexion?retour=' +
    encodeURIComponent(`/complet/abonnement?formule=${planId}`);
  async function act(cancel = false) {
    setBusy(true);
    setMessage('');
    setConflict(false);
    try {
      const response = await fetch('/api/complete/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          cancel
            ? { action: 'cancel' }
            : {
                plan: planId,
                acceptTerms: accepted,
                legalVersion: COMPLETE_TERMS_VERSION,
              },
        ),
      });
      const data = (await response.json()) as { error?: string; url?: string };
      if (response.status === 401) {
        window.location.assign(login);
        return;
      }
      if (!response.ok) {
        setConflict(response.status === 409);
        throw new Error(
          data.error || 'Le paiement n’a pas pu être ouvert. Réessayez.',
        );
      }
      if (cancel) {
        setMessage(
          'La tentative de paiement est annulée. Vous pouvez choisir votre pack.',
        );
        return;
      }
      const url = new URL(data.url ?? '');
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com')
        throw new Error(
          'Le lien de paiement doit être vérifié. Contactez Zentra.',
        );
      window.location.assign(url.href);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'La connexion a été interrompue. Réessayez.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="complete-checkout-summary">
        <div>
          <strong>Zentra Complet {plan.name}</strong>
          <p>
            {plan.seats} personne{plan.seats > 1 ? 's' : ''} ·{' '}
            {plan.analyses.toLocaleString('fr-CH')} analyses Support / mois
            <br />
            Gestion, Support et Automation inclus.
          </p>
        </div>
        <strong>{plan.priceChfCents / 100} CHF / mois</strong>
      </div>
      {signedIn ? (
        <>
          <label className="complete-consent">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>
              J’accepte les{' '}
              <a href="/complet/conditions" target="_blank" rel="noreferrer">
                conditions du pack
              </a>
              , qui réunissent les conditions de Gestion, Support et Automation,
              ainsi que l’
              <a href="/sous-traitance" target="_blank" rel="noreferrer">
                accord de traitement des données
              </a>
              .
            </span>
          </label>
          <button
            className="zentra-primary"
            disabled={!accepted || busy}
            onClick={() => void act()}
          >
            {busy ? 'Un instant…' : 'Continuer vers le paiement'}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </>
      ) : (
        <>
          <p>
            Connectez-vous ou créez votre compte. Votre pack sera associé à ce
            compte et à votre entreprise.
          </p>
          <a className="zentra-primary" href={login}>
            Se connecter pour continuer
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </>
      )}
      {message && (
        <div className="complete-checkout-error" role="status">
          <p>{message}</p>
          {conflict && (
            <>
              <p>
                <a href="/compte/abonnement">Changer ma formule</a> ·{' '}
                <a href="mailto:info@zentraapp.ch?subject=Passage%20au%20pack%20Zentra%20Complet">
                  Contacter Zentra
                </a>
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(true)}
              >
                Annuler une tentative de paiement du pack
              </button>
            </>
          )}
        </div>
      )}
      <p className="complete-terms-note">
        Renouvellement mensuel automatique. Résiliable pour la fin de la période
        payée. Le montant et les informations de commande sont confirmés sur
        Stripe avant tout paiement.
      </p>
    </>
  );
}
