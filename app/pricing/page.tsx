import type { Metadata } from 'next';
import { ArrowRight, Check, CreditCard, Users } from 'lucide-react';
import { PurchaseButton } from '@/components/purchase-button';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Tarifs — 50 CHF par mois, prix fixe',
  description:
    'Zentra coûte 50 CHF par mois pour l’entreprise, avec les fonctionnalités, les mises à jour et les collaborateurs inclus.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Zentra — 50 CHF par mois, prix fixe',
    description:
      'Un abonnement d’entreprise simple, sans module ni collaborateur facturé en supplément.',
    url: '/pricing',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const included = [
  'Facturation suisse et QR-factures',
  'Ventes, commandes et livraisons',
  'Achats, fournisseurs et stock',
  'Comptabilité, TVA et clôture contrôlée',
  'Projets, heures et agenda',
  'Préparation locale des salaires',
  'Import bancaire CAMT supervisé',
  'Fonctionnalités de l’offre Zentra incluses',
  'Collaborateurs et comptable sans supplément',
  'Mises à jour de Zentra incluses',
] as const;

const questions = [
  [
    'Le prix augmente-t-il avec le nombre de collaborateurs ?',
    'Non. Le prix de l’offre Zentra reste fixé à 50 CHF par mois pour l’entreprise, sans supplément par collaborateur. Les rôles de compte n’impliquent toutefois pas une synchronisation générale de la base métier locale entre les appareils.',
  ],
  [
    'Faut-il acheter des modules séparément ?',
    'Non. Les fonctionnalités de l’offre Zentra sont incluses. Il n’existe pas de catalogue de modules payants à débloquer séparément.',
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
        className="min-h-screen overflow-x-clip bg-[#f6f4ef] text-[#18221d]"
      >
        <section className="px-5 pb-14 pt-12 text-center sm:pb-20 sm:pt-20 lg:px-8">
          <div className="mx-auto max-w-4xl">
            <p className="site-eyebrow">Tarif Zentra</p>
            <h1 className="mt-5 text-balance text-[2.8rem] font-semibold leading-[.98] tracking-[-.06em] sm:text-6xl lg:text-7xl">
              Un prix simple.
              <br />
              <span className="text-[#b86b16]">Toute l’entreprise.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#657068]">
              Pas de grille par utilisateur. Pas de fonction essentielle cachée
              derrière un supplément.
            </p>
          </div>
        </section>

        <section className="px-5 pb-16 sm:pb-24 lg:px-8" data-reveal>
          <article className="mx-auto grid max-w-6xl overflow-hidden rounded-[2rem] border border-[#d6d2c8] bg-white shadow-[0_32px_90px_rgba(28,53,39,.11)] lg:grid-cols-[1.08fr_.92fr]">
            <div className="p-7 sm:p-10 lg:p-12">
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                <strong className="text-6xl tracking-[-.065em] sm:text-7xl">
                  50 CHF
                </strong>
                <span className="pb-2 text-base text-[#667169]">/ mois</span>
              </div>
              <p className="mt-4 text-sm font-semibold uppercase tracking-[.11em] text-[#356249]">
                Prix fixe pour l’entreprise
              </p>
              <p className="mt-5 max-w-2xl text-base leading-7 text-[#657068]">
                Toutes les fonctionnalités de l’offre et les collaborateurs sont
                inclus. Zentra ne facture ni siège supplémentaire, ni option
                pour débloquer une fonction.
              </p>

              <ul className="mt-9 grid gap-3 sm:grid-cols-2">
                {included.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm leading-6"
                  >
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[#e5efe7] text-[#315f47]">
                      <Check className="size-3" />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col justify-between bg-[#173d2c] p-7 text-white sm:p-10 lg:p-12">
              <div>
                <CreditCard className="size-7 text-[#efb157]" />
                <h2 className="mt-7 text-2xl font-semibold tracking-[-.035em]">
                  Abonnement et licence liés à votre compte.
                </h2>
                <p className="mt-4 text-sm leading-7 text-white/72">
                  Le paiement passe par une page Stripe hébergée. L’accès peut
                  ensuite être associé à l’entreprise et à ses appareils
                  autorisés.
                </p>
                <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/12 bg-white/[.06] p-4 text-sm leading-6 text-white/72">
                  <Users className="mt-0.5 size-4 shrink-0 text-[#efb157]" />
                  <p>
                    Les collaborateurs sont inclus pour les accès Zentra. La
                    base métier reste locale et n’est pas synchronisée
                    automatiquement entre tous les ordinateurs.
                  </p>
                </div>
              </div>
              <div className="mt-9">
                <PurchaseButton compact />
                <p className="mt-4 text-center text-xs leading-5 text-white/55">
                  Le bouton reflète l’état réel du paiement. La souscription est
                  encore limitée à la recette privée tant que Stripe Tax et les
                  informations légales ne sont pas finalisés.
                </p>
              </div>
            </div>
          </article>
        </section>

        <section
          className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
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
