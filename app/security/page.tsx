import type { Metadata } from 'next';
import {
  ArrowRight,
  Cloud,
  Database,
  FileCheck2,
  HardDrive,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Sécurité & données — fonctionnement local-first',
  description:
    'Comprendre ce qui reste sur votre ordinateur, ce qui utilise les services Zentra et quelles responsabilités de sauvegarde restent à l’entreprise.',
  alternates: { canonical: '/security' },
  openGraph: {
    title: 'Zentra — Sécurité & données',
    description:
      'Une description claire de l’architecture local-first, du compte et du coffre PDF Zentra.',
    url: '/security',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const localData = [
  'Clients et fournisseurs',
  'Employés, salaires et paramètres de paie',
  'Projets, tâches, agenda et heures',
  'Devis, factures et documents de travail',
  'Import bancaire et rapprochements',
  'Écritures comptables, TVA et clôtures',
] as const;

const onlineData = [
  'Adresse e-mail, nom affiché et session du compte',
  'Entreprise, rôles, invitations et appareils autorisés',
  'État de l’abonnement et de la licence',
  'PDF placés volontairement dans le coffre partagé',
] as const;

const safeguards = [
  {
    icon: KeyRound,
    title: 'Compte séparé des données métier',
    text: 'Supabase Auth gère actuellement l’identité et la session. Les jetons utilisés par le site sont placés dans des cookies HttpOnly; la base métier complète n’est pas copiée par ce mécanisme.',
  },
  {
    icon: FileCheck2,
    title: 'Archives versionnées',
    text: 'Chaque PDF archivé reçoit une empreinte SHA-256, une version et une échéance de conservation calculée. Une correction ajoute une version au lieu d’écraser l’original.',
  },
  {
    icon: ShieldCheck,
    title: 'Licence et mises à jour vérifiées',
    text: 'La licence et les paquets de mise à jour utilisent des signatures contrôlées par l’application avant leur acceptation.',
  },
] as const;

export default function SecurityPage() {
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
        <section className="px-5 pb-16 pt-12 sm:pb-24 sm:pt-20 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="site-eyebrow">Sécurité & données</p>
              <h1 className="mt-5 max-w-4xl text-balance text-[2.8rem] font-semibold leading-[.98] tracking-[-.06em] sm:text-6xl lg:text-7xl">
                Local par défaut.
                <br />
                <span className="text-[#b86b16]">Transparent en ligne.</span>
              </h1>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#657068] lg:justify-self-end">
              Zentra manipule des informations sensibles. Cette page décrit ce
              qui est réellement en place, ce qui dépend d’un service en ligne
              et ce qui reste sous la responsabilité de l’entreprise.
            </p>
          </div>
        </section>

        <section
          className="border-y border-[#d7ddd8] bg-[#edf3ef] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <div className="grid overflow-hidden rounded-[2rem] border border-[#ccd7cf] bg-white shadow-[0_26px_80px_rgba(28,53,39,.08)] lg:grid-cols-2">
              <article className="p-7 sm:p-10">
                <span className="grid size-12 place-items-center rounded-2xl bg-[#173d2c] text-white">
                  <HardDrive className="size-5" />
                </span>
                <p className="mt-7 text-xs font-bold uppercase tracking-[.13em] text-[#3f7454]">
                  Reste sur l’ordinateur
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-.045em]">
                  La base métier locale
                </h2>
                <p className="mt-4 text-sm leading-7 text-[#657068]">
                  L’application utilise SQLite et un stockage de fichiers géré
                  localement. Elle peut continuer ses fonctions métier sans
                  connexion permanente après activation.
                </p>
                <ul className="mt-7 grid gap-2.5 text-sm leading-6 text-[#425148] sm:grid-cols-2">
                  {localData.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#4e8b63]" />
                      {item}
                    </li>
                  ))}
                </ul>
              </article>

              <article className="border-t border-[#d7ddd8] bg-[#173d2c] p-7 text-white sm:p-10 lg:border-l lg:border-t-0">
                <span className="grid size-12 place-items-center rounded-2xl bg-[#efb157] text-[#173d2c]">
                  <Cloud className="size-5" />
                </span>
                <p className="mt-7 text-xs font-bold uppercase tracking-[.13em] text-[#efb157]">
                  Utilise un service en ligne
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-.045em]">
                  Le compte et le coffre choisi
                </h2>
                <p className="mt-4 text-sm leading-7 text-white/70">
                  Le serveur ne synchronise pas automatiquement la base métier.
                  Il traite les accès, l’abonnement et les documents que vous
                  envoyez volontairement au coffre.
                </p>
                <ul className="mt-7 grid gap-2.5 text-sm leading-6 text-white/78 sm:grid-cols-2">
                  {onlineData.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#efb157]" />
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl">
              <p className="site-eyebrow">Protections présentes</p>
              <h2 className="site-section-title mt-4">
                Des protections concrètes et vérifiables.
              </h2>
            </div>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {safeguards.map(({ icon: Icon, title, text }) => (
                <article
                  key={title}
                  className="interactive-card rounded-[1.6rem] border border-[#ded9ce] bg-white p-6 sm:p-7"
                >
                  <span className="grid size-11 place-items-center rounded-2xl bg-[#e7efe9] text-[#315f47]">
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-6 text-xl font-semibold tracking-[-.025em]">
                    {title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-[#657068]">
                    {text}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.76fr_1.24fr]">
            <div>
              <p className="site-eyebrow">Sauvegarde & conservation</p>
              <h2 className="site-section-title mt-4">
                Votre sauvegarde reste entre vos mains.
              </h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <article className="rounded-[1.5rem] border border-[#d9d4c9] bg-white p-6">
                <Database className="size-5 text-[#3f7454]" />
                <h3 className="mt-5 text-xl font-semibold">
                  Sauvegarde locale
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#657068]">
                  Zentra peut créer et restaurer une sauvegarde complète. Vous
                  choisissez son emplacement et devez conserver régulièrement
                  une copie externe, puis tester sa restauration.
                </p>
              </article>
              <article className="rounded-[1.5rem] border border-[#e0d4c2] bg-[#fff8ec] p-6">
                <FileCheck2 className="size-5 text-[#a66b1f]" />
                <h3 className="mt-5 text-xl font-semibold">
                  Coffre PDF optionnel
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#675f54]">
                  Le coffre conserve les versions de PDF demandées avec une
                  échéance calculée. Il ne sauvegarde jamais toute la base
                  SQLite et n’est pas présenté comme un support WORM certifié.
                </p>
              </article>
              <div className="flex gap-3 rounded-[1.4rem] border border-[#cfe0d4] bg-[#edf5ef] p-5 text-sm leading-6 text-[#315a43] sm:col-span-2">
                <ShieldCheck className="mt-0.5 size-5 shrink-0" />
                <p>
                  Une copie externe régulière complète le stockage local. Le
                  coffre de factures conserve les PDF choisis, tandis que la
                  sauvegarde Zentra couvre l’ensemble de la base métier.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr]">
              <div>
                <p className="site-eyebrow">Prestataires et localisation</p>
                <h2 className="site-section-title mt-4">
                  La chaîne technique actuelle.
                </h2>
              </div>
              <div className="overflow-hidden rounded-[1.6rem] border border-[#d9d4c9] bg-white">
                {[
                  [
                    'Supabase',
                    'Authentification du compte. Le projet actuel est en Ohio; une migration contrôlée vers la région Supabase de Zurich est en préparation.',
                  ],
                  [
                    'D1 / R2',
                    'Métadonnées de compte et PDF archivés sur demande pendant la migration serveur. La base métier locale n’y est pas synchronisée.',
                  ],
                  [
                    'Stripe',
                    'Paiement de l’abonnement et facturation Stripe lorsque la souscription est activée. Les données de carte ne transitent pas par le formulaire Zentra.',
                  ],
                  [
                    'Sites',
                    'Hébergement transitoire du site public. La future adresse personnalisée sera pilotée par la configuration et le DNS.',
                  ],
                ].map(([name, text]) => (
                  <div
                    key={name}
                    className="grid gap-2 border-b border-[#e5e1d8] p-5 last:border-b-0 sm:grid-cols-[8rem_1fr] sm:p-6"
                  >
                    <strong className="text-[#294235]">{name}</strong>
                    <p className="text-sm leading-6 text-[#657068]">{text}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-5 rounded-[1.4rem] border border-[#d9d4c9] bg-[#f0eee8] p-5 text-sm leading-6 text-[#626c65]">
              Le basculement de la couche compte/archives vers Supabase est en
              cours. L’authentification est reliée; le passage complet à Zurich
              sera effectué après copie et contrôle des comptes, des règles et
              du coffre, sans interrompre le projet actuel avant validation.
            </div>
          </div>
        </section>

        <section
          className="bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
            <article>
              <p className="text-xs font-bold uppercase tracking-[.13em] text-[#efb157]">
                Distribution actuelle
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-.045em]">
                Une installation clairement documentée.
              </h2>
              <p className="mt-5 text-sm leading-7 text-white/72">
                Les mises à jour intégrées vérifient une signature de paquet.
                L’installateur Windows public n’est pas encore signé avec un
                certificat Authenticode et peut afficher « éditeur inconnu ». Le
                build macOS est un aperçu privé signé ad hoc, sans notarisation
                Apple ni canal de mise à jour public.
              </p>
              <a
                href="/download"
                className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#efb157]"
              >
                Voir les informations d’installation{' '}
                <ArrowRight className="size-4" />
              </a>
            </article>
            <article className="rounded-[1.7rem] border border-white/14 bg-white/[.06] p-6 sm:p-8">
              <LockKeyhole className="size-6 text-[#efb157]" />
              <h2 className="mt-6 text-2xl font-semibold">
                Périmètre actuel
              </h2>
              <ul className="mt-5 grid gap-3 text-sm leading-6 text-white/72">
                <li>Distribution Windows avec mise à jour signée; certificat Authenticode à venir.</li>
                <li>Aperçu macOS privé; signature Developer ID et notarisation à venir.</li>
                <li>Migration Supabase vers Zurich préparée séparément du projet actif.</li>
                <li>La validation Swissdec, AFC ou Olico reste un processus distinct.</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="site-eyebrow">Éditeur et contact</p>
              <h2 className="site-section-title mt-4">
                Une question sur vos données ?
              </h2>
            </div>
            <div className="rounded-[1.6rem] border border-[#d9d4c9] bg-white p-6 sm:p-8">
              {/* TODO(legal): ajouter raison sociale, forme juridique, adresse, UID/IDE
                  et responsable du traitement dès que l'éditeur les aura fournis. */}
              <p className="text-sm leading-7 text-[#657068]">
                Pour une question relative au compte ou aux données, contactez
                Zentra à{' '}
                <a
                  href="mailto:leartshabija@gmail.com?subject=Zentra%20-%20données%20et%20sécurité"
                  className="font-semibold text-[#315f47] underline underline-offset-4"
                >
                  leartshabija@gmail.com
                </a>
                .
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
