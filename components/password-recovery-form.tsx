'use client';
import { useState, type SubmitEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  MIN_AUTH_PASSWORD_LENGTH,
  MAX_AUTH_PASSWORD_LENGTH,
} from '@/lib/supabase-auth-policy';

export function PasswordRecoveryForm({ reset = false }: { reset?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (reset && form.get('password') !== form.get('confirmation')) {
      setError('Les deux mots de passe doivent être identiques.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/mot-de-passe', {
        method: reset ? 'PUT' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          reset
            ? { password: form.get('password') }
            : { email: form.get('email') },
        ),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error || 'La demande n’a pas abouti.');
      setDone(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'La demande n’a pas abouti.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-screen place-items-center bg-[#f6f4ee] p-5 text-[#173d2c]">
      <section className="w-full max-w-md rounded-3xl border border-[#d9d4c9] bg-white p-6 sm:p-9">
        <a
          href="/connexion"
          className="inline-flex min-h-11 items-center text-sm font-semibold"
        >
          ← Connexion
        </a>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight">
          {reset ? 'Votre nouveau mot de passe' : 'Mot de passe oublié'}
        </h1>
        {done ? (
          <output className="mt-6 block rounded-2xl bg-[#edf5ef] p-4 text-sm leading-7">
            {reset
              ? 'Votre mot de passe a été modifié. Reconnectez-vous sur vos appareils.'
              : 'Si un compte correspond à cette adresse, vous recevrez un lien. Ouvrez-le dans ce même navigateur pour choisir votre nouveau mot de passe.'}
            <a
              href="/connexion"
              className="mt-4 flex min-h-11 items-center font-semibold underline"
            >
              Se connecter
            </a>
          </output>
        ) : (
          <>
            <p className="mt-4 text-sm leading-7 text-[#657068]">
              {reset
                ? `Choisissez au moins ${MIN_AUTH_PASSWORD_LENGTH} caractères.`
                : 'Indiquez l’adresse e-mail de votre compte Zentra.'}
            </p>
            <form
              className="mt-6 space-y-5"
              onSubmit={(event) => void submit(event)}
            >
              {reset ? (
                <>
                  {['password', 'confirmation'].map((name) => (
                    <label key={name} className="block text-sm font-semibold">
                      {name === 'password'
                        ? 'Nouveau mot de passe'
                        : 'Confirmer le mot de passe'}
                      <input
                        className="mt-2 h-12 w-full rounded-xl border border-[#cbcfc6] px-3 font-normal"
                        name={name}
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={MIN_AUTH_PASSWORD_LENGTH}
                        maxLength={MAX_AUTH_PASSWORD_LENGTH}
                      />
                    </label>
                  ))}
                </>
              ) : (
                <label className="block text-sm font-semibold">
                  Adresse e-mail
                  <input
                    className="mt-2 h-12 w-full rounded-xl border border-[#cbcfc6] px-3 font-normal"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </label>
              )}
              <button
                disabled={busy}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {busy
                  ? 'Un instant…'
                  : reset
                    ? 'Enregistrer mon mot de passe'
                    : 'Recevoir le lien'}
              </button>
            </form>
          </>
        )}
        {error ? (
          <p
            role="alert"
            className="mt-5 rounded-xl bg-[#fff0eb] p-4 text-sm leading-6 text-[#8b3f2e]"
          >
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
