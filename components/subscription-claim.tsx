'use client';

import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

export function SubscriptionClaim({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'done'>('idle');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState('');

  async function claim() {
    setStatus('busy');
    setError('');
    try {
      const response = await fetch('/api/account/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const body = (await response.json()) as {
        organization?: { name?: string };
        error?: string;
      };
      if (!response.ok || !body.organization) {
        throw new Error(
          body.error || 'L’abonnement n’a pas pu être associé.',
        );
      }
      setOrganizationName(body.organization.name ?? 'votre entreprise');
      setStatus('done');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'L’abonnement n’a pas pu être associé.',
      );
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-3xl border border-[#bcd4c3] bg-[#edf5ef] p-6">
        <CheckCircle2 className="size-8 text-[#24593d]" />
        <h2 className="mt-4 text-xl font-semibold">Compte associé</h2>
        <p className="mt-2 text-sm leading-6 text-[#52645a]">
          {organizationName} peut maintenant autoriser sans supplément les
          collaborateurs, comptables et appareils, puis archiver ses factures
          dans le coffre Zentra.
        </p>
        <a
          href="/compte"
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white"
        >
          Ouvrir mon compte
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-[#d9d4c9] bg-white p-6 shadow-[0_20px_60px_rgba(29,45,35,.08)]">
      <h2 className="text-xl font-semibold">Créer le compte de l’entreprise</h2>
      <p className="mt-2 text-sm leading-6 text-[#5f6962]">
        L’abonnement restera facturé par Stripe. Le compte Zentra servira à
        autoriser les collaborateurs et les appareils de l’entreprise.
      </p>
      <button
        type="button"
        disabled={status === 'busy'}
        onClick={() => void claim()}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {status === 'busy' ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {status === 'busy' ? 'Vérification du paiement…' : 'Associer mon abonnement'}
      </button>
      {error ? (
        <p className="mt-4 rounded-2xl bg-[#fff1ed] p-4 text-sm text-[#8b3f2e]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
