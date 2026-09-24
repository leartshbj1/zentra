import type { Metadata } from 'next';
import {
  ArrowRight,
  ChevronDown,
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
  'Nom, coordonnées et activité partagés pour rejoindre une entreprise',
  'État de l’abonnement et de la licence',
  'PDF placés volontairement dans le coffre partagé',
  'Fichiers joints aux projets connectés à l’entreprise',
  'Base complète, salaires, logo et pièces jointes de l’entreprise partagée',
  'Base complète et pièces jointes lorsque la sauvegarde distante est activée',
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
      <main id="contenu" tabIndex={-1} className="security-page polished-page">
        <section className="page-intro page-width">
          <h1>
            Vos données.
            <br />
            <span>En toute transparence.</span>
          </h1>
          <p>
            Ce qui reste sur votre appareil, ce qui est partagé
            <br />
            et les choix qui vous appartiennent.
          </p>
        </section>
        <section
          className="page-width security-overview"
          aria-label="Où se trouvent vos données"
        >
          <article>
            <HardDrive size={30} strokeWidth={1.5} aria-hidden="true" />
            <h2>Sur votre appareil.</h2>
            <p>
              Gestion conserve une copie de travail locale. Après activation,
              les fonctions locales n’exigent pas une connexion permanente.
            </p>
            <details>
              <summary>
                Les données concernées <ChevronDown size={18} />
              </summary>
              <ul>
                {localData.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          </article>
          <article>
            <Cloud size={30} strokeWidth={1.5} aria-hidden="true" />
            <h2>Avec votre entreprise.</h2>
            <p>
              La connexion permet de partager les changements enregistrés avec
              les membres autorisés, et d’utiliser les services en ligne
              activés.
            </p>
            <details>
              <summary>
                Les données concernées <ChevronDown size={18} />
              </summary>
              <ul>
                {onlineData.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          </article>
        </section>
        <section
          className="page-section page-width security-details"
          aria-label="Comprendre les protections"
        >
          <details className="page-detail">
            <summary>
              Les protections de votre compte
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="security-detail-content">
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
                      className="interactive-card rounded-[1.6rem] border border-[#dce1de] bg-white p-6 sm:p-7"
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
            </div>
          </details>
          <details className="page-detail">
            <summary>
              Vos sauvegardes et vos archives
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="security-detail-content">
              <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.76fr_1.24fr]">
                <div>
                  <p className="site-eyebrow">Sauvegarde & conservation</p>
                  <h2 className="site-section-title mt-4">
                    Votre sauvegarde reste entre vos mains.
                  </h2>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <article className="rounded-[1.5rem] border border-[#dedee3] bg-white p-6">
                    <Database className="size-5 text-[#3f7454]" />
                    <h3 className="mt-5 text-xl font-semibold">
                      Sauvegarde locale
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-[#657068]">
                      Zentra peut créer et restaurer une sauvegarde complète.
                      Vous choisissez son emplacement et devez conserver
                      régulièrement une copie externe, puis tester sa
                      restauration.
                    </p>
                  </article>
                  <article className="rounded-[1.5rem] border border-[#dce1de] bg-[#f5f6f7] p-6">
                    <FileCheck2 className="size-5 text-[#225b40]" />
                    <h3 className="mt-5 text-xl font-semibold">
                      Coffre PDF optionnel
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-[#626b66]">
                      Le coffre conserve les versions de PDF demandées avec une
                      échéance calculée. Il ne sauvegarde jamais toute la base
                      SQLite et n’est pas présenté comme un support WORM
                      certifié.
                    </p>
                  </article>
                  <article className="rounded-[1.5rem] border border-[#dedee3] bg-white p-6 sm:col-span-2">
                    <Database className="size-5 text-[#3f7454]" />
                    <h3 className="mt-5 text-xl font-semibold">
                      Sauvegarde complète distante
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-[#657068]">
                      Le titulaire et les administrateurs peuvent envoyer la
                      base de l’entreprise et ses pièces jointes, y compris les
                      salaires. La copie quotidienne s’active sur demande et
                      nécessite que l’application soit ouverte et connectée. Les
                      empreintes des fichiers et l’intégrité de la base sont
                      contrôlées lors de la restauration. Les sauvegardes
                      restent récupérables dans le compte après résiliation.
                    </p>
                  </article>
                  <div className="flex gap-3 rounded-[1.4rem] border border-[#cfe0d4] bg-[#edf5ef] p-5 text-sm leading-6 text-[#315a43] sm:col-span-2">
                    <ShieldCheck className="mt-0.5 size-5 shrink-0" />
                    <p>
                      Gardez une copie externe et vérifiez sa restauration. Les
                      sauvegardes complètes couvrent la base métier et ses
                      pièces jointes ; elles ne fusionnent pas les modifications
                      faites séparément sur plusieurs appareils.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </details>
          <details className="page-detail">
            <summary>
              Les services qui traitent vos données
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="security-detail-content">
              <div className="mx-auto max-w-7xl">
                <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr]">
                  <div>
                    <p className="site-eyebrow">Prestataires et localisation</p>
                    <h2 className="site-section-title mt-4">
                      La chaîne technique actuelle.
                    </h2>
                  </div>
                  <div className="overflow-hidden rounded-[1.6rem] border border-[#dedee3] bg-white">
                    {[
                      [
                        'Supabase',
                        'Authentification, coordonnées et partage continu de la base complète à partir de la version 1.67, sur le projet Supabase créé dans la région Zurich (eu-central-2). Les révisions et fichiers restent privés et chaque requête vérifie le membre, son rôle et son appareil. Le partage inclut les salaires et exige une activation explicite.',
                      ],
                      [
                        'D1 / R2',
                        'Stockage des accès, des archives PDF, des fichiers privés des projets et des sauvegardes complètes activées par l’entreprise. Les fichiers des projets se synchronisent entre appareils autorisés. La localisation du projet Supabase ne garantit pas un stockage de ces données D1/R2 en Suisse.',
                      ],
                      [
                        'Stripe',
                        'Paiement de l’abonnement et facturation Stripe lorsque la souscription est activée. Les données de carte ne transitent pas par le formulaire Zentra.',
                      ],
                      [
                        'Sites',
                        'Hébergement du site public et de ses API, accessibles sur zentraapp.ch.',
                      ],
                    ].map(([name, text]) => (
                      <div
                        key={name}
                        className="grid gap-2 border-b border-[#e5e1d8] p-5 last:border-b-0 sm:grid-cols-[8rem_1fr] sm:p-6"
                      >
                        <strong className="text-[#294235]">{name}</strong>
                        <p className="text-sm leading-6 text-[#657068]">
                          {text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-5 rounded-[1.4rem] border border-[#dedee3] bg-[#eeeef0] p-5 text-sm leading-6 text-[#626c65]">
                  Supabase gère l’authentification et les révisions privées de
                  l’entreprise partagée. La comptabilité, les documents, les
                  salaires et les réglages sont reçus automatiquement par ses
                  membres autorisés. Une réception attend la fermeture des
                  formulaires en cours. Deux copies modifiées simultanément
                  peuvent nécessiter une résolution de conflit ; les
                  modifications locales sont sauvegardées. Les rôles, les
                  appareils, les archives et les services historiques de
                  fichiers utilisent également D1/R2.
                </div>
              </div>
            </div>
          </details>
          <details className="page-detail">
            <summary>
              Installation, signatures et certifications
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="security-detail-content">
              <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
                <article>
                  <h2 className="mt-4 text-3xl font-semibold tracking-[-.045em]">
                    Une installation clairement documentée.
                  </h2>
                  <p className="mt-5 text-sm leading-7 text-white/72">
                    Les mises à jour intégrées vérifient une signature de
                    paquet. L’installateur Windows public n’est pas encore signé
                    avec un certificat Authenticode et peut afficher « éditeur
                    inconnu ». Le build macOS est disponible en accès anticipé
                    avec une signature ad hoc et sans notarisation Apple. Sur
                    les deux plateformes, les mises à jour intégrées vérifient
                    la signature du paquet avant de proposer son installation.
                    Sur Mac, le Trousseau peut demander une nouvelle
                    autorisation d’accès après une mise à jour de cette version
                    en accès anticipé.
                  </p>
                  <a
                    href="/download"
                    className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-[#c2ddcf]"
                  >
                    Voir les informations d’installation{' '}
                    <ArrowRight className="size-4" />
                  </a>
                </article>
                <article className="rounded-[1.7rem] border border-white/14 bg-white/[.06] p-6 sm:p-8">
                  <LockKeyhole className="size-6 text-[#c2ddcf]" />
                  <h2 className="mt-6 text-2xl font-semibold">
                    Périmètre actuel
                  </h2>
                  <ul className="mt-5 grid gap-3 text-sm leading-6 text-white/72">
                    <li>
                      Distribution Windows avec mise à jour signée; certificat
                      Authenticode à venir.
                    </li>
                    <li>
                      macOS disponible en accès anticipé; signature Developer ID
                      et notarisation à venir.
                    </li>
                    <li>
                      Authentification Supabase reliée à la région Zurich; API
                      compte/archives en transition.
                    </li>
                    <li>
                      La validation Swissdec, AFC ou Olico reste un processus
                      distinct.
                    </li>
                  </ul>
                </article>
              </div>
            </div>
          </details>
        </section>
        <section className="page-finish page-width">
          <h2>Une question sur vos données ?</h2>
          <p>Nous sommes là pour vous répondre.</p>
          <div className="page-actions">
            <a
              className="page-primary"
              href="mailto:info@zentraapp.ch?subject=Zentra%20-%20données%20et%20sécurité"
            >
              Contacter Zentra <ArrowRight size={17} />
            </a>
            <a className="page-text-link" href="/confidentialite">
              Lire la confidentialité <ArrowRight size={17} />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
