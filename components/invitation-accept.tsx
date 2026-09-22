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
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/account/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, firstName, lastName }),
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
          maintenant ouvrir Zentra et sélectionner cette entreprise avec la même adresse e-mail. Les données partagées seront récupérées automatiquement.
        </p>
        <a
          href="/compte"
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white"
        >
          Ouvrir mon compte
        </a>
        <a href="/download" className="mt-3 inline-flex min-h-11 items-center px-5 text-sm font-semibold underline">Installer Zentra sur cet appareil</a>
      </div>
    );
  }

  return (
    <form onSubmit={event => { event.preventDefault(); void accept(); }} className="rounded-2xl border border-[#d9d4c9] bg-white p-6">
      <UsersRound className="size-9 text-[#a66b1f]" />
      <h2 className="mt-4 text-xl font-semibold">Rejoindre cette entreprise</h2>
      <p className="mt-2 text-sm leading-6 text-[#5f6962]">
        Votre nom apparaîtra comme interlocuteur sur les devis que vous créez.
      </p>
      <fieldset disabled={busy} className="mt-6 grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">Votre identité dans l’entreprise</legend>
        <label className="grid min-w-0 gap-2 text-sm font-medium">Prénom
          <input name="firstName" autoComplete="given-name" required maxLength={70} value={firstName} onChange={event => setFirstName(event.target.value)} className="min-h-12 min-w-0 w-full rounded-xl border border-[#cbc7bd] px-3 text-base" />
        </label>
        <label className="grid min-w-0 gap-2 text-sm font-medium">Nom
          <input name="lastName" autoComplete="family-name" required maxLength={70} value={lastName} onChange={event => setLastName(event.target.value)} className="min-h-12 min-w-0 w-full rounded-xl border border-[#cbc7bd] px-3 text-base" />
        </label>
      </fieldset>
      <button
        type="submit"
        disabled={busy || !token || !firstName.trim() || !lastName.trim()}
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
    </form>
  );
}
