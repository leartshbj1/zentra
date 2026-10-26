import { describe, expect, it } from 'vitest';
import { budgetFromQuotes, siteFromRaw, siteLedger } from './siteLedger';
import type { Project, Workspace } from './types';

const project = { id: 'p', clientId: 'c', name: 'Villa Dupont', address: '', status: 'in_progress', plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', budgetCents: 0, plannedMinutes: 0, notes: '' } as Project;

function workspace(): Workspace {
  const site = siteFromRaw(
    [
      { id: 'b1', project_id: 'p', position: 0, category: 'labor', label: 'Peintres', amount_cents: 600_000, minutes: 6_000 },
      { id: 'b2', project_id: 'p', position: 1, category: 'material', label: 'Peinture', amount_cents: 180_000 },
      { id: 'b3', project_id: 'p', position: 2, category: 'subcontract', label: 'Échafaudage', amount_cents: 240_000 },
      { id: 'bx', project_id: 'other', position: 0, category: 'labor', label: 'Autre chantier', amount_cents: 999_999 },
    ],
    [{ id: 's1', project_id: 'p', supplier_id: 'sup-e', label: 'Échafaudage façade', agreed_cents: 240_000, status: 'open' }],
    [{ supplier_invoice_id: 'si-e', subcontract_id: 's1' }],
  );
  const line = (id: string, netCents: number, category: string, projectId: string | null = null, costCents?: number) => ({ id, supplierInvoiceId: '', position: 0, description: id, quantityMilli: 1_000, unit: 'forfait', unitPriceCents: netCents, discountBp: 0, vatBp: 810, netCents, vatCents: 0, totalCents: netCents, category, expenseAccountId: null, projectId, ...(costCents === undefined ? {} : { costCents }) });
  return {
    ...site,
    quotes: [
      { id: 'q1', projectId: 'p', status: 'accepted', lines: [{ id: 'l1', description: 'Peinture', quantity: 100, unit: 'h', unitPriceCents: 9_000, vatRateBp: 810 }, { id: 'l2', catalogItemId: 'paint', description: 'Peinture blanche', quantity: 40, unit: 'l', unitPriceCents: 3_000, vatRateBp: 810 }] },
      { id: 'q2', projectId: 'p', status: 'refused', lines: [{ id: 'l3', description: 'Option', quantity: 1, unit: 'forfait', unitPriceCents: 500_000, vatRateBp: 810 }] },
    ],
    invoices: [
      { id: 'i1', projectId: 'p', status: 'issued', lines: [{ id: 'x', description: 'Situation 1', quantity: 1, unit: 'situation', unitPriceCents: 500_000, vatRateBp: 810 }] },
      { id: 'i2', projectId: 'p', status: 'draft', lines: [{ id: 'y', description: 'Brouillon', quantity: 1, unit: 'forfait', unitPriceCents: 999_999, vatRateBp: 810 }] },
    ],
    timeEntries: [{ id: 't1', projectId: 'p', minutes: 1_200, hourlyCostCents: 6_000 }, { id: 't2', projectId: 'other', minutes: 600, hourlyCostCents: 6_000 }],
    laborRateTables: [{ id: 'rt', name: '2026', source: '', validFrom: null, isDefault: true, archivedAt: null, rates: [
      { id: 'ce', kind: 'personnel', code: 'CE', label: 'Chef d’équipe', unit: 'h', rateCents: 9_800, costCents: 7_000 },
      { id: 'nac', kind: 'machine', code: 'N', label: 'Nacelle', unit: 'h', rateCents: 4_000, costCents: 1_500 },
      { id: 'ap', kind: 'personnel', code: 'AP', label: 'Apprenti', unit: 'h', rateCents: 3_500, costCents: null },
    ] }],
    workReports: [{ id: 'w1', projectId: 'p', status: 'signed', lines: [
      { id: 'a', kind: 'labor', description: 'Chef d’équipe', quantity: 5, unit: 'h', unitPriceCents: 9_800, vatBp: 810, laborRateId: 'ce', catalogItemId: null },
      { id: 'b', kind: 'labor', description: 'Nacelle', quantity: 2, unit: 'h', unitPriceCents: 4_000, vatBp: 810, laborRateId: 'nac', catalogItemId: null },
      { id: 'c', kind: 'labor', description: 'Apprenti', quantity: 4, unit: 'h', unitPriceCents: 3_500, vatBp: 810, catalogItemId: null },
      { id: 'd', kind: 'material', description: 'Peinture blanche', quantity: 10, unit: 'l', unitPriceCents: 3_000, vatBp: 810, catalogItemId: 'paint' },
    ] }, { id: 'w2', projectId: 'p', status: 'draft', lines: [{ id: 'e', kind: 'labor', description: 'Brouillon', quantity: 100, unit: 'h', unitPriceCents: 1, vatBp: 0, catalogItemId: null }] }],
    catalogItems: [{ id: 'paint', kind: 'product', name: 'Peinture blanche', unit: 'l', salesPriceCents: 3_000, purchaseCostCents: 1_200 }],
    supplierInvoices: [
      { id: 'si-m', supplierId: 'sup-m', projectId: 'p', documentStatus: 'validated', supplierName: 'Couleurs SA', reference: 'M1', netCents: 80_000, lines: [line('peinture', 80_000, 'Matériel', null, 81_000)] },
      { id: 'si-e', supplierId: 'sup-e', projectId: 'p', documentStatus: 'validated', supplierName: 'Échafaudages SA', reference: 'E1', netCents: 120_000, lines: [line('echaf', 120_000, 'Location')] },
      { id: 'si-d', supplierId: 'sup-m', projectId: 'p', documentStatus: 'draft', supplierName: 'Couleurs SA', reference: 'M2', netCents: 5_000, lines: [line('draft', 5_000, 'Matériel')] },
    ],
    expenses: [{ id: 'x1', projectId: 'p', category: 'Sous-traitance', netCents: 30_000 }, { id: 'x2', projectId: 'p', category: 'Carburant', netCents: 4_000 }],
    employees: [{ id: 'e1', hourlyCostCents: 5_000 }, { id: 'e2', hourlyCostCents: 7_000 }, { id: 'e3', hourlyCostCents: 0 }],
  } as unknown as Workspace;
}

describe('fiche chantier', () => {
  it('compare le prévu au réel par nature de coût', () => {
    const ledger = siteLedger(project, workspace());
    expect(ledger.contractNetCents).toBe(900_000 + 120_000);
    expect(ledger.invoicedNetCents).toBe(500_000);
    expect(ledger.planned.labor).toEqual({ cents: 600_000, minutes: 6_000 });
    // Heures pointées 20 h × 60.– + chef d'équipe 5 h × 70.– ; apprenti sans coût connu.
    expect(ledger.actual.labor).toEqual({ cents: 120_000 + 35_000, minutes: 1_200 + 300 + 240 });
    expect(ledger.uncostedRegieMinutes).toBe(240);
    expect(ledger.actual.machine).toEqual({ cents: 3_000, minutes: 120 });
    // Matériel : facture (coût avec TVA non récupérable 810.–) + carburant + peinture de la régie au prix d'achat.
    expect(ledger.actual.material.cents).toBe(81_000 + 4_000 + 12_000);
    // Sous-traitance : facture reliée + dépense « Sous-traitance ».
    expect(ledger.actual.subcontract.cents).toBe(120_000 + 30_000);
    expect(ledger.draftSupplierInvoices).toBe(1);
    expect(ledger.plannedCents).toBe(1_020_000);
    expect(ledger.actualCents).toBe(155_000 + 3_000 + 97_000 + 150_000);
    expect(ledger.actualMarginCents).toBe(500_000 - ledger.actualCents);
    expect(ledger.plannedMarginCents).toBe(0);
    expect(ledger.invoicedPermille).toBe(490);
    expect(ledger.subcontracts[0]).toMatchObject({ billedCents: 120_000, remainingCents: 120_000, invoices: 1 });
    expect(ledger.finished).toBe(false);
    expect(siteLedger({ ...project, status: 'completed' }, workspace()).finished).toBe(true);
  });

  it('propose un budget depuis les devis acceptés', () => {
    expect(budgetFromQuotes(project, workspace())).toEqual([
      { category: 'labor', label: 'Main-d’œuvre selon devis', amountCents: 600_000, minutes: 6_000 },
      { category: 'material', label: 'Matériel selon devis', amountCents: 48_000, minutes: null },
    ]);
  });
});
