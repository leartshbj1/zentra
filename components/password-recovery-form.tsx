'use client';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Mail,
} from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { notifyAuthChanged } from '@/lib/auth-browser-events';
import {
  MIN_AUTH_PASSWORD_LENGTH,
  MAX_AUTH_PASSWORD_LENGTH,
} from '@/lib/supabase-auth-policy';

export function PasswordRecoveryForm({ reset = false }: { reset?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(reset);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!reset || started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const hashes = fragment.getAll('token_hash');
    const tokenHash = hashes.length === 1 ? hashes[0] : '';
    // Keep the one-use link out of browser history and subsequent requests.
    if (window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
    void (async () => {
      try {
        const response = await fetch(
          tokenHash ? '/api/auth/recuperation' : '/api/auth/mot-de-passe',
          {
            method: tokenHash ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            ...(tokenHash
              ? {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tokenHash }),
                }
              : {}),
          },
        );
        const payload = (await response.json()) as {
          ready?: boolean;
          email?: string;
          error?: string;
        };
        if (!response.ok || !payload.ready || !payload.email)
          throw new Error(
            payload.error ||
              'Ce lien est manquant, expiré ou déjà utilisé. Demandez un nouveau lien pour continuer.',
          );
        setEmail(payload.email);
        if (tokenHash) notifyAuthChanged();
      } catch (reason) {
        setLinkError(
          reason instanceof Error
            ? reason.message
            : 'Le lien n’a pas pu être vérifié. Réessayez avec un nouveau lien.',
        );
      } finally {
        setChecking(false);
      }
    })();
  }, [reset]);

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
      const emailValue = form.get('email');
      const requestedEmail =
        typeof emailValue === 'string' ? emailValue.trim() : '';
      const response = await fetch('/api/auth/mot-de-passe', {
        method: reset ? 'PUT' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          reset
            ? { password: form.get('password'), expectedEmail: email }
            : { email: requestedEmail },
        ),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(
          payload.error || 'La demande n’a pas abouti. Réessayez.',
        );
      if (!reset) setEmail(requestedEmail);
      else notifyAuthChanged();
      setDone(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'La demande n’a pas abouti.',
      );
    } finally {
      setBusy(false);
    }
  }
  const button =
    'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 py-3 text-center text-sm font-semibold text-white disabled:opacity-60';
  const field =
    'mt-2 h-12 w-full min-w-0 rounded-xl border border-[#d5d8d2] bg-[#f5f5f7] px-4 text-base font-normal outline-none focus:border-[#5a856d] focus:ring-2 focus:ring-[#bcd4c3]';
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f5f7] px-5 py-10 text-[#173d2c]">
      <div className="w-full min-w-0 max-w-md">
        <a
          href="/"
          aria-label="Zentra, accueil"
          className="mb-7 inline-flex min-h-11 items-center"
        >
          <BrandWordmark className="w-28" />
        </a>
        <section className="rounded-[2rem] border border-[#e5e5e9] bg-white p-6 shadow-[0_8px_40px_rgba(29,29,31,.04)] sm:p-9">
          <div className="mb-6 grid size-12 place-items-center rounded-2xl bg-[#edf5ef]">
            {done ? <CheckCircle2 /> : reset ? <KeyRound /> : <Mail />}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {done
              ? reset
                ? 'Mot de passe enregistré'
                : 'Consultez vos e-mails'
              : reset
                ? 'Un nouveau mot de passe'
                : 'Mot de passe oublié ?'}
          </h1>
          {checking ? (
            <output className="mt-6 flex items-center gap-3 text-sm">
              <LoaderCircle className="size-5 animate-spin" /> Vérification de
              votre lien…
            </output>
          ) : linkError ? (
            <div className="mt-5 space-y-5">
              <p role="alert" className="text-sm leading-7 text-[#657068]">
                {linkError}
              </p>
              <a href="/mot-de-passe" className={button}>
                Recevoir un nouveau lien
              </a>
            </div>
          ) : done ? (
            <div className="mt-5 space-y-5">
              <output className="block text-sm leading-7 text-[#657068]">
                {reset ? (
                  'Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.'
                ) : (
                  <>
                    Si un compte existe pour{' '}
                    <strong className="break-all text-[#173d2c]">
                      {email}
                    </strong>
                    , un e-mail vous permettra de choisir un nouveau mot de
                    passe. Utilisez le lien du message le plus récent.
                  </>
                )}
              </output>
              <a href="/connexion?autre=1" className={button}>
                Se connecter
              </a>
              {!reset ? (
                <button
                  type="button"
                  onClick={() => {
                    setDone(false);
                    setError('');
                  }}
                  className="min-h-11 w-full text-sm font-semibold underline"
                >
                  Corriger l’adresse ou renvoyer le lien
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mt-4 text-sm leading-7 text-[#657068]">
                {reset
                  ? 'Ce changement concerne uniquement le compte ci-dessous.'
                  : 'Recevez un lien pour choisir votre nouveau mot de passe.'}
              </p>
              {reset ? (
                <p className="mt-4 break-all rounded-xl bg-[#edf5ef] p-4 text-sm font-semibold">
                  {email}
                </p>
              ) : null}
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
                          className={field}
                          name={name}
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          required
                          minLength={MIN_AUTH_PASSWORD_LENGTH}
                          maxLength={MAX_AUTH_PASSWORD_LENGTH}
                          aria-describedby="password-help"
                        />
                      </label>
                    ))}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p id="password-help" className="text-xs text-[#657068]">
                        Au moins {MIN_AUTH_PASSWORD_LENGTH} caractères.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        className="inline-flex min-h-11 items-center gap-2 text-xs font-semibold"
                      >
                        {showPassword ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                        {showPassword ? 'Masquer' : 'Afficher'}
                      </button>
                    </div>
                  </>
                ) : (
                  <label className="block text-sm font-semibold">
                    Adresse e-mail du compte
                    <input
                      className={field}
                      name="email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      defaultValue={email}
                      required
                      maxLength={254}
                      placeholder="vous@entreprise.ch"
                    />
                  </label>
                )}
                {!reset ? (
                  <p className="text-xs leading-5 text-[#657068]">
                    5 demandes maximum par adresse e-mail. Après la 5e, attendez
                    30 minutes.
                  </p>
                ) : null}
                <button disabled={busy} className={button}>
                  {busy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : null}
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
        <a
          href="/connexion?autre=1"
          className="mt-5 flex min-h-11 items-center justify-center text-sm font-semibold"
        >
          ← Retour à la connexion
        </a>
      </div>
    </main>
  );
}
