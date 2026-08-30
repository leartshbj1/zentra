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
import { PurchaseButton } from '@/components/purchase-button';
import { cn } from '@/lib/utils';

const features = [
  { icon: FolderKanban, title: 'Projets, chantiers & clients', text: 'Le module adapte ses libellés au secteur choisi tout en conservant dates, budget, avancement, documents et intervenants.' },
  { icon: FileCheck2, title: 'Devis détaillés', text: 'Vos lignes, vos prix et vos taux de TVA. Un devis accepté devient une facture sans double saisie.' },
  { icon: Receipt, title: 'Factures & paiements', text: 'Acomptes, situations, factures finales, échéances, QR-facture suisse et montants réellement encaissés.' },
  { icon: Clock3, title: 'Temps de travail', text: 'Chronomètre ou saisie manuelle, par collaborateur et par projet ou chantier, avec historique vérifiable.' },
  { icon: WalletCards, title: 'Dépenses & rentabilité', text: 'Matériaux, sous-traitance, locations et coût horaire alimentent une marge fondée sur vos saisies.' },
  { icon: Users, title: 'Équipe & salaires', text: 'Préparez les fiches avec vos propres retenues, sans taux inventé, puis contrôlez-les avec votre fiduciaire.' },
];

const localPromises = [
  { icon: Database, title: 'Base locale', text: 'Clients, montants, heures et salaires sont enregistrés dans une base SQLite sur votre ordinateur.' },
  { icon: WifiOff, title: 'Travail hors ligne', text: 'Les fonctions métier continuent de fonctionner sans connexion Internet.' },
  { icon: HardDrive, title: 'Sauvegarde maîtrisée', text: 'Vous choisissez où créer votre sauvegarde et pouvez la restaurer sur un autre PC.' },
  { icon: LockKeyhole, title: 'Aucun espace cloud métier', text: 'L’application n’envoie pas vos données d’entreprise vers un serveur Elyko.' },
];

