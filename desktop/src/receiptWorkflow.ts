import type { SupplierOrder, SupplierReceipt, Workspace } from './types';
import { formatCatalogQuantity, MAX_STOCK_QUANTITY_MILLI, stockQuantityFromInput } from './catalog';
import { supplierOrderLineProgress, supplierReceiptDateValidationError } from './purchaseOrderFlow';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import { errorMessage, todayIso } from './utils';

export type ReceiptDraft = { date: string; reference: string; notes: string; quantities: Record<string, string> };
export type ReceiptIssue = { field: 'date' | 'reference' | 'notes' | 'quantity' | 'record'; lineId?: string; message: string };
export const receiptQuantityInput = (milli: number) => Number.isSafeInteger(milli) && milli >= 0 ? `${BigInt(milli) / 1000n}.${String(BigInt(milli) % 1000n).padStart(3, '0')}` : 'À vérifier';

export function receiptDraft(order: SupplierOrder | undefined, receipt?: SupplierReceipt): ReceiptDraft {
  return { date: receipt?.receiptDate || todayIso(), reference: receipt?.reference || '', notes: receipt?.notes || '', quantities: Object.fromEntries([...(order?.lines || []).filter(line => line.fulfillmentMode !== 'direct').map(line => [line.id, '0']), ...(receipt?.lines || []).map(line => [line.supplierOrderLineId, receiptQuantityInput(line.quantityMilli)])]) };
}

export function requireReceiptWorkspace(workspace: Workspace) {
  if (!workspace.onboardingCompleted || !workspace.settings || !['supplierOrders', 'supplierReceipts', 'supplierInvoiceMatches', 'catalogItems', 'stockMovements'].every(key => Array.isArray(workspace[key as keyof Workspace]))) throw Error('La commande, les réceptions et le stock doivent être accessibles. Réessayez l’actualisation.');
}

export function receiptFormIssue(draft: ReceiptDraft, order: SupplierOrder | undefined, workspace: Workspace): ReceiptIssue | null {
  if (!order || order.status !== 'confirmed') return { field: 'record', message: 'La commande doit être confirmée et ouverte pour recevoir des marchandises. Revenez aux commandes pour vérifier son état.' };
  const date = supplierReceiptDateValidationError(order.orderDate, draft.date, todayIso());
  if (date) return { field: 'date', message: date };
  if ([...draft.reference.trim()].length > 200) return { field: 'reference', message: 'Raccourcissez la référence du bon à 200 caractères maximum.' };
  if ([...draft.notes.trim()].length > 20_000) return { field: 'notes', message: 'Raccourcissez les notes à 20 000 caractères maximum.' };
  const lines = order.lines.filter(line => line.fulfillmentMode !== 'direct');
  if (Object.entries(draft.quantities).some(([id, text]) => !lines.some(line => line.id === id) && stockQuantityFromInput(text) !== 0)) return { field: 'record', message: 'Une ligne saisie n’est plus dans les marchandises de cette commande. Actualisez pour retrouver la commande complète ; aucune ligne ne sera supprimée automatiquement.' };
  if (!lines.length) return { field: 'record', message: 'Cette commande contient uniquement des prestations directes. Elles ne passent pas par une réception.' };
  let totalLines = 0;
  for (const line of lines) {
    const quantity = stockQuantityFromInput(draft.quantities[line.id] ?? '');
    if (quantity === null || quantity < 0 || quantity > MAX_STOCK_QUANTITY_MILLI) return { field: 'quantity', lineId: line.id, message: 'Indiquez la quantité réellement arrivée, avec trois décimales maximum. Mettez zéro si rien n’est arrivé pour cette ligne.' };
    const remaining = supplierOrderLineProgress(order, line, workspace).remainingToReceiveMilli;
    if (!Number.isSafeInteger(remaining) || remaining < 0) return { field:'record', message:'Les quantités de la commande ne sont pas encore lisibles. Actualisez les réceptions avant de continuer.' };
    if (quantity > remaining) return { field: 'quantity', lineId: line.id, message: `Il reste ${formatCatalogQuantity(remaining)} ${line.unit} à recevoir pour cette ligne. Vérifiez la quantité arrivée ou actualisez les réceptions.` };
    if (quantity > 0) totalLines++;
  }
  return totalLines ? null : { field: 'quantity', lineId: lines[0].id, message: 'Indiquez au moins une quantité réellement arrivée. Vous pouvez aussi remplir toutes les quantités restantes avec le bouton « Tout est arrivé ».' };
}

