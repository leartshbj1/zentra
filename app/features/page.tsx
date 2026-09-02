import type { Metadata } from 'next';
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  BookOpenCheck,
  Building2,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileText,
  FolderKanban,
  Landmark,
  MailCheck,
  Package,
  QrCode,
  Receipt,
  RefreshCcw,
  ScanLine,
  ShieldCheck,
  Users,
  WalletCards,
} from 'lucide-react';
import { ProductShowcase } from '@/components/product-showcase';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { buttonVariants } from '@/components/ui/button';
import { VatClosingDemo } from '@/components/vat-closing-demo';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Fonctionnalités Zentra — ERP et gestion pour PME suisses',
  description:
    'Découvrez les fonctions Zentra pour la facturation suisse, les achats, la comptabilité, la TVA, les salaires, les projets, les heures et l’import bancaire CAMT.',
  alternates: { canonical: '/features' },
  openGraph: {
    title: 'Fonctionnalités Zentra — Toute votre gestion, reliée',
    description:
      'Devis, commandes, factures QR, achats, comptabilité, salaires, projets et banque dans une application local-first conçue pour les PME suisses.',
    url: '/features',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
  twitter: {
    title: 'Fonctionnalités Zentra',
    description:
      'Les fonctions de gestion Zentra, leurs workflows et leurs limites clairement expliqués.',
    images: ['/og.png'],
  },
};

const categories = [
  {
    id: 'ventes',
    icon: FileCheck2,
    label: 'Ventes & facturation',
    text: 'Devis, commandes, livraisons, factures et paiements.',
  },
  {
    id: 'achats',
    icon: Building2,
    label: 'Achats & fournisseurs',
    text: 'Commandes, réceptions, factures, avoirs et stock.',
  },
  {
    id: 'comptabilite',
    icon: BookOpenCheck,
    label: 'Comptabilité & TVA',
    text: 'Écritures, états, décompte TVA et clôture.',
  },
  {
    id: 'salaires',
    icon: Users,
    label: 'Salaires',
    text: 'Préparation locale, cotisations contrôlées et PDF.',
  },
  {
    id: 'projets',
    icon: FolderKanban,
    label: 'Projets & heures',
    text: 'Tâches, agenda, temps, coûts et rentabilité.',
  },
  {
    id: 'banque',
    icon: Landmark,
    label: 'Banque & CAMT',
    text: 'Import local et rapprochement sous contrôle.',
  },
] as const;

const workflow = [
  ['01', 'Devis', 'Une proposition claire, chiffrée et numérotée.'],
  ['02', 'Commande', 'Les produits acceptés sont réservés.'],
  ['03', 'Livraison', 'Le réalisé peut être livré en plusieurs fois.'],
  ['04', 'Facture', 'Le document reprend uniquement ce qui doit être facturé.'],
  ['05', 'Paiement', 'Le solde tient compte des encaissements et avoirs.'],
  ['06', 'Comptabilité', 'L’écriture reste reliée à sa pièce d’origine.'],
] as const;