const sectors = [
  ['A', 'Agriculture, sylviculture et pêche'], ['B', 'Industries extractives'], ['C', 'Industrie manufacturière'],
  ['D', 'Énergie'], ['E', 'Eau, déchets et dépollution'], ['F', 'Construction'], ['G', 'Commerce'],
  ['H', 'Transports et entreposage'], ['I', 'Hébergement et restauration'], ['J', 'Édition et contenus'],
  ['K', 'Télécoms, informatique et information'], ['L', 'Finance et assurance'], ['M', 'Immobilier'],
  ['N', 'Activités spécialisées, scientifiques et techniques'], ['O', 'Services administratifs et soutien'],
  ['P', 'Administration publique'], ['Q', 'Enseignement'], ['R', 'Santé et action sociale'],
  ['S', 'Arts, sports et loisirs'], ['T', 'Autres services'], ['U', 'Activités des ménages'],
  ['V', 'Organisations extraterritoriales'],
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#f6f4ef] text-[#18221d]">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 lg:px-8">
        <a href="#accueil" className="flex items-center gap-2.5" aria-label="Elyko, accueil">
          <BrandMark className="size-9 shadow-sm" />
          <span className="font-semibold tracking-[-0.03em]">Elyko</span>
        </a>
        <nav className="hidden items-center gap-7 text-sm text-[#5c655f] md:flex" aria-label="Navigation principale">
          <a href="#fonctionnalites" className="transition hover:text-[#173d2c]">Fonctionnalités</a>
          <a href="#secteurs" className="transition hover:text-[#173d2c]">Secteurs</a>
          <a href="#confidentialite" className="transition hover:text-[#173d2c]">Données locales</a>
          <a href="#tarif" className="transition hover:text-[#173d2c]">Tarif</a>
          <a href="mailto:leartshabija@gmail.com" className="transition hover:text-[#173d2c]">Contact</a>
        </nav>
        <a href="/telecharger" className={cn(buttonVariants({ size: 'lg' }), 'rounded-full bg-[#173d2c] px-5 text-white hover:bg-[#24563f]')}>
          Télécharger <FileDown className="size-4" />
        </a>
      </header>

      <section id="accueil" className="mx-auto grid w-full max-w-7xl gap-12 px-5 pb-20 pt-14 lg:grid-cols-[.9fr_1.1fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-20">
        <div className="relative z-10">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#d9d5ca] bg-white/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-[.13em] text-[#46604f]">
            <span className="size-1.5 rounded-full bg-[#e79b2f]" /> Application Windows · données locales
          </div>
          <h1 className="max-w-xl text-balance text-5xl font-semibold leading-[.98] tracking-[-.055em] sm:text-6xl lg:text-7xl">
            Chaque activité.<br /><span className="text-[#b86b16]">Chaque franc.</span><br />Enfin clair.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[#667068]">
            Une vraie application Windows pour piloter votre entreprise, quel que soit son domaine, avec une section projets et chantiers, des devis, factures, heures, dépenses, salaires et comptes. Vos données restent sur votre PC.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a href="/telecharger" className={cn(buttonVariants({ size: 'lg' }), 'h-12 rounded-full bg-[#e79b2f] px-6 text-[#1f281f] shadow-[0_10px_30px_rgba(201,117,21,.2)] hover:bg-[#f1aa42]')}>
              Télécharger le .exe <ArrowRight className="size-4" />
            </a>
            <a href="mailto:leartshabija@gmail.com?subject=Demande%20de%20devis%20Elyko" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-12 rounded-full border-[#cfcabf] bg-white/60 px-6')}>
              Demander une offre
            </a>
          </div>
          <a href="/demo-facture" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#315e48] underline decoration-[#d59a47] underline-offset-4">Essayer le générateur de facture interactif <ArrowRight className="size-4" /></a>
          <p className="mt-4 text-sm text-[#737b75]">Windows 10/11 64 bits · 50 CHF / mois · sauvegardes exportables</p>
        </div>

        <div className="relative">
          <div className="absolute -inset-16 -z-10 rounded-full bg-[#e6c988]/35 blur-3xl" />
          <div className="overflow-hidden rounded-[28px] border border-black/10 bg-[#fffdf8] shadow-[0_35px_90px_rgba(35,45,38,.16)]">
            <div className="flex items-center justify-between border-b border-[#e6e2d8] px-5 py-4">
              <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-[#ef7f64]" /><span className="size-2.5 rounded-full bg-[#efbd55]" /><span className="size-2.5 rounded-full bg-[#78b17f]" /></div>
              <span className="rounded-full bg-[#eef2ed] px-3 py-1 text-[11px] font-medium text-[#4b5a50]">Premier démarrage</span>
            </div>
            <div className="grid min-h-[490px] grid-cols-[74px_1fr] sm:grid-cols-[170px_1fr]">
              <aside className="border-r border-[#e9e5dc] bg-[#173d2c] p-3 text-white sm:p-5">
                <BrandMark className="mb-8 size-10" />
                {['Activité', 'Entreprise', 'Facturation', 'Projets', 'Salaires', 'Sauvegarde'].map((item, index) => (
                  <div key={item} className={cn('mb-2 rounded-lg px-2.5 py-2 text-xs', index === 0 ? 'bg-white/12 text-white' : 'text-white/45')}>
                    <span className="sm:hidden">{index + 1}</span><span className="hidden sm:inline">{item}</span>
                  </div>
                ))}
              </aside>
              <div className="min-w-0 p-5 sm:p-7">
                <div className="flex items-center justify-between text-[11px] font-medium text-[#778079]"><span>QUESTIONNAIRE DE CONFIGURATION</span><span>1 / 6</span></div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e8e5dd]"><div className="h-full w-1/6 rounded-full bg-[#e79b2f]" /></div>
                <h2 className="mt-8 text-2xl font-semibold tracking-tight">Quel est votre domaine d’activité&nbsp;?</h2>
                <p className="mt-2 text-sm leading-6 text-[#747d76]">Choisissez la section et la division NOGA 2025, puis précisez votre métier. Aucune donnée d’exemple n’est créée.</p>
                <div className="mt-7 grid gap-4 sm:grid-cols-2">
                  {['Section économique *', 'Division NOGA *', 'Activité précise *', 'Code NOGA détaillé (facultatif)'].map((label, index) => (
                    <div key={label} className={index === 2 ? 'sm:col-span-2' : ''}><span className="text-[11px] font-medium text-[#606a63]">{label}</span><span className="mt-1.5 block h-10 rounded-xl border border-[#dedbd2] bg-white" /></div>
                  ))}
                </div>
                <div className="mt-7 flex items-center justify-between"><span className="flex items-center gap-2 text-xs text-[#54705e]"><ShieldCheck className="size-4" /> Enregistré uniquement sur ce PC</span><span className="rounded-full bg-[#173d2c] px-5 py-2.5 text-xs font-semibold text-white">Continuer</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="secteurs" className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-20 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr] lg:items-end">
            <div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Multisectoriel par conception</p><h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">Votre métier d’abord. Les chantiers quand vous en avez.</h2></div>
            <div className="max-w-2xl lg:justify-self-end"><p className="text-lg leading-8 text-[#6b746e]">Au premier lancement, l’utilisateur choisit sa section et sa division NOGA 2025 puis décrit son activité précise. L’application adapte la terminologie, mais garde un module projets / chantiers disponible.</p><a className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#315e48] underline underline-offset-4" href="https://www.kubb-tool.bfs.admin.ch/fr/noga/2025" target="_blank" rel="noreferrer">Nomenclature officielle OFS / KUBB <ArrowRight className="size-4" /></a></div>
          </div>
          <div className="mt-12 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{sectors.map(([code, label]) => <div key={code} className="flex items-center gap-3 rounded-xl border border-[#e1ddd3] bg-white p-3.5"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#e7efe9] text-sm font-bold text-[#315d47]">{code}</span><span className="text-sm leading-5 text-[#566159]">{label}</span></div>)}</div>
          <div className="mt-6 flex items-start gap-3 rounded-2xl bg-[#f2eee5] p-5 text-sm leading-6 text-[#667068]"><BriefcaseBusiness className="mt-0.5 size-5 shrink-0 text-[#b86b16]" /><p>Les 22 sections et toutes leurs divisions sont proposées. Le code NOGA détaillé et le libellé exact restent saisissables librement pour couvrir les activités spécialisées.</p></div>
        </div>
      </section>

      <section id="confidentialite" className="bg-[#173d2c] px-5 py-24 text-white lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.78fr_1.22fr] lg:items-end">
            <div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efaa3c]">Vos données vous appartiennent</p><h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">Pas de faux cloud caché derrière une icône.</h2></div>
            <p className="max-w-2xl text-lg leading-8 text-white/60 lg:justify-self-end">Elyko installe le logiciel et sa base sur l’ordinateur du client. La gestion quotidienne ne dépend pas d’un navigateur ni d’une connexion permanente.</p>
          </div>
          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{localPromises.map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl border border-white/10 bg-white/7 p-6"><Icon className="size-5 text-[#efaa3c]" /><h3 className="mt-5 font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-white/55">{text}</p></div>)}</div>
        </div>
      </section>

      <section id="fonctionnalites" className="border-b border-[#ded9ce] bg-[#fffdf9] px-5 py-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.75fr_1.25fr] lg:items-end"><div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Du devis au bilan</p><h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">Un vrai outil de gestion, pas une vitrine vide.</h2></div><p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">Les indicateurs apparaissent seulement lorsque vous avez saisi les données nécessaires. Aucun client, montant, projet, chantier ou salaire fictif n’est injecté.</p></div>
          <div className="mt-14 grid gap-px overflow-hidden rounded-[24px] border border-[#ded9ce] bg-[#ded9ce] md:grid-cols-2 lg:grid-cols-3">{features.map(({ icon: Icon, title, text }) => <div key={title} className="bg-[#fffdf9] p-7"><span className="grid size-11 place-items-center rounded-2xl bg-[#e7efe9] text-[#315d47]"><Icon className="size-5" /></span><h3 className="mt-6 font-semibold tracking-tight">{title}</h3><p className="mt-3 text-sm leading-6 text-[#737c75]">{text}</p></div>)}</div>
        </div>
      </section>

      <section className="border-b border-[#ded9ce] px-5 py-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[.82fr_1.18fr] lg:items-end">
            <div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Gestion suisse intégrée</p><h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">De l’offre au bilan, sans ressaisir les mêmes chiffres.</h2></div>
            <p className="max-w-2xl text-lg leading-8 text-[#6b746e] lg:justify-self-end">Chaque action métier produit une trace explicable : l’acceptation autorise la conversion du devis, l’émission alimente la comptabilité, le paiement solde la créance et l’échéance déclenche les relances locales.</p>
          </div>
          <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">{[
            { icon: QrCode, title: 'QR-facture suisse', text: 'Adresses structurées, IBAN ou QR-IBAN, référence contrôlée et section paiement imprimable.' },
            { icon: BellRing, title: 'Relances maîtrisées', text: 'Niveaux, délais, frais éventuels, modèles et historique sans serveur Elyko.' },
            { icon: BookOpenCheck, title: 'Partie double', text: 'Journal, grand livre, balance, bilan et résultat issus d’écritures toujours équilibrées.' },
            { icon: WalletCards, title: 'Paie détaillée', text: 'Toutes les bases et cotisations employé/employeur restent visibles, modifiables et contrôlables.' },
          ].map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl border border-[#ddd8cd] bg-white/65 p-6"><Icon className="size-5 text-[#b86b16]" /><h3 className="mt-5 font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-[#717a73]">{text}</p></div>)}</div>
          <div className="mt-10 flex flex-col items-start justify-between gap-5 rounded-[24px] bg-[#173d2c] p-6 text-white sm:flex-row sm:items-center sm:p-8"><div><p className="font-semibold">Testez le document avant d’installer.</p><p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">Le générateur commence vide, calcule vos propres lignes et imprime un aperçu PDF sans enregistrer ni envoyer vos saisies.</p></div><a href="/demo-facture" className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#efaa3c] px-5 text-sm font-semibold text-[#173d2c]">Créer une facture <ArrowRight className="size-4" /></a></div>
        </div>
      </section>

      <section className="px-5 py-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl"><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Votre première ouverture</p><h2 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">Le logiciel s’adapte à votre entreprise.</h2><p className="mt-5 text-lg leading-8 text-[#6b746e]">L’assistant commence par le domaine NOGA et l’activité précise, puis demande les informations nécessaires avant d’autoriser la facturation. Vous pouvez aussi restaurer une sauvegarde existante.</p></div>
          <div className="mt-14 grid gap-4 lg:grid-cols-4">{[
            ['01', 'Activité', 'Section et division NOGA 2025, code détaillé et description précise du métier.'],
            ['02', 'Identité', 'Raison sociale, responsable, adresse, UID, coordonnées et logo.'],
            ['03', 'Facturation', 'IBAN, numérotation, délais, validité et taux de TVA explicites.'],
            ['04', 'Organisation & protection', 'Projets ou chantiers, temps, paie, stockage et sauvegarde locale.'],
          ].map(([number, title, text], index) => <div key={number} className="relative rounded-2xl border border-[#ddd8cd] bg-white/60 p-6"><span className="text-xs font-bold text-[#c37a20]">{number}</span><h3 className="mt-8 text-lg font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-[#717a73]">{text}</p>{index < 3 && <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-5 rounded-full bg-[#f6f4ef] text-[#9b7b50] lg:block" />}</div>)}</div>
        </div>
      </section>

      <section className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-24 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[.85fr_1.15fr] lg:items-center">
          <div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Des chiffres explicables</p><h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">Savoir combien un projet ou chantier a duré et ce qu’il a rapporté.</h2><p className="mt-6 text-lg leading-8 text-[#6b746e]">Le logiciel sépare durée prévue, dates réelles et heures travaillées. La rentabilité utilise uniquement le facturé net, les coûts horaires configurés et les dépenses enregistrées.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">{[
            { icon: Banknote, title: 'Facturé et encaissé', text: 'Deux montants distincts, par facture et par projet ou chantier.' },
            { icon: Clock3, title: 'Durée et heures réelles', text: 'Calendrier du projet et temps pointé ne sont jamais confondus.' },
            { icon: BarChart3, title: 'Marge sur données saisies', text: 'Aucune estimation masquée lorsqu’un coût manque.' },
            { icon: ShieldCheck, title: 'Traçabilité locale', text: 'Paiements, changements de statut et documents restent reliés.' },
          ].map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl border border-[#e1ddd3] bg-white p-6"><Icon className="size-5 text-[#b86b16]" /><h3 className="mt-5 font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-[#747d76]">{text}</p></div>)}</div>
        </div>
      </section>

      <section id="tarif" className="px-5 py-24 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="text-center"><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Un prix simple</p><h2 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">Tout Elyko. 50 CHF par mois.</h2><p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-[#6e7770]">Une licence Windows pour gérer l’activité, avec les mises à jour de l’application. Les données métier restent chez le client.</p></div>
          <div className="mt-12 grid overflow-hidden rounded-[28px] border border-[#d9d4c9] bg-white shadow-[0_25px_70px_rgba(29,45,35,.1)] md:grid-cols-[1.1fr_.9fr]">
            <div className="p-7 sm:p-10"><div className="flex items-end gap-2"><span className="text-5xl font-semibold tracking-[-.05em]">50 CHF</span><span className="pb-1 text-sm text-[#767f78]">/ mois</span></div><p className="mt-3 text-sm text-[#747d76]">Montant mensuel fixé côté serveur et encaissé sur la page sécurisée Stripe.</p><div className="mt-8 grid gap-3 sm:grid-cols-2">{['Application Windows complète', '22 secteurs NOGA 2025', 'Données métier locales', 'Projets, chantiers & clients', 'Devis & factures', 'Paiements & échéances', 'Temps & dépenses', 'Rentabilité par dossier', 'Salaires préparatoires', 'Comptabilité locale', 'Sauvegarde & restauration', 'Mises à jour incluses'].map((item) => <div key={item} className="flex items-center gap-2 text-sm"><Check className="size-4 text-[#3f7454]" />{item}</div>)}</div></div>
            <div className="flex flex-col justify-between bg-[#173d2c] p-7 text-white sm:p-10"><div><Laptop className="size-7 text-[#efaa3c]" /><h3 className="mt-6 text-2xl font-semibold tracking-tight">Une vraie application `.exe`.</h3><p className="mt-4 text-sm leading-6 text-white/55">Payez sur la page sécurisée Stripe, téléchargez l’installateur puis liez la licence signée à votre PC. Vos données métier ne quittent pas l’ordinateur.</p></div><div className="mt-9 space-y-3"><PurchaseButton compact /><a href="/telecharger" className="flex h-12 items-center justify-center gap-2 rounded-full border border-white/15 px-5 text-sm font-semibold text-white">Télécharger pour Windows <FileDown className="size-4" /></a><a href="mailto:leartshabija@gmail.com?subject=Activer%20Elyko" className="flex h-12 items-center justify-center rounded-full border border-white/15 px-5 text-sm font-semibold text-white">Contacter le service commercial</a></div></div>
          </div>
        </div>
      </section>

      <section className="border-y border-[#ddd8cd] bg-[#fffdf9] px-5 py-24 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[.8fr_1.2fr]">
          <div><p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9a651f]">Questions fréquentes</p><h2 className="mt-4 text-4xl font-semibold tracking-[-.045em]">Clair jusque dans les détails.</h2><p className="mt-5 text-sm leading-6 text-[#727b74]">Une question commerciale ou un besoin particulier&nbsp;? <a href="mailto:leartshabija@gmail.com" className="font-semibold text-[#315e48] underline underline-offset-4">Écrivez-nous</a>.</p></div>
          <div className="divide-y divide-[#ddd8cd]">{[
            ['Est-ce réellement un programme Windows ?', 'Oui. Le téléchargement fournit un installateur .exe pour Windows 10 et Windows 11 64 bits. L’application fonctionne dans sa propre fenêtre, sans dépendre d’un onglet de navigateur.'],
            ['Où sont enregistrées mes données ?', 'Dans le dossier local de l’application sur votre PC. Vous pouvez créer une sauvegarde dans l’emplacement de votre choix et la restaurer ensuite.'],
            ['Y a-t-il des données de démonstration ?', 'Non. Au premier lancement, la base est vide et un questionnaire vous demande les informations réelles de votre entreprise.'],
            ['Le logiciel est-il réservé à la construction ?', 'Non. Le questionnaire couvre les 22 sections NOGA 2025 et leurs divisions. Le module projets / chantiers reste disponible, avec une terminologie adaptée au domaine choisi.'],
            ['Puis-je créer de vrais devis et factures ?', 'Oui. Vous configurez les coordonnées, numéros, délais et taux de TVA. Vous pouvez ensuite créer, imprimer, convertir et suivre vos documents.'],
            ['Le module salaire est-il certifié Swissdec ?', 'Non. Il prépare les éléments avec les montants et taux que vous saisissez. Une validation par votre fiduciaire reste indispensable avant utilisation définitive.'],
          ].map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold"><span>{question}</span><Plus className="size-4 transition group-open:rotate-45" /></summary><p className="max-w-2xl pt-3 text-sm leading-6 text-[#727b74]">{answer}</p></details>)}</div>
        </div>
      </section>

      <section className="px-5 py-24 lg:px-8"><div className="mx-auto max-w-7xl overflow-hidden rounded-[30px] bg-[#e7a33a] px-6 py-14 text-[#183d2c] sm:px-12 lg:flex lg:items-center lg:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.13em]">Prêt à travailler avec vos vrais chiffres&nbsp;?</p><h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-tight tracking-[-.045em]">Installez Elyko sur votre PC Windows.</h2></div><div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-0"><a href="/telecharger" className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white">Télécharger le .exe <ArrowRight className="size-4" /></a><a href="mailto:leartshabija@gmail.com?subject=Demande%20de%20devis%20Elyko" className="inline-flex h-12 items-center justify-center rounded-full border border-[#173d2c]/20 px-6 text-sm font-semibold">Demander une offre</a></div></div></section>

      <footer className="border-t border-[#ddd8cd] px-5 py-8 lg:px-8"><div className="mx-auto flex max-w-7xl flex-col gap-5 text-xs text-[#778078] sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-2"><BrandMark className="size-7" /><strong className="text-[#27382e]">Elyko</strong><span>· Gestion d’entreprise multisectorielle suisse sur Windows</span></div><div className="flex flex-wrap gap-5"><a href="mailto:leartshabija@gmail.com">leartshabija@gmail.com</a><span>© 2026</span></div></div></footer>
    </main>
  );
}
