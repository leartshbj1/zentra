import { describe, expect, it } from 'vitest';
import { appointmentsToShow, clientFromSender, contactProposals } from './autopilotContacts';
import type { MailSignal } from './autopilotSignals';
import type { AppointmentInboxItem } from './AppointmentInbox';
import type { Client, Supplier } from './types';

const sender = { email: 'marie@rive.ch', name: 'Marie Rochat', company: 'Atelier Rive', phone: '+41 21 000 00 00', street: 'Rue du Lac 4', postcode: '1003', city: 'Lausanne', source: 'signature' as const };
const signal = (values: Partial<MailSignal>): MailSignal => ({ kind: 'follow_up', sourceId: 's1', receivedAt: 1, subject: '', evidence: 'Notre nouvelle adresse : Rue du Lac 4.',
  quoteReference: null, invoiceReference: null, amountCents: null, currency: null, documentType: null, sender, requiresHumanValidation: true, ...values });
const client = (values: Partial<Client>) => ({ id: 'c1', name: 'Atelier Rive', company: 'Atelier Rive', email: 'marie@rive.ch', phone: '', ...values }) as Client;

describe('contacts from mails', () => {
  it('updates changed fields only when the mail announces a change', () => {
    const known = client({ addressLine1: 'Rue Haute 1', postalCode: '1003', city: 'Lausanne', phone: '' });
    expect(contactProposals([signal({ kind: 'contact_update' })], [known], [])).toMatchObject([{ kind: 'update', changes: [
      { field: 'addressLine1', before: 'Rue Haute 1', after: 'Rue du Lac 4' }, { field: 'phone', before: '', after: '+41 21 000 00 00' }] }]);
    expect(contactProposals([signal({})], [known], [])).toMatchObject([{ kind: 'complete', changes: [{ field: 'phone' }] }]);
    expect(contactProposals([signal({})], [client({ addressLine1: 'Rue du Lac 4', postalCode: '1003', city: 'Lausanne', phone: '1' })], [])).toEqual([]);
  });
  it('proposes a client for an unknown sender once, never for a supplier mail', () => {
    expect(contactProposals([signal({}), signal({ sourceId: 's2' })], [], [])).toMatchObject([{ kind: 'create' }]);
    expect(contactProposals([signal({ kind: 'supplier_document' })], [], [])).toEqual([]);
    const supplier = { id: 'sup', name: 'Acme', email: 'marie@rive.ch', phone: '', address: '' } as Supplier;
    expect(contactProposals([signal({ kind: 'contact_update' })], [], [supplier])).toMatchObject([{ target: { entity: 'suppliers' }, changes: [{ field: 'address', after: 'Rue du Lac 4, 1003 Lausanne' }, { field: 'phone' }] }]);
    expect(clientFromSender('n1', signal({}))).toMatchObject({ id: 'n1', name: 'Atelier Rive', contactPerson: 'Marie Rochat', addressLine1: 'Rue du Lac 4', postalCode: '1003' });
  });
  it('lists waiting appointments and those of tomorrow', () => {
    const item = (id: string, state: string, startDate: string, importedAt: number | null = null) => ({ id, state, otherDevice: false, importedAt,
      extraction: { startDate } }) as unknown as AppointmentInboxItem;
    const found = appointmentsToShow([item('a', 'ready', '2026-10-22'), item('b', 'imported', '2026-10-21', 1), item('c', 'ignored', '2026-10-21')], '2026-10-20');
    expect(found.waiting.map(row => row.id)).toEqual(['a']);
    expect(found.tomorrow.map(row => row.id)).toEqual(['b']);
  });
});