export function receiptDraftLines(draft: ReceiptDraft, order: SupplierOrder) {
  return order.lines.filter(line => line.fulfillmentMode !== 'direct').map(line => ({ supplierOrderLineId: line.id, quantityMilli: stockQuantityFromInput(draft.quantities[line.id]) ?? 0 })).filter(line => line.quantityMilli > 0);
}

const linesKey = (lines: { supplierOrderLineId: string; quantityMilli: number }[]) => JSON.stringify([...lines].map(line => [line.supplierOrderLineId, line.quantityMilli]).sort(([a], [b]) => String(a).localeCompare(String(b))));
export type ReceiptSnapshot = { supplierOrderId: string; receiptDate: string; reference?: string; notes?: string; lines: { supplierOrderLineId: string; quantityMilli: number }[] };
export function sameReceipt(receipt: SupplierReceipt, snapshot: ReceiptSnapshot) {
  return receipt.supplierOrderId === snapshot.supplierOrderId && receipt.receiptDate === snapshot.receiptDate && receipt.reference === (snapshot.reference?.trim() || '') && receipt.notes === (snapshot.notes?.trim() || '') && linesKey(receipt.lines) === linesKey(snapshot.lines);
}
export type ReceiptIntent = { kind: 'draft' | 'issue' | 'reverse'; id: string; snapshot?: ReceiptSnapshot; reason?: string; creating?: boolean };

export function receiptWasRecorded(workspace: Workspace, intent: ReceiptIntent) {
  requireReceiptWorkspace(workspace);
  const receipt = workspace.supplierReceipts.find(row => row.id === intent.id);
  if (!receipt) return false;
  if (intent.kind === 'draft') return intent.creating || !!intent.snapshot && sameReceipt(receipt, intent.snapshot);
  if (intent.kind === 'reverse') return receipt.status === 'reversed' && receipt.reversalReason === intent.reason?.trim();
  return ['issued', 'reversed'].includes(receipt.status) && (!intent.snapshot || sameReceipt(receipt, intent.snapshot));
}

export class ReceiptOutcomeUnknownError extends Error {
  constructor(readonly intent: ReceiptIntent, readonly mutationCause: unknown) { super('La réponse de la réception n’a pas été reçue. Vérifions son état avant de réessayer.'); }
  wasRecorded(workspace: Workspace) { return receiptWasRecorded(workspace, this.intent); }
}
export class ReceiptRefreshError extends WorkspaceRefreshAfterMutationError {
  constructor(readonly intent: ReceiptIntent, cause: unknown) { super(cause); }
  validateRead(workspace: Workspace) {
    requireReceiptWorkspace(workspace);
    const receipt = workspace.supplierReceipts.find(row => row.id === this.intent.id);
    if (!receipt || this.intent.kind === 'issue' && !['issued', 'reversed'].includes(receipt.status) || this.intent.kind === 'reverse' && receipt.status !== 'reversed') throw Error('L’état enregistré de la réception n’apparaît pas encore dans les données relues. Actualisez à nouveau sans renvoyer l’opération.');
  }
}
export async function runReceiptMutation(intent: ReceiptIntent, write: () => Promise<unknown>, load: () => Promise<Workspace>) {
  try { await write(); } catch (reason) { throw new ReceiptOutcomeUnknownError(intent, reason); }
  try { const next = await load(); new ReceiptRefreshError(intent, null).validateRead(next); return next; }
  catch (reason) { throw new ReceiptRefreshError(intent, reason); }
}

