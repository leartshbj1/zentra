import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { PricingPlans } from '@/components/pricing-plans';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Tarifs — Solo, Start et Pro dès 49 CHF par mois',
  description:
    'Solo 49 CHF pour 1 personne, Start 59 CHF pour 3 et Pro 89 CHF pour 10. Toutes les fonctions actuelles et futures incluses, titulaire compris.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Zentra — Solo 49 CHF, Start 59 CHF, Pro 89 CHF',
    description:
      'Trois formules selon la taille de votre équipe, avec les mêmes fonctionnalités actuelles et futures.',
    url: '/pricing',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const questions = [
  [
    'Le prix augmente-t-il avec le nombre de collaborateurs ?',
    'Choisissez Solo à 49 CHF pour 1 personne, Start à 59 CHF pour 3 personnes ou Pro à 89 CHF pour 10 personnes. Le titulaire, les collaborateurs, les comptables et les accès en lecture seule comptent dans ce total. Les invitations en attente réservent une place. Plusieurs appareils peuvent être liés à une même personne.',
  ],
  [
    'Faut-il acheter des modules séparément ?',
    'Toutes les fonctions actuelles et futures sont incluses dans les trois formules. Le nombre de personnes qui peuvent se connecter est la seule différence. Les fiches de salariés dans la paie ne consomment pas de place.',
  ],
  [
    'Comment fonctionne la résiliation ?',
    'L’abonnement est renouvelé mensuellement. Lorsque Stripe est activé pour votre compte, le portail client permet de gérer le moyen de paiement, les factures Stripe et la résiliation pour la fin de la période en cours.',
  ],
  [
    'Le téléchargement déclenche-t-il un paiement ?',
    'Non. Télécharger l’installateur ne crée aucun abonnement. Une licence active est ensuite nécessaire pour utiliser l’application complète.',
  ],
] as const;

export default function PricingPage() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main
        id="contenu"
        tabIndex={-1}
        className="min-h-screen overflow-x-clip bg-[#f5f5f7] text-[#18221d]"
      >
        <section className="px-5 pb-14 pt-12 text-center sm:pb-20 sm:pt-20 lg:px-8">
          <div className="mx-auto max-w-4xl">
            <p className="site-eyebrow">Tarif Zentra</p>
            <h1 className="mt-5 text-balance text-[2.8rem] font-semibold leading-[.98] tracking-[-.06em] sm:text-6xl lg:text-7xl">
              Votre équipe choisit le rythme.
              <br />
              <span className="text-[#b86b16]">Tout Zentra est inclus.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#657068]">
              Solo, Start ou Pro : choisissez le nombre de personnes qui se
              connectent. Toutes les fonctionnalités actuelles et futures vous
              accompagnent.
            </p>
          </div>
        </section>

        <section className="px-5 pb-16 sm:pb-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-6xl">
            <PricingPlans />
          </div>
        </section>

        <section
          className="border-y border-[#ded9ce] bg-[#ffffff] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[.75fr_1.25fr]">
            <div>
              <p className="site-eyebrow">Questions de prix</p>
              <h2 className="site-section-title mt-4">
                Aucune petite ligne cachée.
              </h2>
              <a
                href="mailto:leartshabija@gmail.com?subject=Zentra%20-%20question%20tarif"
                className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#315f47]"
              >
                Poser une question <ArrowRight className="size-4" />
              </a>
            </div>
            <div className="divide-y divide-[#ded9ce]">
              {questions.map(([question, answer]) => (
                <details key={question} className="group py-3">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-2 font-semibold">
                    <span>{question}</span>
                    <span className="text-xl font-light text-[#a66b1f] transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="max-w-3xl pb-3 pt-1 text-sm leading-7 text-[#657068]">
                    {answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto flex max-w-6xl flex-col gap-7 rounded-[2rem] bg-[#e7a33a] p-7 text-[#173d2c] sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.13em]">
                Voir avant de choisir
              </p>
              <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-.045em]">
                Essayez une facture dans votre navigateur, sans compte.
              </h2>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <a
                href="/demo-facture"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
              >
                Essayer Zentra <ArrowRight className="size-4" />
              </a>
              <a
                href="/download"
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-[#173d2c]/20 px-6 text-sm font-semibold"
              >
                Télécharger
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
