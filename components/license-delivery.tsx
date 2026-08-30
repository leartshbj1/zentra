'use client';

import {
  Check,
  Copy,
  CreditCard,
  Download,
  KeyRound,
  LoaderCircle,
} from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';

type LicenseResponse = {
  token?: string;
  payload?: {
    customer_name?: string | null;
    valid_until?: string;
    installation_id?: string;
  };
  error?: string;
};

export function LicenseDelivery({ sessionId }: { sessionId: string }) {
  const [installationId, setInstallationId] = useState('');
  const [token, setToken] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function activate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/stripe/license', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          installationId: installationId.trim(),
        }),
      });
      const body = (await response.json()) as LicenseResponse;
      if (!response.ok || !body.token)
        throw new Error(body.error || 'La licence n’a pas pu être émise.');
      setToken(body.token);
      setValidUntil(body.payload?.valid_until ?? '');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'La licence n’a pas pu être émise.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  async function openPortal() {
    setPortalBusy(true);
    setError('');
    try {
      const response = await fetch('/api/stripe/portal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url)
        throw new Error(
          body.error || 'Le portail Stripe n’est pas disponible.',
        );
      window.location.assign(body.url);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Le portail Stripe n’est pas disponible.',
      );
      setPortalBusy(false);
    }
  }

  return (
    <div className="rounded-[28px] border border-[#d9d4c9] bg-white p-6 shadow-[0_25px_70px_rgba(29,45,35,.1)] sm:p-9">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#e7efe9] text-[#315d47]">
          <Check className="size-5" />
        </span>
        <div>
          <h2 className="text-xl font-semibold">Paiement reçu</h2>
          <p className="mt-1 text-sm leading-6 text-[#5f6962]">
            La licence est liée à une seule installation Windows afin de limiter
            le partage.
          </p>
        </div>
      </div>
      {!token ? (
        <form onSubmit={activate} className="mt-7">
          <label
            className="block text-sm font-semibold"
            htmlFor="installation-id"
          >
            Identifiant d’installation affiché dans Elyko
          </label>
          <input
            id="installation-id"
            value={installationId}
            onChange={(event) => setInstallationId(event.target.value)}
            placeholder="xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
            required
            className="mt-2 h-12 w-full rounded-xl border border-[#d9d4c9] bg-[#fffdf9] px-4 font-mono text-base outline-none ring-[#d69a40] focus:ring-2 sm:text-sm"
          />
          <p className="mt-2 text-xs leading-5 text-[#5f6962]">
            Installez et ouvrez l’application, puis recopiez l’identifiant du
            bandeau « Activation requise ». Aucune facture, fiche de salaire ni
            donnée de chantier n’est envoyée.
          </p>
          <button
            disabled={busy || !installationId.trim()}
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {busy ? 'Création de la licence…' : 'Créer ma licence signée'}
          </button>
        </form>
      ) : (
        <div className="mt-7 rounded-2xl bg-[#edf3ee] p-5">
          <h3 className="font-semibold">
            Jeton prêt{validUntil ? ` · valable jusqu’au ${validUntil}` : ''}
          </h3>
          <textarea
            readOnly
            value={token}
            rows={4}
            className="mt-3 w-full resize-none rounded-xl border border-[#cad8cd] bg-white p-3 font-mono text-base leading-5 sm:text-xs"
            aria-label="Jeton de licence signé"
          />
          <button
            type="button"
            onClick={() => void copyToken()}
            className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-[#173d2c] px-4 text-sm font-semibold text-white"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copied ? 'Copié' : 'Copier le jeton'}
          </button>
          <p className="mt-3 text-xs leading-5 text-[#617067]">
            Collez ce jeton dans Elyko. La signature est vérifiée localement,
            sans transmettre vos données métier.
          </p>
        </div>
      )}
      {error && (
        <p
          className="mt-4 rounded-xl bg-[#fff1ed] p-3 text-sm text-[#8b3f2e]"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <a
          href="/telecharger"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#e7a33a] px-4 text-sm font-semibold text-[#173d2c]"
        >
          <Download className="size-4" /> Télécharger le .exe
        </a>
        <button
          type="button"
          onClick={() => void openPortal()}
          disabled={portalBusy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[#cbc7bd] px-4 text-sm font-semibold disabled:opacity-60"
        >
          {portalBusy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <CreditCard className="size-4" />
          )}{' '}
          Gérer l’abonnement
        </button>
      </div>
    </div>
  );
}
