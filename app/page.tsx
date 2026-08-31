import {
  ArrowRight,
  Banknote,
  BarChart3,
  BellRing,
  BookOpenCheck,
  BriefcaseBusiness,
  Check,
  Clock3,
  Database,
  FileCheck2,
  FileDown,
  FolderKanban,
  HardDrive,
  Laptop,
  LockKeyhole,
  QrCode,
  Plus,
  Receipt,
  ShieldCheck,
  Users,
  WalletCards,
  WifiOff,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { BrandMark } from '@/components/brand-mark';
import { CapabilityStory } from '@/components/capability-story';
import { HeroDashboard } from '@/components/hero-dashboard';
import { PayrollLocalDemo } from '@/components/payroll-local-demo';
import { ProductShowcase } from '@/components/product-showcase';
import { PurchaseButton } from '@/components/purchase-button';
import { cn } from '@/lib/utils';

const features = [
  {
    icon: FolderKanban,
    title: 'Projets, chantiers & clients',
    text: 'Le module adapte ses libellés au secteur choisi tout en conservant dates, budget, avancement, documents et intervenants.',
  },
  {
    icon: FileCheck2,
    title: 'Devis détaillés',
    text: 'Vos lignes, vos prix et vos taux de TVA. Un devis accepté devient une facture sans double saisie.',
  },
  {
    icon: Receipt,
    title: 'Factures & paiements',
    text: 'Acomptes, situations, factures finales, échéances, QR-facture suisse et montants réellement encaissés.',
  },
  {
    icon: Clock3,
    title: 'Temps de travail',
    text: 'Chronomètre ou saisie manuelle, par collaborateur et par projet ou chantier, avec historique vérifiable.',
  },
  {
    icon: WalletCards,
    title: 'Dépenses & rentabilité',
    text: 'Matériaux, sous-traitance, locations et coût horaire alimentent une marge fondée sur vos saisies.',
  },
  {
    icon: Users,
    title: 'Équipe & salaires',
    text: 'Importez d’anciennes fiches, contrôlez les champs proposés localement et générez des PDF détaillés avec vos taux validés.',
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
    text: 'Vous choisissez où créer votre sauvegarde et pouvez la restaurer sur un autre PC.',
  },
  {
    icon: LockKeyhole,
    title: 'Aucun espace cloud métier',
    text: 'L’application n’envoie pas vos données d’entreprise vers un serveur Elyko.',
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

export default function Home() {
  return (
    <main className="min-h-screen overflow-x-clip bg-[#f6f4ef] text-[#18221d]">
      <header className="sticky top-0 z-40 border-b border-[#d9d4c9]/75 bg-[#f6f4ef]/92 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-3 lg:px-8">
          <a
            href="#accueil"
            className="flex min-h-11 items-center gap-2.5"
            aria-label="Elyko, accueil"
          >
            <BrandMark className="size-9 shadow-sm" />
            <span className="font-semibold tracking-[-0.03em]">Elyko</span>
          </a>
          <nav
            className="hidden items-center gap-7 text-sm text-[#4f5c54] md:flex"
            aria-label="Navigation principale"
          >
            <a
              href="#logiciel"
              className="transition-colors hover:text-[#173d2c]"
            >
              Voir le logiciel
            </a>
            <a
              href="#confidentialite"
              className="transition-colors hover:text-[#173d2c]"
            >
              Données locales
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
          <a
            href="/telecharger"
            className={cn(
              buttonVariants({ size: 'lg' }),
              'h-11 rounded-full bg-[#173d2c] px-4 text-white hover:bg-[#24563f] sm:px-5',
            )}
          >
            Télécharger <span className="hidden min-[390px]:inline">Elyko</span>{' '}
            <FileDown className="size-4 shrink-0" />
          </a>
        </div>
      </header>

      <section
        id="accueil"
        className="mx-auto grid w-full max-w-7xl gap-10 px-5 pb-16 pt-9 sm:gap-12 sm:pb-20 sm:pt-14 lg:grid-cols-[.84fr_1.16fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-16"
      >
        <div className="relative z-10">
          <a href="#paie-locale" className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#d9d5ca] bg-white/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#46604f] transition hover:border-[#b9c7bd] hover:bg-white">
            <span className="local-pulse size-1.5 rounded-full bg-[#4f9b68]" />
            Nouveau · import local de fiches de salaire
          </a>
          <h1 className="max-w-xl text-balance text-[2.55rem] font-semibold leading-[.98] tracking-[-.055em] min-[380px]:text-5xl sm:text-6xl lg:text-7xl">
            Toute votre entreprise.
            <br />
            <span className="text-[#b86b16]">Une seule vue.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[#667068]">
            Devis, factures QR, projets et chantiers, heures, salaires et
            comptabilité&nbsp;: Elyko centralise votre gestion dans une
            application Windows, tandis que vos données métier restent sur votre
            PC.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a
              href="/telecharger"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-12 rounded-full bg-[#e79b2f] px-6 text-[#1f281f] shadow-[0_10px_30px_rgba(201,117,21,.2)] hover:bg-[#f1aa42]',
              )}
            >
              Télécharger Elyko <ArrowRight className="size-4" />
            </a>
            <a
              href="#logiciel"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'hidden h-12 rounded-full border-[#cfcabf] bg-white/60 px-6 sm:inline-flex',
              )}
            >
              Voir Elyko en action
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
            50 CHF / mois · données locales · sauvegardes exportables
          </p>
          <div className="mt-6 grid max-w-xl grid-cols-2 gap-2 text-xs font-medium text-[#4f5e55] sm:mt-7 sm:grid-cols-4">
            {[
              ['22', 'secteurs NOGA'],
              ['1 clic', 'devis → facture'],
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

      <CapabilityStory />

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
                Voyez exactement comment Elyko travaille.
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
        id="paie-locale"
        className="border-b border-[#ded9ce] bg-[#fffaf2] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Nouveau dans Elyko 1.3.0
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Vos anciennes fiches deviennent une base de travail.
              </h2>
            </div>
            <div className="max-w-2xl lg:justify-self-end">
              <p className="text-lg leading-8 text-[#68736c]">
                Importez plusieurs PDF ou images. Elyko lit d’abord le texte disponible, puis peut utiliser SmolVLM localement pour proposer les champs, associer la fiche à un collaborateur et préparer une fiche « à contrôler ».
              </p>
              <p className="mt-3 text-sm leading-6 text-[#7a7061]">
                Aucun document de paie n’est envoyé. Chaque résultat doit être comparé à l’original et confirmé par une personne avant création.
              </p>
            </div>
          </div>
          <div className="mt-10 sm:mt-14">
            <PayrollLocalDemo />
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ['Import groupé', 'PDF, PNG, JPEG ou WebP, avec détection des doublons et reprise du contrôle.'],
              ['IA exécutée localement', 'Le modèle s’exécute sur le PC après son téléchargement initial ; il reste facultatif.'],
              ['PDF professionnel', 'Bases, taux, retenues, charges employeur, net, paiement et mentions restent lisibles.'],
            ].map(([title, text]) => (
              <div key={title} className="rounded-2xl border border-[#ded8cd] bg-white/70 p-5">
                <Check className="size-4 text-[#3f7a55]" />
                <h3 className="mt-3 text-sm font-semibold text-[#2d4135]">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-[#667169]">{text}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs leading-5 text-[#7a746b]">
            Le modèle officiel SmolVLM-500M-Instruct utilisé ici n’est pas spécifiquement affiné pour la paie suisse. Elyko n’est pas certifié Swissdec.
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
                Vos données restent là où vous les travaillez.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-white/76 lg:justify-self-end">
              Elyko installe l’application et sa base sur votre ordinateur. La
              gestion quotidienne ne dépend pas d’un navigateur ni d’une
              connexion permanente.
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
                Du devis au bilan
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
          <div className="mt-10 grid gap-px overflow-hidden rounded-[24px] border border-[#ded9ce] bg-[#ded9ce] sm:mt-14 md:grid-cols-2 lg:grid-cols-3">
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
        className="border-b border-[#ded9ce] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">
                Gestion suisse intégrée
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                De l’offre au bilan, sans ressaisir les mêmes chiffres.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">
              Chaque action métier produit une trace explicable : l’acceptation
              autorise la conversion du devis, l’émission alimente la
              comptabilité, le paiement solde la créance et l’échéance signale
              les relances à préparer.
            </p>
          </div>
          <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: QrCode,
                title: 'QR-facture suisse',
                text: 'Adresses structurées, IBAN ou QR-IBAN, référence contrôlée et section paiement imprimable.',
              },
              {
                icon: BellRing,
                title: 'Relances maîtrisées',
                text: 'Niveaux, délais, frais éventuels, modèles et historique sans serveur Elyko.',
              },
              {
                icon: BookOpenCheck,
                title: 'Partie double',
                text: 'Journal, grand livre, balance, bilan et résultat issus d’écritures toujours équilibrées.',
              },
              {
                icon: WalletCards,
                title: 'Paie détaillée',
                text: 'Toutes les bases et cotisations employé/employeur restent visibles, modifiables et contrôlables.',
              },
            ].map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl border border-[#ddd8cd] bg-white/65 p-6"
              >
                <Icon className="size-5 text-[#b86b16]" />
                <h3 className="mt-5 font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#5f6962]">{text}</p>
              </div>
            ))}
          </div>
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
              Tout Elyko. 50 CHF par mois.
            </h2>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#5f6962]">
              Une licence Windows pour gérer l’activité, avec les mises à jour
              de l’application. Les données métier restent sur votre ordinateur.
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
                Montant mensuel fixé côté serveur et encaissé sur la page
                sécurisée Stripe.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {[
                  'Application Windows complète',
                  '22 secteurs NOGA 2025',
                  'Données métier locales',
                  'Projets, chantiers & clients',
                  'Devis & factures',
                  'Paiements & échéances',
                  'Temps & dépenses',
                  'Rentabilité par dossier',
                  'Salaires préparatoires',
                  'Comptabilité locale',
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
                  L’application Elyko pour Windows.
                </h3>
                <p className="mt-4 text-sm leading-6 text-white/75">
                  Téléchargez Elyko, souscrivez sur la page sécurisée Stripe
                  puis liez la licence signée à votre PC. Vos données métier ne
                  quittent pas l’ordinateur.
                </p>
              </div>
              <div className="mt-9 space-y-3">
                <PurchaseButton compact />
                <a
                  href="/telecharger"
                  className="flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/15 px-5 py-3 text-center text-sm font-semibold leading-5 text-white"
                >
                  Télécharger Elyko <FileDown className="size-4 shrink-0" />
                </a>
                <a
                  href="mailto:leartshabija@gmail.com?subject=Activer%20Elyko"
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
                'Sur quels appareils Elyko fonctionne-t-il ?',
                'Elyko est disponible pour Windows 10 et Windows 11 64 bits. L’application fonctionne dans sa propre fenêtre et la gestion quotidienne ne dépend pas d’un onglet de navigateur.',
              ],
              [
                'Où sont enregistrées mes données ?',
                'Dans le dossier local de l’application sur votre PC. Vous pouvez créer une sauvegarde dans l’emplacement de votre choix et la restaurer ensuite.',
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
                'Le module salaire est-il certifié Swissdec ?',
                'Non. Il prépare les éléments avec les montants et taux que vous saisissez. Une validation par votre fiduciaire reste indispensable avant utilisation définitive.',
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
              Installez Elyko sur votre PC Windows.
            </h2>
          </div>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-0">
            <a
              href="/telecharger"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
            >
              Télécharger Elyko <ArrowRight className="size-4" />
            </a>
            <a
              href="mailto:leartshabija@gmail.com?subject=Demande%20de%20devis%20Elyko"
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
            <BrandMark className="size-7 shrink-0" />
            <strong className="text-[#27382e]">Elyko</strong>
            <span className="basis-full leading-5 min-[430px]:basis-auto">
              Gestion d’entreprise multisectorielle suisse sur Windows
            </span>
          </div>
          <div className="flex flex-wrap gap-5">
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
