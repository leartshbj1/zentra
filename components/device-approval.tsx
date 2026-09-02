'use client';

import { CheckCircle2, Laptop, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

type Membership = {
  organizationId: string;
  organizationName: string;
  role: string;
};

export function DeviceApproval({
  initialCode,
  memberships,
}: {
  initialCode: string;
  memberships: Membership[];
}) {
  const [userCode, setUserCode] = useState(initialCode);
  const [organizationId, setOrganizationId] = useState(
    memberships.length === 1 ? memberships[0].organizationId : '',
  );
  const [busy, setBusy] = useState(false);
  const [approvedName, setApprovedName] = useState('');
  const [error, setError] = useState('');

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/account/device/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode, organizationId }),
      });
      const body = (await response.json()) as {
        organization?: { name?: string };
        error?: string;
      };
      if (!response.ok || !body.organization) {
        throw new Error(body.error || 'L’appareil n’a pas pu être autorisé.');
      }
      setApprovedName(body.organization.name ?? 'votre entreprise');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'L’appareil n’a pas pu être autorisé.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (approvedName) {
    return (
      <div className="rounded-3xl border border-[#bcd4c3] bg-[#edf5ef] p-7">
        <CheckCircle2 className="size-10 text-[#24593d]" />
        <h2 className="mt-4 text-2xl font-semibold">Appareil autorisé</h2>
        <p className="mt-2 leading-7 text-[#52645a]">
          Revenez dans Zentra. L’application termine automatiquement la connexion
          à {approvedName}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-[#d9d4c9] bg-white p-6 shadow-[0_20px_60px_rgba(29,45,35,.08)] sm:p-8">
      <Laptop className="size-9 text-[#a66b1f]" />
      <label className="mt-5 block text-sm font-semibold" htmlFor="device-code">
        Code affiché dans Zentra
      </label>
      <input
        id="device-code"
        value={userCode}
        onChange={(event) => setUserCode(event.target.value.toUpperCase())}
        placeholder="ABCD-EFGH"
        autoComplete="one-time-code"
        spellCheck={false}
        className="mt-2 h-14 w-full rounded-2xl border border-[#cbc7bd] bg-[#fffdf9] px-4 text-center font-mono text-2xl tracking-[.15em] outline-none focus:ring-2 focus:ring-[#d69a40]"
      />
      {memberships.length > 1 ? (
        <>
          <label className="mt-5 block text-sm font-semibold" htmlFor="organization">
            Entreprise à ouvrir
          </label>
          <select
            id="organization"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="mt-2 h-12 w-full rounded-2xl border border-[#cbc7bd] bg-white px-4"
          >
            <option value="">Choisir une entreprise</option>
            {memberships.map((membership) => (
              <option key={membership.organizationId} value={membership.organizationId}>
                {membership.organizationName}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => void approve()}
        disabled={busy || !userCode.trim() || memberships.length === 0}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {busy ? 'Autorisation…' : 'Autoriser cet appareil'}
      </button>
      {memberships.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-[#fff5df] p-4 text-sm text-[#76511e]">
          Ce compte ne fait encore partie d’aucune entreprise Zentra. Utilisez le
          lien d’invitation reçu ou associez d’abord l’abonnement après le paiement.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-2xl bg-[#fff1ed] p-4 text-sm text-[#8b3f2e]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