const capabilityRows = [
  [
    'Clients et dossiers',
    'Disponible',
    'Coordonnées, projets, documents et soldes dans la base locale.',
  ],
  [
    'Devis → commande → livraison → facture',
    'Disponible',
    'Flux complet pour les produits; facture directe possible pour une prestation simple.',
  ],
  [
    'Factures QR suisses',
    'Disponible avec contrôle',
    'QR-IBAN, QRR, SCOR ou sans référence; validation finale par l’entreprise.',
  ],
  [
    'Facturation récurrente',
    'Supervisée',
    'Zentra prépare des brouillons lorsque l’application est ouverte; aucune émission automatique.',
  ],
  [
    'Relances',
    'Supervisées',
    'Solde revérifié, aperçu, courrier ou e-mail prérempli; aucun message ne part seul.',
  ],
  [
    'Fournisseurs et achats',
    'Disponible',
    'Commandes, réceptions, factures, avoirs, rapprochement et paiements.',
  ],
  [
    'Import d’un e-mail fournisseur',
    'Disponible sur fichier',
    'Lecture locale déterministe d’un .eml ou .txt choisi; brouillon à compléter et valider.',
  ],
  [
    'Catalogue et stock',
    'Disponible',
    'Produits, services, réservations et mouvements liés aux pièces émises.',
  ],
  [
    'Import CAMT.053 / CAMT.054',
    'Assisté',
    'Les correspondances sont proposées; l’utilisateur confirme chaque paiement.',
  ],
  [
    'Comptabilité',
    'Disponible avec contrôle',
    'Partie double, journal, grand livre, balance, bilan et compte de résultat.',
  ],
  [
    'TVA suisse',
    'Disponible avec validation',
    'Aperçu et XML eCH-0217 v2.0.0 pour import manuel, sans transmission à l’AFC.',
  ],
  [
    'Clôture et dossier fiduciaire',
    'Disponible avec validation',
    'Revue, verrouillage et ZIP DRAFT ou FINAL; aucune certification Olico revendiquée.',
  ],
  [
    'Salaires',
    'Assistés localement',
    'Import OCR/IA local, calculs contrôlés et PDF; aucune certification Swissdec.',
  ],
  [
    'Projets, tâches et jalons',
    'Disponible',
    'Responsables, priorités, échéances, budgets, coûts et rentabilité.',
  ],
  [
    'Temps et facturation',
    'Disponible',
    'Chronomètre ou saisie manuelle, approbation puis facture depuis les heures.',
  ],
  [
    'Agenda',
    'Disponible localement',
    'Rendez-vous, tâches, jalons et échéances réunis sans calendrier externe.',
  ],
  [
    'Compte et collaborateurs',
    'Disponible',
    'Rôles, appareils et coffre partagé; aucune synchronisation générale implicite de la base métier.',
  ],
  [
    'Coffre PDF versionné',
    'Optionnel',
    'Versions, empreinte et échéance de conservation; ce n’est pas un stockage certifié WORM/Olico.',
  ],
] as const;

function SectionHeading({
  id,
  eyebrow,
  title,
  text,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
          {eyebrow}
        </p>
        <h2
          id={id}
          className="mt-4 text-3xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
        >
          {title}
        </h2>
      </div>
      <p className="max-w-2xl text-base leading-7 text-[#667169] sm:text-lg sm:leading-8 lg:justify-self-end">
        {text}
      </p>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileCheck2;
  title: string;
  text: string;
}) {
  return (
    <article className="interactive-card rounded-2xl border border-[#ded9ce] bg-white p-5 sm:p-6">
      <span className="grid size-10 place-items-center rounded-xl bg-[#e7efe9] text-[#315d47]">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h3 className="mt-5 font-semibold tracking-[-.02em] text-[#263a2e]">
        {title}
      </h3>
      <p className="mt-2 text-sm leading-6 text-[#647068]">{text}</p>
    </article>
  );
}

function TruthNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-start gap-3 rounded-2xl border border-[#e2d4bf] bg-[#f7eddd] p-4 text-sm leading-6 text-[#684d27] sm:p-5">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export default function FeaturesPage() {
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
        <section className="px-5 pb-16 pt-12 sm:pb-24 sm:pt-18 lg:px-8 lg:pt-24">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
              <div data-reveal="left">
                <p className="inline-flex items-center gap-2 rounded-full border border-[#d9d4c9] bg-white/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#46604f]">
                  <BadgeCheck className="size-3.5 text-[#3f7454]" />
                  Les fonctions, sans promesse cachée
                </p>
                <h1 className="mt-6 max-w-3xl text-balance text-[2.65rem] font-semibold leading-[.98] tracking-[-.055em] min-[380px]:text-5xl sm:text-6xl lg:text-[4.6rem]">
                  Une gestion complète.
                  <br />
                  <span className="text-[#b86b16]">
                    Un seul fil conducteur.
                  </span>
                </h1>
              </div>
              <div
                className="max-w-2xl lg:justify-self-end"
                data-reveal="right"
              >
                <p className="text-lg leading-8 text-[#667068]">
                  Zentra relie ventes, achats, comptabilité, salaires, projets
                  et banque dans une application conçue pour les PME suisses.
                  Chaque automatisation sensible reste vérifiable et validée par
                  une personne.
                </p>
                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <a
                    href="/demo-facture"
                    className={cn(
                      buttonVariants({ size: 'lg' }),
                      'h-12 rounded-full bg-[#e79b2f] px-6 text-[#1f281f] hover:bg-[#f1aa42]',
                    )}
                  >
                    Essayer une facture <ArrowRight className="size-4" />
                  </a>
                  <a
                    href="/download"
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'lg' }),
                      'h-12 rounded-full border-[#cfcabf] bg-white/65 px-6',
                    )}
                  >
                    Télécharger Zentra
                  </a>
                </div>
              </div>
            </div>

            <nav
              className="mt-12 grid gap-2 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3 xl:grid-cols-6"
              aria-label="Catégories de fonctionnalités"
            >
              {categories.map(({ id, icon: Icon, label, text }) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="group min-w-0 rounded-2xl border border-[#ddd8cd] bg-white/75 p-4 transition hover:-translate-y-0.5 hover:border-[#b9c9bd] hover:bg-white"
                >
                  <Icon className="size-4 text-[#3d7352]" aria-hidden="true" />
                  <strong className="mt-4 block text-sm text-[#294235]">
                    {label}
                  </strong>
                  <span className="mt-1.5 block text-xs leading-5 text-[#6b756e]">
                    {text}
                  </span>
                  <ArrowRight className="mt-3 size-3.5 text-[#a66b1f] transition-transform group-hover:translate-x-1" />
                </a>
              ))}
            </nav>
          </div>
        </section>

        <section
          className="border-y border-[#d9ded9] bg-[#eef2ef] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="interface-title"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              id="interface-title"
              eyebrow="L’interface Zentra"
              title="Voyez comment les modules travaillent ensemble."
              text="Les aperçus ci-dessous utilisent des exemples fictifs clairement identifiés. L’application installée, elle, démarre vide et travaille uniquement avec les informations de votre entreprise."
            />
            <div className="mt-10 sm:mt-14">
              <ProductShowcase />
            </div>
          </div>
        </section>

        <section
          id="workflow"
          className="bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="workflow-title"
        >
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-6 lg:grid-cols-[.72fr_1.28fr] lg:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efb157]">
                  Un workflow, pas six silos
                </p>
                <h2
                  id="workflow-title"
                  className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
                >
                  Une information saisie. Une suite logique.
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-white/72 lg:justify-self-end">
                Les documents restent liés à leur origine. Les étapes
                financières ne sont jamais déduites silencieusement : vous
                confirmez ce qui est livré, facturé, encaissé et comptabilisé.
              </p>
            </div>

            <ol className="story-rail mt-12 grid gap-3 sm:grid-cols-2 lg:mt-16 lg:grid-cols-6">
              {workflow.map(([number, title, text]) => (
                <li
                  key={number}
                  className="story-step interactive-card relative rounded-2xl border border-white/14 bg-white/[.075] p-5"
                >
                  <span className="text-xs font-bold tracking-[.12em] text-[#efb157]">
                    {number}
                  </span>
                  <h3 className="mt-8 font-semibold">{title}</h3>
                  <p className="mt-2 text-xs leading-5 text-white/66">{text}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm leading-6 text-white/65">
              Une prestation simple peut passer directement du devis accepté à
              la facture. Les lignes de produits suivent la commande et la
              livraison afin d’éviter un double mouvement de stock.
            </p>
          </div>
        </section>

        <section
          id="ventes"
          className="scroll-mt-24 px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Ventes & facturation"
              title="Du devis au paiement, sans perdre le contexte."
              text="Préparez les documents, suivez ce qui a réellement été livré et conservez un solde explicable jusqu’à l’encaissement."
            />
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3">
              <FeatureCard
                icon={FileCheck2}
                title="Devis et commandes"
                text="Lignes libres ou issues du catalogue, remises, TVA et conversion contrôlée après acceptation."
              />
              <FeatureCard
                icon={Receipt}
                title="Livraisons et facturation"
                text="Bons partiels ou complets, situations et facture finale selon les quantités réalisées."
              />
              <FeatureCard
                icon={QrCode}
                title="Facture QR"
                text="Section de paiement suisse en CHF ou EUR, avec contrôles IBAN, QRR et SCOR."
              />
              <FeatureCard
                icon={RefreshCcw}
                title="Factures récurrentes"
                text="Planification mensuelle, trimestrielle ou annuelle qui crée uniquement des brouillons à vérifier."
              />
              <FeatureCard
                icon={MailCheck}
                title="Relances supervisées"
                text="Niveaux configurables, solde revérifié et e-mail prérempli ou courrier, toujours déclenché par vous."
              />
              <FeatureCard
                icon={FileText}
                title="Corrections traçables"
                text="Une facture émise n’est pas réécrite : Zentra prépare un avoir puis une facture de remplacement."
              />
            </div>
            <TruthNote>
              Zentra ne réalise aucun envoi automatique aujourd’hui. Les
              factures récurrentes et les relances sont préparées lorsque
              l’application fonctionne, puis restent soumises à votre
              validation.
            </TruthNote>
          </div>
        </section>

        <section
          id="achats"
          className="scroll-mt-24 border-y border-[#ded9ce] bg-[#fffaf2] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Achats & fournisseurs"
              title="Commander, recevoir et payer avec les bonnes pièces."
              text="Le cycle fournisseur conserve les quantités, les prix, la TVA et les liens entre commande, réception, facture, avoir et règlement."
            />
            <div className="mt-10 grid gap-4 lg:mt-14 lg:grid-cols-[.92fr_1.08fr]">
              <div className="grid gap-3 sm:grid-cols-2">
                <FeatureCard
                  icon={Building2}
                  title="Annuaire fournisseurs"
                  text="Coordonnées, conditions de paiement, IBAN et historique d’achats dans la base locale."
                />
                <FeatureCard
                  icon={Package}
                  title="Commandes et réceptions"
                  text="Réceptions partielles ou complètes; seule l’émission d’une réception fait entrer le stock suivi."
                />
                <FeatureCard
                  icon={Receipt}
                  title="Rapprochement"
                  text="Comparaison des commandes, réceptions et factures avant validation."
                />
                <FeatureCard
                  icon={WalletCards}
                  title="Avoirs et paiements"
                  text="Solde restant, imputation d’un avoir et comptabilisation du règlement restent distincts."
                />
              </div>
              <article className="rounded-[26px] bg-[#173d2c] p-6 text-white sm:p-8">
                <ScanLine
                  className="size-6 text-[#efb157]"
                  aria-hidden="true"
                />
                <p className="mt-7 text-xs font-semibold uppercase tracking-[.12em] text-[#efb157]">
                  Factures reçues
                </p>
                <h3 className="mt-3 text-2xl font-semibold tracking-[-.035em]">
                  Un e-mail devient un brouillon, jamais une écriture surprise.
                </h3>
                <ol className="mt-7 space-y-3 text-sm text-white/72">
                  {[
                    'Vous exportez puis choisissez un message .eml ou .txt.',
                    'Zentra extrait localement les champs lisibles avec des règles déterministes.',
                    'Vous vérifiez le fournisseur, la catégorie, la pièce et l’échéance.',
                    'La validation, le paiement et la comptabilisation restent des actions séparées.',
                  ].map((item, index) => (
                    <li key={item} className="flex gap-3">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-[#efb157]">
                        {index + 1}
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-7 border-t border-white/12 pt-5 text-xs leading-5 text-white/58">
                  Zentra ne se connecte pas encore directement à Gmail ou
                  Outlook et ne lit pas automatiquement le contenu du PDF joint.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section
          id="comptabilite"
          className="scroll-mt-24 px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Comptabilité & TVA"
              title="Des états construits depuis des écritures explicables."
              text="La comptabilité relie chaque mouvement à sa source et maintient débit, crédit et soldes visibles jusqu’à la clôture."
            />
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-4">
              <FeatureCard
                icon={BookOpenCheck}
                title="Journal et grand livre"
                text="Écritures en partie double, plan comptable paramétrable et extournes traçables."
              />
              <FeatureCard
                icon={Landmark}
                title="Balance et bilan"
                text="Balance, bilan et compte de résultat calculés depuis les écritures enregistrées."
              />
              <FeatureCard
                icon={FileCheck2}
                title="Centre TVA"
                text="Profils datés, sources à classer, ajustements et aperçu avant export."
              />
              <FeatureCard
                icon={ShieldCheck}
                title="Clôture contrôlée"
                text="Pré-revue, empreinte, verrouillage explicite et dossier pour la fiduciaire."
              />
            </div>
            <div className="mt-10">
              <VatClosingDemo />
            </div>
            <TruthNote>
              Le XML eCH-0217 est destiné à un import manuel dans Décompte TVA
              pro. Zentra ne transmet rien à l’AFC et ne revendique aucune
              certification AFC ou Olico. Le bilan ne remplace pas la validation
              d’une clôture complète par le responsable ou la fiduciaire.
            </TruthNote>
          </div>
        </section>

        <section
          id="salaires"
          className="scroll-mt-24 border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Salaires"
              title="Préparer la paie sans inventer les paramètres manquants."
              text="Zentra combine import local, règles datées, paramètres de l’entreprise et contrôles humains pour produire une fiche de salaire détaillée."
            />
            <div className="mt-10 grid gap-4 lg:mt-14 lg:grid-cols-[1.06fr_.94fr]">
              <div className="rounded-[26px] border border-[#d9ded9] bg-[#eef2ef] p-6 sm:p-8">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FeatureCard
                    icon={ScanLine}
                    title="Import local multipage"
                    text="PDF ou images analysés sur l’ordinateur, avec provenance et rapprochement au collaborateur."
                  />
                  <FeatureCard
                    icon={Users}
                    title="Dossier collaborateur"
                    text="Coordonnées, emploi, paramètres annuels et historique des fiches."
                  />
                  <FeatureCard
                    icon={BadgeCheck}
                    title="Cotisations contrôlées"
                    text="Base, taux, part salariale et patronale restent visibles et sourcés."
                  />
                  <FeatureCard
                    icon={FileText}
                    title="PDF détaillé"
                    text="Décompte mensuel généré depuis les montants confirmés et les taux applicables."
                  />
                </div>
              </div>
              <aside className="rounded-[26px] bg-[#173d2c] p-6 text-white sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[.12em] text-[#efb157]">
                  Contrôle avant calcul
                </p>
                <h3 className="mt-4 text-2xl font-semibold tracking-[-.035em]">
                  Les taux propres à votre entreprise restent les vôtres.
                </h3>
                <p className="mt-4 text-sm leading-7 text-white/72">
                  Les paramètres qui dépendent d’un canton, d’une caisse, d’un
                  assureur ou d’un règlement LPP ne sont pas remplacés par une
                  valeur nationale supposée. Zentra bloque ou alerte lorsque la
                  preuve nécessaire manque.
                </p>
                <div className="mt-7 space-y-3 text-sm text-white/68">
                  {[
                    'SmolVLM reste un modèle local générique.',
                    'Aucune déclaration ELM n’est générée ou transmise.',
                    'Le calcul autonome complet de la QST n’est pas livré.',
                    'Le certificat annuel de salaire n’est pas encore généré.',
                  ].map((item) => (
                    <p key={item} className="flex gap-2.5">
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-[#efb157]" />
                      {item}
                    </p>
                  ))}
                </div>
              </aside>
            </div>
          </div>
        </section>

        <section
          id="projets"
          className="scroll-mt-24 px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Projets & heures"
              title="Comprendre ce qui a pris du temps et ce qui a rapporté."
              text="Le vocabulaire s’adapte à l’activité choisie : projet, dossier, mission ou chantier. Les calculs utilisent uniquement les données enregistrées."
            />
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3">
              <FeatureCard
                icon={FolderKanban}
                title="Projets et chantiers"
                text="Client, budget, dates prévues et réelles, dépenses, facturé, encaissé et marge."
              />
              <FeatureCard
                icon={Check}
                title="Tâches et jalons"
                text="Responsables, priorité, échéance et statut, avec temps lié à la tâche."
              />
              <FeatureCard
                icon={Clock3}
                title="Temps de travail"
                text="Chronomètre ou saisie manuelle, approbation et facturation des heures retenues."
              />
              <FeatureCard
                icon={CalendarDays}
                title="Agenda local"
                text="Vues jour, semaine et mois pour les rendez-vous et échéances issues du travail."
              />
              <FeatureCard
                icon={Banknote}
                title="Coûts et rentabilité"
                text="Coût horaire configuré, dépenses et revenus nets séparés des montants encaissés."
              />
              <FeatureCard
                icon={RefreshCcw}
                title="Heures vers facture"
                text="Sélection des heures approuvées et création d’un brouillon de facture rattaché au projet."
              />
            </div>
          </div>
        </section>

        <section
          id="banque"
          className="scroll-mt-24 border-y border-[#d4ddd6] bg-[#edf4ef] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              eyebrow="Banque & CAMT"
              title="Rapprocher plus vite, sans décider à votre place."
              text="Zentra lit localement les relevés CAMT exportés par votre banque, écarte les doublons et recherche les pièces compatibles."
            />
            <div className="mt-10 grid gap-3 lg:mt-14 lg:grid-cols-3">
              {[
                [
                  '01',
                  'Importer',
                  'Choisissez un CAMT.053 ou CAMT.054 v04/v08 enregistré sur votre ordinateur.',
                ],
                [
                  '02',
                  'Comparer',
                  'Zentra examine compte, devise, date, référence structurée, montant et solde restant.',
                ],
                [
                  '03',
                  'Confirmer',
                  'Vous choisissez la facture exacte avant la création du paiement et de son écriture éventuelle.',
                ],
              ].map(([number, title, text]) => (
                <article
                  key={number}
                  className="rounded-[22px] border border-[#ccd8cf] bg-white p-6 sm:p-7"
                >
                  <span className="text-xs font-bold tracking-[.13em] text-[#9a651f]">
                    {number}
                  </span>
                  <h3 className="mt-7 text-xl font-semibold tracking-[-.025em]">
                    {title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#647068]">
                    {text}
                  </p>
                </article>
              ))}
            </div>
            <TruthNote>
              Une ligne CAMT.054 reste en revue. Le CAMT.053 définitif est
              requis avant de confirmer un paiement. Zentra ne se connecte pas
              directement à la banque et ne produit pas encore d’ordre pain.001.
            </TruthNote>
          </div>
        </section>

        <section
          id="automatisations"
          className="bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="automation-title"
        >
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-7 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efb157]">
                  Automatisations contrôlées
                </p>
                <h2
                  id="automation-title"
                  className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
                >
                  Zentra automatise. Vous gardez le contrôle.
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-white/72 lg:justify-self-end">
                Une proposition reste une proposition. Les actions qui émettent
                un document, enregistrent un paiement ou modifient la
                comptabilité demandent une validation explicite.
              </p>
            </div>
            <div className="mt-12 grid gap-4 lg:grid-cols-3">
              {[
                {
                  icon: MailCheck,
                  title: 'Un e-mail fournisseur est importé.',
                  steps: [
                    'Les champs lisibles sont détectés localement.',
                    'Les doublons et données manquantes sont signalés.',
                    'Vous vérifiez avant de créer le brouillon.',
                  ],
                },
                {
                  icon: Landmark,
                  title: 'Un mouvement apparaît dans le CAMT.',
                  steps: [
                    'Les factures compatibles sont proposées.',
                    'Le solde et la référence sont revérifiés.',
                    'Vous confirmez paiement et comptabilisation.',
                  ],
                },
                {
                  icon: RefreshCcw,
                  title: 'Une échéance arrive.',
                  steps: [
                    'Zentra prépare un brouillon ou une relance.',
                    'Le contenu et le solde restent modifiables.',
                    'Vous choisissez si et comment agir.',
                  ],
                },
              ].map(({ icon: Icon, title, steps }) => (
                <article
                  key={title}
                  className="interactive-card rounded-[24px] border border-white/14 bg-white/[.075] p-6 sm:p-7"
                >
                  <span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-[#efb157]">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-7 text-xl font-semibold leading-7">
                    {title}
                  </h3>
                  <ol className="mt-5 space-y-3 text-sm leading-6 text-white/68">
                    {steps.map((step, index) => (
                      <li key={step} className="flex gap-3">
                        <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-[#efb157]">
                          {index + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          className="border-b border-[#ded9ce] bg-[#eef2ef] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="capabilities-title"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeading
              id="capabilities-title"
              eyebrow="Périmètre actuel"
              title="Ce que fait Zentra, et jusqu’où."
              text="Les statuts distinguent les fonctions disponibles, les aides qui exigent une validation et les services volontairement limités."
            />
            <div
              className="capability-table mt-10 overflow-x-auto rounded-[24px] border border-[#d4dad5] bg-white sm:mt-14"
              aria-label="Tableau des capacités de Zentra"
            >
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[#dce1dd] bg-[#f7f9f7] text-xs uppercase tracking-[.08em] text-[#6b776f]">
                    <th className="px-5 py-4 font-semibold">Fonction</th>
                    <th className="px-5 py-4 font-semibold">État</th>
                    <th className="px-5 py-4 font-semibold">Périmètre</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e5e9e6] text-sm">
                  {capabilityRows.map(([name, status, detail]) => (
                    <tr key={name} className="align-top">
                      <th className="px-5 py-4 font-semibold text-[#2b4134]">
                        {name}
                      </th>
                      <td className="px-5 py-4">
                        <span className="inline-flex rounded-full bg-[#e8f1ea] px-2.5 py-1 text-[11px] font-semibold text-[#356249]">
                          {status}
                        </span>
                      </td>
                      <td className="px-5 py-4 leading-6 text-[#667169]">
                        {detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[.72fr_1.28fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Limites assumées
              </p>
              <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                La confiance commence par des mots exacts.
              </h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [
                  'Paie',
                  'Zentra n’est pas certifié Swissdec et ne transmet aucune déclaration ELM.',
                ],
                [
                  'TVA et clôture',
                  'Les exports et contrôles ne remplacent pas la validation de l’entreprise ou de sa fiduciaire.',
                ],
                [
                  'Archivage',
                  'Le coffre PDF versionné n’est pas présenté comme un support WORM certifié Olico.',
                ],
                [
                  'Collaboration',
                  'Les rôles et archives sont partagés; la base métier locale n’est pas synchronisée automatiquement.',
                ],
              ].map(([title, text]) => (
                <article
                  key={title}
                  className="rounded-2xl border border-[#ded9ce] bg-white p-5"
                >
                  <CircleAlert className="size-4 text-[#a66b1f]" />
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#647068]">
                    {text}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 pb-16 sm:pb-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-7xl overflow-hidden rounded-[30px] bg-[#e7a33a] px-6 py-12 text-[#183d2c] sm:px-12 sm:py-14 lg:flex lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.13em]">
                Prêt à découvrir Zentra ?
              </p>
              <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-[-.045em] sm:text-4xl">
                Votre entreprise est déjà assez compliquée. Votre logiciel de
                gestion ne devrait pas l’être.
              </h2>
            </div>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-0">
              <a
                href="/demo-facture"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
              >
                Essayer Zentra <ArrowRight className="size-4" />
              </a>
              <a
                href="/pricing"
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-[#173d2c]/20 px-6 text-sm font-semibold"
              >
                Voir le tarif
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
