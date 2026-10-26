/**
 * Autopilote — rattacher une facture fournisseur reçue à son chantier.
 *
 * Repère, sans rien calculer ni écrire, la facture brouillon sans chantier
 * dont le texte (référence, remarque, lignes) cite un seul chantier : son nom
 * (référence du chantier), son adresse (adresse de livraison) ou le numéro
 * d'une commande fournisseur passée pour lui. La carte propose le chantier ;
 * le clic appelle une commande native réversible.
 */
import type { AppLanguage } from './language';
import type { Project, SupplierInvoice, SupplierOrder } from './types';

export type SiteEvidence = 'order' | 'address' | 'name';
export type SiteAttachProposal = { invoice: SupplierInvoice; project: Project; evidence: SiteEvidence; matched: string };

/** Texte comparable : minuscules, sans accents, ponctuation réduite à un espace. */
export function comparable(value: string): string {
  return ` ${value.replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/ß/g, 'ss').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

const GENERIC = new Set(['chantier', 'travaux', 'renovation', 'projet', 'maison', 'immeuble', 'villa', 'appartement', 'batiment', 'atelier', 'bureau']);

/** Le nom d'un chantier est assez distinctif s'il garde au moins 5 lettres hors mots génériques. */
function distinctiveName(name: string): string | null {
  const words = comparable(name).trim().split(' ').filter(Boolean);
  const kept = words.filter(word => !GENERIC.has(word));
  return kept.join('').length >= 5 ? ` ${words.join(' ')} ` : null;
}

/** Première partie de l'adresse (rue et numéro), si elle contient un numéro. */
function streetOf(address: string): string | null {
  const street = comparable(address.split(/[,\n]/)[0] ?? '').trim();
  return /\d/.test(street) && street.replace(/[^a-z]/g, '').length >= 4 ? ` ${street} ` : null;
}

const STRENGTH: Record<SiteEvidence, number> = { order: 3, address: 2, name: 1 };

export function siteAttachProposals(invoices: readonly SupplierInvoice[], projects: readonly Project[], orders: readonly SupplierOrder[]): SiteAttachProposal[] {
  const active = projects.filter(project => !project.archivedAt && project.status !== 'closed');
  const proposals: SiteAttachProposal[] = [];
  for (const invoice of invoices) {
    if (invoice.documentStatus !== 'draft' || invoice.projectId || invoice.lines.some(line => line.projectId)) continue;
    const text = comparable([invoice.reference, invoice.note, ...invoice.lines.map(line => line.description)].join(' '));
    const found = new Map<string, { evidence: SiteEvidence; matched: string }>();
    const keep = (projectId: string, evidence: SiteEvidence, matched: string) => {
      const current = found.get(projectId);
      if (!current || STRENGTH[evidence] > STRENGTH[current.evidence]) found.set(projectId, { evidence, matched });
    };
    for (const order of orders) {
      if (!order.projectId || !order.number || order.status === 'cancelled') continue;
      if (text.includes(comparable(order.number))) keep(order.projectId, 'order', order.number);
    }
    for (const project of active) {
      const street = streetOf(project.address);
      if (street && text.includes(street)) keep(project.id, 'address', project.address.split(/[,\n]/)[0].trim());
      const name = distinctiveName(project.name);
      if (name && text.includes(name)) keep(project.id, 'name', project.name);
    }
    if (!found.size) continue;
    const best = Math.max(...[...found.values()].map(match => STRENGTH[match.evidence]));
    const strongest = [...found].filter(([, match]) => STRENGTH[match.evidence] === best);
    // Deux chantiers aussi plausibles : Autopilote ne choisit pas.
    if (strongest.length !== 1) continue;
    const [projectId, match] = strongest[0];
    const project = active.find(candidate => candidate.id === projectId) ?? projects.find(candidate => candidate.id === projectId);
    if (project) proposals.push({ invoice, project, ...match });
  }
  return proposals;
}

const COPY = {
  fr: {
    title: 'Rattacher au chantier {project}', detail: '{supplier} · facture {reference} · {amount}',
    order: 'La facture cite la commande {matched}, passée pour ce chantier.', address: 'La facture mentionne l’adresse du chantier ({matched}).', name: 'La facture cite le chantier « {matched} ».',
    attach: 'Rattacher', open: 'Voir la facture', done: 'Facture rattachée au chantier. Ses coûts comptent dans la fiche chantier.',
  },
  de: {
    title: 'Der Baustelle {project} zuordnen', detail: '{supplier} · Rechnung {reference} · {amount}',
    order: 'Die Rechnung nennt die Bestellung {matched}, die für diese Baustelle erfolgte.', address: 'Die Rechnung nennt die Adresse der Baustelle ({matched}).', name: 'Die Rechnung nennt die Baustelle «{matched}».',
    attach: 'Zuordnen', open: 'Rechnung ansehen', done: 'Rechnung der Baustelle zugeordnet. Ihre Kosten zählen im Baustellenblatt.',
  },
  it: {
    title: 'Collega al cantiere {project}', detail: '{supplier} · fattura {reference} · {amount}',
    order: 'La fattura cita l’ordine {matched}, passato per questo cantiere.', address: 'La fattura indica l’indirizzo del cantiere ({matched}).', name: 'La fattura cita il cantiere «{matched}».',
    attach: 'Collega', open: 'Vedi la fattura', done: 'Fattura collegata al cantiere. I suoi costi contano nella scheda cantiere.',
  },
  en: {
    title: 'Link to the {project} job', detail: '{supplier} · invoice {reference} · {amount}',
    order: 'The invoice quotes order {matched}, placed for this job.', address: 'The invoice mentions the job address ({matched}).', name: 'The invoice names the job “{matched}”.',
    attach: 'Link', open: 'View the invoice', done: 'Invoice linked to the job. Its costs now count in the job sheet.',
  },
} as const;

export function autopilotSiteCopy(language: AppLanguage) {
  return COPY[language] ?? COPY.fr;
}
