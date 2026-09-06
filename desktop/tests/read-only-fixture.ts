import { desktopApi } from '../src/bridge';
import type { CatalogItem, Workspace } from '../src/types';

// Synthetic directory and time entries, used only by mobile-harness.html.
export function installReadOnlyFixture(workspace: Workspace) {
  const item: CatalogItem = { id: 'readonly-stock', kind: 'product', sku: 'TEST-001', name: 'Produit de recette', description: 'Référence utilisée pour le contrôle des droits', unit: 'pièce', salesPriceCents: 15000, purchaseCostCents: 7000, vatBp: 810, trackStock: true, stockQuantityMilli: 8000, reorderLevelMilli: 1000, archivedAt: null, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-01T08:00:00Z' };
  workspace.catalogItems = [item, { ...item, id: 'readonly-archive', name: 'Produit archivé de recette', archivedAt: '2026-09-02' }];
  workspace.clients.push({ ...workspace.clients[0], id: 'readonly-archived-client', company: 'Client archivé de recette', archivedAt: '2026-09-02' });
  workspace.quotes[0].status = 'issued';
  workspace.quotes[2].status = 'accepted';
  workspace.timeEntries = [{ id: 'readonly-time', projectId: workspace.projects[0].id, employeeId: workspace.employees[0].id, date: '2026-09-01', minutes: 120, hourlyCostCents: 5000, note: 'Heures de recette', status: 'approved', billable: true, billingRateCents: 10000, billingStatus: 'unbilled', taskId: null, invoiceId: null } as Workspace['timeEntries'][number]];
  desktopApi.updateEntity = async (entity, id, values) => {
    const calls = JSON.parse(sessionStorage.getItem('readonly-mutation-calls') || '[]');
    calls.push({ entity, id, values });
    sessionStorage.setItem('readonly-mutation-calls', JSON.stringify(calls));
    if (entity === 'clients') workspace.clients = workspace.clients.map(client => client.id === id ? { ...client, ...values } : client);
    return structuredClone(workspace);
  };
}
