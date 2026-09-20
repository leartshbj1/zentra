'use client';

import { CreditCard, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { planById, type PlanId } from '@/lib/plans';
import { LEGAL_VERSION } from '@/lib/legal';

type CheckoutStatus = {
  ready?: boolean;
  error?: string;
  testMode?: boolean;
  authenticated?: boolean;
  accessRestricted?: boolean;
  portalLoginUrl?: string;
};

function trustedPortalLoginUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'billing.stripe.com' &&
      url.pathname.startsWith('/p/login/')
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function PurchaseButton({
  className,
  compact = false,
  planId,
}: {
  className?: string;
  compact?: boolean;
  planId: PlanId;
}) {
  const plan = planById(planId)!;
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const [portalLoginUrl, setPortalLoginUrl] = useState('');
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [referralCode,setReferralCode]=useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/stripe/status?plan=${plan.id}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => ({
        response,
        body: (await response.json()) as CheckoutStatus,
      }))
      .then(({ response, body }) => {
        if (!active) return;
        setReady(response.ok && body.ready === true);
        setAccessRestricted(body.accessRestricted === true);
        setLoginRequired(body.authenticated === false);
        setPortalLoginUrl(trustedPortalLoginUrl(body.portalLoginUrl));
        if (!response.ok)
          setError('Le paiement est momentanément indisponible.');
      })
      .catch(() => {
        if (active) {
          setReady(false);
          setError('Le paiement est momentanément indisponible.');
        }
      });
    return () => {
      active = false;
    };
  }, [plan.id]);

  async function checkout() {
    if (loginRequired) {
      window.location.assign(
        `/connexion?retour=${encodeURIComponent(`/pricing?formule=${plan.id}#${plan.id}`)}`,
      );
      return;
    }
    if (!acceptTerms) {
      setError('Lisez et acceptez les conditions avant de continuer vers le paiement.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/stripe/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id, acceptTerms, legalVersion: LEGAL_VERSION,referralCode:referralCode.trim().toUpperCase() }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url)
        throw new Error(
          body.error || 'Stripe n’a pas retourné de page de paiement.',
        );
      window.location.assign(body.url);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Le paiement Stripe n’a pas pu démarrer.',
      );
      setBusy(false);
    }
  }

  const unavailable = ready === false;
  const label = busy
    ? 'Ouverture de Stripe…'
    : ready === null
      ? 'Vérification de Stripe…'
      : loginRequired
        ? 'Se connecter pour s’abonner'
        : unavailable
          ? 'Paiement temporairement indisponible'
          : compact
            ? `Choisir ${plan.name}`
            : `Choisir ${plan.name} · ${plan.priceChfCents / 100} CHF/mois`;

  return (
    <div className="w-full">
      {ready === true && !loginRequired && <div className="mb-3 text-sm leading-6">
        <details className="mb-4"><summary className="cursor-pointer py-3">Vous avez un code de parrainage ?</summary><label className="block">Code de l’entreprise qui vous invite<input value={referralCode} maxLength={30} onChange={e=>setReferralCode(e.target.value)} autoCapitalize="characters" placeholder="ZT-…" className="my-2 block min-h-12 w-full rounded-xl border border-[#c5cdc7] bg-white px-3 text-base text-[#173d2c]"/></label><p>−50 % sur votre premier mois, puis {plan.priceChfCents/100} CHF/mois. Réservé aux nouvelles entreprises clientes. <a href="/parrainage/conditions" className="underline" target="_blank" rel="noreferrer">Conditions</a></p></details>
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input type="checkbox" checked={acceptTerms} onChange={event => setAcceptTerms(event.target.checked)} className="mt-1 size-5 shrink-0 accent-[#315e48]" />
          <span>J’accepte les <a href="/conditions" target="_blank" rel="noopener noreferrer" className="underline">conditions d’abonnement</a>, dont l’<a href="/sous-traitance" target="_blank" rel="noopener noreferrer" className="underline">annexe de traitement des données</a>.</span>
        </label>
        <p>{plan.priceChfCents / 100} CHF/mois · renouvellement mensuel · résiliation pour la prochaine échéance. Aucune TVA suisse facturée par l’éditeur.</p>
      </div>}
      <button
        type="button"
        onClick={() => void checkout()}
        disabled={busy || ready === null || (ready !== true && !loginRequired)}
        className={cn(
          'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#efaa3c] px-5 py-3 text-center text-sm font-semibold leading-5 text-[#173d2c] transition-colors hover:bg-[#f4b857] disabled:cursor-not-allowed disabled:opacity-65',
          className,
        )}
      >
        {busy || ready === null ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : ready || loginRequired ? (
          <CreditCard className="size-4" />
        ) : (
          <ShieldCheck className="size-4" />
        )}
        {label}
      </button>
      {(error || (unavailable && !loginRequired)) && (
        <output className="mt-2 block text-center text-xs leading-5 text-current opacity-70">
          {error ||
            (accessRestricted
              ? 'Le paiement de test est réservé au compte propriétaire. Les visiteurs ne peuvent pas créer d’abonnement gratuit.'
              : 'Réessayez dans quelques instants ou contactez-nous pour activer votre licence.')}
        </output>
      )}
      {portalLoginUrl && (
        <a
          className="mt-2 block min-h-8 text-center text-xs font-semibold leading-8 underline underline-offset-4"
          href={portalLoginUrl}
        >
          Déjà client ? Gérer mon abonnement
        </a>
      )}
    </div>
  );
}
