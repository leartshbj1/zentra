'use client';

import { Check, Copy, LoaderCircle, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const ROLE_OPTIONS = [
  {
    value: 'admin',
    label: 'Administrateur',
    description: 'Peut travailler dans Zentra et gérer les accès.',
  },
  {
    value: 'accountant',
    label: 'Comptable',
    description: 'Accès de travail complet, sans pouvoir gérer l’équipe.',
  },
  {
    value: 'member',
    label: 'Collaborateur',
    description: 'Accès de travail complet, sans pouvoir gérer les accès.',
  },
  {
    value: 'read_only',
    label: 'Lecture seule',
    description: 'Peut consulter et exporter, mais aucune modification.',
  },
] as const;

export function TeamInvite({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] =
    useState<(typeof ROLE_OPTIONS)[number]['value']>('member');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState('');
  const [error, setError] = useState('');

  async function createInvitation() {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const response = await fetch('/api/account/invitations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, email, role }),
      });
      const body = (await response.json()) as {
        invitation?: { url?: string };
        error?: string;
      };
      if (!response.ok || !body.invitation?.url) {
        throw new Error(body.error || 'L’invitation n’a pas pu être créée.');
      }
      setInvitationUrl(body.invitation.url);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'L’invitation n’a pas pu être créée.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(invitationUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('Copiez le lien manuellement depuis le champ ci-dessous.');
    }
  }

  const selectedRole = ROLE_OPTIONS.find((option) => option.value === role)!;
  const invitationMailto =
    invitationUrl && email.trim()
      ? `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent('Invitation à rejoindre Zentra')}&body=${encodeURIComponent(`Bonjour,\n\nVous êtes invité(e) à rejoindre notre entreprise sur Zentra avec le rôle « ${selectedRole.label} ».\n\nOuvrez ce lien sécurisé avant son expiration :\n${invitationUrl}\n\nÀ bientôt.`)}`
      : '';

  return (
    <div className="rounded-3xl border border-[#d9d4c9] bg-white p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-2xl bg-[#edf5ef] text-[#24593d]">
          <UserPlus className="size-5" />
        </span>
        <div>
          <h3 className="font-semibold">Inviter une personne</h3>
          <p className="text-sm text-[#667168]">
            Le lien expire après 7 jours.
          </p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_180px]">
        <label className="text-sm font-semibold">
          E-mail (recommandé)
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="collaborateur@entreprise.ch"
            autoComplete="email"
            className="mt-2 h-12 w-full rounded-2xl border border-[#cbc7bd] bg-[#fffdf9] px-4 font-normal outline-none"
          />
        </label>
        <label className="text-sm font-semibold">
          Rôle
          <select
            value={role}
            onChange={(event) =>
              setRole(
                event.target.value as (typeof ROLE_OPTIONS)[number]['value'],
              )
            }
            className="mt-2 h-12 w-full rounded-2xl border border-[#cbc7bd] bg-white px-4 font-normal"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-3 rounded-2xl bg-[#f4f2ec] px-4 py-3 text-sm leading-6 text-[#5f6962]">
        <strong className="text-[#173d2c]">{selectedRole.label} :</strong>{' '}
        {selectedRole.description}
      </p>
      <button
        type="button"
        onClick={() => void createInvitation()}
        disabled={busy}
        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {busy ? 'Création…' : 'Créer le lien sécurisé'}
      </button>
      {invitationUrl ? (
        <div className="mt-5 rounded-2xl bg-[#f4f2ec] p-4">
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#667168]">
            Invitation prête
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={invitationUrl}
              aria-label="Lien d’invitation"
              className="h-11 min-w-0 flex-1 rounded-xl border border-[#d9d4c9] bg-white px-3 text-sm"
            />
            <button
              type="button"
              onClick={() => void copyInvitation()}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#b9c8bd] bg-white px-4 text-sm font-semibold"
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {copied ? 'Copié' : 'Copier'}
            </button>
            {invitationMailto ? (
              <a
                href={invitationMailto}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#b9c8bd] bg-white px-4 text-sm font-semibold"
              >
                Préparer l’e-mail
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <p
          className="mt-4 rounded-2xl bg-[#fff1ed] p-4 text-sm text-[#8b3f2e]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
