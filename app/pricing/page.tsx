import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { PricingPlans } from '@/components/pricing-plans';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { CompleteBanner } from '@/components/complete-banner';

export const metadata: Metadata = {
  title: 'Tarifs — Solo, Start et Pro dès 49 CHF par mois',
  description:
    'Solo 49 CHF pour 1 personne, Start 59 CHF pour 3 et Pro 89 CHF pour 10. Fonctions de gestion incluses, titulaire compris. Zentra Automation est une option séparée à 15 CHF/mois.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Zentra — Solo 49 CHF, Start 59 CHF, Pro 89 CHF',
    description:
      'Trois formules selon la taille de votre équipe, avec les mêmes fonctions de gestion.',
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
    'Les fonctions de gestion décrites dans ces trois formules sont incluses. Zentra Automation est une option facultative à 15 CHF/mois par entreprise. Le nombre de personnes qui peuvent se connecter est la seule différence. Les fiches de salariés dans la paie ne consomment pas de place. Zentra Support est un produit avec un abonnement distinct.',
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
      <main id="contenu" tabIndex={-1} className="pricing-page polished-page">
        <section className="page-intro page-width">
          <h1>
            La même gestion.
            <br />
            <span>À la taille de votre équipe.</span>
          </h1>
          <p>
            1, 3 ou 10 personnes, titulaire compris.
            <br />
            Choisissez votre formule. Toutes les fonctions de Gestion sont
            incluses.
          </p>
          <p className="page-caption">
            Automation en option à 15 CHF/mois par entreprise.
          </p>
        </section>

        <section className="px-5 pb-16 sm:pb-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-6xl">
            <PricingPlans />
          </div>
        </section>

        <CompleteBanner />
        <section
          className="border-y border-[#dce1de] bg-[#ffffff] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[.75fr_1.25fr]">
            <div>
              <p className="site-eyebrow">Questions de prix</p>
              <h2 className="site-section-title mt-4">
                Aucune petite ligne cachée.
              </h2>
              <a
                href="mailto:info@zentraapp.ch?subject=Zentra%20-%20question%20tarif"
                className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#315f47]"
              >
                Poser une question <ArrowRight className="size-4" />
              </a>
            </div>
            <div className="divide-y divide-[#dce1de]">
              {questions.map(([question, answer]) => (
                <details key={question} className="group py-3">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-2 font-semibold">
                    <span>{question}</span>
                    <span className="text-xl font-light text-[#225b40] transition-transform group-open:rotate-45">
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
          <div className="mx-auto flex max-w-6xl flex-col gap-7 rounded-[2rem] bg-[#e9f0ec] p-7 text-[#173d2c] sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-.045em]">
                Découvrez Zentra avant de choisir.
              </h2>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <a
                href="/demo-facture"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
              >
                Visiter l’app <ArrowRight className="size-4" />
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
