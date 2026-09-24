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
import { useEffect, useRef, useState } from 'react';
import { LEGAL_VERSION } from '@/lib/legal';
import { notifyAuthChanged } from '@/lib/auth-browser-events';
import { loadAuthFormSession } from '@/lib/auth-form-session';
import {
  MAX_AUTH_PASSWORD_LENGTH,
  MIN_AUTH_PASSWORD_LENGTH,
} from '@/lib/supabase-auth-policy';

type AuthMode = 'connexion' | 'inscription';

export function ZentraAuthForm({
  returnTo,
  initialError,
  switchAccount = false,
}: {
  returnTo: string;
  initialError: string;
  switchAccount?: boolean;
}) {
  const [mode, setMode] = useState<AuthMode>('connexion');
  const [busy, setBusy] = useState(true);
  const submitting = useRef(false);
  const [currentEmail, setCurrentEmail] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    // A stale ?autre=1 tab is reloaded by cross-tab auth notifications.
    // It must only read the new session, never replay a logout on mount.
    void loadAuthFormSession(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setCurrentEmail(
          payload.authenticated ? (payload.user?.email ?? '') : '',
        );
        if (switchAccount && !payload.authenticated)
          setNotice('Connectez le compte de votre choix.');
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : 'La session n’a pas pu être vérifiée.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [returnTo, switchAccount]);

  async function changeAccount() {
    if (busy || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/deconnexion', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error('La déconnexion n’a pas abouti. Réessayez.');
      setCurrentEmail('');
      setNotice('Vous êtes déconnecté. Saisissez votre autre compte.');
      notifyAuthChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Réessayez.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitting.current) return;
    submitting.current = true;
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    setNotice('');
    const data = new FormData(form);
    const endpoint =
      mode === 'connexion' ? '/api/auth/connexion' : '/api/auth/inscription';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          password: data.get('password'),
          displayName: data.get('displayName'),
          ...(mode === 'inscription'
            ? {
                acceptTerms: data.get('acceptTerms') === 'on',
                legalVersion: LEGAL_VERSION,
              }
            : {}),
          returnTo,
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
        notifyAuthChanged();
        window.location.assign(returnTo);
        return;
      }
      if (payload.requiresEmailConfirmation) {
        setNotice(
          'Dernière étape : confirmez votre adresse avec le lien reçu par e-mail, dans ce même navigateur. Si vous avez déjà un compte, connectez-vous ou utilisez « Mot de passe oublié ».',
        );
        setMode('connexion');
        form.reset();
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'La demande n’a pas abouti.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError('');
    setNotice('');
  }

  return (
    <div className="auth-surface w-full min-w-0 max-w-md">
      <div className="rounded-[2rem] border border-[#e5e5e9] bg-white p-6 shadow-[0_8px_40px_rgba(29,29,31,.04)] sm:p-8">
        <div
          className="grid grid-cols-2 rounded-full bg-[#eeeef0] p-1"
          role="tablist"
          aria-label="Accès au compte"
        >
          {(['connexion', 'inscription'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              disabled={busy}
              aria-selected={mode === item}
              onClick={() => selectMode(item)}
              className={`min-h-11 min-w-0 rounded-full px-2 text-sm font-semibold transition sm:px-4 ${
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
          <h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] text-[#173d2c]">
            {mode === 'connexion'
              ? switchAccount
                ? 'Connectez votre autre compte'
                : 'Bienvenue dans Zentra'
              : 'Créez votre compte'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#657168]">
            {switchAccount
              ? 'Saisissez l’adresse e-mail du compte que vous souhaitez utiliser.'
              : mode === 'connexion'
                ? 'Connectez-vous pour retrouver votre entreprise.'
                : 'Votre accès personnel aux produits et à l’équipe de votre entreprise.'}
          </p>
        </div>

        {currentEmail ? (
          <div className="mt-5 rounded-2xl bg-[#edf5ef] p-4 text-sm">
            <p className="break-all">
              Connecté avec <strong>{currentEmail}</strong>
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              <a
                className="inline-flex min-h-11 items-center font-semibold underline"
                href={returnTo}
              >
                Continuer avec ce compte
              </a>
              <button
                type="button"
                disabled={busy}
                className="inline-flex min-h-11 items-center font-semibold underline"
                onClick={() => void changeAccount()}
              >
                Changer de compte
              </button>
            </div>
          </div>
        ) : null}

        <form
          className="mt-7 space-y-4"
          onSubmit={(event) => void submit(event)}
        >
          {mode === 'inscription' ? (
            <label className="block text-sm font-semibold text-[#31483a]">
              Nom et prénom
              <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#f5f5f7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
                <UserRound
                  className="size-4 shrink-0 text-[#7b877f]"
                  aria-hidden="true"
                />
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
            <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#f5f5f7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
              <Mail
                className="size-4 shrink-0 text-[#7b877f]"
                aria-hidden="true"
              />
              <input
                required
                name="email"
                type="email"
                value={formEmail}
                onChange={(event) => setFormEmail(event.target.value)}
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
            <span className="mt-2 flex min-h-12 items-center gap-3 rounded-2xl border border-[#d5d8d2] bg-[#f5f5f7] px-4 focus-within:border-[#5a856d] focus-within:ring-3 focus-within:ring-[#bcd4c3]/40">
              <LockKeyhole
                className="size-4 shrink-0 text-[#7b877f]"
                aria-hidden="true"
              />
              <input
                required
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={
                  mode === 'connexion' ? 'current-password' : 'new-password'
                }
                minLength={
                  mode === 'inscription' ? MIN_AUTH_PASSWORD_LENGTH : 1
                }
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
                aria-label={
                  showPassword
                    ? 'Masquer le mot de passe'
                    : 'Afficher le mot de passe'
                }
              >
                {showPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </span>
          </label>

          {mode === 'inscription' && (
            <div className="space-y-3 text-sm leading-6 text-[#48484d]">
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  name="acceptTerms"
                  type="checkbox"
                  required
                  className="mt-1 size-5 shrink-0 accent-[#315e48]"
                />
                <span>
                  J’accepte les{' '}
                  <a
                    href="/conditions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    conditions d’utilisation Zentra
                  </a>
                  .
                </span>
              </label>
              <p>
                Consultez la{' '}
                <a
                  href="/confidentialite"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  politique de confidentialité
                </a>{' '}
                pour connaître les données traitées et vos droits. Créer un
                compte ne déclenche aucun paiement.
              </p>
            </div>
          )}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white shadow-none transition hover:-translate-y-0.5 hover:bg-[#204d38] disabled:translate-y-0 disabled:cursor-wait disabled:opacity-65"
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
        {mode === 'connexion' ? (
          <a
            href="/mot-de-passe"
            className="mt-3 flex min-h-11 items-center justify-center text-sm font-semibold text-[#285d43] underline underline-offset-4"
          >
            Mot de passe oublié ?
          </a>
        ) : null}

        {notice ? (
          <output className="mt-5 flex items-start gap-3 rounded-2xl border border-[#bad3c1] bg-[#edf6ef] p-4 text-sm leading-6 text-[#28563d]">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {notice}
          </output>
        ) : null}
        {error ? (
          <p
            className="mt-5 rounded-2xl border border-[#edcabe] bg-[#fff2ed] p-4 text-sm leading-6 text-[#8b3f2e]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-5 px-5 text-center text-xs leading-5 text-[#748078]">
        Utilisez votre adresse personnelle pour retrouver les accès accordés par
        votre entreprise.
      </p>
    </div>
  );
}
