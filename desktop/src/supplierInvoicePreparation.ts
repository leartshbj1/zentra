import type { SupplierInvoice, Workspace } from './types';
import { purchaseCostCategories, purchaseVatOptions } from './purchaseVat';
import { selectableSuppliers, supplierDueDate } from './purchases';
import { isSalesDate } from './salesFormValidation';
import { createId, todayIso } from './utils';
import { t } from './language';

export type SupplierInvoiceDraftLine = {
  id: string; description: string; quantityMilli: number; unit: string; unitPriceCents: number;
  discountBp: number; vatBp: number; category: string; expenseAccountId: string; projectId: string;
};
export type PurchaseLineFields = Omit<SupplierInvoiceDraftLine, 'quantityMilli' | 'unitPriceCents' | 'discountBp'> & { quantity: string; price: string; discount: string };
export type PurchaseFields = {
  supplierId: string; reference: string; date: string; dueDate: string; projectId: string; note: string;
  vatTreatment: '' | 'input_materials' | 'input_investments' | 'non_deductible'; lines: PurchaseLineFields[];
};
export type PurchaseIssue = { step: 0 | 1; field: string; message: string; line?: number };
export const purchaseLineField = (id: string, field: string) => `line-${id}-${field}`;

export function purchaseDecimal(value: string, decimals: number, max: number): number | null {
  const normalized = value.trim().replace(',', '.');
  if (normalized.length > 64 || !new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const exact = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0'));
  return exact <= BigInt(max) ? Number(exact) : null;
}

function decimalText(value: number, places: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return t('À vérifier');
  const scale = 10n ** BigInt(places), number = BigInt(value);
  return `${number / scale}.${String(number % scale).padStart(places, '0')}`;
}

export function newPurchaseLine(workspace: Workspace): PurchaseLineFields {
  const settings = workspace.settings!;
  return { id: createId(), description: '', quantity: '1', unit: t('unité'), price: '', discount: '0',
    vatBp: purchaseVatOptions(settings.organization.vatRegistered, settings.billing.vatRatesBp)[0] ?? 0,
    category: purchaseCostCategories(settings.work.costCategories)[0] ?? '', expenseAccountId: '', projectId: '' };
}

export function purchaseFields(workspace: Workspace, item?: SupplierInvoice, today = todayIso()): PurchaseFields {
  const choices = selectableSuppliers(workspace.suppliers, item?.supplierId);
  const supplier = item ? choices.find(value => value.id === item.supplierId) : choices.length === 1 ? choices[0] : undefined;
  return { supplierId: item?.supplierId ?? supplier?.id ?? '', reference: item?.reference ?? '', date: item?.documentDate ?? today,
    dueDate: item?.dueDate ?? supplierDueDate(today, supplier, workspace.settings!.billing.paymentTermsDays), projectId: item?.projectId ?? '', note: item?.note ?? '', vatTreatment: '',
    lines: item?.lines.length ? item.lines.map(line => ({ id: line.id, description: line.description,
      quantity: decimalText(line.quantityMilli, 3), unit: line.unit, price: decimalText(line.unitPriceCents, 2), discount: decimalText(line.discountBp, 2),
      vatBp: line.vatBp, category: line.category, expenseAccountId: line.expenseAccountId ?? '', projectId: line.projectId ?? '' })) : [newPurchaseLine(workspace)] };
}

export function changePurchaseDate(fields: PurchaseFields, field: 'date' | 'supplierId', value: string, workspace: Workspace): PurchaseFields {
  const previous = workspace.suppliers.find(supplier => supplier.id === fields.supplierId);
  const followed = isSalesDate(fields.date) && fields.dueDate === supplierDueDate(fields.date, previous, workspace.settings!.billing.paymentTermsDays);
  const next = { ...fields, [field]: value };
  if (followed && isSalesDate(next.date)) next.dueDate = supplierDueDate(next.date, workspace.suppliers.find(supplier => supplier.id === next.supplierId), workspace.settings!.billing.paymentTermsDays);
  return next;
}

export function purchaseLineValue(line: PurchaseLineFields): SupplierInvoiceDraftLine | null {
  const quantityMilli = purchaseDecimal(line.quantity, 3, 1_000_000_000);
  const unitPriceCents = purchaseDecimal(line.price, 2, 10_000_000_000);
  const discountBp = purchaseDecimal(line.discount.trim() || '0', 2, 10_000);
  if (quantityMilli === null || quantityMilli <= 0 || unitPriceCents === null || discountBp === null) return null;
  const { quantity: _quantity, price: _price, discount: _discount, ...rest } = line;
  return { ...rest, quantityMilli, unitPriceCents, discountBp };
}

export function supplierInvoiceLineTotals(line: SupplierInvoiceDraftLine) {
  if (![line.quantityMilli, line.unitPriceCents, line.discountBp, line.vatBp].every(value => Number.isSafeInteger(value) && value >= 0) || line.discountBp > 10_000 || line.vatBp > 10_000) return null;
  // Match the native invoice's half-up rounding, without floating-point products.
  const base = (BigInt(line.quantityMilli) * BigInt(line.unitPriceCents) + 500n) / 1000n;
  const net = base - (base * BigInt(line.discountBp) + 5000n) / 10000n;
  const vat = (net * BigInt(line.vatBp) + 5000n) / 10000n, total = net + vat;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? { netCents: Number(net), vatCents: Number(vat), totalCents: Number(total) } : null;
}

export function purchaseTotals(lines: PurchaseLineFields[]) {
  let netCents = 0, vatCents = 0, totalCents = 0;
  for (const fields of lines) {
    const line = purchaseLineValue(fields), totals = line && supplierInvoiceLineTotals(line);
    if (!totals) return null;
    netCents += totals.netCents; vatCents += totals.vatCents; totalCents += totals.totalCents;
    if (![netCents, vatCents, totalCents].every(Number.isSafeInteger)) return null;
  }
  return { netCents, vatCents, totalCents };
}

export function purchaseIssue(fields: PurchaseFields, rates: number[], onlyStep?: 0 | 1): PurchaseIssue | null {
  if (onlyStep !== 1) {
    const issue = (field: string, message: string): PurchaseIssue => ({ step: 0, field, message });
    if (!fields.supplierId) return issue('supplierId', 'Choisissez le fournisseur qui a émis cette facture.');
    if (!isSalesDate(fields.date)) return issue('date', 'Recopiez la date inscrite sur la facture reçue.');
    if (!isSalesDate(fields.dueDate)) return issue('dueDate', 'Indiquez la date limite de paiement. Le délai habituel peut vous aider.');
    if (fields.dueDate < fields.date) return issue('dueDate', 'La date limite de paiement doit être le jour de la facture ou après.');
    if (fields.reference.length > 200) return issue('reference', 'La référence peut contenir 200 caractères au maximum.');
    if (fields.note.length > 10_000) return issue('note', 'La note peut contenir 10 000 caractères au maximum.');
  }
  if (onlyStep === 0) return null;
  if (!fields.lines.length || fields.lines.length > 250) return { step: 1, field: 'purchase-lines', message: 'Cette facture doit contenir entre 1 et 250 lignes.' };
  for (const [index, line] of fields.lines.entries()) {
    const issue = (field: string, message: string): PurchaseIssue => ({ step: 1, field: purchaseLineField(line.id, field), message, line: index + 1 });
    if (!line.description.trim() || line.description.length > 1_000) return issue('description', 'décrivez ce que vous avez acheté, en 1 000 caractères maximum.');
    const quantity = purchaseDecimal(line.quantity, 3, 1_000_000_000);
    if (quantity === null || quantity <= 0) return issue('quantity', 'indiquez une quantité supérieure à zéro, jusqu’à 1 000 000, avec trois décimales maximum. Exemple : 2,5.');
    if (!line.unit.trim() || line.unit.length > 50) return issue('unit', 'indiquez une unité, par exemple pièce, heure ou mètre (50 caractères maximum).');
    if (purchaseDecimal(line.price, 2, 10_000_000_000) === null) return issue('price', 'recopiez le prix hors TVA d’une unité, entre 0 et 100 000 000 CHF, avec deux décimales maximum. Exemple : 85,50.');
    if (purchaseDecimal(line.discount.trim() || '0', 2, 10_000) === null) return issue('discount', 'la remise va de 0 à 100 %, avec deux décimales maximum. Vous pouvez laisser ce champ vide.');
    if (!Number.isInteger(line.vatBp) || !rates.includes(line.vatBp)) return issue('vatBp', 'ce taux n’est plus disponible. Choisissez un taux de vos paramètres.');
    if (!line.category.trim() || line.category.length > 200) return issue('category', 'choisissez une catégorie pour retrouver cet achat dans vos coûts.');
  }
  const totals = purchaseTotals(fields.lines);
  if (!totals) return { step: 1, field: 'purchase-lines', message: 'Le total dépasse la précision disponible. Vérifiez les prix et les quantités avant de continuer.' };
  if (totals.totalCents <= 0) return { step: 1, field: purchaseLineField(fields.lines[0].id, 'price'), message: 'Indiquez le prix des achats : le total de la facture doit être supérieur à zéro.' };
  return null;
}
