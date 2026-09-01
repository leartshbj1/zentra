import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Clock3,
  Database,
  FileCheck2,
  FolderKanban,
  HardDrive,
  Laptop,
  Landmark,
  LockKeyhole,
  Package,
  QrCode,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  WifiOff,
} from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { DownloadButton } from '@/components/download-button';
import {
  ELYKO_INSTALLER_CHECKSUM_PATH,
  ELYKO_INSTALLER_NAME,
  ELYKO_INSTALLER_SHA256,
  ELYKO_INSTALLER_SIZE_MIB,
  ELYKO_VERSION,
} from '@/lib/downloads';
import { PurchaseButton } from '@/components/purchase-button';

export const metadata = {
  title: `Elyko pour Windows — Télécharger la version ${ELYKO_VERSION}`,
  description:
    'Installez Elyko sur Windows 10 ou 11 pour gérer devis, factures QR et récurrentes supervisées, projets, salaires et comptabilité avec vos données sur votre PC.',
  openGraph: {
    title: 'Elyko pour Windows',
    description: `Toute votre gestion d’entreprise dans une application Windows. Version ${ELYKO_VERSION} disponible.`,
  },
  twitter: {
    title: 'Elyko pour Windows',
    description: `Toute votre gestion d’entreprise dans une application Windows. Version ${ELYKO_VERSION} disponible.`,
  },
};

const capabilities = [
  {
    icon: FileCheck2,
    title: 'Devis, commandes et BL',
    text: 'Les devis avec produits deviennent des commandes livrables; les prestations simples peuvent rester en facture directe.',
  },
  {
    icon: QrCode,
    title: 'Factures QR et récurrentes',
    text: 'Créez une facture unique ou planifiez des brouillons mensuels, trimestriels ou annuels ; l’émission et le QR restent à valider.',
  },
  {
    icon: FolderKanban,
    title: 'Projets et chantiers',
    text: 'Suivez durée, heures, dépenses, facturé, encaissé et rentabilité.',
  },
  {
    icon: Users,
    title: 'Équipe et salaires',
    text: 'Importez des fiches, contrôlez les champs proposés localement et générez des PDF détaillés.',
  },
  {
    icon: Clock3,
    title: 'Temps de travail',
    text: 'Enregistrez les heures par collaborateur et préparez une facture depuis les heures approuvées.',
  },
  {
    icon: Database,
    title: 'Comptabilité liée',
    text: 'Retrouvez journal, grand livre, balance, bilan et résultat.',
  },
  {
    icon: Building2,
    title: 'Fournisseurs et achats',
    text: 'Joignez les justificatifs locaux, suivez les échéances et comptabilisez validation et règlement.',
  },
  {
    icon: Landmark,
    title: 'Import CAMT local',
    text: 'Importez CAMT.053/.054 et confirmez manuellement le crédit client ou le débit fournisseur proposé.',
  },
  {
    icon: Package,
    title: 'Stock traçable',
    text: 'Suivez entrées, sorties, corrections, seuils et déductions des factures standard émises.',
  },
];

