import type { AppSettings, CatalogItem, Workspace } from './types';
import { MAX_STOCK_QUANTITY_MILLI, stockQuantityFromInput } from './catalog';
import { WorkspaceCreationOutcomeUnknownError } from './workspaceCreation';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { errorMessage } from './utils';

export type CatalogDraft = { kind: CatalogItem['kind']; name: string; sku: string; description: string; unit: string; salesPrice: string; purchaseCost: string; vatBp: string; trackStock: boolean; reorderLevel: string };
export type CatalogIssue = { field: keyof CatalogDraft | 'record'; message: string };
export const CATALOG_MAX_CENTS = 9_000_000_000_000_000;

export function catalogMoneyInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return 'Valeur à vérifier';
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export function formatCatalogMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return '—';
  const input = catalogMoneyInput(cents);
  if (!input) return '—';
  const [whole, decimals] = input.split('.');
  return `${new Intl.NumberFormat('fr-CH').format(BigInt(whole))},${decimals} CHF`;
}

export function mergeCatalogDraft(baseline: CatalogDraft, local: CatalogDraft, current: CatalogDraft): CatalogDraft {
  return Object.fromEntries((Object.keys(local) as (keyof CatalogDraft)[]).map(field => [field, local[field] === baseline[field] ? current[field] : local[field]])) as CatalogDraft;
}

export function parseCatalogMoney(input: string): number | null {
  const value = input.trim().replace(',', '.');
  if (value.length > 64 || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(CATALOG_MAX_CENTS) ? Number(cents) : null;
}

export function catalogVatRates(settings: AppSettings, item?: CatalogItem): number[] {
  const rates = settings.organization.vatRegistered ? settings.billing.vatRatesBp : [0];
  return [...new Set([...rates, ...(item ? [item.vatBp] : [])])].filter(rate => Number.isInteger(rate) && rate >= 0 && rate <= 10_000);
}

export function catalogDraft(item: CatalogItem | undefined, settings: AppSettings): CatalogDraft {
  return {
    kind: item?.kind ?? 'service', name: item?.name ?? '', sku: item?.sku ?? '', description: item?.description ?? '',
    unit: item?.unit ?? 'heure', salesPrice: item ? catalogMoneyInput(item.salesPriceCents) : '',
    purchaseCost: item ? catalogMoneyInput(item.purchaseCostCents) : '',
    vatBp: String(item?.vatBp ?? (settings.organization.vatRegistered ? settings.billing.vatRatesBp[0] ?? 0 : 0)),
    trackStock: item?.trackStock ?? true,
    reorderLevel: item ? `${BigInt(item.reorderLevelMilli) / 1000n}.${String(BigInt(item.reorderLevelMilli) % 1000n).padStart(3, '0')}` : '0',
  };
}

export function catalogPricePreview(price: string, vat: string) {
  const cents = parseCatalogMoney(price), rate = Number(vat);
  if (cents === null || !/^\d+$/.test(vat) || !Number.isInteger(rate) || rate < 0 || rate > 10_000) return null;
  const tax = (BigInt(cents) * BigInt(rate) + 5000n) / 10000n;
  const total = BigInt(cents) + tax;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? { netCents: cents, vatCents: Number(tax), totalCents: Number(total) } : null;
}

export function catalogFormIssue(draft: CatalogDraft, rates: number[], item?: CatalogItem, hasHistory = false): CatalogIssue | null {
  for (const [field, label, max] of [['name', 'nom', 200], ['unit', 'unité', 40], ['sku', 'référence', 80], ['description', 'description', 10_000]] as const) {
    const text = draft[field].trim();
    if ((field === 'name' || field === 'unit') && !text) return { field, message: `Indiquez ${field === 'name' ? 'le nom à retrouver dans vos documents' : 'l’unité utilisée pour le prix, par exemple heure ou pièce'}.` };
    if ([...text].length > max) return { field, message: `Raccourcissez ${label === 'nom' ? 'le nom' : `la ${label}`} à ${max.toLocaleString('fr-CH')} caractères maximum.` };
  }
  if (!['product', 'service'].includes(draft.kind)) return { field: 'kind', message: 'Choisissez Produit ou Service.' };
  if (hasHistory && item && (draft.kind !== item.kind || (draft.kind === 'product' && draft.trackStock) !== item.trackStock)) return { field: 'kind', message: 'Ce produit a déjà des mouvements. Conservez son type et son suivi de stock ; créez une autre référence pour un service.' };
  if (parseCatalogMoney(draft.salesPrice) === null) return { field: 'salesPrice', message: 'Indiquez le prix pour une unité, à partir de zéro, avec deux décimales maximum. Exemple : 85,50.' };
  if (draft.purchaseCost.trim() && parseCatalogMoney(draft.purchaseCost) === null) return { field: 'purchaseCost', message: 'Indiquez un coût positif ou nul avec deux décimales maximum, ou laissez ce champ vide.' };
  if (!/^\d+$/.test(draft.vatBp) || !rates.includes(Number(draft.vatBp))) return { field: 'vatBp', message: 'Choisissez un taux disponible dans les réglages de votre entreprise.' };
  if (!catalogPricePreview(draft.salesPrice, draft.vatBp)) return { field: 'salesPrice', message: 'Le prix avec TVA dépasse la capacité de calcul. Vérifiez le montant saisi.' };
  if (draft.kind === 'product' && draft.trackStock) {
    const threshold = stockQuantityFromInput(draft.reorderLevel);
    if (threshold === null || threshold < 0 || threshold > MAX_STOCK_QUANTITY_MILLI) return { field: 'reorderLevel', message: 'Indiquez un seuil positif ou nul, avec trois décimales maximum. Zéro garde uniquement l’alerte de rupture.' };
    if (item && !item.trackStock && item.stockQuantityMilli !== 0) return { field: 'trackStock', message: 'Cette ancienne référence a un solde sans historique. Créez une nouvelle référence suivie, puis renseignez son stock par une entrée.' };
  }
  return null;
}

export function catalogFormData(draft: CatalogDraft, editing: boolean) {
  const tracked = draft.kind === 'product' && draft.trackStock;
  return {
    kind: draft.kind, name: draft.name.trim(), sku: draft.sku.trim() || null,
    description: draft.description.trim(), unit: draft.unit.trim(),
    salesPriceCents: parseCatalogMoney(draft.salesPrice)!, purchaseCostCents: parseCatalogMoney(draft.purchaseCost) ?? 0,
    vatBp: Number(draft.vatBp), trackStock: tracked, reorderLevelMilli: tracked ? stockQuantityFromInput(draft.reorderLevel)! : 0,
    ...(editing ? {} : { stockQuantityMilli: 0 }),
  };
}
export type CatalogData = ReturnType<typeof catalogFormData>;

export function requireCatalogWorkspace(workspace: Workspace) {
  if (!workspace.onboardingCompleted || !workspace.settings || !Array.isArray(workspace.catalogItems) || !Array.isArray(workspace.stockMovements)) throw new Error('La fiche et son historique doivent être accessibles. Réessayez l’actualisation.');
}

export function catalogWasSaved(workspace: Workspace, id: string, data: CatalogData) {
  requireCatalogWorkspace(workspace);
  const row = workspace.catalogItems.find(item => item.id === id);
  // Stock can move after saving the identity; it is never an editable field here.
  return !!row && Object.entries(data).filter(([key]) => key !== 'stockQuantityMilli').every(([key, value]) => key === 'sku' ? (row.sku || null) === value : row[key as keyof CatalogItem] === value);
}

export class CatalogSaveUnknownError extends WorkspaceCreationOutcomeUnknownError {
  constructor(id: string, readonly data: CatalogData, cause: unknown, readonly creating: boolean) { super('catalogItems', id, cause); }
  override wasRecorded(workspace: Workspace) { requireCatalogWorkspace(workspace); return this.creating ? super.wasRecorded(workspace) : catalogWasSaved(workspace, this.recordId, this.data); }
}
export class CatalogSaveRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly id: string, readonly data: CatalogData, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) {
    requireCatalogWorkspace(workspace);
    if (!workspace.catalogItems.some(row => row.id === this.id)) throw new Error('La référence enregistrée n’apparaît pas dans le catalogue relu. Actualisez à nouveau sans recréer la fiche.');
  }
}
export async function runCatalogSave(id: string, data: CatalogData, write: () => Promise<unknown>, load: () => Promise<Workspace>, creating: boolean) {
  try { await write(); } catch (cause) { throw new CatalogSaveUnknownError(id, data, cause, creating); }
  try { const result = await load(); new CatalogSaveRefreshError(id, data, null).validateRead(result); return result; }
  catch (cause) { throw new CatalogSaveRefreshError(id, data, cause); }
}

