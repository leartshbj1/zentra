// Préparation de l'ordre de paiement des factures fournisseurs, à partir des
// données de l'app seulement : solde ouvert, coordonnées lues sur la
// QR-facture, sinon IBAN de la fiche fournisseur.

import { buildPaymentOrder, paymentMessageId, type PaymentAddress, type PaymentOrderIssue, type PaymentOrderLine, type PaymentReference } from './pain001';
import { isSwissIban, normalizeIbanText } from './swissQrBill';
import type { Supplier, SupplierInvoice, Workspace } from './types';

export type PayableInvoice = Readonly<{
  invoice: SupplierInvoice;
  supplier: Supplier | null;
  /** null si l'IBAN manque : la facture reste à payer à la main. */
  line: PaymentOrderLine | null;
  missing: 'iban' | null;
  /** Date du dernier ordre préparé pour cette facture, s'il y en a un. */
  lastOrderDate: string | null;
}>;

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Prochain jour ouvré bancaire (lundi à vendredi), à partir du lendemain. */
export function nextBankDay(today: string): string {
  let date = addDays(today, 1);
  for (;;) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return date;
    date = addDays(date, 1);
  }
}

/** « Rue du Lac 12, 2501 Biel » → rue, numéro, NPA, localité. Le reste est gardé tel quel. */
export function parseFreeAddress(text: string): PaymentAddress | undefined {
  const parts = text.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const townIndex = parts.findIndex((part) => /^(?:CH-)?\d{4}\s+\S/.test(part));
  if (townIndex < 0) return undefined;
  const town = /^(?:CH-)?(\d{4})\s+(.+)$/.exec(parts[townIndex])!;
  const streetText = townIndex > 0 ? parts[townIndex - 1] : '';
  const street = /^(.*\S)\s+(\d+[A-Za-z]?)$/.exec(streetText);
  return {
    street: street ? street[1] : streetText,
    buildingNumber: street ? street[2] : '',
    postalCode: town[1],
    city: town[2],
    country: 'CH',
  };
}