export default function DownloadPage() {
  return (
    <main className="min-h-screen overflow-x-clip bg-[#f5f3ee] pb-24 text-[#17231d] md:pb-0">
      <header className="sticky top-0 z-40 border-b border-[#d9d4c9]/75 bg-[#f5f3ee]/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3 lg:px-8">
          <a
            href="/"
            className="flex min-h-11 items-center gap-2.5"
            aria-label="Elyko, accueil"
          >
            <BrandMark className="size-9" />
            <span className="font-semibold tracking-[-.03em]">Elyko</span>
          </a>
          <a
            href="/"
            className="flex min-h-11 items-center gap-2 text-sm font-medium text-[#526159]"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden min-[360px]:inline">Retour au site</span>
            <span className="min-[360px]:hidden">Retour</span>
          </a>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-12 px-5 pb-16 pt-10 sm:pb-20 sm:pt-14 lg:grid-cols-[.84fr_1.16fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-20">
        <div data-reveal="left">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#d5dad5] bg-white/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[.12em] text-[#496054]">
            <span className="local-pulse size-1.5 rounded-full bg-[#4e9d68]" />
            Elyko pour Windows · version {ELYKO_VERSION}
          </div>
          <h1 className="mt-6 max-w-xl text-balance text-[2.6rem] font-semibold leading-[.99] tracking-[-.055em] min-[380px]:text-5xl sm:text-6xl lg:text-[4.35rem]">
            Toute votre entreprise,
            <br />
            <span className="text-[#b66b18]">dans une seule application.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-[#667169]">
            Catalogue, devis, commandes, BL, factures QR uniques ou récurrentes
            supervisées, fournisseurs, import CAMT, projets, heures, salaires et
            comptabilité&nbsp;: installez Elyko sur votre PC et travaillez avec
            vos propres données, dans une interface pensée pour votre activité.
          </p>

          <div className="mt-8">
            <DownloadButton />
          </div>
          <a
            href="/#logiciel"
            className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#315f47] underline decoration-[#c98a34] underline-offset-4"
          >
            Voir Elyko en action <ArrowRight className="size-4" />
          </a>

          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#5d6b63]">
            <span className="inline-flex items-center gap-1.5">
              <Laptop className="size-3.5" /> Windows 10/11
            </span>
            <span>64 bits</span>
            <span>{ELYKO_INSTALLER_SIZE_MIB} Mio</span>
            <span>50 CHF / mois</span>
          </div>
          <p className="mt-3 max-w-xl text-xs leading-5 text-[#7a857e]">
            Le téléchargement ne déclenche aucun paiement. Une licence active
            est requise pour utiliser l’application complète.
          </p>
        </div>

        <div
          className="installer-stage relative"
          data-reveal="right"
          aria-hidden="true"
        >
          <div className="absolute -inset-12 -z-10 rounded-full bg-[#d8bd83]/35 blur-3xl" />
          <div className="installer-window overflow-hidden rounded-[26px] border border-[#cfd6d0] bg-white shadow-[0_38px_100px_rgba(20,52,36,.2)]">
            <div className="flex h-11 items-center justify-between border-b border-[#dfe4df] bg-[#fbfcfb] px-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#354a3e]">
                <BrandMark className="size-5" /> Installation d’Elyko
              </div>
              <div className="flex h-full items-center text-[13px] text-[#647169]">
                <span className="grid h-full w-9 place-items-center">—</span>
                <span className="grid h-full w-9 place-items-center">□</span>
                <span className="grid h-full w-9 place-items-center">×</span>
              </div>
            </div>
            <div className="grid min-h-[440px] sm:grid-cols-[.82fr_1.18fr]">
              <div className="relative overflow-hidden bg-[#173d2c] p-6 text-white sm:p-8">
                <div className="absolute -right-16 -top-16 size-52 rounded-full border border-white/8" />
                <div className="absolute -right-6 -top-6 size-36 rounded-full border border-white/8" />
                <BrandMark className="size-12 shadow-lg" />
                <p className="mt-8 text-xs font-semibold uppercase tracking-[.11em] text-[#efb157]">
                  Votre espace de gestion
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-[-.04em]">
                  Elyko
                </h2>
                <p className="mt-4 text-sm leading-6 text-white/76">
                  Une installation guidée, puis un questionnaire adapté à votre
                  entreprise.
                </p>
                <div className="mt-8 space-y-3 text-[11px] text-white/78">
                  {[
                    'Application de bureau Windows',
                    'Base de données locale',
                    'Sauvegardes exportables',
                  ].map((item) => (
                    <div key={item} className="flex items-center gap-2">
                      <Check className="size-3.5 text-[#7dd197]" /> {item}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-col p-6 sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[.11em] text-[#76531f]">
                  Prêt à installer
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-[-.035em] text-[#22382a]">
                  Elyko sur cet ordinateur
                </h2>
                <p className="mt-3 text-xs leading-5 text-[#758078]">
                  L’assistant installe Elyko et crée les éléments nécessaires au
                  lancement depuis le menu Démarrer.
                </p>
                <div className="mt-7 space-y-4 text-[11px]">
                  {[
                    ['Version', ELYKO_VERSION],
                    ['Architecture', 'Windows x64'],
                    ['Emplacement', 'Applications de l’utilisateur'],
                    ['Données métier', 'Stockage local'],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex justify-between gap-4 border-b border-[#e8ece9] pb-3"
                    >
                      <span className="text-[#66736b]">{label}</span>
                      <strong className="text-right text-[#405247]">
                        {value}
                      </strong>
                    </div>
                  ))}
                </div>
                <div className="mt-auto pt-7">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#e8ece9]">
                    <span className="installer-progress block h-full w-[82%] rounded-full bg-gradient-to-r from-[#2d6749] to-[#77a781]" />
                  </div>
                  <div className="mt-4 flex justify-end">
                    <span className="inline-flex min-h-10 items-center rounded-lg bg-[#173d2c] px-5 text-[11px] font-semibold text-white">
                      Installer Elyko
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="installer-chip absolute -bottom-4 left-3 flex max-w-[calc(100%_-_1.5rem)] flex-wrap items-center gap-2 rounded-full border border-[#cad6cc] bg-white px-3 py-2 text-[11px] font-semibold leading-4 text-[#355141] shadow-lg sm:left-auto sm:right-6">
            <ShieldCheck className="size-3.5 text-[#3b7752]" /> Données
            conservées sur votre PC
          </div>
        </div>
      </section>

      <section
        className="border-y border-[#ded9ce] bg-[#fffdf9] px-5 py-12 sm:py-16 lg:px-8"
        data-reveal
        aria-labelledby="application-windows-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
              Ce que vous installez
            </p>
            <h2
              id="application-windows-title"
              className="mt-4 text-3xl font-semibold tracking-[-.04em] sm:text-4xl"
            >
              Une vraie application Windows, pas un site emballé.
            </h2>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              [
                Laptop,
                'Installateur .exe',
                'Un installateur Windows x64 ajoute Elyko aux applications et au menu Démarrer, avec sa propre fenêtre de bureau.',
              ],
              [
                Database,
                'Données métier locales',
                'La base SQLite et les justificatifs restent dans le dossier Elyko de ce PC; ils ne sont pas hébergés sur un compte Elyko.',
              ],
              [
                WifiOff,
                'Connexion limitée',
                'L’activation, les mises à jour et l’installation éventuelle de WebView2 peuvent utiliser Internet; la gestion quotidienne reste locale.',
              ],
            ].map(([Icon, title, text]) => (
              <article
                key={title as string}
                className="interactive-card rounded-2xl border border-[#ddd9cf] bg-white p-6"
              >
                <Icon className="size-5 text-[#3f7553]" />
                <h3 className="mt-5 font-semibold text-[#263a2e]">
                  {title as string}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[#647068]">
                  {text as string}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        className="border-y border-[#dce1dc] bg-[#edf2ee] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-6 lg:grid-cols-[.72fr_1.28fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Dans Elyko
              </p>
              <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
                Votre gestion quotidienne, réunie.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#68756d] lg:justify-self-end">
              L’application relie les documents, le travail réalisé et les
              chiffres. Une action alimente la suivante sans masquer l’origine
              des données.
            </p>
          </div>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3">
            {capabilities.map(({ icon: Icon, title, text }, index) => (
              <div
                key={title}
                className="interactive-card rounded-2xl border border-[#d7dfd8] bg-white p-6"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <span className="grid size-11 place-items-center rounded-2xl bg-[#e7f0e8] text-[#326249]">
                  <Icon className="size-5" />
                </span>
                <h3 className="mt-5 font-semibold text-[#263a2e]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#647068]">{text}</p>
              </div>
            ))}
          </div>
          <a
            href="/#logiciel"
            className="mt-7 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#315f47] underline decoration-[#c88b37] underline-offset-4"
          >
            Explorer les écrans interactifs <ArrowRight className="size-4" />
          </a>
        </div>
      </section>

      <section className="px-5 py-16 sm:py-24 lg:px-8" data-reveal>
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
              Démarrage guidé
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">
              De l’installation à votre premier document.
            </h2>
            <p className="mt-5 text-lg leading-8 text-[#68746c]">
              Le parcours suit un ordre clair. Vous installez Elyko, activez
              votre licence, puis configurez l’entreprise avec vos informations
              réelles.
            </p>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              [
                '01',
                'Téléchargez Elyko',
                'Récupérez la dernière version depuis le site officiel Elyko.',
                Laptop,
              ],
              [
                '02',
                'Ouvrez l’application',
                'Lancez l’installation, puis ouvrez Elyko depuis le menu Démarrer.',
                Sparkles,
              ],
              [
                '03',
                'Activez la licence',
                'Copiez l’identifiant affiché, récupérez la licence signée après le paiement et validez-la une fois en ligne.',
                LockKeyhole,
              ],
              [
                '04',
                'Configurez l’entreprise',
                'Choisissez votre activité et complétez le questionnaire avec vos propres données.',
                Check,
              ],
            ].map(([number, title, text, Icon], index) => (
              <div
                key={number as string}
                className="relative rounded-2xl border border-[#ddd9cf] bg-white/70 p-6"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[#9c6825]">
                    {number as string}
                  </span>
                  <Icon className="size-4 text-[#49765c]" />
                </div>
                <h3 className="mt-7 font-semibold">{title as string}</h3>
                <p className="mt-3 text-sm leading-6 text-[#667169]">
                  {text as string}
                </p>
                {index < 3 && (
                  <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-5 rounded-full bg-[#f5f3ee] text-[#9b7b50] lg:block" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="licence"
        className="bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1fr_.8fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efb157]">
              Licence Elyko
            </p>
            <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl">
              L’application complète pour 50 CHF par mois.
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-white/78">
              Le paiement est traité par Stripe. La licence signée est liée à
              l’identifiant d’installation affiché par Elyko, tandis que vos
              données métier restent sur votre PC. La première activation et les
              renouvellements vérifient uniquement le jeton par HTTPS.
            </p>
            <div className="mt-7 grid gap-3 text-sm text-white/72 sm:grid-cols-2">
              {[
                'Toutes les fonctions incluses',
                'Nouvelles versions incluses',
                'Paiement sécurisé par Stripe',
                'Résiliation depuis le portail client',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <Check className="size-4 text-[#77cf92]" /> {item}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-[24px] border border-white/12 bg-white/7 p-6 sm:p-8">
            <div className="flex items-end gap-2">
              <strong className="text-5xl tracking-[-.05em]">50 CHF</strong>
              <span className="pb-1 text-sm text-white/76">/ mois</span>
            </div>
            <p className="mt-3 text-xs leading-5 text-white/74">
              Installez d’abord Elyko afin de récupérer l’identifiant demandé
              pendant l’activation.
            </p>
            <div className="mt-7">
              <PurchaseButton compact />
            </div>
            <a
              href="mailto:leartshabija@gmail.com?subject=Elyko%20-%20activation"
              className="mt-3 flex min-h-12 items-center justify-center rounded-full border border-white/15 px-5 text-center text-sm font-semibold text-white"
            >
              Besoin d’aide pour l’activation
            </a>
          </div>
        </div>
      </section>

      <section
        className="border-b border-[#ddd9cf] bg-white/55 px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
      >
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.9fr_1.1fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
              Version {ELYKO_VERSION}
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] sm:text-4xl">
              Vos factures récurrentes restent sous votre contrôle.
            </h2>
            <div className="mt-7 space-y-3">
              {[
                'Planification mensuelle, trimestrielle ou annuelle depuis une commande de prestations confirmée',
                'Création locale de brouillons aux dates prévues, au démarrage et pendant l’utilisation',
                'Contrôle obligatoire avant émission, QR, envoi et comptabilisation',
                'Pause, reprise et arrêt définitif avec un état visible',
                'Client, lignes et délai de paiement conservés dans le modèle',
                'Une reprise du traitement ne duplique pas un brouillon déjà créé',
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-3 text-sm leading-6 text-[#59675f]"
                >
                  <Check className="mt-1 size-4 shrink-0 text-[#3e7854]" />
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [
                  HardDrive,
                  'Données sur le PC',
                  'Clients, modèles récurrents, documents, salaires, heures et projets sont enregistrés localement.',
                ],
                [
                  WifiOff,
                  'Gestion hors ligne',
                  'Après activation, les fonctions métier ne dépendent pas d’une connexion permanente.',
                ],
              ].map(([Icon, title, text]) => (
                <div
                  key={title as string}
                  className="rounded-2xl border border-[#ddd9cf] bg-white p-5"
                >
                  <Icon className="size-5 text-[#3f7553]" />
                  <h3 className="mt-4 font-semibold">{title as string}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#647068]">
                    {text as string}
                  </p>
                </div>
              ))}
            </div>
            <details className="group rounded-2xl border border-[#ddd9cf] bg-white">
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-semibold">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-5 text-[#48775a]" />
                  Informations techniques et sécurité
                </span>
                <span className="text-xl font-light transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="space-y-4 border-t border-[#e5e1d8] px-5 py-5 text-xs leading-6 text-[#5f6c64]">
                <p>
                  <strong>Fichier :</strong> {ELYKO_INSTALLER_NAME} ·{' '}
                  {ELYKO_INSTALLER_SIZE_MIB} Mio · Windows x64
                </p>
                <p>
                  <strong>SHA-256 :</strong>{' '}
                  <code className="break-all">{ELYKO_INSTALLER_SHA256}</code> ·{' '}
                  <a
                    className="font-semibold underline underline-offset-3"
                    href={ELYKO_INSTALLER_CHECKSUM_PATH}
                  >
                    télécharger l’empreinte
                  </a>
                </p>
                <div className="flex items-start gap-3 rounded-xl bg-[#edf4ee] p-4 text-[#315e48]">
                  <RefreshCcw className="mt-0.5 size-4 shrink-0" />
                  <p>
                    <strong>Mises à jour intégrées et signées.</strong> La
                    version
                    {ELYKO_VERSION} embarque la clé publique Elyko et vérifie la
                    signature de chaque futur installateur avant de proposer son
                    installation. Si une ancienne version ne propose pas la mise
                    à jour intégrée, installez {ELYKO_VERSION} manuellement
                    depuis cette page.
                  </p>
                </div>
                <div className="flex items-start gap-3 rounded-xl bg-[#fff5e6] p-4 text-[#75501f]">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <p>
                    <strong>Information Windows.</strong> Cette version n’est
                    pas encore signée avec un certificat Authenticode. Windows
                    peut afficher « Éditeur inconnu ». Utilisez uniquement le
                    fichier provenant du site officiel Elyko et contrôlez son
                    empreinte. L’installation de WebView2 peut demander une
                    connexion Internet si ce composant manque sur le PC.
                  </p>
                </div>
                <p>
                  <strong>Protection de licence :</strong> activation en ligne,
                  jeton signé et liaison locale protégée par Windows DPAPI.
                  Cette version n’utilise pas encore d’attestation matérielle
                  TPM/CNG et ne peut pas garantir une protection absolue contre
                  un administrateur du PC qui modifierait le logiciel.
                </p>
              </div>
            </details>
          </div>
        </div>
      </section>

      <section
        className="bg-[#173d2c] px-5 py-14 text-white sm:py-20 lg:px-8"
        data-reveal
        aria-labelledby="sauvegarde-title"
      >
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.8fr_1.2fr] lg:items-start">
          <div>
            <HardDrive className="size-7 text-[#efb157]" />
            <p className="mt-5 text-xs font-semibold uppercase tracking-[.13em] text-[#efb157]">
              Votre responsabilité locale
            </p>
            <h2
              id="sauvegarde-title"
              className="mt-4 text-3xl font-semibold tracking-[-.04em] sm:text-4xl"
            >
              Une donnée locale doit être sauvegardée.
            </h2>
            <p className="mt-5 text-sm leading-6 text-white/72">
              Si le PC est perdu ou son disque devient illisible sans sauvegarde
              externe, Elyko ne peut pas récupérer vos données depuis un
              serveur, puisqu’elles n’y ont jamais été envoyées.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              [
                'Après la configuration',
                'Créez une première sauvegarde dès que vos coordonnées et réglages sont validés.',
              ],
              [
                'Avant chaque mise à jour',
                'Exportez une sauvegarde complète avant d’installer une nouvelle version.',
              ],
              [
                'Hors de ce PC',
                'Copiez régulièrement le fichier sur un support externe ou un emplacement chiffré que vous contrôlez.',
              ],
              [
                'Test de restauration',
                'Vérifiez périodiquement la restauration sur un environnement sûr, sans écraser votre base active.',
              ],
            ].map(([title, text]) => (
              <article
                key={title}
                className="rounded-2xl border border-white/12 bg-white/[.07] p-5"
              >
                <Check className="size-4 text-[#79d094]" />
                <h3 className="mt-4 text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-white/66">{text}</p>
              </article>
            ))}
            <div className="sm:col-span-2 rounded-2xl border border-[#efb157]/30 bg-[#efb157]/10 p-5 text-xs leading-6 text-white/72">
              <strong className="text-white">Portée réglementaire :</strong> la
              paie est assistée localement mais non certifiée Swissdec/ELM.
              Elyko génère un XML eCH-0217 v2.0.0 pour import manuel, sans
              transmission ni acceptation AFC garantie. Le dossier fiduciaire
              soutient un processus orienté CO/Olico, mais n’est pas certifié
              Olico et ne remplace pas la validation du bouclement.
            </div>
          </div>
        </div>
      </section>

      <footer className="px-5 py-8 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 text-xs text-[#607068] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BrandMark className="size-7" />
            <strong className="text-[#2a3d31]">Elyko</strong>
            <span>pour les entreprises suisses</span>
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

      <div className="fixed inset-x-3 bottom-3 z-50 rounded-2xl border border-[#d1d8d2] bg-white/95 p-2 shadow-[0_18px_50px_rgba(20,50,34,.24)] backdrop-blur-xl md:hidden">
        <DownloadButton compact />
      </div>
    </main>
  );
}
