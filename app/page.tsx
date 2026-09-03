import type { Metadata } from 'next';
import {
  ArrowRight,
  Banknote,
  BookOpenCheck,
  Building2,
  Check,
  Database,
  FileCheck2,
  FileDown,
  FolderKanban,
  HardDrive,
  Landmark,
  MailCheck,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { HeroDashboard } from '@/components/hero-dashboard';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { buttonVariants } from '@/components/ui/button';
import { ZENTRA_VERSION } from '@/lib/downloads';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: { absolute: 'Zentra — ERP suisse pour PME' },
  description:
    'Toute votre PME dans un seul logiciel : facturation suisse, comptabilité, salaires, achats, projets et banque, pour 50 CHF par mois.',
  alternates: { canonical: '/' },
  openGraph: {
    url: '/',
    title: 'Zentra — Toute votre PME. Un seul logiciel.',
    description:
      'Un ERP local-first conçu pour les PME suisses. 50 CHF par mois, prix fixe et collaborateurs inclus.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const values = [
  {
    icon: BookOpenCheck,
    eyebrow: 'Tout au même endroit',
    title: 'Une information saisie. Une suite logique.',
    text: 'Devis, factures, achats, comptabilité, salaires et projets restent reliés au lieu de vivre dans des outils séparés.',
  },
  {
    icon: ShieldCheck,
    eyebrow: 'Conçu pour la Suisse',
    title: 'Les flux suisses font partie du produit.',
    text: 'TVA suisse, QR-factures, relevés CAMT et préparation comptable sont intégrés avec des étapes de contrôle explicites.',
  },
  {
    icon: Database,
    eyebrow: 'Vos données, chez vous',
    title: 'Le métier reste d’abord sur votre ordinateur.',
    text: 'Clients, salaires, projets, heures et comptabilité sont conservés dans la base locale de l’application.',
  },
] as const;

const workflow = [
  ['01', 'Devis', 'Préparer et faire accepter'],
  ['02', 'Commande', 'Réserver et organiser'],
  ['03', 'Livraison', 'Tracer le réalisé'],
  ['04', 'Facture', 'Émettre avec QR'],
  ['05', 'Paiement', 'Pointer ou rapprocher'],
  ['06', 'Comptabilité', 'Produire l’écriture liée'],
] as const;

const modules = [
  {
    icon: FileCheck2,
    title: 'Ventes & facturation',
    text: 'Devis, commandes, livraisons, factures QR, avoirs et relances supervisées.',
    href: '/features#ventes',
  },
  {
    icon: Building2,
    title: 'Achats & fournisseurs',
    text: 'Commandes, réceptions, factures reçues, rapprochement et paiements.',
    href: '/features#achats',
  },
  {
    icon: BookOpenCheck,
    title: 'Comptabilité & TVA',
    text: 'Journal, grand livre, balance, bilan, résultat et export TVA à contrôler.',
    href: '/features#comptabilite',
  },
  {
    icon: Users,
    title: 'Salaires',
    text: 'Import local assisté, calculs contrôlés et fiches PDF détaillées.',
    href: '/features#salaires',
  },
  {
    icon: FolderKanban,
    title: 'Projets & heures',
    text: 'Tâches, jalons, temps, coûts, facturé, encaissé et rentabilité.',
    href: '/features#projets',
  },
  {
    icon: Landmark,
    title: 'Banque & CAMT',
    text: 'Import local des relevés et rapprochements proposés avant validation.',
    href: '/features#banque',
  },
] as const;

const automationStories = [
  {
    icon: MailCheck,
    label: 'Facture fournisseur reçue',
    steps: [
      'Vous choisissez un e-mail exporté en .eml',
      'Zentra extrait localement la pièce PDF ou image choisie',
      'Vous vérifiez le document, le fournisseur, les dates et la TVA',
      'Un brouillon est créé, jamais une écriture définitive',
    ],
  },
  {
    icon: Banknote,
    label: 'Mouvement bancaire importé',
    steps: [
      'Vous importez un fichier CAMT.053 ou CAMT.054',
      'Zentra recherche la facture correspondante',
      'Vous contrôlez le compte, la référence et le montant',
      'Le paiement et son écriture sont créés après validation',
    ],
  },
] as const;

export default function Home() {
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
        <section
          id="accueil"
          className="relative mx-auto grid w-full max-w-7xl gap-12 px-5 pb-16 pt-10 sm:pb-20 sm:pt-16 lg:grid-cols-[.86fr_1.14fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-20"
        >
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#d8d5cb] bg-white/72 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.12em] text-[#42614e]">
              <span className="local-pulse size-1.5 rounded-full bg-[#4f9b68]" />
              Logiciel de gestion PME Suisse
            </div>
            <h1 className="mt-6 max-w-2xl text-balance text-[2.85rem] font-semibold leading-[.96] tracking-[-.06em] min-[390px]:text-5xl sm:text-6xl lg:text-[4.65rem]">
              Toute votre PME.
              <br />
              <span className="text-[#b86b16]">Un seul logiciel.</span>
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-[#616d65] sm:text-xl sm:leading-9">
              Facturation, comptabilité, salaires, achats et gestion réunis dans
              un ERP conçu pour les PME suisses.
            </p>

            <div
              className="mt-7 flex flex-wrap gap-2"
              aria-label="Tarif Zentra"
            >
              <strong className="rounded-full bg-[#173d2c] px-4 py-2 text-sm text-white">
                50 CHF / mois
              </strong>
              <span className="rounded-full border border-[#d7d2c6] bg-white/70 px-4 py-2 text-sm font-semibold text-[#48564e]">
                Prix fixe
              </span>
              <span className="rounded-full border border-[#d7d2c6] bg-white/70 px-4 py-2 text-sm font-semibold text-[#48564e]">
                Collaborateurs inclus
              </span>
            </div>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a
                href="/demo-facture"
                className={cn(
                  buttonVariants({ size: 'lg' }),
                  'h-12 rounded-full bg-[#e79b2f] px-6 text-[#1f281f] shadow-[0_12px_32px_rgba(201,117,21,.2)] hover:bg-[#f1aa42]',
                )}
              >
                Essayer Zentra <ArrowRight className="size-4" />
              </a>
              <a
                href="#workflow"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'lg' }),
                  'h-12 rounded-full border-[#cfcabf] bg-white/60 px-6 hover:bg-white',
                )}
              >
                Découvrir Zentra
              </a>
            </div>
            <p className="mt-4 text-sm leading-6 text-[#667169]">
              Démonstration web sans compte · Windows · macOS en accès anticipé
              · données métier principalement locales
            </p>
          </div>

          <HeroDashboard />

          <div className="lg:col-span-2">
            <div className="grid gap-px overflow-hidden rounded-2xl border border-[#d9d6cc] bg-[#d9d6cc] sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['Version', `Zentra ${ZENTRA_VERSION}`],
                ['Plateformes', 'Windows · macOS anticipé'],
                ['Facturation', 'QR-factures suisses'],
                ['Équipe', 'Accès sans prix par siège'],
              ].map(([label, value]) => (
                <div key={label} className="bg-[#fbfaf6] px-5 py-4">
                  <span className="block text-[10px] font-bold uppercase tracking-[.14em] text-[#899088]">
                    {label}
                  </span>
                  <strong className="mt-1.5 block text-sm text-[#2a4034]">
                    {value}
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          className="border-y border-[#dedad0] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="valeur-title"
        >
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl">
              <p className="site-eyebrow">Pourquoi Zentra</p>
              <h2 id="valeur-title" className="site-section-title mt-4">
                Moins de ressaisie. Plus de continuité.
              </h2>
            </div>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {values.map(({ icon: Icon, eyebrow, title, text }) => (
                <article
                  key={title}
                  className="interactive-card rounded-[1.6rem] border border-[#ddd9cf] bg-white p-6 sm:p-7"
                >
                  <span className="grid size-11 place-items-center rounded-2xl bg-[#e7f0e9] text-[#315f47]">
                    <Icon className="size-5" />
                  </span>
                  <p className="mt-6 text-[11px] font-bold uppercase tracking-[.13em] text-[#a16620]">
                    {eyebrow}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold tracking-[-.025em]">
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
          id="workflow"
          className="px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="workflow-title"
        >
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-6 lg:grid-cols-[.75fr_1.25fr] lg:items-end">
              <div>
                <p className="site-eyebrow">Un seul flux</p>
                <h2 id="workflow-title" className="site-section-title mt-4">
                  Chaque étape prépare la suivante.
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-[#657068] lg:justify-self-end">
                Les modules ne sont pas simplement côte à côte. Les documents,
                paiements et écritures gardent leur lien, avec une validation
                aux étapes sensibles.
              </p>
            </div>

            <ol className="workflow-rail mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              {workflow.map(([number, title, text]) => (
                <li
                  key={number}
                  className="workflow-node relative rounded-2xl border border-[#d9d6cc] bg-white p-5"
                >
                  <span className="text-[10px] font-bold tracking-[.14em] text-[#a66b1f]">
                    {number}
                  </span>
                  <h3 className="mt-5 font-semibold text-[#244331]">{title}</h3>
                  <p className="mt-2 text-xs leading-5 text-[#69736c]">
                    {text}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-5 flex flex-col gap-3 text-sm leading-6 text-[#687269] sm:flex-row sm:items-center sm:justify-between">
              <p>
                Ce parcours s’applique aux articles à livrer. Une prestation
                simple peut rester dans un flux de facturation directe.
              </p>
              <a
                href="/features#ventes"
                className="inline-flex min-h-11 shrink-0 items-center gap-2 font-semibold text-[#315f47]"
              >
                Voir le flux complet <ArrowRight className="size-4" />
              </a>
            </div>
          </div>
        </section>

        <section
          id="logiciel"
          className="border-y border-[#d8ddd8] bg-[#edf3ef] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="modules-title"
        >
          <span id="fonctionnalites" className="sr-only" />
          <div className="mx-auto max-w-7xl">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="site-eyebrow text-[#3b7151]">
                  Modules principaux
                </p>
                <h2 id="modules-title" className="site-section-title mt-4">
                  L’essentiel pour gérer une PME suisse.
                </h2>
                <p className="mt-5 text-lg leading-8 text-[#617068]">
                  Six espaces forts, reliés par les mêmes clients, fournisseurs,
                  documents et écritures.
                </p>
              </div>
              <a
                href="/features"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'lg' }),
                  'h-12 rounded-full border-[#bfcfc3] bg-white/70 px-6',
                )}
              >
                Voir toutes les fonctionnalités{' '}
                <ArrowRight className="size-4" />
              </a>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {modules.map(({ icon: Icon, title, text, href }) => (
                <a
                  key={title}
                  href={href}
                  className="interactive-card group rounded-[1.5rem] border border-[#d2dcd4] bg-white/88 p-6 shadow-[0_14px_40px_rgba(41,78,55,.05)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <span className="grid size-11 place-items-center rounded-2xl bg-[#173d2c] text-white">
                      <Icon className="size-5" />
                    </span>
                    <ArrowRight className="size-4 text-[#8a958d] transition-transform group-hover:translate-x-1" />
                  </div>
                  <h3 className="mt-6 text-xl font-semibold tracking-[-.025em]">
                    {title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-[#657068]">
                    {text}
                  </p>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section
          id="automatisation"
          className="relative overflow-hidden bg-[#153b2a] px-5 py-16 text-white sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="automation-title"
        >
          <div className="automation-glow" aria-hidden="true" />
          <div className="relative mx-auto max-w-7xl">
            <div className="grid gap-7 lg:grid-cols-[.8fr_1.2fr] lg:items-end">
              <div>
                <p className="text-xs font-bold uppercase tracking-[.14em] text-[#efb157]">
                  Automatiser sans masquer
                </p>
                <h2
                  id="automation-title"
                  className="mt-4 text-4xl font-semibold leading-tight tracking-[-.05em] sm:text-5xl"
                >
                  Zentra automatise.
                  <br />
                  Vous gardez le contrôle.
                </h2>
              </div>
              <p className="max-w-2xl text-lg leading-8 text-white/68 lg:justify-self-end">
                Zentra prépare ce qui peut l’être. Avant un paiement, une
                écriture ou un envoi, l’utilisateur voit ce qui a été trouvé et
                décide.
              </p>
            </div>

            <div className="mt-12 grid gap-5 lg:grid-cols-2">
              {automationStories.map(({ icon: Icon, label, steps }) => (
                <article
                  key={label}
                  className="rounded-[1.7rem] border border-white/12 bg-white/[.055] p-6 sm:p-8"
                >
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-2xl bg-[#efad48] text-[#173d2c]">
                      <Icon className="size-5" />
                    </span>
                    <h3 className="text-xl font-semibold">{label}</h3>
                  </div>
                  <ol className="mt-7 space-y-0">
                    {steps.map((step, index) => (
                      <li
                        key={step}
                        className="automation-step flex gap-4 pb-5 last:pb-0"
                      >
                        <span className="relative z-10 grid size-7 shrink-0 place-items-center rounded-full border border-white/18 bg-[#214c37] text-[10px] font-bold text-[#f3bb67]">
                          {index + 1}
                        </span>
                        <p className="pt-0.5 text-sm leading-6 text-white/76">
                          {step}
                        </p>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>

            <div className="mt-5 flex flex-col gap-4 rounded-[1.4rem] border border-[#efb157]/30 bg-[#efb157]/10 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-3xl text-sm leading-6 text-white/78">
                Les relances sont préparées dans l’application, puis ouvertes
                comme e-mail prérempli ou imprimées après votre décision. Zentra
                n’envoie actuellement ni e-mail ni SMS tout seul.
              </p>
              <a
                href="/features#automatisations"
                className="inline-flex min-h-11 shrink-0 items-center gap-2 font-semibold text-[#f4bd69]"
              >
                Comprendre les garde-fous <ArrowRight className="size-4" />
              </a>
            </div>
          </div>
        </section>

        <section
          id="confidentialite"
          className="px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="local-title"
        >
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.8fr_1.2fr] lg:items-center">
            <div>
              <p className="site-eyebrow">Approche local-first</p>
              <h2 id="local-title" className="site-section-title mt-4">
                Les données de votre entreprise ne devraient pas appartenir à
                votre logiciel.
              </h2>
              <p className="mt-6 text-lg leading-8 text-[#647068]">
                La gestion quotidienne est principalement conservée sur
                l’ordinateur de l’entreprise. Le serveur intervient pour le
                compte, les rôles, la licence et les PDF que vous choisissez
                d’archiver.
              </p>
              <a
                href="/security"
                className="mt-7 inline-flex min-h-11 items-center gap-2 font-semibold text-[#315f47]"
              >
                Voir précisément où vont les données{' '}
                <ArrowRight className="size-4" />
              </a>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <article className="rounded-[1.7rem] border border-[#cad8ce] bg-[#eaf2ec] p-7">
                <span className="grid size-12 place-items-center rounded-2xl bg-[#173d2c] text-white">
                  <HardDrive className="size-5" />
                </span>
                <p className="mt-6 text-[11px] font-bold uppercase tracking-[.13em] text-[#477159]">
                  Sur votre ordinateur
                </p>
                <h3 className="mt-2 text-xl font-semibold">Données métier</h3>
                <p className="mt-3 text-sm leading-7 text-[#5f6d64]">
                  Clients, fournisseurs, employés, salaires, projets, heures,
                  banque, documents de travail, écritures et réglages.
                </p>
              </article>
              <article className="rounded-[1.7rem] border border-[#dfd5c6] bg-[#fffaf1] p-7">
                <span className="grid size-12 place-items-center rounded-2xl bg-[#e7a33a] text-[#173d2c]">
                  <ShieldCheck className="size-5" />
                </span>
                <p className="mt-6 text-[11px] font-bold uppercase tracking-[.13em] text-[#9a651f]">
                  Services en ligne
                </p>
                <h3 className="mt-2 text-xl font-semibold">
                  Accès et coffre optionnel
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#675f54]">
                  Authentification, membres, appareils, abonnement et uniquement
                  les PDF transmis volontairement au coffre de l’entreprise.
                </p>
              </article>
              <p className="text-sm leading-6 text-[#6b746e] sm:col-span-2">
                Le local-first rend votre stratégie de sauvegarde indispensable.
                Zentra permet l’export et la restauration, mais ne remplace pas
                une copie externe entretenue par l’entreprise.
              </p>
            </div>
          </div>
        </section>

        <section
          id="tarif"
          className="border-y border-[#ddd8cd] bg-[#fffdf9] px-5 py-16 sm:py-24 lg:px-8"
          data-reveal
          aria-labelledby="pricing-title"
        >
          <div className="mx-auto max-w-5xl">
            <div className="text-center">
              <p className="site-eyebrow">Un prix simple</p>
              <h2 id="pricing-title" className="site-section-title mt-4">
                Tout Zentra. 50 CHF par mois.
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#657068]">
                Un prix pour l’entreprise. Pas de module à débloquer, pas de
                siège à compter.
              </p>
            </div>

            <article className="mt-10 grid overflow-hidden rounded-[2rem] border border-[#d6d2c8] bg-white shadow-[0_28px_80px_rgba(28,53,39,.1)] md:grid-cols-[1.08fr_.92fr]">
              <div className="p-7 sm:p-10">
                <p className="text-xs font-bold uppercase tracking-[.14em] text-[#9a651f]">
                  Zentra
                </p>
                <div className="mt-4 flex items-end gap-2">
                  <strong className="text-5xl tracking-[-.055em] sm:text-6xl">
                    50 CHF
                  </strong>
                  <span className="pb-1.5 text-sm text-[#687269]">/ mois</span>
                </div>
                <p className="mt-4 text-sm leading-7 text-[#657068]">
                  Abonnement mensuel d’entreprise. Le montant est fixé côté
                  serveur et le paiement passe par Stripe lorsque la
                  souscription est ouverte.
                </p>
              </div>
              <div className="bg-[#173d2c] p-7 text-white sm:p-10">
                <ul className="grid gap-3 text-sm">
                  {[
                    'Fonctionnalités incluses',
                    'Collaborateurs et comptable inclus',
                    'Mises à jour incluses',
                    'Sauvegarde et restauration locales',
                  ].map((item) => (
                    <li key={item} className="flex items-center gap-3">
                      <span className="grid size-6 place-items-center rounded-full bg-white/10">
                        <Check className="size-3.5 text-[#efb157]" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="mt-8 grid gap-3 sm:grid-cols-2 md:grid-cols-1">
                  <a
                    href="/pricing"
                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#e7a33a] px-5 text-sm font-semibold text-[#173d2c]"
                  >
                    Voir le tarif <ArrowRight className="size-4" />
                  </a>
                  <a
                    href="/download"
                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/18 px-5 text-sm font-semibold"
                  >
                    Télécharger Zentra <FileDown className="size-4" />
                  </a>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
          <div className="mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-[#e7a33a] px-6 py-12 text-[#173d2c] sm:px-12 sm:py-14 lg:flex lg:items-center lg:justify-between lg:gap-10">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.14em]">
                Commencer simplement
              </p>
              <h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Votre entreprise est déjà assez compliquée. Votre logiciel de
                gestion ne devrait pas l’être.
              </h2>
            </div>
            <div className="mt-8 flex shrink-0 flex-col gap-3 sm:flex-row lg:mt-0 lg:flex-col">
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
                Télécharger l’application
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
