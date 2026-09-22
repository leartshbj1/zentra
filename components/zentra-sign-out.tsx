'use client';
import { useState } from 'react';
import { LoaderCircle, LogOut } from 'lucide-react';
import type { ZentraUser } from '@/app/zentra-auth';
import { notifyAuthChanged } from '@/lib/auth-browser-events';
import { safeAuthReturnPath } from '@/lib/supabase-auth-http';

export function ZentraSignOut({
  returnTo,
}: {
  provider: ZentraUser['provider'];
  returnTo: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const className =
    'inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-full border border-[#c8c4ba] bg-white px-5 text-sm font-semibold disabled:opacity-60';
  const safeReturnTo = safeAuthReturnPath(returnTo);
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/deconnexion', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error('La déconnexion n’a pas abouti. Réessayez.');
      notifyAuthChanged();
      window.location.replace(
        `/connexion?deconnecte=1&retour=${encodeURIComponent(safeReturnTo)}`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'La déconnexion n’a pas abouti.',
      );
      setBusy(false);
    }
  }
  return (
    <div className="self-start">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void signOut()}
          className={className}
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <LogOut className="size-4" />
          )}{' '}
          {busy ? 'Déconnexion…' : 'Déconnexion'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void signOut()}
          className={className}
        >
          Changer de compte
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[#8b3f2e]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
