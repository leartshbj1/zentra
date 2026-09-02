'use client';

import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
  UserRound,
} from 'lucide-react';
import type { SubmitEvent } from 'react';
import { useEffect, useState } from 'react';
import {
  MAX_AUTH_PASSWORD_LENGTH,
  MIN_AUTH_PASSWORD_LENGTH,
} from '@/lib/supabase-auth-policy';

type AuthMode = 'connexion' | 'inscription';

export function ZentraAuthForm({
  returnTo,
  sitesSignInUrl,
  initialError,
}: {
  returnTo: string;
  sitesSignInUrl: string;
  initialError: string;
}) {
  const [mode, setMode] = useState<AuthMode>('connexion');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { authenticated?: boolean };
        if (payload.authenticated) window.location.replace(returnTo);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [returnTo]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    setNotice('');
    const data = new FormData(form);
    const endpoint =
      mode === 'connexion'
        ? '/api/auth/connexion'
        : '/api/auth/inscription';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          password: data.get('password'),
          displayName: data.get('displayName'),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        requiresEmailConfirmation?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || 'La demande n’a pas abouti.');
      }
      if (payload.authenticated) {
        window.location.assign(returnTo);
        return;
      }
      if (payload.requiresEmailConfirmation) {
        setNotice(
          'Compte créé. Ouvrez le message envoyé par Zentra dans ce même navigateur pour confirmer votre adresse.',
        );
        setMode('connexion');
        form.reset();
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'La demande n’a pas abouti.',
      );
    } finally {
      setBusy(false);
    }
  }

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError('');
    setNotice('');
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-[2rem] border border-[#d8d4c9] bg-white p-6 shadow-[0_28px_90px_rgba(20,55,38,.12)] sm:p-8">
        <div
          className="grid grid-cols-2 rounded-full bg-[#f0eee8] p-1"
          role="tablist"
          aria-label="Accès au compte"
        >
          {(['connexion', 'inscription'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              onClick={() => selectMode(item)}
              className={`min-h-11 rounded-full px-4 text-sm font-semibold transition ${
                mode === item
                  ? 'bg-[#173d2c] text-white shadow-sm'
                  : 'text-[#58665e] hover:text-[#173d2c]'
              }`}
            >
              {item === 'connexion' ? 'Se connecter' : 'Créer un compte'}
            </button>
          ))}
        </div>

        <div className="mt-7">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-[#a66b1f]">
            {mode === 'connexion' ? 'Bon retour' : 'Votre espace Zentra'}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] text-[#173d2c]">
            {mode === 'connexion'
              ? 'Accédez à votre entreprise'
              : 'Créez votre accès sécurisé'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#657168]">
            Un compte par personne, puis autant de collaborateurs et de
            comptables que nécessaire dans l’entreprise.
          </p>
        </div>

        <form className="mt-7 space-y-4" onSubmit={(event) => void submit(event)}>
          {mode === 'inscription' ? (
            <label className="block text-sm font-semibold text-[#31483a]">
              Nom et prénom
              <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#fbfaf7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
                <UserRound className="size-4 shrink-0 text-[#7b877f]" aria-hidden="true" />
                <input
                  name="displayName"
                  autoComplete="name"
                  maxLength={120}
                  className="h-11 min-w-0 flex-1 bg-transparent text-base font-normal outline-none placeholder:text-[#9aa39d]"
                  placeholder="Marie Dupont"
                />
              </span>
            </label>
          ) : null}

          <label className="block text-sm font-semibold text-[#31483a]">
            Adresse e-mail
            <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#fbfaf7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
              <Mail className="size-4 shrink-0 text-[#7b877f]" aria-hidden="true" />
              <input
                required
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={254}
                className="h-11 min-w-0 flex-1 bg-transparent text-base font-normal outline-none placeholder:text-[#9aa39d]"
                placeholder="vous@entreprise.ch"
              />
            </span>
          </label>

          <label className="block text-sm font-semibold text-[#31483a]">
            Mot de passe
            <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#fbfaf7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
              <LockKeyhole className="size-4 shrink-0 text-[#7b877f]" aria-hidden="true" />
              <input
                required
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'connexion' ? 'current-password' : 'new-password'}
                minLength={mode === 'inscription' ? MIN_AUTH_PASSWORD_LENGTH : 1}
                maxLength={MAX_AUTH_PASSWORD_LENGTH}
                className="h-11 min-w-0 flex-1 bg-transparent text-base font-normal outline-none placeholder:text-[#9aa39d]"
                placeholder={
                  mode === 'inscription'
                    ? `${MIN_AUTH_PASSWORD_LENGTH} caractères minimum`
                    : 'Votre mot de passe'
                }
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="grid size-10 shrink-0 place-items-center rounded-full text-[#607067] hover:bg-[#e9eee9]"
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </span>
          </label>

          <button
            type="submit"
            disabled={busy}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(23,61,44,.2)] transition hover:-translate-y-0.5 hover:bg-[#204d38] disabled:translate-y-0 disabled:cursor-wait disabled:opacity-65"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {busy
              ? 'Vérification…'
              : mode === 'connexion'
                ? 'Ouvrir mon espace'
                : 'Créer mon compte'}
            {!busy ? <ArrowRight className="size-4" /> : null}
          </button>
        </form>

        {notice ? (
          <output className="mt-5 flex items-start gap-3 rounded-2xl border border-[#bad3c1] bg-[#edf6ef] p-4 text-sm leading-6 text-[#28563d]">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {notice}
          </output>
        ) : null}
        {error ? (
          <p className="mt-5 rounded-2xl border border-[#edcabe] bg-[#fff2ed] p-4 text-sm leading-6 text-[#8b3f2e]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6 border-t border-[#e4e1d9] pt-5 text-center">
          <p className="text-xs leading-5 text-[#7a847e]">
            Accès actuel via ChatGPT Sites pendant la transition ?
          </p>
          <a
            href={sitesSignInUrl}
            target="_top"
            className="mt-2 inline-flex min-h-11 items-center justify-center text-sm font-semibold text-[#285d43] underline decoration-[#b3c7ba] underline-offset-4"
          >
            Continuer avec l’accès Sites
          </a>
        </div>
      </div>

      <p className="mt-5 px-5 text-center text-xs leading-5 text-[#748078]">
        Les jetons de session restent dans des cookies HttpOnly sécurisés et ne
        sont jamais exposés au code de la page.
      </p>
    </div>
  );
}
