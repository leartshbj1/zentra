import {
  BadgeCheck,
  BookOpenCheck,
  FileCheck2,
  GraduationCap,
  Landmark,
  RefreshCcw,
  ScanLine,
  ShieldCheck,
  Stamp,
} from 'lucide-react';

const workflow = [
  {
    number: '01',
    icon: Stamp,
    title: 'Vous posez votre identité',
    text: 'Le questionnaire enregistre l’activité NOGA, les coordonnées, l’IBAN et un logo vérifié puis copié dans le stockage local.',
    detail: 'Aucune entreprise fictive n’est créée.',
  },
  {
    number: '02',
    icon: FileCheck2,
    title: 'Le devis déclenche la suite',
    text: 'Après acceptation, un devis avec produits prépare la commande, réserve le stock et guide la livraison. Une prestation simple peut rester en facture directe.',
    detail: 'Une chaîne liée, sans double saisie ni double sortie.',
  },
  {
    number: '03',
    icon: Landmark,
    title: 'Le paiement laisse une trace',
    text: 'Quand la comptabilité est configurée, l’encaissement enregistré met à jour le solde et génère l’écriture liée à la créance.',
    detail: 'Journal et document restent reliés.',
  },
  {
    number: '04',
    icon: ScanLine,
    title: 'La paie se prépare localement',
    text: 'Les PDF multipages et images sont lus sur le PC. Zentra croise texte, pages rendues et contrôles arithmétiques avant toute confirmation.',
    detail: 'Les propositions restent à contrôler.',
  },
  {
    number: '05',
    icon: BookOpenCheck,
    title: 'Vous relisez avant de clôturer',
    text: 'Journal, grand livre, balance, bilan et résultat sont construits à partir d’écritures explicables, jamais de chiffres de démonstration.',
    detail: 'Les taux variables restent sous votre contrôle.',
  },
] as const;

const safeguards = [
  {
    icon: ShieldCheck,
    eyebrow: 'Référentiel suisse contrôlable',
    title: 'Une règle avec sa période et sa source.',
    text: 'Les valeurs nationales connues sont datées. Les taux qui dépendent du canton, de la caisse, de l’assureur ou du plan LPP ne sont pas inventés : vous les saisissez et votre fiduciaire peut les valider.',
    badge: 'Validation humaine requise',
    tone: 'green',
  },
  {
    icon: GraduationCap,
    eyebrow: 'Guide dans l’application',
    title: 'Chaque écran est expliqué au bon moment.',
    text: 'Une visite guidée montre où créer un client, transformer un devis, enregistrer un paiement, importer une fiche et retrouver les réglages. Elle peut être relancée sans ajouter de fausses données.',
    badge: 'Relançable depuis Aide',
    tone: 'gold',
  },
  {
    icon: RefreshCcw,
    eyebrow: 'Mises à jour sécurisées',
    title: 'Le canal reste fermé tant qu’il n’est pas signé.',
    text: 'Le module refuse tout téléchargement si la clé publique de l’éditeur et le manifeste HTTPS ne sont pas configurés. Une fois le canal activé, chaque paquet doit passer la vérification de signature avant installation.',
    badge: 'Activation éditeur nécessaire',
    tone: 'slate',
  },
] as const;

export function CapabilityStory() {
  return (
    <>
      <section
        className="border-y border-[#d9ded9] bg-[#173d2c] px-5 py-16 text-white sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="journee-zentra-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-7 lg:grid-cols-[.76fr_1.24fr] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#efb157]">
                Une journée dans Zentra
              </p>
              <h2
                id="journee-zentra-title"
                className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
              >
                Une action métier. Une suite logique et vérifiable.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-white/72 lg:justify-self-end">
              Zentra relie les documents, les encaissements, la paie et la
              comptabilité. L’automatisation commence seulement après votre
              configuration et s’arrête dès qu’une information doit être validée.
            </p>
          </div>

          <ol className="story-rail mt-12 grid gap-3 sm:mt-16 lg:grid-cols-5">
            {workflow.map(({ number, icon: Icon, title, text, detail }) => (
              <li
                key={number}
                className="story-step interactive-card relative min-w-0 rounded-2xl border border-white/14 bg-white/[.075] p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold tracking-[.12em] text-[#efb157]">
                    {number}
                  </span>
                  <span className="grid size-10 place-items-center rounded-xl bg-white/10 text-[#86d39d]">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                </div>
                <h3 className="mt-8 text-lg font-semibold leading-6">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-white/70">{text}</p>
                <p className="mt-5 border-t border-white/12 pt-4 text-xs font-semibold leading-5 text-[#f0bd6e]">
                  {detail}
                </p>
              </li>
            ))}
          </ol>

          <p className="mt-6 flex items-start gap-3 rounded-2xl border border-white/12 bg-black/10 p-5 text-sm leading-6 text-white/68">
            <BadgeCheck className="mt-0.5 size-5 shrink-0 text-[#83d19a]" aria-hidden="true" />
            Ce parcours décrit les fonctions du logiciel. Les noms, montants et
            documents montrés dans les aperçus du site sont explicitement fictifs
            et ne sont jamais installés chez le client.
          </p>
        </div>
      </section>

      <section
        className="border-b border-[#ded9ce] bg-[#fffaf2] px-5 py-16 sm:py-24 lg:px-8"
        data-reveal
        aria-labelledby="garde-fous-title"
      >
        <div className="mx-auto max-w-7xl">
          <div className="max-w-4xl">
            <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#95621f]">
              Automatiser sans masquer
            </p>
            <h2
              id="garde-fous-title"
              className="mt-4 text-4xl font-semibold leading-tight tracking-[-.045em] sm:text-5xl"
            >
              Les garde-fous font partie du produit.
            </h2>
            <p className="mt-5 text-lg leading-8 text-[#626f67]">
              Zentra distingue ce qui peut être calculé, ce qui doit être configuré
              et ce qui nécessite encore une vérification professionnelle.
            </p>
          </div>

          <div className="mt-10 grid gap-4 lg:mt-14 lg:grid-cols-3">
            {safeguards.map(({ icon: Icon, eyebrow, title, text, badge, tone }) => (
              <article
                key={title}
                className="guardrail-card interactive-card flex min-w-0 flex-col rounded-[24px] border border-[#ddd7cb] bg-white p-6 sm:p-7"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-2xl bg-[#e7efe9] text-[#315d47]">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className={`status-pill status-pill--${tone}`}>{badge}</span>
                </div>
                <p className="mt-8 text-xs font-semibold uppercase tracking-[.11em] text-[#95621f]">
                  {eyebrow}
                </p>
                <h3 className="mt-3 text-xl font-semibold leading-7 tracking-[-.025em] text-[#253a2e]">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-[#5b6860]">{text}</p>
              </article>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-[#e2d4bf] bg-[#f5ead8] p-5 text-sm leading-6 text-[#684d27] sm:p-6">
            <strong>À propos du canal de mise à jour :</strong> tant que la clé
            de signature publique et l’adresse HTTPS de publication ne sont pas
            présentes dans une version distribuée, Zentra reste volontairement en
            mode manuel et invite à télécharger la nouvelle version depuis le site.
          </div>
        </div>
      </section>
    </>
  );
}
