// Préremplit une facture fournisseur à partir d'une QR-facture lue, sans IA :
// fournisseur reconnu par son IBAN ou son nom, numéro et dates des
// informations de facture, montant net calculé seulement quand la TVA est
// indiquée sur la QR-facture.

import { newPurchaseLine, type PurchaseFields, type PurchaseLineFields } from './supplierInvoicePreparation';
import { supplierDueDate } from './purchases';
import { isQrIban, isSwissIban, normalizeIbanText, qrBillDueDate, type QrBill } from './swissQrBill';
import type { Supplier, SupplierInvoicePaymentDetails, Workspace } from './types';

const comparable = (value: string) => value.normalize('NFKC').toLocaleLowerCase('fr-CH').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Le fournisseur de la QR-facture : même IBAN (fiche ou facture précédente), sinon même nom. */
export function matchQrBillSupplier(bill: QrBill, workspace: Workspace): Supplier | null {
  const active = workspace.suppliers.filter((supplier) => !supplier.archivedAt);
  const byIban = active.filter((supplier) => normalizeIbanText(supplier.iban) === bill.iban);
  if (byIban.length === 1) return byIban[0];
  const known = new Set(workspace.supplierInvoices
    .filter((invoice) => invoice.paymentDetails?.creditorIban === bill.iban)
    .map((invoice) => invoice.supplierId));
  const byHistory = active.filter((supplier) => known.has(supplier.id));
  if (byHistory.length === 1) return byHistory[0];
  const name = comparable(bill.creditor.name);
  const byName = active.filter((supplier) => comparable(supplier.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

/**
 * Montant net d'un total TTC pour un taux donné, avec l'arrondi de l'app
 * (demi supérieur). Rend null si aucun montant net ne retombe exactement sur le total.
 */
export function netFromGross(totalCents: number, vatBp: number): number | null {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return null;
  const estimate = Math.round((totalCents * 10_000) / (10_000 + vatBp));
  for (const net of [estimate, estimate - 1, estimate + 1, estimate - 2, estimate + 2]) {
    if (net > 0 && net + Math.floor((net * vatBp + 5000) / 10_000) === totalCents) return net;
  }
  return null;
}

export type QrBillLines = Readonly<{
  lines: PurchaseLineFields[];
  /** false quand le montant HT reste à répartir par l'utilisateur. */
  complete: boolean;
}>;

function lastCategory(workspace: Workspace, supplierId: string | undefined): string | null {
  if (!supplierId) return null;
  const invoices = workspace.supplierInvoices
    .filter((invoice) => invoice.supplierId === supplierId && invoice.documentStatus === 'validated' && invoice.lines.length > 0)
    .sort((left, right) => right.documentDate.localeCompare(left.documentDate));
  return invoices[0]?.lines[0]?.category || null;
}

export function qrBillLines(bill: QrBill, workspace: Workspace, supplierId: string | undefined, allowedRatesBp: readonly number[]): QrBillLines {
  const base = newPurchaseLine(workspace);
  const category = lastCategory(workspace, supplierId) ?? base.category;
  const number = bill.billInformation?.invoiceNumber;
  const description = number ? `Facture ${number}` : bill.message || `Facture ${bill.creditor.name}`;
  const line = (price: string, vatBp: number): PurchaseLineFields => ({ ...newPurchaseLine(workspace), description: description.slice(0, 1000), quantity: '1', unit: 'forfait', price, vatBp, category });
  const vat = bill.billInformation?.vat ?? [];
  const toBp = (percent: number) => Math.round(percent * 100);
  if (bill.amountCents !== null && vat.length === 1 && vat[0].netAmountCents === null && allowedRatesBp.includes(toBp(vat[0].ratePercent))) {
    const bp = toBp(vat[0].ratePercent);
    const net = netFromGross(bill.amountCents, bp);
    if (net !== null) return { lines: [line((net / 100).toFixed(2), bp)], complete: true };
  }
  if (vat.length > 0 && vat.every((entry) => entry.netAmountCents !== null && allowedRatesBp.includes(toBp(entry.ratePercent)))) {
    const lines = vat.map((entry) => line((entry.netAmountCents! / 100).toFixed(2), toBp(entry.ratePercent)));
    return { lines, complete: true };
  }
  return { lines: [line('', base.vatBp)], complete: false };
}

/** Champs de la facture fournisseur préremplis depuis la QR-facture. */
export function applyQrBill(bill: QrBill, previous: PurchaseFields, workspace: Workspace, supplier: Supplier | null, today: string, allowedRatesBp: readonly number[]): { fields: PurchaseFields; complete: boolean } {
  const information = bill.billInformation;
  const date = information?.invoiceDate ?? today;
  const dueDate = qrBillDueDate(bill) ?? supplierDueDate(date, supplier ?? undefined, workspace.settings!.billing.paymentTermsDays);
  const { lines, complete } = qrBillLines(bill, workspace, supplier?.id, allowedRatesBp);
  return {
    fields: {
      ...previous,
      supplierId: supplier?.id ?? previous.supplierId,
      reference: (information?.invoiceNumber ?? (bill.referenceType === 'NON' ? bill.message : '') ?? '').slice(0, 200) || previous.reference,
      date,
      dueDate,
      vatTreatment: '',
      lines,
    },
    complete,
  };
}

/** Coordonnées de paiement à garder avec la facture (pour l'ordre de paiement). */
export function qrBillPaymentDetails(bill: QrBill, supplierInvoiceId: string): Omit<SupplierInvoicePaymentDetails, 'updatedAt'> {
  const creditor = bill.creditor;
  return {
    supplierInvoiceId,
    creditorIban: bill.iban,
    referenceType: bill.referenceType,
    reference: bill.reference,
    creditorName: creditor.name.slice(0, 70),
    creditorStreet: (creditor.type === 'S' ? creditor.street : creditor.addressLine1).slice(0, 70),
    creditorBuildingNumber: creditor.buildingNumber.slice(0, 16),
    creditorPostalCode: creditor.postalCode.slice(0, 16),
    creditorCity: creditor.city.slice(0, 35),
    creditorCountry: creditor.country,
    amountCents: bill.amountCents,
    currency: bill.currency,
    message: bill.message.slice(0, 140),
    billInformation: bill.rawBillInformation.slice(0, 140),
    source: 'qr_bill',
  };
}

/** Fiche fournisseur proposée quand personne ne correspond. Le QR-IBAN n'est pas gardé comme IBAN habituel. */
export function supplierFromQrBill(bill: QrBill) {
  const creditor = bill.creditor;
  const street = creditor.type === 'S' ? [creditor.street, creditor.buildingNumber].filter(Boolean).join(' ') : creditor.addressLine1;
  const town = [creditor.postalCode, creditor.city].filter(Boolean).join(' ');
  const terms = bill.billInformation?.conditions.length ? Math.max(...bill.billInformation.conditions.map((condition) => condition.days)) : 30;
  return {
    name: creditor.name,
    address: [street, town].filter(Boolean).join('\n'),
    iban: isSwissIban(bill.iban) && !isQrIban(bill.iban) ? bill.iban : '',
    currency: 'CHF',
    paymentTermsDays: Math.min(365, Math.max(0, terms)),
    uidNumber: bill.billInformation?.vatNumber ?? '',
  };
}
