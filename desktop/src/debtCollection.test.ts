// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDebtCollectionRequest, debtCollectionCandidates, debtCollectionIssues, debtCollectionXml } from './debtCollection';
import type { Client, Invoice, Reminder, Workspace } from './types';

const invoice = { id: 'i1', number: 'F-2026-0012', issueDate: '2026-08-01', dueDate: '2026-08-31', currency: 'CHF', status: 'overdue', clientId: 'c1', totalCents: 178_000 } as unknown as Invoice;
const client = { id: 'c1', name: 'Jean Dupont', company: 'Dupont & Fils SA', addressLine1: 'Rue du Lac', buildingNumber: '12', postalCode: '1006', city: 'Lausanne', country: 'ch' } as unknown as Client;
const workspace = {
  invoices: [invoice],
  clients: [client],
  settings: { organization: { legalName: 'Menuiserie Dupont Sàrl', uidNumber: 'CHE-123.456.789', address: { street: 'Route de Berne', buildingNumber: '12', postalCode: '1700', city: 'Fribourg', country: 'CH' } } },
} as unknown as Workspace;
const reminder = (level: number, status: Reminder['status'], sent: string): Reminder => ({
  id: 'r' + level, invoiceId: 'i1', level, status, scheduledDate: sent, lastDeliveryAt: sent + 'T09:00:00Z', paymentDeadlineDays: 10,
  balanceCents: 178_000, liveBalanceCents: 178_000,
} as unknown as Reminder);

describe('réquisition de poursuite', () => {
  it('ne propose la poursuite qu’après la dernière relance et son délai', () => {
    const reminders = [reminder(1, 'completed', '2026-09-07'), reminder(2, 'completed', '2026-09-21'), reminder(3, 'completed', '2026-10-05')];
    expect(debtCollectionCandidates(workspace, reminders, 3, '2026-10-15', new Set())).toHaveLength(0);
    expect(debtCollectionCandidates(workspace, reminders, 3, '2026-10-16', new Set()).map((row) => row.deadline)).toEqual(['2026-10-15']);
    expect(debtCollectionCandidates(workspace, reminders.slice(0, 2), 3, '2026-10-30', new Set())).toHaveLength(0);
    expect(debtCollectionCandidates(workspace, reminders, 3, '2026-10-30', new Set(['i1']))).toHaveLength(0);
  });

  it('reprend créance, intérêts depuis l’échéance et frais convenus', () => {
    const settings = { interestEnabled: true, interestRateBp: 500, fees: { 2: 2_000, 3: 3_000 } };
    const request = buildDebtCollectionRequest(workspace, invoice, client, 178_000, '2026-10-05', settings, 3, '2026-10-20');
    expect(request).toMatchObject({
      claimCents: 178_000, interestRateBp: 500, interestFrom: '2026-09-01', feesCents: 5_000,
      title: 'Facture F-2026-0012 du 01.08.2026, échue le 31.08.2026',
      debtor: { name: 'Dupont & Fils SA', street: 'Rue du Lac 12', postalCode: '1006', city: 'Lausanne', country: 'CH' },
    });
    expect(debtCollectionIssues(request)).toEqual([]);
    const text = debtCollectionXml(request, '2026-10-20T10:00:00');
    const document = new DOMParser().parseFromString(text, 'application/xml');
    expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(document.querySelector('Debiteur Nom')?.textContent).toBe('Dupont & Fils SA');
    expect(document.querySelector('Creance Montant')?.textContent).toBe('1780.00');
    expect(document.querySelector('Interet')?.getAttribute('taux')).toBe('5.00');
    expect(document.querySelector('FraisDeRappel')?.textContent).toBe('50.00');
  });

  it('signale une adresse de débiteur incomplète', () => {
    const request = buildDebtCollectionRequest(workspace, invoice, { ...client, city: '' } as Client, 178_000, '2026-10-05', { interestEnabled: false, interestRateBp: 500, fees: {} }, 3, '2026-10-20');
    expect(request.interestFrom).toBeNull();
    expect(debtCollectionIssues(request)).toEqual(['L’adresse complète du débiteur est obligatoire pour l’office des poursuites.']);
  });
});
