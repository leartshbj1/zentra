import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { chatGPTSignInPath } from '@/app/chatgpt-auth';
import { ZentraAuthForm } from '@/components/zentra-auth-form';
import { safeAuthReturnPath } from '@/lib/supabase-auth-http';
import { legacySupabaseConfirmationPath } from '@/lib/supabase-auth-pkce';
import { Building2, DatabaseZap, ShieldCheck } from 'lucide-react';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connexion sécurisée — Zentra',
  description: 'Accédez au compte de votre entreprise Zentra.',
};

export default async function ConnexionPage({
  searchParams,
}: {
  searchParams: Promise<{
    retour?: string;
    erreur?: string;
    confirmation?: string | string[];
    code?: string | string[];
    error?: string | string[];
  }>;
}) {
  const parameters = await searchParams;
  const legacyConfirmation = legacySupabaseConfirmationPath(parameters);
  if (legacyConfirmation) redirect(legacyConfirmation);
  const returnTo = safeAuthReturnPath(parameters.retour);
  const confirmationError = confirmationErrorMessage(parameters.erreur);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f6f4ee] px-5 py-8 text-[#173d2c] sm:grid sm:place-items-center sm:py-14">
      <div className="pointer-events-none absolute -left-32 top-10 size-80 rounded-full bg-[#dbe9de]/70 blur-3xl" />
      <div className="pointer-events-none absolute -right-28 bottom-0 size-96 rounded-full bg-[#f0d7aa]/40 blur-3xl" />
      <div className="relative mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[1fr_28rem] lg:items-center lg:gap-16">
        <section className="pt-3 lg:pt-0">
          <a href="/" className="inline-flex items-center gap-3 font-semibold">
            <span className="grid size-11 place-items-center rounded-2xl bg-[#173d2c] text-lg font-bold text-white">
              Z
            </span>
            <span className="text-xl tracking-[-.03em]">zentra</span>
          </a>
          <p className="mt-12 text-xs font-bold uppercase tracking-[.2em] text-[#a66b1f]">
            Compte d’entreprise
          </p>
          <h2 className="mt-4 max-w-xl text-4xl font-semibold tracking-[-.05em] sm:text-5xl">
            Votre équipe retrouve le même espace, simplement.
          </h2>
          <p className="mt-5 max-w-lg text-base leading-7 text-[#5f6d64]">
            Le travail reste local dans l’application. Le compte sécurisé sert à
            l’abonnement, aux accès de l’équipe et au coffre documentaire choisi
            par l’entreprise.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              [
                ShieldCheck,
                'Session protégée',
                'Cookies HttpOnly et renouvellement contrôlé.',
              ],
              [
                Building2,
                'Équipe sans supplément',
                'Collaborateurs et comptable dans la même entreprise.',
              ],
              [
                DatabaseZap,
                'Données maîtrisées',
                'Aucun jeu de données fictif dans votre espace.',
              ],
            ].map(([Icon, title, description]) => {
              const ItemIcon = Icon as typeof ShieldCheck;
              return (
                <div
                  key={String(title)}
                  className="flex items-start gap-3 rounded-2xl border border-[#d9ddd6] bg-white/65 p-4 backdrop-blur-sm"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#e7f0e9] text-[#2f6649]">
                    <ItemIcon className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{String(title)}</p>
                    <p className="mt-1 text-xs leading-5 text-[#6b766f]">
                      {String(description)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <ZentraAuthForm
          returnTo={returnTo}
          sitesSignInUrl={chatGPTSignInPath(returnTo)}
          initialError={confirmationError}
        />
      </div>
    </main>
  );
}

function confirmationErrorMessage(value: string | undefined) {
  if (!value) return '';
  if (value === 'navigateur_different') {
    return 'Ce lien doit être ouvert dans le même navigateur que celui utilisé pour créer le compte. Recommencez l’inscription.';
  }
  if (value === 'lien_refuse' || value === 'code_invalide') {
    return 'Ce lien de confirmation est invalide ou a expiré. Recommencez l’inscription.';
  }
  return 'La confirmation n’a pas pu être terminée. Recommencez l’inscription pour recevoir un nouveau lien.';
}
