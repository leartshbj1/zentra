import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { CatalogItem, Workspace } from '../src/types';

// Synthetic persistence for the real UI. Native import transactions are tested separately.
export function installDirectoryRecoveryFixture(data: Workspace) {
  data.settings!.billing.vatRatesBp = [810, 0];
  const template: CatalogItem = { id: 'catalog-active', sku: 'REF-1', name: 'Article existant', description: '', unit: 'pièce', kind: 'product', salesPriceCents: 1234, purchaseCostCents: 500, vatBp: 810, trackStock: true, stockQuantityMilli: 5000, reorderLevelMilli: 1000, archivedAt: null };
  data.catalogItems = [template, { ...template, id: 'catalog-archive', sku: 'ARCHIVE', name: 'Article archivé', salesPriceCents: 999, trackStock: false, stockQuantityMilli: 0, archivedAt: '2026-09-01' }];
  const record = (kind: string, input: unknown) => {
    const key = `qa-directory-${kind}`;
    sessionStorage.setItem(key, JSON.stringify([...JSON.parse(sessionStorage.getItem(key) || '[]'), input]));
  };
  const refuse = () => {
    if (sessionStorage.getItem('qa-directory-refuse')) { sessionStorage.removeItem('qa-directory-refuse'); throw new Error('Enregistrement momentanément indisponible. Vos informations sont conservées.'); }
  };
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-directory-block-reads')) throw new Error('La lecture du catalogue est momentanément indisponible.');
    return structuredClone(data);
  };
  desktopApi.importCatalogItems = async (rows, policy) => {
    refuse(); record('imports', { rows, policy });
    for (const row of rows) {
      const existing = data.catalogItems.find(item => item.sku.toLowerCase() === row.sku.toLowerCase());
      if (existing && policy === 'skip') continue;
      if (existing) Object.assign(existing, row);
      else data.catalogItems.push({ ...template, ...row, id: crypto.randomUUID(), trackStock: false, stockQuantityMilli: 0, archivedAt: null });
    }
    sessionStorage.setItem('qa-directory-catalog', JSON.stringify(data.catalogItems));
    sessionStorage.setItem('qa-directory-block-reads', '1');
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.createEntity = async (entity, input) => {
    refuse(); record('writes', { entity, input });
    const id = crypto.randomUUID();
    if (entity === 'clients') data.clients.push({ id, name: String(input.contactPerson), company: String(input.company), email: String(input.email), phone: String(input.phone), address: String(input.addressLine1), addressLine1: String(input.addressLine1), buildingNumber: String(input.addressLine2), postalCode: String(input.postalCode), city: String(input.city), country: String(input.country), notes: String(input.notes), uidNumber: '', archivedAt: null });
    else if (entity === 'suppliers') data.suppliers.push({ id, name: String(input.name), contactName: String(input.contactName), email: String(input.email), phone: String(input.phone), address: String(input.address), uidNumber: String(input.uidNumber), iban: String(input.iban), currency: 'CHF', paymentTermsDays: Number(input.paymentTermsDays), notes: String(input.notes), archivedAt: null, createdAt: '2026-09-12', updatedAt: '2026-09-12' });
    else throw new Error('Entité non prise en charge par cette recette.');
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.archiveEntity = async (entity, id) => {
    record('archives', { entity, id });
    const items = entity === 'clients' ? data.clients : entity === 'suppliers' ? data.suppliers : data.catalogItems;
    const item = items.find(row => row.id === id)!;
    item.archivedAt = '2026-09-12';
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.updateEntity = async (entity, id, input) => {
    record('updates', { entity, id, input });
    const items = entity === 'clients' ? data.clients : entity === 'suppliers' ? data.suppliers : data.catalogItems;
    Object.assign(items.find(row => row.id === id)!, input);
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
}
