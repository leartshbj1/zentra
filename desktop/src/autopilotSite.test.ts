import { describe, expect, it } from 'vitest';
import { autopilotSiteCopy, comparable, siteAttachProposals } from './autopilotSite';
import type { Project, SupplierInvoice, SupplierOrder } from './types';

const project = (id: string, name: string, address = '', status = 'in_progress') => ({ id, clientId: 'c', name, address, status, plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', budgetCents: 0, plannedMinutes: 0, notes: '' }) as Project;
const invoice = (id: string, text: { reference?: string; note?: string; line?: string }, extra: Partial<SupplierInvoice> = {}) => ({
  id, supplierId: 's', projectId: null, documentStatus: 'draft', supplierName: 'Couleurs SA', reference: text.reference ?? 'F-1', note: text.note ?? '', netCents: 10_000,
  lines: [{ id: id + '-l', description: text.line ?? 'Peinture', projectId: null }], ...extra,
}) as unknown as SupplierInvoice;
const projects = [project('dupont', 'Villa Dupont', 'Chemin des Vignes 14, 1253 Vandœuvres'), project('martin', 'Rénovation Martin', 'Rue du Lac 3, 1800 Vevey'), project('old', 'Atelier Favre', 'Rue Haute 1', 'closed')];
const orders = [{ id: 'o1', projectId: 'martin', number: 'CF-2026-0042', status: 'confirmed' }, { id: 'o2', projectId: 'dupont', number: 'CF-2026-0007', status: 'cancelled' }] as SupplierOrder[];

describe('Autopilote — rattacher une facture fournisseur au chantier', () => {
  it('normalise accents et ponctuation', () => {
    expect(comparable('Vandœuvres, Ch. des Vignes 14')).toBe(' vandoeuvres ch des vignes 14 ');
    expect(comparable('CF-2026/0042')).toBe(' cf 2026 0042 ');
  });

  it('reconnaît le numéro de commande, l’adresse de livraison ou le nom du chantier', () => {
    const proposals = siteAttachProposals([
      invoice('by-order', { reference: 'R-881', note: 'Votre commande CF 2026 0042' }),
      invoice('by-address', { line: 'Livraison : chemin des Vignes 14, Vandoeuvres — enduit' }),
      invoice('by-name', { note: 'Chantier villa dupont, 2e étage' }),
      invoice('nothing', { note: 'Fournitures diverses' }),
    ], projects, orders);
    expect(proposals.map(proposal => [proposal.invoice.id, proposal.project.id, proposal.evidence])).toEqual([
      ['by-order', 'martin', 'order'], ['by-address', 'dupont', 'address'], ['by-name', 'dupont', 'name'],
    ]);
    expect(proposals[1].matched).toBe('Chemin des Vignes 14');
  });

  it('ne propose rien si deux chantiers sont aussi plausibles, si la facture est validée ou déjà rattachée', () => {
    expect(siteAttachProposals([invoice('both', { note: 'Villa Dupont et Rénovation Martin' })], projects, orders)).toEqual([]);
    expect(siteAttachProposals([invoice('validated', { note: 'Villa Dupont' }, { documentStatus: 'validated' })], projects, orders)).toEqual([]);
    expect(siteAttachProposals([invoice('linked', { note: 'Villa Dupont' }, { projectId: 'dupont' })], projects, orders)).toEqual([]);
    // Commande annulée ou chantier clôturé : pas de preuve.
    expect(siteAttachProposals([invoice('cancelled-order', { note: 'Commande CF-2026-0007' }), invoice('closed', { note: 'Rue Haute 1' })], projects, orders)).toEqual([]);
    // La commande l'emporte sur un nom moins sûr.
    expect(siteAttachProposals([invoice('order-wins', { note: 'Villa Dupont, commande CF-2026-0042' })], projects, orders)[0].project.id).toBe('martin');
  });

  it('a son texte dans les quatre langues', () => {
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      const copy = autopilotSiteCopy(language);
      expect(Object.values(copy).every(value => value.trim().length > 0)).toBe(true);
      expect(copy.title).toContain('{project}');
    }
  });
});
