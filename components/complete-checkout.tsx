'use client';
import { siteCount } from 'zentra:site-language';
import { useEffect, useRef, useState } from 'react';
import { SwissPaymentMethods } from '@/components/swiss-payment-methods';
import { ArrowRight } from 'lucide-react';
import { completePaymentUrl } from '@/lib/client-payment-url';
import {
  completePlan,
  COMPLETE_TERMS_VERSION,
  type CompletePlanId,
} from '@/lib/complete/plans';

export function CompleteCheckout({
  planId,
  signedIn,
  initialOrganization,
}: {
  planId: CompletePlanId;
  signedIn: boolean;
  initialOrganization?: string;
}) {
  const plan = completePlan(planId)!;
  const [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(false);
  const [companies, setCompanies] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [organizationId, setOrganizationId] = useState(
    initialOrganization ?? '',
  );
  const [companyError, setCompanyError] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    fetch('/api/payments/gestion/companies', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          companies?: { id: string; name: string }[];
        };
        if (
          !response.ok ||
          !Array.isArray(data.companies) ||
          data.companies.some(
            (item) =>
              !item ||
              typeof item.id !== 'string' ||
              typeof item.name !== 'string',
          )
        )
          throw Error();
        if (controller.signal.aborted) return;
        if (
          initialOrganization &&
          !data.companies.some((item) => item.id === initialOrganization)
        )
          throw Error();
        setCompanies(data.companies);
        setOrganizationId(
          initialOrganization ??
            (data.companies.length === 1 ? data.companies[0].id : ''),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setCompanyError(true);
      });
    return () => controller.abort();
  }, [signedIn, initialOrganization]);
  const companyReady =
    !companyError &&
    companies !== null &&
    (companies.length === 0 ||
      companies.some((item) => item.id === organizationId));
  const purchaseParams = new URLSearchParams({ formule: planId });
  if (initialOrganization)
    purchaseParams.set('organizationId', initialOrganization);
  const login =
    '/connexion?retour=' +
    encodeURIComponent(`/complet/abonnement?${purchaseParams}`);
  async function act(cancel = false) {
    if (working.current || (!cancel && (!accepted || !companyReady))) return;
    working.current = true;
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
                ...(organizationId ? { organizationId } : {}),
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
      const url = completePaymentUrl(data.url ?? '', window.location.origin);
      if (!url)
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
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="complete-checkout-summary">
        <div>
          <strong>Zentra Complet {plan.name}</strong>
          <p>
            {siteCount('people', plan.seats)} ·{' '}
            {plan.analyses.toLocaleString('fr-CH')} analyses Support / mois
            <br />
            Gestion, Support et Automation inclus.
          </p>
        </div>
        <strong>{plan.priceChfCents / 100} CHF / mois</strong>
      </div>
      {signedIn ? (
        <>
          {companies && companies.length > 1 && (
            <label className="complete-company-choice">
              Votre entreprise
              <select
                value={organizationId}
                disabled={busy}
                onChange={(event) => setOrganizationId(event.target.value)}
              >
                <option value="">Choisissez votre entreprise.</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {companyError && (
            <p role="alert">
              Vos entreprises n’ont pas pu être vérifiées. Rechargez la page
              avant de continuer.
            </p>
          )}
          <SwissPaymentMethods
            product={`complet:${planId}`}
            organizationId={organizationId || undefined}
            disabled={busy || !companyReady}
          />
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
            disabled={!accepted || busy || !companyReady}
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
        <div
          className="complete-checkout-error"
          aria-live="polite"
          aria-atomic="true"
        >
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
        payée. Le montant et les informations de commande sont confirmés sur la
        page de paiement avant tout paiement.
      </p>
    </>
  );
}