export function catalogNativeIssue(reason: unknown): CatalogIssue | null {
  const text = errorMessage(reason, '');
  if (/catalogue a changé|catalog_items\//i.test(text)) return { field: 'record', message: 'La fiche a changé ou n’est plus accessible. Actualisez les informations avant de reprendre.' };
  if (/track_stock|stock tracking|stock.*zero balance/i.test(text)) return { field: 'trackStock', message: 'Le suivi de stock doit conserver son historique. Gardez le réglage actuel ou créez une autre référence.' };
  for (const [pattern, field, message] of [
    [/sales_price_cents/, 'salesPrice', 'Vérifiez le prix de vente : montant positif ou nul, en CHF.'],
    [/purchase_cost_cents/, 'purchaseCost', 'Vérifiez le coût : montant positif ou nul, en CHF.'],
    [/reorder_level_milli/, 'reorderLevel', 'Vérifiez le seuil : zéro ou une quantité positive.'],
    [/vat_bp/, 'vatBp', 'Vérifiez le taux de TVA sélectionné.'],
    [/\bsku\b/i, 'sku', 'Vérifiez la référence : 80 caractères maximum.'],
    [/\bname\b/, 'name', 'Indiquez le nom de la référence, en 200 caractères maximum.'],
    [/\bunit\b/, 'unit', 'Indiquez l’unité, en 40 caractères maximum.'],
    [/description/, 'description', 'Raccourcissez la description à 10 000 caractères maximum.'],
  ] as const) if (pattern.test(text)) return { field, message };
  return null;
}