function endToEndId(invoice: SupplierInvoice): string {
  // Référence lisible sur le relevé ; repli sur l'identifiant si le numéro manque.
  const reference = invoice.reference.normalize('NFKD').replace(/[^A-Za-z0-9+?/\-:().,' ]/g, '').trim();
  return (reference || invoice.id.replace(/-/g, '')).slice(0, 35);
}

export function paymentLine(invoice: SupplierInvoice, supplier: Supplier | null): PaymentOrderLine | null {
  const details = invoice.paymentDetails;
  const amountCents = invoice.balanceCents;
  if (details) {
    const reference: PaymentReference = details.referenceType === 'NON'
      ? { type: 'NON' }
      : { type: details.referenceType, value: details.reference };
    return {
      endToEndId: endToEndId(invoice),
      amountCents,
      currency: 'CHF',
      creditor: {
        name: details.creditorName,
        iban: details.creditorIban,
        address: {
          street: details.creditorStreet,
          buildingNumber: details.creditorBuildingNumber,
          postalCode: details.creditorPostalCode,
          city: details.creditorCity,
          country: details.creditorCountry || 'CH',
        },
      },
      reference,
      message: details.referenceType === 'NON' ? (details.message || `Facture ${invoice.reference}`.trim()) : details.message,
    };
  }
  const iban = normalizeIbanText(supplier?.iban ?? '');
  if (!supplier || !iban) return null;
  return {
    endToEndId: endToEndId(invoice),
    amountCents,
    currency: 'CHF',
    creditor: { name: supplier.name, iban, address: parseFreeAddress(supplier.address) },
    reference: { type: 'NON' },
    message: invoice.reference ? `Facture ${invoice.reference}` : '',
  };
}

/** Factures validées avec un solde, la plus urgente d'abord. */
export function payableInvoices(workspace: Workspace): PayableInvoice[] {
  const suppliers = new Map(workspace.suppliers.map((supplier) => [supplier.id, supplier]));
  const lastOrder = new Map<string, string>();
  for (const order of workspace.supplierPaymentOrders ?? []) {
    for (const item of order.items) {
      const previous = lastOrder.get(item.supplierInvoiceId);
      if (!previous || previous < order.createdAt) lastOrder.set(item.supplierInvoiceId, order.createdAt);
    }
  }
  return workspace.supplierInvoices
    .filter((invoice) => invoice.documentStatus === 'validated' && invoice.balanceCents > 0)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.supplierName.localeCompare(right.supplierName))
    .map((invoice) => {
      const supplier = suppliers.get(invoice.supplierId) ?? null;
      const line = paymentLine(invoice, supplier);
      return { invoice, supplier, line, missing: line ? null : 'iban', lastOrderDate: lastOrder.get(invoice.id)?.slice(0, 10) ?? null };
    });
}

/** Sélection par défaut : échues ou à échéance dans les 7 jours, payables par ordre, pas encore dans un ordre. */
export function defaultSelection(rows: readonly PayableInvoice[], today: string): string[] {
  const limit = addDays(today, 7);
  return rows.filter((row) => row.line && !row.lastOrderDate && row.invoice.dueDate <= limit).map((row) => row.invoice.id);
}

export type PreparedOrder =
  | Readonly<{ ok: true; xml: string; fileName: string; messageId: string; executionDate: string; debtorIban: string; totalCents: number; items: { supplierInvoiceId: string; endToEndId: string; amountCents: number }[] }>
  | Readonly<{ ok: false; reason: 'company_iban' | 'nothing_selected' | 'invalid'; issues: readonly PaymentOrderIssue[]; invoiceIds: readonly string[] }>;

export function prepareSupplierPaymentOrder(workspace: Workspace, rows: readonly PayableInvoice[], selected: readonly string[], executionDate: string, now: Date, suffix: string): PreparedOrder {
  const settings = workspace.settings;
  const debtorIban = normalizeIbanText(settings?.billing.iban ?? '');
  if (!settings || !isSwissIban(debtorIban)) return { ok: false, reason: 'company_iban', issues: [], invoiceIds: [] };
  const chosen = rows.filter((row) => selected.includes(row.invoice.id) && row.line);
  if (chosen.length === 0) return { ok: false, reason: 'nothing_selected', issues: [], invoiceIds: [] };
  // Les identifiants de bout en bout doivent être uniques dans l'ordre.
  const used = new Set<string>();
  const lines = chosen.map((row) => {
    let id = row.line!.endToEndId;
    for (let n = 2; used.has(id); n += 1) id = `${row.line!.endToEndId.slice(0, 31)}-${n}`;
    used.add(id);
    return { ...row.line!, endToEndId: id };
  });
  const pad = (value: number) => String(value).padStart(2, '0');
  const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const messageId = paymentMessageId(createdAt, suffix);
  const address = settings.organization.address;
  const result = buildPaymentOrder({
    messageId,
    createdAt,
    executionDate,
    debtor: {
      name: settings.billing.accountHolder || settings.organization.legalName,
      iban: debtorIban,
      address: { street: address.street, buildingNumber: address.buildingNumber, postalCode: address.postalCode, city: address.city, country: address.country || 'CH' },
    },
    lines,
  });
  if (!result.ok) return { ok: false, reason: 'invalid', issues: result.issues, invoiceIds: chosen.map((row) => row.invoice.id) };
  return {
    ok: true,
    xml: result.xml,
    fileName: `ordre-de-paiement-${executionDate}.xml`,
    messageId,
    executionDate,
    debtorIban,
    totalCents: result.controlSumCents,
    items: chosen.map((row, index) => ({ supplierInvoiceId: row.invoice.id, endToEndId: lines[index].endToEndId, amountCents: lines[index].amountCents })),
  };
}

/** Résumé de la carte Autopilote : factures payables par ordre, échues ou dans les 7 jours, pas encore dans un ordre. */
export function paymentOrderSummary(workspace: Workspace, today: string) {
  const rows = payableInvoices(workspace);
  const ids = defaultSelection(rows, today);
  const totalCents = rows.filter((row) => ids.includes(row.invoice.id)).reduce((sum, row) => sum + row.invoice.balanceCents, 0);
  return { count: ids.length, totalCents, ids };
}
