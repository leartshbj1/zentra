import type { Metadata } from 'next';
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  BookOpenCheck,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
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
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { VatClosingDemo } from '@/components/vat-closing-demo';
import { PageDisclosures } from '@/components/page-disclosures';
export const metadata: Metadata = {
  title: 'Fonctionnalités — Tout votre quotidien dans Gestion',
  description:
    'Explorez les devis, achats, comptabilité, TVA, salaires, projets et banque dans Zentra Gestion.',
  alternates: { canonical: '/features' },
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
    'Lecture locale déterministe d’un .eml choisi, extraction contrôlée d’une pièce PDF ou image, puis brouillon à valider.',
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
    'Rôles, appareils et entreprise partagée; les changements enregistrés se synchronisent entre les membres autorisés connectés.',
  ],
  [
    'Coffre PDF versionné',
    'Optionnel',
    'Versions, empreinte et échéance de conservation; ce n’est pas un stockage certifié WORM/Olico.',
  ],
] as const;

function SectionHeading({
  title,
  text,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <header className="feature-detail-heading">
      <h3>{title}</h3>
      <p>{text}</p>
    </header>
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
    <article className="feature-detail-item">
      <Icon size={20} aria-hidden="true" />
      <h4>{title}</h4>
      <p>{text}</p>
    </article>
  );
}
function TruthNote({ children }: { children: React.ReactNode }) {
  return <p className="page-note">{children}</p>;
}

