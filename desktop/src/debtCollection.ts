// Réquisition de poursuite préparée pour une facture restée impayée après
// la dernière relance. Les rubriques suivent la réquisition officielle
// (créancier, débiteur, créance, intérêts, titre de la créance) et les
// données d'un message eSchKG. Zentra ne dépose rien : vous la transmettez
// à l'office des poursuites (EasyGov, eSchKG ou papier).

import type { Client, Invoice, Reminder, Workspace } from './types';
import { reminderCharges, type ReminderChargeSettings } from './reminderCharges';

export type DebtCollectionRequest = Readonly<{
  invoiceId: string;
  creditor: { name: string; street: string; postalCode: string; city: string; country: string; uid: string };
  debtor: { name: string; street: string; postalCode: string; city: string; country: string };
  claimCents: number;
  currency: string;
  interestRateBp: number;
  interestFrom: string | null;
  feesCents: number;
  title: string;
  lastReminderDate: string;
}>;

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amount = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const swissDate = (iso: string) => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';

/** Dernière relance envoyée (niveau le plus haut terminé) pour chaque facture. */
export function lastSentReminders(reminders: readonly Reminder[]): Map<string, Reminder> {
  const result = new Map<string, Reminder>();
  for (const reminder of reminders) {
    if (reminder.status !== 'completed') continue;
    const current = result.get(reminder.invoiceId);
    if (!current || reminder.level > current.level) result.set(reminder.invoiceId, reminder);
  }
  return result;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Factures pour lesquelles une réquisition peut être préparée : dernière
 * relance du cycle envoyée, délai donné dépassé, solde ouvert, aucune
 * réquisition déjà préparée.
 */
export function debtCollectionCandidates(workspace: Workspace, reminders: readonly Reminder[], maxLevel: number, today: string, prepared: ReadonlySet<string>) {
  const sent = lastSentReminders(reminders);
  return workspace.invoices.flatMap((invoice) => {
    const reminder = sent.get(invoice.id);
    if (!reminder || reminder.level < maxLevel || prepared.has(invoice.id)) return [];
    const balance = reminder.liveBalanceCents ?? reminder.balanceCents;
    if (balance <= 0 || invoice.status === 'paid' || invoice.status === 'cancelled') return [];
    const sentOn = (reminder.lastDeliveryAt || reminder.scheduledDate).slice(0, 10);
    const deadline = addDays(sentOn, reminder.paymentDeadlineDays || 10);
    return deadline < today ? [{ invoice, reminder, balanceCents: balance, sentOn, deadline }] : [];
  });
}

export function buildDebtCollectionRequest(workspace: Workspace, invoice: Invoice, client: Client | undefined, balanceCents: number, sentOn: string, settings: ReminderChargeSettings, level: number, today: string): DebtCollectionRequest {
  const organization = workspace.settings!.organization;
  const address = organization.address;
  const charges = reminderCharges(settings, level, balanceCents, invoice.dueDate ?? today, today);
  const street = (value: string | undefined, number: string | undefined) => [value, number].filter(Boolean).join(' ');
  return {
    invoiceId: invoice.id,
    creditor: { name: organization.legalName, street: street(address.street, address.buildingNumber), postalCode: address.postalCode, city: address.city, country: address.country || 'CH', uid: organization.uidNumber || '' },
    debtor: {
      name: client?.company || client?.name || '',
      street: street(client?.addressLine1, client?.buildingNumber ?? undefined),
      postalCode: client?.postalCode ?? '',
      city: client?.city ?? '',
      country: (client?.country || 'CH').toUpperCase(),
    },
    claimCents: balanceCents,
    currency: invoice.currency || 'CHF',
    interestRateBp: settings.interestEnabled ? settings.interestRateBp : 0,
    interestFrom: settings.interestEnabled ? charges.interestFrom ?? addDays(invoice.dueDate ?? today, 1) : null,
    // Seuls les frais de rappel convenus figurent ; les frais de poursuite sont avancés à l'office.
    feesCents: Object.entries(settings.fees).filter(([key]) => Number(key) <= level).reduce((sum, [, cents]) => sum + cents, 0),
    title: `Facture ${invoice.number ?? ''} du ${swissDate(invoice.issueDate ?? '')}, échue le ${swissDate(invoice.dueDate ?? '')}`.replace(/\s+/g, ' ').trim(),
    lastReminderDate: sentOn,
  };
}

/** Problèmes qui empêchent un dépôt valable, à corriger avant d'enregistrer. */
export function debtCollectionIssues(request: DebtCollectionRequest): string[] {
  const issues: string[] = [];
  if (!request.debtor.name) issues.push('Le nom du débiteur manque sur la fiche client.');
  if (!request.debtor.street || !request.debtor.postalCode || !request.debtor.city) issues.push('L’adresse complète du débiteur est obligatoire pour l’office des poursuites.');
  if (!request.creditor.street || !request.creditor.postalCode || !request.creditor.city) issues.push('L’adresse de l’entreprise est incomplète dans les réglages.');
  if (request.claimCents <= 0) issues.push('La facture n’a plus de solde ouvert.');
  return issues;
}

export function debtCollectionXml(request: DebtCollectionRequest, createdAt: string): string {
  const party = (tag: string, value: { name: string; street: string; postalCode: string; city: string; country: string; uid?: string }) =>
    `  <${tag}>\n    <Nom>${xml(value.name)}</Nom>\n    <Rue>${xml(value.street)}</Rue>\n    <NPA>${xml(value.postalCode)}</NPA>\n    <Localite>${xml(value.city)}</Localite>\n    <Pays>${xml(value.country)}</Pays>\n${value.uid ? `    <IDE>${xml(value.uid)}</IDE>\n` : ''}  </${tag}>\n`;
  const interest = request.interestRateBp > 0 && request.interestFrom
    ? `    <Interet taux="${(request.interestRateBp / 100).toFixed(2)}" depuis="${request.interestFrom}"/>\n`
    : '';
  const fees = request.feesCents > 0 ? `  <FraisDeRappel devise="${xml(request.currency)}">${amount(request.feesCents)}</FraisDeRappel>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!-- Réquisition de poursuite préparée par Zentra. Rubriques de la réquisition officielle ; à déposer par EasyGov, un service eSchKG ou le formulaire papier. -->\n`
    + `<RequisitionDePoursuite xmlns="urn:zentra:requisition-poursuite:1" creeLe="${xml(createdAt)}">\n`
    + party('Creancier', request.creditor)
    + party('Debiteur', request.debtor)
    + `  <Creance>\n    <Montant devise="${xml(request.currency)}">${amount(request.claimCents)}</Montant>\n${interest}    <Titre>${xml(request.title)}</Titre>\n    <DerniereRelance>${request.lastReminderDate}</DerniereRelance>\n  </Creance>\n`
    + fees
    + `</RequisitionDePoursuite>\n`;
}
