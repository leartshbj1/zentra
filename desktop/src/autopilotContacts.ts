import type { MailSignal } from './autopilotSignals';
import type { AppointmentInboxItem } from './AppointmentInbox';
import type { Client, Supplier } from './types';

/**
 * Client and supplier records from mails: a change of address or phone
 * announced by mail updates the record; an unknown sender can become a client;
 * a known client missing an address or phone can be completed. A value already
 * on the record is replaced only by a mail that announces the change.
 */
export type ContactField = 'addressLine1' | 'postalCode' | 'city' | 'phone' | 'address';
export type ContactChange = Readonly<{ field: ContactField; before: string; after: string }>;
export type ContactProposal = Readonly<{
  key: string; kind: 'update' | 'complete' | 'create';
  target: Readonly<{ entity: 'clients' | 'suppliers'; id: string; name: string }> | null;
  changes: readonly ContactChange[];
  signal: MailSignal;
}>;
const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
const value = (text: string | null | undefined) => (text ?? '').trim();

export function contactProposals(signals: readonly MailSignal[], clients: readonly Client[], suppliers: readonly Supplier[]): ContactProposal[] {
  const activeClients = clients.filter(row => !row.archivedAt), activeSuppliers = suppliers.filter(row => !row.archivedAt);
  const proposals: ContactProposal[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const sender = signal.sender;
    const email = lower(sender?.email);
    if (!sender || !email) continue;
    const client = activeClients.find(row => lower(row.email) === email)
      ?? (signal.kind === 'contact_update' && sender.company ? activeClients.find(row => lower(row.company) === lower(sender.company)) : undefined);
    const supplier = client ? undefined : activeSuppliers.find(row => lower(row.email) === email);
    const announced = signal.kind === 'contact_update';
    if (client) {
      // A change replaces values; otherwise only empty fields are filled.
      const changes = ([['addressLine1', client.addressLine1, sender.street], ['postalCode', client.postalCode, sender.postcode],
        ['city', client.city, sender.city], ['phone', client.phone, sender.phone]] as const).flatMap(([field, before, after]) =>
        value(after) && value(after) !== value(before) && (announced || !value(before)) ? [{ field, before: value(before), after: value(after) }] : []);
      if (changes.length && !seen.has('client:' + client.id)) {
        seen.add('client:' + client.id);
        proposals.push({ key: `contact:${signal.sourceId}`, kind: announced ? 'update' : 'complete',
          target: { entity: 'clients', id: client.id, name: client.company || client.name }, changes, signal });
      }
      continue;
    }
    if (supplier) {
      const address = [value(sender.street), [value(sender.postcode), value(sender.city)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const changes = ([['address', supplier.address, address], ['phone', supplier.phone, sender.phone]] as const).flatMap(([field, before, after]) =>
        value(after) && value(after) !== value(before) && (announced || !value(before)) ? [{ field, before: value(before), after: value(after) }] : []);
      if (changes.length && !seen.has('supplier:' + supplier.id)) {
        seen.add('supplier:' + supplier.id);
        proposals.push({ key: `contact:${signal.sourceId}`, kind: announced ? 'update' : 'complete',
          target: { entity: 'suppliers', id: supplier.id, name: supplier.name }, changes, signal });
      }
      continue;
    }
    // Supplier mails do not make clients.
    if (signal.kind === 'supplier_document' || signal.kind === 'supplier_order') continue;
    if (seen.has('email:' + email)) continue;
    seen.add('email:' + email);
    proposals.push({ key: `contact:${signal.sourceId}`, kind: 'create', target: null, changes: [], signal });
  }
  return proposals;
}

/** The client record a "Créer le client" makes from the sender, without inventing anything. */
export function clientFromSender(id: string, signal: MailSignal) {
  const sender = signal.sender!;
  const company = value(sender.company), person = value(sender.name), email = value(sender.email);
  return { id, name: company || person || email, contactPerson: person, company, email, phone: value(sender.phone),
    addressLine1: value(sender.street), addressLine2: '', postalCode: value(sender.postcode), city: value(sender.city), canton: '', country: 'CH', notes: '' };
}

/** Appointments read from mails that are waiting, and the reminder the day before for those added. */
export function appointmentsToShow(items: readonly AppointmentInboxItem[], today: string) {
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  return {
    waiting: items.filter(item => !item.otherDevice && !['imported', 'ignored', 'processing'].includes(item.state)),
    tomorrow: items.filter(item => item.importedAt && item.extraction.startDate === tomorrow),
  };
}
