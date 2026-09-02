'use client';

import { CheckCircle2, LoaderCircle, UsersRound } from 'lucide-react';
import { useState } from 'react';

export function InvitationAccept({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [organization, setOrganization] = useState<{
    name: string;
    role: string;
  } | null>(null);
  const [error, setError] = useState('');

  async function accept() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/account/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json()) as {
        organization?: { name?: string; role?: string };
        error?: string;
      };
      if (!response.ok || !body.organization?.name) {
        throw new Error(body.error || 'L’invitation n’a pas pu être acceptée.');
      }
      setOrganization({
        name: body.organization.name,
        role: body.organization.role ?? 'member',
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'L’invitation n’a pas pu être acceptée.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (organization) {
    return (
      <div className="rounded-3xl border border-[#bcd4c3] bg-[#edf5ef] p-7">
        <CheckCircle2 className="size-10 text-[#24593d]" />
        <h2 className="mt-4 text-2xl font-semibold">Bienvenue dans l’équipe</h2>
        <p className="mt-2 leading-7 text-[#52645a]">
          Votre accès à <strong>{organization.name}</strong> est actif. Vous pouvez
          maintenant connecter Zentra depuis l’application.
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
      <UsersRound className="size-9 text-[#a66b1f]" />
      <h2 className="mt-4 text-xl font-semibold">Rejoindre cette entreprise</h2>
      <p className="mt-2 text-sm leading-6 text-[#5f6962]">
        L’accès sera lié au compte ChatGPT avec lequel vous êtes connecté. Vos
        droits dépendront du rôle choisi par l’administrateur.
      </p>
      <button
        type="button"
        onClick={() => void accept()}
        disabled={busy || !token}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {busy ? 'Activation…' : 'Accepter l’invitation'}
      </button>
      {error ? (
        <p className="mt-4 rounded-2xl bg-[#fff1ed] p-4 text-sm text-[#8b3f2e]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