export default function FeaturesPage() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1} className="features-page polished-page">
        <PageDisclosures />
        <section className="page-intro page-width">
          <h1>
            Une place pour
            <br />
            <span>chaque partie de votre activité.</span>
          </h1>
          <p>
            Choisissez ce que vous souhaitez découvrir.
            <br />
            Les détails s’ouvrent à votre rythme.
          </p>
          <nav className="page-jump-links" aria-label="Fonctionnalités">
            {categories.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>
        </section>
        <section
          className="page-width feature-library"
          aria-label="Les fonctions de Gestion"
        >
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="ventes"
          >
            <summary>
              <FileCheck2 size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Ventes et facturation</h2>
                <p>Du devis accepté au paiement enregistré.</p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
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
            </div>
          </details>
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="achats"
          >
            <summary>
              <Building2 size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Achats et fournisseurs</h2>
                <p>Vos achats, vos pièces et vos règlements.</p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
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
                      className="size-6 text-[#c2ddcf]"
                      aria-hidden="true"
                    />

                    <h3 className="mt-3 text-2xl font-semibold tracking-[-.035em]">
                      Un e-mail devient un brouillon, jamais une écriture
                      surprise.
                    </h3>
                    <ol className="mt-7 space-y-3 text-sm text-white/72">
                      {[
                        'Vous exportez puis choisissez un message .eml ou .txt.',
                        'Zentra extrait localement les champs lisibles avec des règles déterministes.',
                        'Vous vérifiez le fournisseur, la catégorie, la pièce et l’échéance.',
                        'La validation, le paiement et la comptabilisation restent des actions séparées.',
                      ].map((item, index) => (
                        <li key={item} className="flex gap-3">
                          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-[#c2ddcf]">
                            {index + 1}
                          </span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-7 border-t border-white/12 pt-5 text-xs leading-5 text-white/58">
                      Zentra ne se connecte pas encore directement à Gmail ou
                      Outlook et ne lit pas automatiquement le contenu du PDF
                      joint.
                    </p>
                  </article>
                </div>
              </div>
            </div>
          </details>
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="comptabilite"
          >
            <summary>
              <BookOpenCheck size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Comptabilité et TVA</h2>
                <p>Des chiffres reliés à leurs documents.</p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
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
                  Le XML eCH-0217 est destiné à un import manuel dans Décompte
                  TVA pro. Zentra ne transmet rien à l’AFC et ne revendique
                  aucune certification AFC ou Olico. Le bilan ne remplace pas la
                  validation d’une clôture complète par le responsable ou la
                  fiduciaire.
                </TruthNote>
              </div>
            </div>
          </details>
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="salaires"
          >
            <summary>
              <Users size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Salaires</h2>
                <p>
                  Les dossiers de votre équipe et la préparation de la paie.
                </p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
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
                    <h3 className="mt-4 text-2xl font-semibold tracking-[-.035em]">
                      Les taux propres à votre entreprise restent les vôtres.
                    </h3>
                    <p className="mt-4 text-sm leading-7 text-white/72">
                      Les paramètres qui dépendent d’un canton, d’une caisse,
                      d’un assureur ou d’un règlement LPP ne sont pas remplacés
                      par une valeur nationale supposée. Zentra bloque ou alerte
                      lorsque la preuve nécessaire manque.
                    </p>
                    <div className="mt-7 space-y-3 text-sm text-white/68">
                      {[
                        'Qwen reste un modèle local générique.',
                        'Aucune déclaration ELM n’est générée ou transmise.',
                        'Le calcul autonome complet de la QST n’est pas livré.',
                        'Le certificat annuel de salaire n’est pas encore généré.',
                      ].map((item) => (
                        <p key={item} className="flex gap-2.5">
                          <CircleAlert className="mt-0.5 size-4 shrink-0 text-[#c2ddcf]" />
                          {item}
                        </p>
                      ))}
                    </div>
                  </aside>
                </div>
              </div>
            </div>
          </details>
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="projets"
          >
            <summary>
              <FolderKanban size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Projets et heures</h2>
                <p>Le travail, les documents et les coûts de chaque projet.</p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
              <div className="mx-auto max-w-7xl">
                <SectionHeading
                  eyebrow="Projets & heures"
                  title="Comprendre ce qui a pris du temps et ce qui a rapporté."
                  text="Chaque projet réunit ses documents, photos, devis et factures. Les calculs utilisent uniquement les données enregistrées."
                />
                <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3">
                  <FeatureCard
                    icon={FolderKanban}
                    title="Projets et documents"
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
            </div>
          </details>
          <details
            className="feature-disclosure"
            data-page-disclosure
            id="banque"
          >
            <summary>
              <Landmark size={24} strokeWidth={1.5} aria-hidden="true" />
              <span>
                <h2>Banque et rapprochements</h2>
                <p>De votre relevé bancaire au bon encaissement.</p>
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="feature-details">
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
                      <span className="text-xs font-bold tracking-[.13em] text-[#626b66]">
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
                  requis avant de confirmer un paiement. Zentra ne se connecte
                  pas directement à la banque et ne produit pas encore d’ordre
                  pain.001.
                </TruthNote>
              </div>
            </div>
          </details>
        </section>
        <section className="page-section page-width page-split" id="partage">
          <div>
            <h2>
              Votre entreprise.
              <br />
              <span>Sur vos appareils.</span>
            </h2>
            <p>
              Connectez votre compte et choisissez la même entreprise. Les
              documents, les chiffres et les réglages partagés suivent les
              modifications enregistrées par les membres autorisés.
            </p>
          </div>
          <div className="page-reading-copy">
            <h3>Chaque personne a son accès.</h3>
            <p>
              Les rôles encadrent les actions. Une connexion Internet permet
              l’échange des changements. Les formulaires en cours et les
              conflits éventuels demandent un traitement distinct.
            </p>
            <a className="page-text-link" href="/security">
              Comprendre le partage <ArrowRight size={17} />
            </a>
          </div>
        </section>
        <section className="page-band" id="automatisations">
          <div className="page-width page-split">
            <div>
              <h2>
                Moins de répétitions.
                <br />
                <span>Plus de suivi.</span>
              </h2>
              <p>
                Les brouillons récurrents et les relances préparées restent sous
                votre contrôle. Avec l’option Automation, vos documents et
                messages peuvent aussi préparer les prochaines actions.
              </p>
              <a className="page-text-link" href="/automation">
                Explorer Automation <ArrowRight size={17} />
              </a>
            </div>
            <div className="page-reading-copy">
              <h3>Vous choisissez ce qui s’applique.</h3>
              <p>
                L’option Automation coûte 15 CHF/mois par entreprise avec
                Gestion. Les parcours e-mail nécessitent Support relié. Aucun
                paiement bancaire ni envoi automatique de réponse.
              </p>
            </div>
          </div>
        </section>
        <section className="page-section page-width">
          <details className="page-detail">
            <summary>
              Explorer les aperçus de l’application
              <ChevronDown size={20} />
            </summary>
            <p className="page-caption">
              Données fictives. Votre application travaille avec les données de
              votre entreprise.
            </p>
            <ProductShowcase />
          </details>
          <details className="page-detail">
            <summary>
              Consulter le détail des disponibilités
              <ChevronDown size={20} />
            </summary>
            <div className="capability-reading-list">
              {capabilityRows.map(([title, status, text]) => (
                <div key={title}>
                  <h3>{title}</h3>
                  <p>{text}</p>
                  <span>{status}</span>
                </div>
              ))}
            </div>
          </details>
        </section>
        <section className="page-finish page-width">
          <h2>Essayez, tout simplement.</h2>
          <p>Découvrez les vrais écrans de Zentra, avec une entreprise de démonstration.</p>
          <div className="page-actions">
            <a className="page-primary" href="/demo-facture">
              Ouvrir la démo <ArrowRight size={17} />
            </a>
            <a className="page-text-link" href="/pricing">
              Choisir une formule <ArrowRight size={17} />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
