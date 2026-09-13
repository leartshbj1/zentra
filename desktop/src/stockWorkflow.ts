import type { CatalogItem, StockMovementType, Workspace } from './types';
import { MAX_STOCK_QUANTITY_MILLI, stockMovementError, stockQuantityFromInput } from './catalog';
import { errorMessage } from './utils';
import { isValidIsoCalendarDate } from './payrollImportQuality';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

export type StockIssue = { field: 'quantity' | 'reason' | 'reference' | 'date' | 'item'; message: string };
export type StockDraft = { quantity: string; reason: string; reference: string; date: string };
export type StockIntent = { requestId: string; catalogItemId: string; movementType: StockMovementType; quantityDeltaMilli: number; reason: string; reference?: string; date?: string; countedQuantityMilli?: number };

export function requireStockWorkspace(value: Workspace) {
  if (!value.onboardingCompleted || !value.settings || !Array.isArray(value.catalogItems) || !Array.isArray(value.stockMovements) || !Array.isArray(value.stockReservationEvents) || !Array.isArray(value.stockAvailability)) throw new Error('Le catalogue et ses quantités n’ont pas pu être chargés. Réessayez l’actualisation.');
}

export class WorkspaceStockOutcomeUnknownError extends Error {
  constructor(readonly intent: StockIntent, readonly mutationCause: unknown) {
    super('La réponse du mouvement de stock n’a pas été reçue. Vérifions son historique avant de réessayer.');
    this.name = 'WorkspaceStockOutcomeUnknownError';
  }
  wasRecorded(workspace: Workspace): boolean {
    return stockWasRecorded(workspace, this.intent);
  }
}

export function stockWasRecorded(workspace: Workspace, intent: StockIntent): boolean {
  requireStockWorkspace(workspace);
  const row = workspace.stockMovements.find(row => row.requestId === intent.requestId);
  return !!row && row.sourceType === 'manual' && row.catalogItemId === intent.catalogItemId
    && row.movementType === intent.movementType && row.quantityDeltaMilli === intent.quantityDeltaMilli
    && row.reason === intent.reason.trim() && (row.reference || '') === (intent.reference?.trim() || '')
    && (!intent.date || row.movementDate === intent.date)
    && (intent.countedQuantityMilli == null || row.balanceAfterMilli === intent.countedQuantityMilli);
}

export class WorkspaceStockRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent: StockIntent, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) {
    if (!stockWasRecorded(workspace, this.intent)) throw new Error('Le mouvement enregistré n’apparaît pas encore dans l’historique relu. Actualisez à nouveau, sans recréer le mouvement.');
  }
}

export async function runStockMutation(intent: StockIntent, write: () => Promise<unknown>, load: () => Promise<Workspace>): Promise<Workspace> {
  try { await write(); } catch (cause) { throw new WorkspaceStockOutcomeUnknownError(intent, cause); }
  const receipt = new WorkspaceStockRefreshError(intent, null);
  try { const next = await load(); receipt.validateRead(next); return next; }
  catch (cause) { throw new WorkspaceStockRefreshError(intent, cause); }
}

export function stockFormIssue(item: CatalogItem | undefined, type: StockMovementType, counted: boolean, expected: number, reserved: number, draft: StockDraft): StockIssue | null {
  if (!item || item.archivedAt) return { field: 'item', message: 'Cette référence est absente ou archivée. Revenez au catalogue pour vérifier sa fiche.' };
  const quantity = stockQuantityFromInput(draft.quantity);
  if (counted && (quantity === null || quantity < 0 || quantity > MAX_STOCK_QUANTITY_MILLI)) return {field:'quantity',message:'Indiquez la quantité réellement comptée, à partir de zéro, avec au maximum trois décimales.'};
  if (counted && quantity === expected) return {field:'quantity',message:'Le stock correspond déjà à la quantité comptée. Aucune correction n’est nécessaire.'};
  const delta = counted && quantity !== null ? quantity - expected : quantity;
  const quantityError = stockMovementError(item, type, delta, reserved);
  if (quantityError) return {field:'quantity',message:quantityError};
  if (!draft.date || !isValidIsoCalendarDate(draft.date)) return {field:'date',message:'Choisissez la date réelle du mouvement.'};
  if (!draft.reason.trim()) return {field:'reason',message:'Indiquez pourquoi le stock change, par exemple « Inventaire du dépôt ».'};
  if ([...draft.reason.trim()].length > 500) return {field:'reason',message:'Raccourcissez le motif à 500 caractères maximum.'};
  if ([...draft.reference.trim()].length > 200) return {field:'reference',message:'Raccourcissez la référence à 200 caractères maximum.'};
  return null;
}

export function stockNativeIssue(reason: unknown): StockIssue | null {
  const text = errorMessage(reason, '');
  if (/request_id/i.test(text) && /déjà/i.test(text)) return {field:'item',message:'Un mouvement existe déjà pour cette saisie. Revenez au catalogue et consultez son historique avant de préparer une nouvelle correction.'};
  if (/reason|motif/i.test(text)) return {field:'reason',message:'Complétez le motif du mouvement, en 500 caractères maximum.'};
  if (/reference|référence.*(long|200)/i.test(text)) return {field:'reference',message:'Vérifiez la référence : elle doit rester courte, avec 200 caractères maximum.'};
  if (/date/i.test(text) && !/updated/i.test(text)) return {field:'date',message:'Vérifiez la date du mouvement : jour, mois et année doivent être valides.'};
  if (/quantity_milli|quantité négative|stock insuffisant|réserv|capacité/i.test(text)) return {field:'quantity',message:'La quantité ne peut pas être enregistrée avec le stock disponible. Relisez les quantités et les réservations ci-dessus.'};
  if (/track_stock|catalog_items|archiv|produit suivi/i.test(text)) return {field:'item',message:'La fiche doit être un produit actif avec suivi de stock. Vérifiez-la dans le catalogue.'};
  return null;
}
