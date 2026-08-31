'use client';

import { CreditCard, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type CheckoutStatus = { ready?: boolean; error?: string };

export function PurchaseButton({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/stripe/status', {
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
  }, []);

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/stripe/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
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
      : unavailable
        ? 'Paiement temporairement indisponible'
        : compact
          ? 'S’abonner avec Stripe'
          : 'Acheter la licence · 50 CHF/mois';

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => void checkout()}
        disabled={busy || ready !== true}
        className={cn(
          'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#efaa3c] px-5 py-3 text-center text-sm font-semibold leading-5 text-[#173d2c] transition-colors hover:bg-[#f4b857] disabled:cursor-not-allowed disabled:opacity-65',
          className,
        )}
      >
        {busy || ready === null ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : ready ? (
          <CreditCard className="size-4" />
        ) : (
          <ShieldCheck className="size-4" />
        )}
        {label}
      </button>
      {(error || unavailable) && (
        <output className="mt-2 block text-center text-xs leading-5 text-current opacity-70">
          {error ||
            'Réessayez dans quelques instants ou contactez-nous pour activer votre licence.'}
        </output>
      )}
    </div>
  );
}
