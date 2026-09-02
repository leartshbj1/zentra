import {
  ArrowRight,
  Banknote,
  BarChart3,
  BellRing,
  BookOpenCheck,
  BriefcaseBusiness,
  Building2,
  Check,
  CircleStop,
  Clock3,
  Database,
  FileCheck2,
  FileDown,
  FolderKanban,
  HardDrive,
  History,
  Landmark,
  Laptop,
  LockKeyhole,
  MailCheck,
  Plus,
  Package,
  Receipt,
  ShieldCheck,
  Users,
  WalletCards,
  WifiOff,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { BrandWordmark } from '@/components/brand-mark';
import { BusinessOperationsDemo } from '@/components/business-operations-demo';
import { CapabilityStory } from '@/components/capability-story';
import { HeroDashboard } from '@/components/hero-dashboard';
import { MobileNavigation } from '@/components/mobile-navigation';
import { PayrollLocalDemo } from '@/components/payroll-local-demo';
import { ProductShowcase } from '@/components/product-showcase';
import { PurchaseButton } from '@/components/purchase-button';
import { RecurrenceDemo } from '@/components/recurrence-demo';
import { ReminderDemo } from '@/components/reminder-demo';
import { VatClosingDemo } from '@/components/vat-closing-demo';
import { ProductFlowDemo } from './product-flow-demo';
import { ZENTRA_VERSION } from '@/lib/downloads';
import { cn } from '@/lib/utils';

const features = [
  {
    icon: FolderKanban,
    title: 'Projets, chantiers & clients',
    text: 'Le module adapte ses libellés au secteur choisi et suit dates, budget, avancement, temps, coûts et rentabilité.',
  },
  {
    icon: Package,
    title: 'Produits, services & stock',
    text: 'Un catalogue local avec prix, TVA, seuils et historique des mouvements, réutilisable dans vos documents.',
  },
  {
    icon: FileCheck2,
    title: 'Devis, commandes & livraisons',
    text: 'Un devis avec produits devient une commande avec réservation et BL. Une prestation simple peut rester en facture directe.',
  },
  {
    icon: Receipt,
    title: 'Factures & paiements',
    text: 'Factures uniques ou récurrentes supervisées, situations, échéances, QR-facture suisse, avoirs et montants réellement encaissés.',
  },
  {
    icon: BellRing,
    title: 'Relances supervisées',
    text: 'Trois niveaux configurables, solde revérifié après chaque paiement et historique local avant toute décision d’envoi.',
  },
  {
    icon: Clock3,
    title: 'Temps de travail',
    text: 'Chronomètre ou saisie manuelle, par collaborateur et par projet ou chantier, avec historique vérifiable.',
  },
  {
    icon: Building2,
    title: 'Fournisseurs & achats',
    text: 'Commandes, réceptions partielles, factures, avoirs, rapprochement à trois pièces et paiements.',
  },
  {
    icon: WalletCards,
    title: 'Dépenses & rentabilité',
    text: 'Matériaux, sous-traitance, locations et coût horaire alimentent une marge fondée sur vos saisies.',
  },
  {
    icon: Users,
    title: 'Équipe & salaires',
    text: 'Importez d’anciennes fiches, contrôlez les champs proposés localement, suivez les décisions annuelles et générez des PDF détaillés avec vos taux validés.',
  },
  {
    icon: BookOpenCheck,
    title: 'Comptabilité & TVA',
    text: 'Journal, grand livre, bilan, résultat et centre TVA avec export XML eCH-0217 contrôlé.',
  },
  {
    icon: ShieldCheck,
    title: 'Clôture & fiduciaire',
    text: 'Pré-clôture, protection cumulative de l’historique, empreinte des données et dossier ZIP DRAFT ou FINAL.',
  },
];

const localPromises = [
  {
    icon: Database,
    title: 'Base locale',
    text: 'Clients, montants, heures et salaires sont enregistrés dans une base SQLite sur votre ordinateur.',
  },
  {
    icon: WifiOff,
    title: 'Travail hors ligne',
    text: 'Les fonctions métier continuent de fonctionner sans connexion Internet.',
  },
  {
    icon: HardDrive,
    title: 'Sauvegarde maîtrisée',
    text: 'Vous choisissez où créer votre sauvegarde et pouvez la restaurer sur un autre ordinateur.',
  },
  {
    icon: LockKeyhole,
    title: 'Cloud clairement limité',
    text: 'Compte, droits d’accès et PDF que vous archivez volontairement sont les seules données métier hébergées par Zentra.',
  },
];

const sectors = [
  ['A', 'Agriculture, sylviculture et pêche'],
  ['B', 'Industries extractives'],
  ['C', 'Industrie manufacturière'],
  ['D', 'Énergie'],
  ['E', 'Eau, déchets et dépollution'],
  ['F', 'Construction'],
  ['G', 'Commerce'],
  ['H', 'Transports et entreposage'],
  ['I', 'Hébergement et restauration'],
  ['J', 'Édition et contenus'],
  ['K', 'Télécoms, informatique et information'],
  ['L', 'Finance et assurance'],
  ['M', 'Immobilier'],
  ['N', 'Activités spécialisées, scientifiques et techniques'],
  ['O', 'Services administratifs et soutien'],
  ['P', 'Administration publique'],
  ['Q', 'Enseignement'],
  ['R', 'Santé et action sociale'],
  ['S', 'Arts, sports et loisirs'],
  ['T', 'Autres services'],
  ['U', 'Activités des ménages'],
  ['V', 'Organisations extraterritoriales'],
];

const capabilityRows = [
  [
    'Clients & dossier 360°',
    'Disponible',
    'Fiche, projets, documents, soldes et archivage local.',
  ],
  [
    'Vente complète',
    'Disponible',
    'Devis accepté, commande, réservation, BL partiel/complet, situation/finale, QR et paiements.',
  ],
  [
    'Relances de factures',
    'Disponible avec validation',
    'Cycle explicite, paiements partiels, aperçu, e-mail prérempli, impression et preuve locale sans envoi automatique.',
  ],
  [
    'Projets & temps',
    'Disponible',
    'Budgets, durées, coûts, rentabilité et heures approuvées à facturer.',
  ],
  [
    'Tâches & jalons',
    'Disponible',
    'Vue par projet, responsables, priorités et échéances; temps manuel ou chronométré lié à une tâche.',
  ],
  [
    'Achats fournisseurs',
    'Disponible',
    'Commande, réception, facture ou avoir, rapprochement, stock, paiement et comptabilisation.',
  ],
  [
    'Banque CAMT',
    'Assisté',
    'Crédits clients et débits fournisseurs proposés, puis confirmés par l’utilisateur.',
  ],
  [
    'Comptabilité',
    'Disponible avec contrôle',
    'Journal, grand livre, balance, bilan et résultat calculés depuis les écritures.',
  ],
  [
    'TVA suisse',
    'Disponible avec validation',
    'Profils datés, classifications explicites, aperçu et XML eCH-0217 v2.0.0 pour import manuel.',
  ],
  [
    'Clôture & dossier fiduciaire',
    'Disponible avec validation',
    'Contrôles, empreinte, verrouillage irréversible et ZIP DRAFT/FINAL avec manifeste SHA-256.',
  ],
  [
    'Paie suisse',
    'Assistée localement',
    'Import OCR/IA local, calculs contrôlés et PDF; Zentra n’est pas certifié Swissdec.',
  ],
  [
    'Import paie multipage',
    'Disponible',
    'PDF jusqu’à 12 pages, texte limité au lot analysé, provenance ouvrable page par page et contrôle humain avant création.',
  ],
  [
    'Catalogue & stock',
    'Disponible',
    'Produits et services réutilisables, réservations, en main/disponible et sortie unique sur BL ou facture directe.',
  ],
  [
    'Compte & collaborateurs',
    'Disponible',
    'Abonnement d’entreprise, rôles propriétaire, administrateur, comptable, membre ou lecture seule, sans supplément par collaborateur.',
  ],
  [
    'Archive de factures 10 ans',
    'Disponible',
    'Copies PDF versionnées, empreinte SHA-256, chaîne de preuves et original conservé; sans prétendre à une certification Olico.',
  ],
  [
    'Correction après émission ou paiement',
    'Disponible',
    'L’original reste intact; Zentra prépare un avoir intégral puis une facture de remplacement avec un motif durable.',
  ],
  [
    'Agenda',
    'Disponible',
    'Échéances, tâches, jalons, factures, devis et rendez-vous réunis dans une vue locale légère.',
  ],
  [
    'Application',
    'Windows · aperçu macOS privé',
    'Application Windows 10/11 x64 disponible. Une version macOS universelle est compilée en privé par GitHub Actions, sans certificat Apple; elle n’est pas encore distribuée au public.',
  ],
] as const;

export default function Home() {
  return (
    <main
      id="contenu"
      tabIndex={-1}
      className="min-h-screen overflow-x-clip bg-[#f6f4ef] text-[#18221d]"
    >
      <a href="#accueil" className="site-skip-link">
        Aller au contenu
      </a>
      <header className="sticky top-0 z-40 border-b border-[#d9d4c9]/75 bg-[#f6f4ef]/92 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-3 lg:px-8">
          <a
            href="#accueil"
            className="flex min-h-11 items-center gap-2.5"
            aria-label="Zentra, accueil"
          >
            <BrandWordmark className="w-[6.9rem]" />
          </a>
          <nav
            className="hidden items-center gap-6 text-sm text-[#4f5c54] lg:flex"
            aria-label="Navigation principale"
          >
            <a
              href="#logiciel"
              className="transition-colors hover:text-[#173d2c]"
            >
              Voir le logiciel
            </a>
            <a
              href="#catalogue-achats"
              className="transition-colors hover:text-[#173d2c]"
            >
              Catalogue & achats
            </a>
            <a
              href="#lot-119"
              className="transition-colors hover:text-[#173d2c]"
            >
              Nouveautés 1.19
            </a>
            <a
              href="#capacites"
              className="transition-colors hover:text-[#173d2c]"
            >
              Capacités
            </a>
            <a
              href="#confidentialite"
              className="transition-colors hover:text-[#173d2c]"
            >
              Local & cloud
            </a>
            <a
              href="/compte"
              className="transition-colors hover:text-[#173d2c]"
            >
              Mon compte
            </a>
            <a href="#tarif" className="transition-colors hover:text-[#173d2c]">
              Tarif
            </a>
            <a
              href="mailto:leartshabija@gmail.com"
              className="transition-colors hover:text-[#173d2c]"
            >
              Contact
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <MobileNavigation />
            <a
              href="/telecharger"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'size-11 rounded-full bg-[#173d2c] px-0 text-white hover:bg-[#24563f] min-[390px]:h-11 min-[390px]:w-auto min-[390px]:px-5',
              )}
            >
              <span className="sr-only min-[390px]:not-sr-only">
                Télécharger Zentra
              </span>
              <FileDown className="size-4 shrink-0" />
            </a>
          </div>
        </div>
      </header>

      <section
        id="accueil"
        className="mx-auto grid w-full max-w-7xl gap-10 px-5 pb-16 pt-9 sm:gap-12 sm:pb-20 sm:pt-14 lg:grid-cols-[.84fr_1.16fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-16"
      >
        <div className="relative z-10">
          <a
            href="#lot-119"
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#d9d5ca] bg-white/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#46604f] transition hover:border-[#b9c7bd] hover:bg-white"
          >
            <span className="local-pulse size-1.5 rounded-full bg-[#4f9b68]" />
            Zentra {ZENTRA_VERSION} · disponible sur Windows
          </a>
          <h1 className="max-w-xl text-balance text-[2.55rem] font-semibold leading-[.98] tracking-[-.055em] min-[380px]:text-5xl sm:text-6xl lg:text-7xl">
            Toute votre entreprise.
            <br />
            <span className="text-[#b86b16]">Une seule vue.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[#667068]">
            Catalogue, devis, factures QR, fournisseurs, achats, import CAMT,
            projets, heures, salaires, comptabilité, TVA et clôture&nbsp;:
            Zentra centralise votre gestion dans une vraie application de
            bureau. Windows est disponible aujourd’hui. Une version macOS
            universelle Intel et Apple Silicon est compilée en privé pour la
            recette, mais n’est pas encore une distribution publique. Vos
            données opérationnelles restent locales. Le compte d’équipe et le
            coffre de factures sont optionnels&nbsp;: seuls ces services utilisent
            le serveur.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a
              href="/telecharger"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-12 rounded-full bg-[#e79b2f] px-6 text-[#1f281f] shadow-[0_10px_30px_rgba(201,117,21,.2)] hover:bg-[#f1aa42]',
              )}
            >
              Télécharger Zentra <ArrowRight className="size-4" />
            </a>
            <a
              href="#logiciel"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'hidden h-12 rounded-full border-[#cfcabf] bg-white/60 px-6 sm:inline-flex',
              )}
            >
              Voir Zentra en action
            </a>
          </div>
          <a
            href="/demo-facture"
            className="mt-4 hidden min-h-11 items-center gap-2 text-sm font-semibold text-[#315e48] underline decoration-[#d59a47] underline-offset-4 sm:inline-flex"
          >
            Essayer le générateur de facture interactif{' '}
            <ArrowRight className="size-4" />
          </a>
          <p className="mt-3 text-sm text-[#5f6962]">
            50 CHF / mois, prix fixe · toutes les fonctions et collaborateurs
            inclus
          </p>
          <div className="mt-6 grid max-w-xl grid-cols-2 gap-2 text-xs font-medium text-[#4f5e55] sm:mt-7 sm:grid-cols-4">
            {[
              ['22', 'secteurs NOGA'],
              ['5 étapes', 'devis → paiement'],
              ['QR', 'facture suisse'],
              ['Local', 'données métier'],
            ].map(([value, label]) => (
              <div
                key={label}
                className="rounded-xl border border-[#ddd9cf] bg-white/55 px-2 py-2.5 sm:px-3"
              >
                <strong className="block text-sm text-[#254333]">
                  {value}
                </strong>
                <span className="mt-0.5 block text-[11px] leading-4 text-[#647168]">
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
        <HeroDashboard />
      </section>

      <section
        id="lot-119"
        className="scroll-mt-24 border-y border-[#d4ddd6] bg-[#edf4ef] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-119-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#37684b]">
                Nouveautés de Zentra {ZENTRA_VERSION}
              </p>
              <h2
                id="lot-119-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Plus simple à suivre, sans automatisme opaque.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#637168] lg:justify-self-end">
              La version 1.19 réunit les échéances dans un agenda local,
              structure l’import local des e-mails fournisseurs exportés et
              prépare la collaboration par rôles. Chaque proposition sensible
              reste à confirmer par l’utilisateur et les données métier restent
              sur l’ordinateur.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                icon: Check,
                eyebrow: 'Agenda local',
                title: 'Toutes les échéances dans une vue claire.',
                text: 'Rendez-vous, tâches, jalons et dates de documents sont réunis sans charger de service externe au démarrage.',
              },
              {
                icon: BookOpenCheck,
                eyebrow: 'Factures reçues',
                title: 'Une boîte fournisseurs à contrôler.',
                text: 'Exportez un message en .eml : Zentra le lit localement avec des règles déterministes, sans IA ni connexion à votre boîte mail, puis prépare un brouillon à confirmer.',
              },
              {
                icon: Users,
                eyebrow: 'Travail en équipe',
                title: 'Des accès adaptés à chaque personne.',
                text: 'Propriétaire, administrateur, comptable, membre ou lecture seule : les rôles encadrent les accès sans supplément par collaborateur.',
              },
              {
                icon: ShieldCheck,
                eyebrow: 'macOS universel',
                title: 'Un aperçu privé pour Intel et Apple Silicon.',
                text: 'GitHub Actions construit un app et un DMG ad hoc sans certificat Apple. Ce lot sert à la recette privée et peut être bloqué par Gatekeeper.',
              },
            ].map(({ icon: Icon, eyebrow, title, text }) => (
              <article
                key={title}
                className="interactive-card rounded-[24px] border border-[#d2ddd4] bg-white/85 p-6 shadow-[0_18px_45px_rgba(41,78,55,.06)]"
              >
                <Icon className="size-6 text-[#397150]" aria-hidden="true" />
                <p className="mt-5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#52745f]">
                  {eyebrow}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-[-.025em] text-[#254333]">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#637168]">{text}</p>
              </article>
            ))}
          </div>

          <div className="mt-5 rounded-[22px] border border-[#d9d1c3] bg-[#fffaf1] p-5 text-sm leading-6 text-[#6f6455]">
            L’aperçu macOS 1.19 n’est ni signé avec un certificat Developer ID,
            ni notarié par Apple. Une diffusion publique fluide attendra ces
            deux étapes; l’artefact actuel est uniquement destiné aux tests
            privés depuis GitHub Actions.
          </div>
        </div>
      </section>

      <section
        id="lot-114"
        className="scroll-mt-24 border-y border-[#d4ddd6] bg-[#edf4ef] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-114-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#37684b]">
                Relances de factures supervisées
              </p>
              <h2
                id="lot-114-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Les relances avancent. Vous gardez le dernier mot.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#637168] lg:justify-self-end">
              Zentra détecte localement les factures échues, prépare le bon
              niveau et revérifie le solde juste avant l’action. Vous relisez le
              document, choisissez le canal et confirmez vous-même l’envoi.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                icon: BellRing,
                eyebrow: 'Cycle simple',
                title: 'Trois niveaux prêts à adapter.',
                text: 'Rappel amical à J+7, première relance à J+21 et dernière relance à J+35, avec délais et textes modifiables.',
              },
              {
                icon: WalletCards,
                eyebrow: 'Solde réel',
                title: 'Les paiements partiels sont déduits.',
                text: 'Le montant ouvert est recalculé avant l’aperçu. Une facture soldée arrête immédiatement le cycle.',
              },
              {
                icon: History,
                eyebrow: 'Preuve locale',
                title: 'Chaque décision reste traçable.',
                text: 'Brouillon, impression confirmée, envoi manuel ou arrêt sont conservés dans un historique immuable.',
              },
              {
                icon: CircleStop,
                eyebrow: 'Aucun automatisme risqué',
                title: 'Ni e-mail ni poursuite sans vous.',
                text: 'Le contrôle fonctionne quand Zentra est ouvert. L’application ne lance jamais seule une démarche de recouvrement.',
              },
            ].map(({ icon: Icon, eyebrow, title, text }) => (
              <article
                key={title}
                className="interactive-card rounded-[24px] border border-[#d2ddd4] bg-white/85 p-6 shadow-[0_18px_45px_rgba(41,78,55,.06)]"
              >
                <Icon className="size-6 text-[#397150]" aria-hidden="true" />
                <p className="mt-5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#52745f]">
                  {eyebrow}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-[-.025em] text-[#294334]">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#627168]">{text}</p>
              </article>
            ))}
          </div>

          <ReminderDemo />

          <div className="mt-5 grid gap-4 rounded-[22px] border border-[#decda8] bg-[#fff7e8] p-5 text-sm leading-6 text-[#6e572f] lg:grid-cols-[1fr_auto] lg:items-center">
            <p>
              <strong className="text-[#62471d]">Cadre suisse visible.</strong>{' '}
              Une échéance dépassée ne signifie pas toujours que le débiteur est
              juridiquement en demeure. Les modèles conseillés n’ajoutent ni
              frais ni intérêt automatiquement ; le taux légal de 5&nbsp;% ne
              doit être appliqué qu’après vérification des conditions du cas.
              Zentra n’engage aucune poursuite.
            </p>
            <a
              href="/telecharger"
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 font-semibold text-white transition hover:bg-[#24563f]"
            >
              <MailCheck className="size-4" /> Télécharger Zentra{' '}
              {ZENTRA_VERSION}
            </a>
          </div>
        </div>
      </section>

      <section
        id="lot-111"
        className="scroll-mt-24 border-y border-[#d8d2c6] bg-[#fffaf1] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-111-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Zentra 1.11 · facturation récurrente supervisée
              </p>
              <h2
                id="lot-111-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Planifiez. Zentra prépare. Vous décidez.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#6f6659] lg:justify-self-end">
              À partir d’une commande de prestations confirmée, choisissez un
              rythme mensuel, trimestriel ou annuel. Aux dates prévues, Zentra
              crée uniquement des brouillons locaux&nbsp;: vous gardez la main
              sur l’émission, le QR, l’envoi et la comptabilisation.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                icon: FileCheck2,
                eyebrow: 'Modèle contrôlé',
                title: 'Une base claire avant de planifier.',
                text: 'Le client, les lignes et le délai de paiement sont conservés avec le modèle récurrent.',
              },
              {
                icon: Clock3,
                eyebrow: 'Calendrier fiable',
                title: 'Fin de mois et années bissextiles respectées.',
                text: 'Le rythme mensuel, trimestriel ou annuel reste prévisible, y compris pour une date ancrée au dernier jour du mois.',
              },
              {
                icon: HardDrive,
                eyebrow: 'Automatisation locale',
                title: 'Les échéances sont préparées sur ce PC.',
                text: 'Zentra vérifie les modèles actifs au démarrage et pendant son utilisation. Aucun service cloud ne fabrique vos factures.',
              },
              {
                icon: ShieldCheck,
                eyebrow: 'Validation humaine',
                title: 'Aucune facture n’est envoyée seule.',
                text: 'Chaque occurrence reste un brouillon à contrôler. L’émission, le QR, l’envoi et l’écriture comptable sont des actions séparées.',
              },
            ].map(({ icon: Icon, eyebrow, title, text }) => (
              <article
                key={title}
                className="rounded-[24px] border border-[#ddd2c0] bg-white/80 p-6 shadow-[0_18px_45px_rgba(81,58,27,.06)]"
              >
                <Icon className="size-6 text-[#a8661e]" aria-hidden="true" />
                <p className="mt-5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#8b6b3d]">
                  {eyebrow}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-[-.025em] text-[#3f3528]">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#6f6659]">{text}</p>
              </article>
            ))}
          </div>

          <RecurrenceDemo />

          <div className="mt-5 flex flex-col gap-3 rounded-[22px] border border-[#cad9ce] bg-[#edf5ef] p-5 text-sm leading-6 text-[#42604f] sm:flex-row sm:items-center sm:justify-between">
            <p>
              <strong className="text-[#244a35]">
                Toujours local et contrôlé.
              </strong>{' '}
              Le planning, les modèles et les brouillons restent dans la base
              locale Zentra. La démonstration ci-dessus fonctionne uniquement
              dans votre navigateur&nbsp;: elle n’enregistre et n’envoie aucune
              donnée, et ne crée aucune facture réelle.
            </p>
            <a
              href="/telecharger"
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 font-semibold text-white transition hover:bg-[#24563f]"
            >
              Télécharger Zentra {ZENTRA_VERSION}{' '}
              <ArrowRight className="size-4" />
            </a>
          </div>
        </div>
      </section>

      <CapabilityStory />

      <section
        id="lot-19"
        className="scroll-mt-24 border-y border-[#d7ddd8] bg-[#edf4ef] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-19-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#37684b]">
                Zentra 1.9 · TVA suisse et bouclement
              </p>
              <h2
                id="lot-19-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Préparer, contrôler, puis seulement exporter ou clôturer.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#607068] lg:justify-self-end">
              Le nouveau centre TVA relie les pièces locales à un traitement
              explicite. Le dossier de clôture fige ensuite une preuve
              vérifiable avant tout verrouillage irréversible.
            </p>
          </div>

          <div className="mt-10">
            <VatClosingDemo />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <article className="rounded-[24px] border border-[#cbd8ce] bg-[#173d2c] p-6 text-white sm:p-7">
              <BookOpenCheck
                className="size-6 text-[#efb157]"
                aria-hidden="true"
              />
              <h3 className="mt-5 text-xl font-semibold">
                Du journal jusqu’au dossier fiduciaire.
              </h3>
              <p className="mt-3 text-sm leading-7 text-white/72">
                Journal, grand livre, balance, bilan, résultat, index des
                pièces, audit, manifeste et SHA-256 sont réunis dans un ZIP
                DRAFT ou FINAL, sans effacer l’historique.
              </p>
            </article>
            <article className="rounded-[24px] border border-[#d9d1c3] bg-[#fffaf1] p-6 sm:p-7">
              <ShieldCheck
                className="size-6 text-[#a8661e]"
                aria-hidden="true"
              />
              <h3 className="mt-5 text-xl font-semibold text-[#3f3528]">
                Une portée réglementaire écrite noir sur blanc.
              </h3>
              <p className="mt-3 text-sm leading-7 text-[#6f6455]">
                Le XML est destiné à l’import manuel dans Décompte TVA pro. Le
                dossier soutient un processus orienté CO/Olico, mais Zentra ne
                revendique ni transmission AFC, ni acceptation, ni
                certification.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section
        id="lot-18"
        className="scroll-mt-24 border-b border-[#ded9ce] bg-[#fffaf1] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-18-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.8fr_1.2fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#37684b]">
                Zentra 1.8 · nouveau cycle fournisseur
              </p>
              <h2
                id="lot-18-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Commander, recevoir et payer sans recopier les lignes.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#607068] lg:justify-self-end">
              Une commande fournisseur confirmée guide la réception, le contrôle
              de la facture, l’avoir éventuel et le paiement. Les quantités, les
              prix HT et la TVA restent reliés à leur pièce d’origine.
            </p>
          </div>

          <ol className="mt-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              [
                '1',
                'Commander',
                'Produits, prestations directes, projet, compte de charge et TVA dans un brouillon contrôlé.',
              ],
              [
                '2',
                'Réceptionner',
                'Réception partielle ou complète. Le stock augmente uniquement quand le bon est émis.',
              ],
              [
                '3',
                'Rapprocher',
                'Commande, réception et facture comparées; les frais hors commande peuvent rester séparés.',
              ],
              [
                '4',
                'Comptabiliser',
                'Validation, avoir, paiement et écriture locale avec corrections motivées et auditables.',
              ],
            ].map(([number, title, text]) => (
              <li
                key={number}
                className="rounded-[24px] border border-[#cfdad2] bg-white/80 p-5 shadow-[0_16px_45px_rgba(32,72,47,.06)] sm:p-6"
              >
                <span className="grid size-9 place-items-center rounded-full bg-[#204f35] text-xs font-bold text-white">
                  {number}
                </span>
                <h3 className="mt-5 text-lg font-semibold text-[#244331]">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[#607068]">{text}</p>
              </li>
            ))}
          </ol>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <article className="rounded-[24px] border border-[#cbd8ce] bg-[#173d2c] p-6 text-white sm:p-7">
              <Package className="size-6 text-[#efb157]" aria-hidden="true" />
              <h3 className="mt-5 text-xl font-semibold">
                Les mouvements de stock restent uniques.
              </h3>
              <p className="mt-3 text-sm leading-7 text-white/72">
                Le brouillon et le rapprochement ne touchent pas le stock. Une
                réception émise crée l’entrée; son extourne motivée crée le
                mouvement inverse, sans effacer l’historique.
              </p>
            </article>
            <article className="rounded-[24px] border border-[#d9d1c3] bg-[#fffaf1] p-6 sm:p-7">
              <Receipt className="size-6 text-[#a8661e]" aria-hidden="true" />
              <h3 className="mt-5 text-xl font-semibold text-[#3f3528]">
                Les écarts restent visibles avant validation.
              </h3>
              <p className="mt-3 text-sm leading-7 text-[#6f6455]">
                Une quantité manquante, un prix ou une TVA différents ne sont
                pas masqués. L’utilisateur corrige le brouillon ou assume une
                facture autonome; aucune décision financière ambiguë n’est prise
                automatiquement.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section
        id="lot-17"
        className="scroll-mt-24 border-y border-[#ded9ce] bg-[#fffaf1] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="lot-17-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Zentra 1.7 · nouveau flux de vente
              </p>
              <h2
                id="lot-17-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Livrer progressivement. Facturer exactement le réalisé.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">
              Depuis la version 1.7, Zentra relie le devis, la commande, la
              réservation, le bon de livraison et la facture. Chaque écran
              montre une seule prochaine action et conserve les corrections dans
              l’audit.
            </p>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <article className="rounded-[26px] border border-[#d9d4c8] bg-white p-6 shadow-[0_18px_55px_rgba(35,58,43,.07)] sm:p-8">
              <div className="grid size-11 place-items-center rounded-2xl bg-[#e8f0ea] text-[#2f6848]">
                <Package className="size-5" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-.03em]">
                La commande pilote le stock et la livraison.
              </h3>
              <p className="mt-4 text-sm leading-7 text-[#606c64]">
                Un devis accepté contenant des produits à livrer devient une
                commande sans recopier les lignes. Sa confirmation réserve le
                stock; chaque BL émis déduit uniquement le livré.
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-[#34483b]">
                {[
                  'En main, réservé et disponible visibles séparément.',
                  'BL partiel ou complet imprimable depuis la commande.',
                  'Annulation ou inversion exige un motif et laisse une trace.',
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-0.5 size-4 shrink-0 text-[#3f7454]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="rounded-[26px] border border-[#dfd4c3] bg-white p-6 shadow-[0_18px_55px_rgba(66,46,23,.07)] sm:p-8">
              <div className="grid size-11 place-items-center rounded-2xl bg-[#f7ead7] text-[#9a651f]">
                <Receipt className="size-5" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-.03em]">
                La facture suit uniquement ce qui est livrable.
              </h3>
              <p className="mt-4 text-sm leading-7 text-[#606c64]">
                Pour les lignes à livrer, Zentra propose les quantités livrées
                et non encore facturées. Une livraison partielle prépare une
                situation; les prestations directes restent facturables sans BL.
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-[#34483b]">
                {[
                  'Une seule facture liée peut rester en brouillon à la fois.',
                  'Un échec d’IBAN ou de période laisse la commande ouverte.',
                  'La commande se clôt seulement après émission réussie de la finale.',
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-0.5 size-4 shrink-0 text-[#9a651f]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <p className="mt-5 rounded-2xl border border-[#c9d9cd] bg-[#eef7f0] px-5 py-4 text-sm leading-6 text-[#315e47]">
            Inclus dans Zentra {ZENTRA_VERSION}. La facturation progressive
            porte actuellement sur les quantités livrées pour les articles
            concernés; les prestations directes n’exigent pas de BL. Les
            acomptes libres par montant ou pourcentage seront ajoutés dans un
            lot distinct.
          </p>
        </div>
      </section>

      <section
        id="logiciel"
        className="border-y border-[#d9ded9] bg-[#eef2ef] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-6 lg:grid-cols-[.72fr_1.28fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Explorez l’interface
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Voyez exactement comment Zentra travaille.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#66736b] lg:justify-self-end">
              Passez du pilotage aux documents, aux projets, aux salaires et à
              la comptabilité. Chaque écran ci-dessous présente un flux concret
              de l’application.
            </p>
          </div>
          <div className="mt-10 sm:mt-14">
            <ProductShowcase />
          </div>
        </div>
      </section>

      <section
        id="demo-flux"
        className="border-b border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="demo-flux-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Essayez sans compte
              </p>
              <h2
                id="demo-flux-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Testez le devis, la livraison et la facture.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#68736c] lg:justify-self-end">
              La démonstration démarre vide et utilise uniquement les valeurs
              que vous saisissez. Elle illustre le flux réel sans créer de
              compte ni stocker vos informations.
            </p>
          </div>
          <div className="mt-10 sm:mt-14">
            <ProductFlowDemo />
          </div>
        </div>
      </section>

      <section
        id="catalogue-achats"
        className="border-b border-[#ded9ce] bg-[#fffaf2] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="catalogue-achats-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Disponible dans Zentra
              </p>
              <h2
                id="catalogue-achats-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Du catalogue au devis. Du fournisseur au paiement.
              </h2>
            </div>
            <div className="max-w-2xl lg:justify-self-end">
              <p className="text-lg leading-8 text-[#68736c]">
                Réutilisez vos références commerciales sans perdre la liberté de
                modifier chaque document, puis suivez les achats qui restent à
                payer avec leur fournisseur et leur échéance.
              </p>
              <p className="mt-3 text-sm leading-6 text-[#7a7061]">
                Ces informations sont enregistrées dans la base locale de
                l’application. Aucune donnée d’entreprise n’est nécessaire pour
                essayer la démonstration ci-dessous.
              </p>
            </div>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-5">
            {[
              {
                icon: Package,
                title: 'Catalogue local',
                text: 'Recherchez, filtrez, modifiez, archivez ou réactivez vos produits et services.',
              },
              {
                icon: FileCheck2,
                title: 'Devis avec remises',
                text: 'Copiez une référence dans une ligne indépendante, puis adaptez quantité, prix, TVA et remise.',
              },
              {
                icon: Building2,
                title: 'Annuaire fournisseurs',
                text: 'Conservez coordonnées, conditions de paiement, IBAN et historique lié aux achats.',
              },
              {
                icon: Receipt,
                title: 'Achats à suivre',
                text: 'Distinguez à payer, échu et payé, avec une confirmation avant d’enregistrer le règlement.',
              },
              {
                icon: Package,
                title: 'Stock réservé et livré',
                text: 'Une commande confirmée réserve; le BL émis sort le stock; la facture liée ne le déduit jamais une seconde fois.',
              },
            ].map(({ icon: Icon, title, text }) => (
              <article
                key={title}
                className="interactive-card rounded-2xl border border-[#ded8cd] bg-white/75 p-5"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-[#e7efe9] text-[#315d47]">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-5 font-semibold text-[#2d4135]">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#667169]">{text}</p>
              </article>
            ))}
          </div>

          <p className="mt-4 text-xs leading-5 text-[#756e64]">
            Chaque entrée, réservation, sortie ou correction reste inscrite
            localement. Dans le flux commande, le stock physique sort au BL et
            jamais à nouveau à la facture. Une facture standard créée
            directement conserve sa sortie contrôlée pour les produits suivis.
          </p>

          <div className="mt-8 sm:mt-10">
            <BusinessOperationsDemo />
          </div>

          <article className="mt-8 overflow-hidden rounded-[26px] border border-[#d6c29d] bg-[#173d2c] text-white sm:mt-10">
            <div className="grid gap-7 p-6 sm:p-8 lg:grid-cols-[.72fr_1.28fr] lg:items-center lg:p-10">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-[#efb157]/35 bg-[#efb157]/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[.1em] text-[#f2bd6d]">
                  <span className="size-1.5 rounded-full bg-[#efb157]" />
                  Disponible dans Zentra {ZENTRA_VERSION}
                </span>
                <Landmark
                  className="mt-7 size-7 text-[#efb157]"
                  aria-hidden="true"
                />
                <h3 className="mt-4 text-2xl font-semibold leading-tight tracking-[-.035em] sm:text-3xl">
                  Import bancaire suisse CAMT — vous gardez le dernier mot
                </h3>
              </div>
              <div>
                <p className="text-base leading-7 text-white/75">
                  Importez sur votre PC les relevés CAMT.053 ou CAMT.054 de
                  votre banque. Zentra détecte les doublons et propose les
                  factures clients correspondant aux crédits et les factures
                  fournisseurs correspondant aux débits. Un CAMT.054 reste en
                  revue&nbsp;: aucun paiement ne peut être confirmé sans le
                  relevé CAMT.053 définitif.
                </p>
                <ol className="mt-6 grid gap-3 sm:grid-cols-3">
                  {[
                    [
                      '01',
                      'Importer',
                      'Choisir un fichier CAMT v04 ou v08 sur le PC.',
                    ],
                    [
                      '02',
                      'Comparer',
                      'Contrôler compte, devise, référence et montant.',
                    ],
                    [
                      '03',
                      'Confirmer',
                      'Créer le paiement et, si la comptabilité est activée, son écriture.',
                    ],
                  ].map(([number, title, text]) => (
                    <li
                      key={number}
                      className="rounded-2xl border border-white/12 bg-white/[.07] p-4"
                    >
                      <span className="text-[11px] font-bold tracking-[.12em] text-[#efb157]">
                        {number}
                      </span>
                      <p className="mt-4 text-sm font-semibold">{title}</p>
                      <p className="mt-1.5 text-xs leading-5 text-white/65">
                        {text}
                      </p>
                    </li>
                  ))}
                </ol>
                <p className="mt-4 text-xs leading-5 text-white/58">
                  Les écritures en attente, extournes, lots ambigus et montants
                  incohérents restent visibles mais bloqués. Une suggestion ne
                  crée jamais un paiement&nbsp;: la facture exacte et le solde
                  sont toujours confirmés par l’utilisateur.
                </p>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section
        id="paie-locale"
        className="border-b border-[#ded9ce] bg-[#fffaf2] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Paie locale contrôlée
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Vos anciennes fiches deviennent une base de travail.
              </h2>
            </div>
            <div className="max-w-2xl lg:justify-self-end">
              <p className="text-lg leading-8 text-[#68736c]">
                Importez plusieurs PDF ou images. Zentra lit d’abord le texte
                disponible, puis peut utiliser SmolVLM localement pour proposer
                les champs, associer la fiche à un collaborateur et préparer une
                fiche « à contrôler ».
              </p>
              <p className="mt-3 text-sm leading-6 text-[#7a7061]">
                Aucun document de paie n’est envoyé. Chaque résultat doit être
                comparé à l’original et confirmé par une personne avant
                création.
              </p>
            </div>
          </div>
          <div className="mt-10 sm:mt-14">
            <PayrollLocalDemo />
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              [
                'Import groupé',
                'PDF, PNG, JPEG ou WebP, avec détection des doublons et reprise du contrôle.',
              ],
              [
                'IA exécutée localement',
                'Le modèle s’exécute sur le PC après son téléchargement initial ; il reste facultatif.',
              ],
              [
                'PDF professionnel',
                'Bases, taux, retenues, charges employeur, net, paiement et mentions restent lisibles.',
              ],
            ].map(([title, text]) => (
              <div
                key={title}
                className="rounded-2xl border border-[#ded8cd] bg-white/70 p-5"
              >
                <Check className="size-4 text-[#3f7a55]" />
                <h3 className="mt-3 text-sm font-semibold text-[#2d4135]">
                  {title}
                </h3>
                <p className="mt-2 text-xs leading-5 text-[#667169]">{text}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs leading-5 text-[#7a746b]">
            Le modèle officiel SmolVLM-500M-Instruct utilisé ici n’est pas
            spécifiquement affiné pour la paie suisse. Zentra n’est pas certifié
            Swissdec.
          </p>
        </div>
      </section>

      <section
        id="secteurs"
        className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-20 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Multisectoriel par conception
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Votre métier d’abord. Les chantiers quand vous en avez.
              </h2>
            </div>
            <div className="max-w-2xl lg:justify-self-end">
              <p className="text-lg leading-8 text-[#6b746e]">
                Au premier lancement, l’utilisateur choisit sa section et sa
                division NOGA 2025 puis décrit son activité précise.
                L’application adapte la terminologie, mais garde un module
                projets / chantiers disponible.
              </p>
              <a
                className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#315e48] underline underline-offset-4"
                href="https://www.kubb-tool.bfs.admin.ch/fr/noga/2025"
                target="_blank"
                rel="noreferrer"
              >
                Nomenclature officielle OFS / KUBB{' '}
                <ArrowRight className="size-4" />
              </a>
            </div>
          </div>
          <details className="sector-details group mt-10 overflow-hidden rounded-[24px] border border-[#ddd8cd] bg-white sm:mt-12">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-semibold text-[#294536] sm:px-6">
              <span className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-[#e7efe9] text-sm font-bold text-[#315d47]">
                  22
                </span>
                Voir tous les secteurs NOGA pris en charge
              </span>
              <Plus className="size-5 shrink-0 transition-transform duration-200 group-open:rotate-45" />
            </summary>
            <div className="grid gap-2 border-t border-[#e5e1d8] bg-[#faf9f5] p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
              {sectors.map(([code, label]) => (
                <div
                  key={code}
                  className="interactive-card flex min-h-16 items-center gap-3 rounded-xl border border-[#e1ddd3] bg-white p-3.5"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#e7efe9] text-sm font-bold text-[#315d47]">
                    {code}
                  </span>
                  <span className="text-sm leading-5 text-[#46554c]">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </details>
          <div className="mt-6 flex items-start gap-3 rounded-2xl bg-[#f2eee5] p-5 text-sm leading-6 text-[#667068]">
            <BriefcaseBusiness className="mt-0.5 size-5 shrink-0 text-[#b86b16]" />
            <p>
              Les 22 sections et toutes leurs divisions sont proposées. Le code
              NOGA détaillé et le libellé exact restent saisissables librement
              pour couvrir les activités spécialisées.
            </p>
          </div>
        </div>
      </section>

      <section
        id="confidentialite"
        className="bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efaa3c]">
                Vos données vous appartiennent
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Local d’abord. Partagé seulement quand vous le décidez.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-white/76 lg:justify-self-end">
              Zentra installe l’application et sa base sur votre ordinateur. La
              gestion quotidienne ne dépend pas d’un navigateur ni d’une
              connexion permanente. Le serveur gère le compte, les rôles et les
              appareils; il reçoit uniquement les PDF que vous placez dans le
              coffre partagé de votre entreprise.
            </p>
          </div>
          <div className="mt-10 grid gap-3 sm:mt-14 sm:grid-cols-2 lg:grid-cols-4">
            {localPromises.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="interactive-card rounded-2xl border border-white/12 bg-white/7 p-6"
              >
                <Icon className="size-5 text-[#efaa3c]" />
                <h3 className="mt-5 font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-white/76">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="fonctionnalites"
        className="border-b border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.75fr_1.25fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Des devis aux rapports comptables
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Tout le cycle de gestion dans le même espace.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">
              Les indicateurs apparaissent seulement lorsque vous avez saisi les
              données nécessaires. Aucun client, montant, projet, chantier ou
              salaire fictif n’est injecté.
            </p>
          </div>
          <div className="mt-10 grid gap-px overflow-hidden rounded-[24px] border border-[#ded9ce] bg-[#ded9ce] sm:mt-14 md:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, text }) => (
              <div key={title} className="interactive-card bg-[#fffdf9] p-7">
                <span className="grid size-11 place-items-center rounded-2xl bg-[#e7efe9] text-[#315d47]">
                  <Icon className="size-5" />
                </span>
                <h3 className="mt-6 font-semibold tracking-tight">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#626d65]">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="capacites"
        className="border-b border-[#ded9ce] bg-[#eef2ef] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="capacites-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Ce que fait vraiment Zentra
              </p>
              <h2
                id="capacites-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Des fonctions claires, avec leurs limites visibles.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#68736c] lg:justify-self-end">
              Les statuts ci-dessous distinguent ce qui est disponible, ce qui
              demande une confirmation humaine et ce qui n’est pas encore
              automatisé.
            </p>
          </div>
          <div
            className="capability-table mt-10 overflow-x-auto rounded-[24px] border border-[#d4dad5] bg-white sm:mt-14"
            aria-label="Tableau des capacités Zentra"
          >
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="bg-[#173d2c] text-white">
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-[.1em]">
                    Domaine
                  </th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-[.1em]">
                    État
                  </th>
                  <th className="px-5 py-4 text-xs font-semibold uppercase tracking-[.1em]">
                    Portée
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e4e7e2]">
                {capabilityRows.map(([domain, status, scope]) => (
                  <tr key={domain}>
                    <th
                      scope="row"
                      className="px-5 py-4 text-sm font-semibold text-[#263d30]"
                    >
                      {domain}
                    </th>
                    <td className="px-5 py-4">
                      <span
                        className={
                          status === 'Disponible'
                            ? 'status-pill status-pill--green'
                            : status === 'Windows · aperçu macOS privé'
                              ? 'status-pill status-pill--slate'
                              : 'status-pill status-pill--gold'
                        }
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm leading-6 text-[#667169]">
                      {scope}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs leading-5 text-[#717d75]">
            « Disponible » décrit une fonction du logiciel; ce n’est pas une
            certification légale, Swissdec ou Olico. Les fonctions indiquées
            figurent dans l’installateur public {ZENTRA_VERSION}.
          </p>
        </div>
      </section>

      <section
        className="border-b border-[#ded9ce] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Continuité métier
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Du client à la comptabilité, sans ressaisir les mêmes données.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">
              Zentra conserve l’origine des informations à chaque étape. Le
              devis avec produits devient une commande; la réservation, le BL,
              la facture et le paiement restent reliés. Une prestation simple
              peut conserver le flux direct. L’utilisateur confirme les étapes
              financières.
            </p>
          </div>
          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {[
              {
                icon: Building2,
                title: 'Client',
                text: 'Coordonnées réutilisées dans les projets, devis et factures.',
              },
              {
                icon: FileCheck2,
                title: 'Devis accepté',
                text: 'Les lignes et conditions sont figées avant la transformation.',
              },
              {
                icon: Package,
                title: 'Commande & BL',
                text: 'La commande réserve le stock; chaque livraison peut rester partielle.',
              },
              {
                icon: Receipt,
                title: 'Situation ou finale',
                text: 'Les articles suivent le livré non facturé; les prestations directes restent disponibles sans BL.',
              },
              {
                icon: Landmark,
                title: 'Paiement confirmé',
                text: 'Règlement manuel ou proposition CAMT validée explicitement par l’utilisateur.',
              },
              {
                icon: BookOpenCheck,
                title: 'Comptabilité',
                text: 'Une configuration active produit des écritures équilibrées et traçables.',
              },
            ].map(({ icon: Icon, title, text }, index) => (
              <div
                key={title}
                className="relative rounded-2xl border border-[#ddd8cd] bg-white/65 p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <Icon className="size-5 text-[#b86b16]" />
                  <span className="text-xs font-bold text-[#9b7b50]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className="mt-6 font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#5f6962]">{text}</p>
                {index < 5 ? (
                  <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden size-5 rounded-full bg-[#f6f4ef] text-[#9b7b50] xl:block" />
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-5 rounded-2xl border border-[#e1d4c0] bg-[#fff9ef] px-5 py-4 text-sm leading-6 text-[#70562f]">
            Zentra facture progressivement le livré des lignes concernées; les
            prestations simples peuvent rester en facture directe. Les acomptes
            définis par montant ou pourcentage et l’envoi automatique des
            relances restent des étapes suivantes. L’import manuel du XML TVA
            est disponible; Zentra ne transmet rien à l’AFC.
          </p>
          <div className="mt-10 flex flex-col items-start justify-between gap-5 rounded-[24px] bg-[#173d2c] p-6 text-white sm:flex-row sm:items-center sm:p-8">
            <div>
              <p className="font-semibold">
                Testez le document avant d’installer.
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/72">
                Le générateur commence vide, calcule vos propres lignes et
                imprime un aperçu PDF sans enregistrer ni envoyer vos saisies.
              </p>
            </div>
            <a
              href="/demo-facture"
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#efaa3c] px-5 text-sm font-semibold text-[#173d2c]"
            >
              Créer une facture <ArrowRight className="size-4" />
            </a>
          </div>
        </div>
      </section>

      <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
              Votre première ouverture
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">
              Le logiciel s’adapte à votre entreprise.
            </h2>
            <p className="mt-5 text-lg leading-8 text-[#6b746e]">
              L’assistant commence par le domaine NOGA et l’activité précise,
              puis demande les informations nécessaires avant d’autoriser la
              facturation. Vous pouvez aussi restaurer une sauvegarde existante.
            </p>
          </div>
          <div className="mt-14 grid gap-4 lg:grid-cols-4">
            {[
              [
                '01',
                'Activité',
                'Section et division NOGA 2025, code détaillé et description précise du métier.',
              ],
              [
                '02',
                'Identité',
                'Raison sociale, responsable, adresse, UID, coordonnées et logo.',
              ],
              [
                '03',
                'Facturation',
                'IBAN, numérotation, délais, validité et taux de TVA explicites.',
              ],
              [
                '04',
                'Organisation & protection',
                'Projets ou chantiers, temps, paie, stockage et sauvegarde locale.',
              ],
            ].map(([number, title, text], index) => (
              <div
                key={number}
                className="relative rounded-2xl border border-[#ddd8cd] bg-white/60 p-6"
              >
                <span className="text-xs font-bold text-[#8a5a1b]">
                  {number}
                </span>
                <h3 className="mt-8 text-lg font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#5f6962]">{text}</p>
                {index < 3 && (
                  <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-5 rounded-full bg-[#f6f4ef] text-[#9b7b50] lg:block" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[.85fr_1.15fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
              Des chiffres explicables
            </p>
            <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
              Savoir combien un projet ou chantier a duré et ce qu’il a
              rapporté.
            </h2>
            <p className="mt-6 text-lg leading-8 text-[#6b746e]">
              Le logiciel sépare durée prévue, dates réelles et heures
              travaillées. La rentabilité utilise uniquement le facturé net, les
              coûts horaires configurés et les dépenses enregistrées.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                icon: Banknote,
                title: 'Facturé et encaissé',
                text: 'Deux montants distincts, par facture et par projet ou chantier.',
              },
              {
                icon: Clock3,
                title: 'Durée et heures réelles',
                text: 'Calendrier du projet et temps pointé ne sont jamais confondus.',
              },
              {
                icon: BarChart3,
                title: 'Marge sur données saisies',
                text: 'Aucune estimation masquée lorsqu’un coût manque.',
              },
              {
                icon: ShieldCheck,
                title: 'Traçabilité locale',
                text: 'Paiements, changements de statut et documents restent reliés.',
              },
            ].map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl border border-[#e1ddd3] bg-white p-6"
              >
                <Icon className="size-5 text-[#b86b16]" />
                <h3 className="mt-5 font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#5f6962]">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="tarif" className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
              Un prix simple
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">
              Tout Zentra. 50 CHF par mois.
            </h2>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#5f6962]">
              Un abonnement d’entreprise au prix fixe, avec toutes les
              fonctionnalités, les mises à jour et autant de collaborateurs que
              nécessaire, sans option payante par fonction ou par personne.
            </p>
          </div>
          <div className="mt-12 grid overflow-hidden rounded-[28px] border border-[#d9d4c9] bg-white shadow-[0_25px_70px_rgba(29,45,35,.1)] md:grid-cols-[1.1fr_.9fr]">
            <div className="p-7 sm:p-10">
              <div className="flex items-end gap-2">
                <span className="text-5xl font-semibold tracking-[-.05em]">
                  50 CHF
                </span>
                <span className="pb-1 text-sm text-[#5f6962]">/ mois</span>
              </div>
              <p className="mt-3 text-sm text-[#5f6962]">
                Montant final fixé côté serveur, taxe incluse lorsqu’elle
                s’applique, et encaissé sur la page sécurisée Stripe. Vous ne
                paierez jamais un supplément pour débloquer une fonctionnalité
                ou ajouter un collaborateur. Renouvellement automatique chaque
                mois, résiliable depuis le portail client pour la fin de la
                période en cours.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {[
                  'Application Windows complète',
                  'Aperçu macOS réservé à la recette privée',
                  'Collaborateurs et comptable sans supplément',
                  'Toutes les fonctions présentes et futures incluses',
                  '22 secteurs NOGA 2025',
                  'Données métier locales',
                  'Projets, chantiers & clients',
                  'Catalogue produits & services',
                  'Devis, remises & factures',
                  'Paiements & échéances',
                  'Fournisseurs & achats à payer',
                  'Temps & dépenses',
                  'Rentabilité par dossier',
                  'Salaires préparatoires',
                  'Comptabilité locale',
                  'Centre TVA & export eCH',
                  'Dossier de clôture fiduciaire',
                  'Sauvegarde & restauration',
                  'Mises à jour incluses',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm">
                    <Check className="size-4 text-[#3f7454]" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-between bg-[#173d2c] p-7 text-white sm:p-10">
              <div>
                <Laptop className="size-7 text-[#efaa3c]" />
                <h3 className="mt-6 text-2xl font-semibold tracking-tight">
                  Zentra pour toute votre équipe.
                </h3>
                <p className="mt-4 text-sm leading-6 text-white/75">
                  Téléchargez Zentra et souscrivez sur la page sécurisée Stripe.
                  Vous pouvez aussi rattacher l’abonnement à votre compte puis
                  autoriser les collaborateurs ou le comptable. Les données
                  opérationnelles resteront locales; seuls le compte et les PDF
                  archivés sur option seront hébergés.
                </p>
              </div>
              <div className="mt-9 space-y-3">
                <PurchaseButton compact />
                <a
                  href="/telecharger"
                  className="flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/15 px-5 py-3 text-center text-sm font-semibold leading-5 text-white"
                >
                  Télécharger Zentra <FileDown className="size-4 shrink-0" />
                </a>
                <a
                  href="mailto:leartshabija@gmail.com?subject=Activer%20Zentra"
                  className="flex min-h-12 items-center justify-center rounded-full border border-white/15 px-5 py-3 text-center text-sm font-semibold leading-5 text-white"
                >
                  Contacter le service commercial
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="border-y border-[#ddd8cd] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
              Questions fréquentes
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-.045em]">
              Clair jusque dans les détails.
            </h2>
            <p className="mt-5 text-sm leading-6 text-[#5f6962]">
              Une question commerciale ou un besoin particulier&nbsp;?{' '}
              <a
                href="mailto:leartshabija@gmail.com"
                className="font-semibold text-[#315e48] underline underline-offset-4"
              >
                Écrivez-nous
              </a>
              .
            </p>
          </div>
          <div className="divide-y divide-[#ddd8cd]">
            {[
              [
                'Sur quels appareils Zentra fonctionne-t-il ?',
                'L’installateur public est disponible pour Windows 10 et Windows 11 64 bits. Un aperçu macOS universel Intel et Apple Silicon est compilé en privé par GitHub Actions avec une signature ad hoc, sans certificat Apple. Gatekeeper peut demander « Ouvrir quand même » dans Réglages système > Confidentialité et sécurité. La version publique attendra un certificat Developer ID et la notarisation Apple.',
              ],
              [
                'Où sont enregistrées mes données ?',
                'Clients, salaires, projets, comptabilité et base de travail restent dans le dossier local de l’application. Le serveur conserve le compte, les accès et uniquement les versions PDF que vous choisissez d’archiver. La sauvegarde SQLite complète reste indispensable.',
              ],
              [
                'Combien coûtent les collaborateurs et les nouvelles fonctions ?',
                'Rien de plus. Le prix reste fixé à 50 CHF par mois pour l’entreprise : toutes les fonctionnalités présentes et futures et tous les collaborateurs sont inclus, sans module ni siège facturé en supplément.',
              ],
              [
                'Y a-t-il des données de démonstration ?',
                'Non. Au premier lancement, la base est vide et un questionnaire vous demande les informations réelles de votre entreprise.',
              ],
              [
                'Le logiciel est-il réservé à la construction ?',
                'Non. Le questionnaire couvre les 22 sections NOGA 2025 et leurs divisions. Le module projets / chantiers reste disponible, avec une terminologie adaptée au domaine choisi.',
              ],
              [
                'Puis-je créer de vrais devis et factures ?',
                'Oui. Vous configurez les coordonnées, numéros, délais et taux de TVA. Vous pouvez ensuite créer, imprimer, convertir et suivre vos documents.',
              ],
              [
                'Puis-je corriger une facture déjà payée ?',
                'Oui, avec une trace complète : Zentra ne réécrit pas le document payé. Il prépare un avoir intégral lié à l’original, puis une nouvelle facture modifiable, chacun avec son propre numéro et le motif conservé. Tant que ces deux documents restent des brouillons, la préparation peut être abandonnée sans toucher à l’original.',
              ],
              [
                'Comment fonctionne le catalogue ?',
                'Vous créez vos produits et services localement. Lorsqu’une référence est ajoutée à un devis, son libellé, son unité, son prix et sa TVA sont copiés dans une ligne qui reste modifiable. Une référence archivée n’est plus proposée par défaut.',
              ],
              [
                'Comment suivre les achats fournisseurs ?',
                'Vous confirmez une commande, émettez une ou plusieurs réceptions, puis rapprochez la facture sur les quantités, les prix HT et la TVA. Les avoirs, paiements et écritures restent liés aux pièces; chaque correction sensible exige un motif.',
              ],
              [
                'L’import bancaire CAMT est-il déjà disponible ?',
                'Oui. Vous pouvez importer localement des relevés CAMT.053 et CAMT.054 v04/v08. Les CAMT.054 servent à la revue; le CAMT.053 définitif est exigé avant de confirmer un crédit client ou un débit fournisseur. Aucune suggestion ne crée un paiement automatiquement.',
              ],
              [
                'Zentra envoie-t-il les relances automatiquement ?',
                'Non. Zentra prépare localement une relance à contrôler. Vous pouvez demander l’ouverture d’un e-mail prérempli dans votre logiciel de messagerie, imprimer le courrier ou confirmer un envoi déjà réalisé. Aucun e-mail ne part seul, et Zentra ne prétend pas qu’un brouillon a été créé si votre ordinateur ne l’ouvre pas.',
              ],
              [
                'Que se passe-t-il lorsque l’application est fermée ?',
                'Les automatismes métier et les relances reprennent au prochain démarrage ou retour dans l’application. Le coffre serveur conserve les PDF déjà archivés, mais il n’émet ni ne relance une facture à votre place.',
              ],
              [
                'Une facture payée peut-elle encore être relancée ?',
                'Zentra revérifie le solde après les paiements et avoirs. Si le solde est nul, la relance ouverte est arrêtée avant la préparation ou l’envoi.',
              ],
              [
                'Trois rappels sont-ils obligatoires en Suisse ?',
                'Non, il n’existe pas de règle générale imposant trois rappels avant une poursuite. Une échéance dépassée ne suffit pas non plus toujours à établir la demeure. Zentra fournit un cycle pratique, sans remplacer l’examen du contrat ni un conseil juridique.',
              ],
              [
                'Des frais ou intérêts sont-ils ajoutés automatiquement ?',
                'Non. Les modèles conseillés n’ajoutent aucun frais ni intérêt. Le taux légal de 5 % suppose notamment que la demeure soit établie; toute application doit être décidée et vérifiée séparément.',
              ],
              [
                'Le module salaire est-il certifié Swissdec ?',
                'Non. Il prépare localement les éléments avec les montants et taux que vous contrôlez, mais ne transmet pas de déclaration ELM. Une validation par votre fiduciaire reste indispensable.',
              ],
              [
                'Zentra transmet-il un décompte TVA à l’AFC ?',
                'Non. Zentra génère localement un XML eCH-0217 v2.0.0 pour import manuel dans Décompte TVA pro. L’utilisateur vérifie, complète et soumet ensuite dans le Portail AFC; aucune transmission, acceptation ou certification n’est garantie par Zentra.',
              ],
              [
                'Le bilan affiché constitue-t-il une clôture légale automatique ?',
                'Non. Zentra propose une revue SHA-256, un verrouillage explicite et un ZIP DRAFT ou FINAL contenant les états et contrôles. Le processus soutient une organisation orientée CO/Olico, mais ne constitue pas une certification Olico; inventaires, amortissements, régularisations, annexe et décisions restent à valider par le responsable ou la fiduciaire.',
              ],
            ].map(([question, answer]) => (
              <details key={question} className="group py-3">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-2 font-semibold">
                  <span>{question}</span>
                  <Plus className="size-4 shrink-0 transition-transform duration-150 group-open:rotate-45" />
                </summary>
                <p className="max-w-2xl pb-2 pt-2 text-sm leading-6 text-[#626d65]">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
        <div className="mx-auto max-w-7xl overflow-hidden rounded-[30px] bg-[#e7a33a] px-6 py-12 text-[#183d2c] sm:px-12 sm:py-14 lg:flex lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.13em]">
              Prêt à travailler avec vos vrais chiffres&nbsp;?
            </p>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-[-.045em] sm:text-4xl">
              Installez Zentra sur Windows. La version macOS publique suivra après validation Apple.
            </h2>
          </div>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-0">
            <a
              href="/telecharger"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
            >
              Télécharger Zentra <ArrowRight className="size-4" />
            </a>
            <a
              href="mailto:leartshabija@gmail.com?subject=Demande%20de%20devis%20Zentra"
              className="inline-flex h-12 items-center justify-center rounded-full border border-[#173d2c]/20 px-6 text-sm font-semibold"
            >
              Demander une offre
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#ddd8cd] px-5 py-8 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 text-xs text-[#5f6962] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <BrandWordmark className="w-20 shrink-0" />
            <span className="basis-full leading-5 min-[430px]:basis-auto">
              Gestion d’entreprise multisectorielle suisse sur ordinateur
            </span>
          </div>
          <div className="flex flex-wrap gap-5">
            <a className="inline-flex min-h-11 items-center" href="/compte">
              Mon compte
            </a>
            <a
              className="inline-flex min-h-11 items-center"
              href="/confidentialite"
            >
              Données & confidentialité
            </a>
            <a
              className="inline-flex min-h-11 items-center"
              href="mailto:leartshabija@gmail.com"
            >
              leartshabija@gmail.com
            </a>
            <span className="inline-flex min-h-11 items-center">© 2026</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