export function receiptNativeIssue(reason: unknown, order?: SupplierOrder): ReceiptIssue | null {
  const text = errorMessage(reason, '');
  if (/receipt_date|date.*réception|date réelle|date.*arrivée/i.test(text)) return { field: 'date', message: 'Vérifiez le jour réel d’arrivée : entre la commande et aujourd’hui.' };
  if (/\breference\b/i.test(text)) return { field: 'reference', message: 'Vérifiez la référence du bon de livraison : 200 caractères maximum.' };
  if (/\bnotes\b/i.test(text)) return { field: 'notes', message: 'Raccourcissez les notes à 20 000 caractères maximum.' };
  const line = order?.lines.find(line => text.includes(line.id));
  if (line && /quantité|quantity|restante|réceptionn/i.test(text)) return { field: 'quantity', lineId: line.id, message: 'La quantité disponible a changé. Comparez ce qui reste à recevoir avec ce qui est réellement arrivé.' };
  if (/a changé|brouillon|modifi|commande.*confirm|supplier_(receipts|orders)\//i.test(text)) return { field: 'record', message: 'La réception ou la commande a changé. Actualisez les données avant de reprendre.' };
  return null;
}

export function receiptIssueProblems(receipt: SupplierReceipt | undefined, workspace: Workspace): string[] {
  if (!receipt) return ['Cette réception n’est plus accessible. Actualisez les données.'];
  if (receipt.status !== 'draft') return ['Cette réception a déjà été validée ou annulée. Consultez son état actuel dans les réceptions.'];
  const order = workspace.supplierOrders.find(row => row.id === receipt.supplierOrderId);
  const draft = receiptDraft(order, receipt);
  const invalid = receiptFormIssue(draft, order, workspace);
  const problems = invalid ? [invalid.message] : [];
  if (order) {
    for (const line of receipt.lines) {
      const original = order.lines.find(row => row.id === line.supplierOrderLineId);
      if (!original || original.fulfillmentMode === 'direct') { problems.push('Une ligne ne correspond plus à une marchandise à recevoir. Corrigez le brouillon.'); continue; }
      if (original.fulfillmentMode === 'stocked_receipt') {
        const item = workspace.catalogItems.find(item => item.id === original.catalogItemId);
        if (!item || !item.trackStock || item.kind !== 'product') problems.push(`Le suivi de stock de « ${line.description} » n’est pas disponible. Vérifiez sa référence dans le catalogue.`);
      }
    }
  }
  return [...new Set(problems)];
}

export function receiptStockEffects(receipt: SupplierReceipt, workspace: Workspace) {
  const order = workspace.supplierOrders.find(row => row.id === receipt.supplierOrderId);
  const totals = new Map<string, bigint>();
  for (const line of receipt.lines) {
    const original = order?.lines.find(row => row.id === line.supplierOrderLineId);
    if (original?.fulfillmentMode === 'stocked_receipt' && original.catalogItemId && Number.isSafeInteger(line.quantityMilli)) totals.set(original.catalogItemId, (totals.get(original.catalogItemId) ?? 0n) + BigInt(line.quantityMilli));
  }
  return [...totals].map(([id, quantity]) => ({ id, quantity, item: workspace.catalogItems.find(row => row.id === id) }));
}

export function receiptReverseProblems(receipt: SupplierReceipt | undefined, workspace: Workspace) {
  if (!receipt || receipt.status !== 'issued') return ['Seule une réception déjà validée peut être annulée. Actualisez son état.'];
  const problems: string[] = [];
  if (workspace.supplierInvoiceMatches.some(match => receipt.lines.some(line => line.id === match.supplierReceiptLineId))) problems.push('Cette réception est liée à une facture fournisseur. Ouvrez cette facture pour vérifier son rapprochement avant de corriger la réception.');
  for (const effect of receiptStockEffects(receipt, workspace)) {
    if (!effect.item || !Number.isSafeInteger(effect.item.stockQuantityMilli) || BigInt(effect.item.stockQuantityMilli) < effect.quantity) problems.push(`Il ne reste pas assez de « ${effect.item?.name || 'marchandises'} » en stock pour annuler cette réception. Vérifiez les sorties dans le catalogue.`);
  }
  return problems;
}
