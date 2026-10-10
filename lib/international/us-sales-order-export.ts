import { snapshotPrivateJson } from './private-json';
import { ExportError, MAX_EXPORT_PDF_PAGES, MAX_EXPORT_ROWS, MAX_EXPORT_TEXT_CHARACTERS } from './export-snapshot';
import type { UsExportFonts } from './export-renderer';
import { formatAddress, validateAddress } from './addresses';
import { escapeDocumentHtml, type PrintedParty } from './documents';
import { formatDateOnly, parseInstant } from './localization';
import { estimateTotals, lineTotals, type SalesLine } from './invoicing';
import { formatMoney, money } from './money';
import { validateUsSalesOrderRecord, type UsSalesOrderInvoiceLink } from './us-sales-order-contract';
import type { CompanyAddress, CompanyLanguage } from './types';
import type { PDFFont, PDFPage } from 'pdf-lib';

const en = {
  title: 'Sales order', draft: 'Draft', confirmed: 'Internally confirmed', cancelled: 'Cancelled',
  seller: 'Seller', customer: 'Customer', shippingAddress: 'Shipping address', contact: 'Contact', date: 'Order date',
  sourceEstimate: 'Source estimate', sourceEstimateRevision: 'Source estimate revision', sourceErpRevision: 'Source ERP revision',
  orderRevision: 'Order revision', internalConfirmation: 'Internal confirmation', confirmedBy: 'Recorded by', confirmedAt: 'Recorded at (UTC)',
  cancellation: 'Internal cancellation', cancelledBy: 'Recorded by', cancelledAt: 'Recorded at (UTC)', reason: 'Reason',
  createdBy: 'Created by', createdAt: 'Created at (UTC)', customerReference: 'Customer reference', confirmationReference: 'Confirmation reference', relatedInvoice: 'Related invoice',
  termsDays: 'Payment terms (days)', description: 'Description', quantity: 'Quantity', unitPrice: 'Unit price', net: 'Net amount',
  subtotal: 'Subtotal', discount: 'Discount', netTotal: 'Total excluding tax', taxPending: 'Tax determination pending', notes: 'Notes',
  notice: 'Commercial record. Internal confirmation does not certify customer acceptance. This is not an invoice or a payment receipt.',
  page: 'Page', of: 'of',
} as const;
type Copy = { readonly [K in keyof typeof en]: string };
export const usSalesOrderExportCopy: Readonly<Record<CompanyLanguage, Copy>> = {
  en,
  fr: {
    title: 'Commande client', draft: 'Brouillon', confirmed: 'Confirmée en interne', cancelled: 'Annulée',
    seller: 'Vendeur', customer: 'Client', shippingAddress: 'Adresse de livraison', contact: 'Interlocuteur', date: 'Date de commande',
    sourceEstimate: 'Devis source', sourceEstimateRevision: 'Révision du devis source', sourceErpRevision: 'Révision ERP source',
    orderRevision: 'Révision de la commande', internalConfirmation: 'Confirmation interne', confirmedBy: 'Enregistrée par', confirmedAt: 'Enregistrée le (UTC)',
    cancellation: 'Annulation interne', cancelledBy: 'Enregistrée par', cancelledAt: 'Enregistrée le (UTC)', reason: 'Motif',
    createdBy: 'Créée par', createdAt: 'Créée le (UTC)', customerReference: 'Référence client', confirmationReference: 'Référence de confirmation', relatedInvoice: 'Facture liée',
    termsDays: 'Délai de paiement (jours)', description: 'Description', quantity: 'Quantité', unitPrice: 'Prix unitaire', net: 'Montant net',
    subtotal: 'Sous-total', discount: 'Remise', netTotal: 'Total hors taxes', taxPending: 'Taxe à déterminer', notes: 'Notes',
    notice: 'Document commercial. La confirmation interne ne certifie pas l’accord du client. Ceci n’est ni une facture ni un reçu de paiement.',
    page: 'Page', of: 'sur',
  },
  de: {
    title: 'Kundenauftrag', draft: 'Entwurf', confirmed: 'Intern bestätigt', cancelled: 'Storniert',
    seller: 'Verkäufer', customer: 'Kunde', shippingAddress: 'Lieferadresse', contact: 'Kontaktperson', date: 'Auftragsdatum',
    sourceEstimate: 'Ursprüngliches Angebot', sourceEstimateRevision: 'Revision des ursprünglichen Angebots', sourceErpRevision: 'Ursprüngliche ERP-Revision',
    orderRevision: 'Auftragsrevision', internalConfirmation: 'Interne Bestätigung', confirmedBy: 'Erfasst von', confirmedAt: 'Erfasst am (UTC)',
    cancellation: 'Interne Stornierung', cancelledBy: 'Erfasst von', cancelledAt: 'Erfasst am (UTC)', reason: 'Grund',
    createdBy: 'Erstellt von', createdAt: 'Erstellt am (UTC)', customerReference: 'Kundenreferenz', confirmationReference: 'Bestätigungsreferenz', relatedInvoice: 'Verknüpfte Rechnung',
    termsDays: 'Zahlungsfrist (Tage)', description: 'Beschreibung', quantity: 'Menge', unitPrice: 'Einzelpreis', net: 'Nettobetrag',
    subtotal: 'Zwischensumme', discount: 'Rabatt', netTotal: 'Gesamtbetrag ohne Steuer', taxPending: 'Steuer noch zu bestimmen', notes: 'Notizen',
    notice: 'Geschäftsdokument. Die interne Bestätigung bestätigt keine Zustimmung des Kunden. Dies ist weder eine Rechnung noch ein Zahlungsbeleg.',
    page: 'Seite', of: 'von',
  },
  it: {
    title: 'Ordine cliente', draft: 'Bozza', confirmed: 'Confermato internamente', cancelled: 'Annullato',
    seller: 'Venditore', customer: 'Cliente', shippingAddress: 'Indirizzo di consegna', contact: 'Referente', date: 'Data dell’ordine',
    sourceEstimate: 'Preventivo di origine', sourceEstimateRevision: 'Revisione del preventivo di origine', sourceErpRevision: 'Revisione ERP di origine',
    orderRevision: 'Revisione dell’ordine', internalConfirmation: 'Conferma interna', confirmedBy: 'Registrata da', confirmedAt: 'Registrata il (UTC)',
    cancellation: 'Annullamento interno', cancelledBy: 'Registrato da', cancelledAt: 'Registrato il (UTC)', reason: 'Motivo',
    createdBy: 'Creato da', createdAt: 'Creato il (UTC)', customerReference: 'Riferimento cliente', confirmationReference: 'Riferimento di conferma', relatedInvoice: 'Fattura collegata',
    termsDays: 'Termine di pagamento (giorni)', description: 'Descrizione', quantity: 'Quantità', unitPrice: 'Prezzo unitario', net: 'Importo netto',
    subtotal: 'Subtotale', discount: 'Sconto', netTotal: 'Totale al netto delle imposte', taxPending: 'Imposta da determinare', notes: 'Note',
    notice: 'Documento commerciale. La conferma interna non certifica l’accettazione del cliente. Non è una fattura né una ricevuta di pagamento.',
    page: 'Pagina', of: 'di',
  },
};

export interface UsSalesOrderExportRow {
  readonly id: string;
  readonly description: string;
  readonly quantityUnits: string;
  readonly quantityScale: number;
  readonly unitPriceMinor: string;
  readonly discountBasisPoints: number;
  readonly grossMinor: string;
  readonly discountMinor: string;
  readonly netMinor: string;
}
export interface UsSalesOrderExportSnapshot {
  readonly schemaVersion: 1;
  readonly documentType: 'sales_order';
  readonly organizationId: string;
  readonly salesOrderId: string;
  readonly orderRevision: number;
  readonly sourceErpRevision: number;
  readonly sourceEstimateId: string;
  readonly sourceEstimateNumber: string;
  readonly sourceEstimateRevision: number;
  readonly currency: 'USD';
  readonly paper: 'Letter';
  readonly language: CompanyLanguage;
  readonly number: string;
  readonly date: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly customerReference: string | null;
  readonly status: 'draft' | 'confirmed' | 'cancelled';
  readonly seller: PrintedParty;
  readonly customer: PrintedParty;
  readonly shippingAddress: CompanyAddress | null;
  readonly contactName: string | null;
  readonly paymentTermsDays: number;
  readonly confirmation: Readonly<{ userId: string; at: string; reference: string }> | null;
  readonly cancellation: Readonly<{ userId: string; at: string; reason: string }> | null;
  readonly invoice: UsSalesOrderInvoiceLink | null;
  readonly rows: readonly UsSalesOrderExportRow[];
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  readonly netMinor: string;
  readonly taxStatus: 'pending';
  readonly notes: string;
}

const invalid = (): never => { throw new ExportError('invalid_export_snapshot'); };
const object = (input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...keys, ...optional].includes(key))) return invalid();
  return value;
};
const text = (input: unknown, maximum = 4000, empty = false, multiline = false): string => {
  if (typeof input !== 'string' || input.length > maximum || (!empty && !input.trim()) || Array.from(input).some(character => {
    const code = character.charCodeAt(0); return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  })) return invalid();
  return input;
};
const key = (input: unknown) => text(input, 160);
const revision = (input: unknown): number => { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) return invalid(); return input; };
const minor = (input: unknown): string => { if (typeof input !== 'string' || !/^(?:0|[1-9][0-9]{0,51})$/.test(input)) return invalid(); return input; };
function party(input: unknown): PrintedParty {
  const value = object(input, ['name', 'address'], ['contactEmail', 'contactPhone']);
  const raw = object(value.address, ['country', 'line1', 'postalCode', 'city', 'subdivision'], ['line2']);
  if (raw.country !== 'US' && raw.country !== 'CH') return invalid();
  const address = validateAddress(raw, raw.country), name = text(value.name, 256);
  const contactEmail = Object.hasOwn(value, 'contactEmail') ? text(value.contactEmail, 254) : undefined;
  if (contactEmail !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail)) return invalid();
  return { name, address, ...(contactEmail === undefined ? {} : { contactEmail }), ...(Object.hasOwn(value, 'contactPhone') ? { contactPhone: text(value.contactPhone, 80) } : {}) };
}
function event(input: unknown, cancellation = false): { userId: string; at: string; reason?: string; reference?: string } {
  const value = object(input, cancellation ? ['userId', 'at', 'reason'] : ['userId', 'at', 'reference']);
  const userId = text(value.userId, 256), at = text(value.at, 40); parseInstant(at);
  return { userId, at, ...(cancellation ? { reason: text(value.reason, 500) } : { reference: text(value.reference, 500) }) };
}

/** Authorized callers load a real record first. No browser party, price, actor,
 * current company settings or financial state is merged into the archived order. */
export function buildUsSalesOrderExportSnapshot(input: unknown, language?: CompanyLanguage): UsSalesOrderExportSnapshot {
  try {
    const detached = snapshotPrivateJson(input), root = object(detached, ['order', 'invoice']);
    if (!root.order || typeof root.order !== 'object' || Array.isArray(root.order)) return invalid();
    const organizationId = text((root.order as Record<string, unknown>).organizationId, 128);
    const record = validateUsSalesOrderRecord(detached, organizationId), o = record.order, source = o.sourceEstimate;
    const totals = estimateTotals(source);
    return validateUsSalesOrderExportSnapshot({
      schemaVersion: 1, documentType: 'sales_order', organizationId, salesOrderId: o.id, orderRevision: o.revision,
      sourceErpRevision: o.sourceErpRevision, sourceEstimateId: source.id, sourceEstimateNumber: source.number, sourceEstimateRevision: source.revision,
      currency: 'USD', paper: 'Letter', language: language ?? o.companyConfiguration.language, number: o.number, date: o.orderDate,
      createdBy: o.createdBy, createdAt: o.createdAt, customerReference: o.customerReference, status: o.state,
      seller: { name: o.sellerSnapshot.displayName, address: o.companyConfiguration.address, ...(o.sellerSnapshot.contactEmail ? { contactEmail: o.sellerSnapshot.contactEmail } : {}), ...(o.sellerSnapshot.contactPhone ? { contactPhone: o.sellerSnapshot.contactPhone } : {}) },
      customer: { name: source.customer.name, address: source.customer.billingAddress, ...(source.customer.email ? { contactEmail: source.customer.email } : {}), ...(source.customer.phone ? { contactPhone: source.customer.phone } : {}) },
      shippingAddress: source.customer.shippingAddress ?? null, contactName: source.customer.contactName ?? null, paymentTermsDays: source.paymentTermsDays,
      confirmation: o.confirmation ? { userId: o.confirmation.confirmedBy, at: o.confirmation.confirmedAt, reference: o.confirmation.reference } : null,
      cancellation: o.cancellation ? { userId: o.cancellation.cancelledBy, at: o.cancellation.cancelledAt, reason: o.cancellation.reason } : null,
      invoice: record.invoice,
      rows: source.lines.map(line => { const t = lineTotals(line, 'USD'); return { id: line.id, description: line.description, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, unitPriceMinor: line.unitPrice.minorUnits, discountBasisPoints: line.discountBasisPoints, grossMinor: t.gross.minorUnits, discountMinor: t.discount.minorUnits, netMinor: t.net.minorUnits }; }),
      subtotalMinor: totals.subtotal.minorUnits, discountMinor: totals.discount.minorUnits, netMinor: totals.net.minorUnits, taxStatus: 'pending', notes: source.notes,
    });
  } catch (error) { if (error instanceof ExportError) throw error; return invalid(); }
}

/** Independent commercial export. This validates data, never Auth or membership.
 * No ERP/ledger revision is invented for an order outside ErpState schema 1-4. */
export function validateUsSalesOrderExportSnapshot(input: unknown): UsSalesOrderExportSnapshot {
  try {
    const value = object(snapshotPrivateJson(input), ['schemaVersion', 'documentType', 'organizationId', 'salesOrderId', 'orderRevision', 'sourceErpRevision', 'sourceEstimateId', 'sourceEstimateNumber', 'sourceEstimateRevision', 'currency', 'paper', 'language', 'number', 'date', 'createdBy', 'createdAt', 'customerReference', 'status', 'seller', 'customer', 'shippingAddress', 'contactName', 'paymentTermsDays', 'confirmation', 'cancellation', 'invoice', 'rows', 'subtotalMinor', 'discountMinor', 'netMinor', 'taxStatus', 'notes']);
    if (value.schemaVersion !== 1 || value.documentType !== 'sales_order' || value.currency !== 'USD' || value.paper !== 'Letter' || value.taxStatus !== 'pending' || !['fr', 'de', 'it', 'en'].includes(String(value.language)) || !['draft', 'confirmed', 'cancelled'].includes(String(value.status))) return invalid();
    const organizationId = text(value.organizationId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) return invalid();
    const orderRevision = revision(value.orderRevision), sourceErpRevision = revision(value.sourceErpRevision), sourceEstimateRevision = revision(value.sourceEstimateRevision);
    if (sourceEstimateRevision > sourceErpRevision) return invalid();
    const seller = party(value.seller), customer = party(value.customer);
    if (seller.address.country !== 'US') return invalid();
    const date = text(value.date, 10); formatDateOnly(date, 'en-US');
    const paymentTermsDays = value.paymentTermsDays;
    if (typeof paymentTermsDays !== 'number' || !Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) return invalid();
    const rawConfirmation = value.confirmation === null ? null : event(value.confirmation);
    const confirmation = rawConfirmation === null ? null : { userId: rawConfirmation.userId, at: rawConfirmation.at, reference: rawConfirmation.reference! };
    const rawCancellation = value.cancellation === null ? null : event(value.cancellation, true);
    const cancellation = rawCancellation === null ? null : { userId: rawCancellation.userId, at: rawCancellation.at, reason: rawCancellation.reason! };
    if ((value.status === 'draft' && (confirmation !== null || cancellation !== null)) || (value.status === 'confirmed' && (!confirmation || cancellation !== null)) || (value.status === 'cancelled' && !cancellation) || (confirmation && cancellation && parseInstant(confirmation.at) > parseInstant(cancellation.at))) return invalid();
    const createdBy = text(value.createdBy, 256), createdAt = text(value.createdAt, 40); parseInstant(createdAt);
    if ((confirmation && parseInstant(confirmation.at) < parseInstant(createdAt)) || (cancellation && parseInstant(cancellation.at) < parseInstant(createdAt)) || orderRevision !== (value.status === 'draft' ? 1 : value.status === 'confirmed' || !confirmation ? 2 : 3)) return invalid();
    let invoice: UsSalesOrderInvoiceLink | null = null;
    if (value.invoice !== null) {
      const i = object(value.invoice, ['id', 'number', 'sourceEstimateRevision', 'issuedAt']);
      const issuedAt = text(i.issuedAt, 40); parseInstant(issuedAt);
      if (value.status !== 'confirmed' || !confirmation || revision(i.sourceEstimateRevision) !== sourceEstimateRevision || parseInstant(issuedAt) < parseInstant(confirmation.at)) return invalid();
      invoice = { id: key(i.id), number: text(i.number, 160), sourceEstimateRevision, issuedAt };
    }
    if (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > MAX_EXPORT_ROWS) return invalid();
    const ids = new Set<string>();
    const rows = value.rows.map(raw => {
      const row = object(raw, ['id', 'description', 'quantityUnits', 'quantityScale', 'unitPriceMinor', 'discountBasisPoints', 'grossMinor', 'discountMinor', 'netMinor']);
      const id = key(row.id), description = text(row.description, 4000, false, true);
      if (ids.has(id)) return invalid(); ids.add(id);
      const quantityUnits = minor(row.quantityUnits), unitPriceMinor = minor(row.unitPriceMinor), grossMinor = minor(row.grossMinor), discountMinor = minor(row.discountMinor), netMinor = minor(row.netMinor);
      if (typeof row.quantityScale !== 'number' || !Number.isInteger(row.quantityScale) || row.quantityScale < 0 || row.quantityScale > 6 || typeof row.discountBasisPoints !== 'number' || !Number.isInteger(row.discountBasisPoints) || row.discountBasisPoints < 0 || row.discountBasisPoints > 10000) return invalid();
      const source: SalesLine = { id, description, quantityUnits, quantityScale: row.quantityScale, unitPrice: money('USD', unitPriceMinor), discountBasisPoints: row.discountBasisPoints, taxTreatment: 'taxable' };
      const totals = lineTotals(source, 'USD');
      if (totals.gross.minorUnits !== grossMinor || totals.discount.minorUnits !== discountMinor || totals.net.minorUnits !== netMinor) return invalid();
      return { id, description, quantityUnits, quantityScale: row.quantityScale, unitPriceMinor, discountBasisPoints: row.discountBasisPoints, grossMinor, discountMinor, netMinor };
    });
    const subtotalMinor = minor(value.subtotalMinor), discountMinor = minor(value.discountMinor), netMinor = minor(value.netMinor);
    if (rows.reduce((sum, row) => sum + BigInt(row.grossMinor), BigInt(0)).toString() !== subtotalMinor || rows.reduce((sum, row) => sum + BigInt(row.discountMinor), BigInt(0)).toString() !== discountMinor || BigInt(subtotalMinor) - BigInt(discountMinor) !== BigInt(netMinor)) return invalid();
    let shippingAddress: CompanyAddress | null = null;
    if (value.shippingAddress !== null) { const raw = object(value.shippingAddress, ['country', 'line1', 'postalCode', 'city', 'subdivision'], ['line2']); if (raw.country !== 'CH' && raw.country !== 'US') return invalid(); shippingAddress = validateAddress(raw, raw.country); }
    const snapshot = { schemaVersion: 1, documentType: 'sales_order', organizationId, salesOrderId: key(value.salesOrderId), orderRevision, sourceErpRevision, sourceEstimateId: key(value.sourceEstimateId), sourceEstimateNumber: text(value.sourceEstimateNumber, 160), sourceEstimateRevision, currency: 'USD', paper: 'Letter', language: value.language as CompanyLanguage, number: text(value.number, 160), date, createdBy, createdAt, customerReference: value.customerReference === null ? null : text(value.customerReference, 500), status: value.status as UsSalesOrderExportSnapshot['status'], seller, customer, shippingAddress, contactName: value.contactName === null ? null : text(value.contactName, 256), paymentTermsDays, confirmation, cancellation, invoice, rows, subtotalMinor, discountMinor, netMinor, taxStatus: 'pending', notes: text(value.notes, 20_000, true, true) };
    if (JSON.stringify(snapshot).length > MAX_EXPORT_TEXT_CHARACTERS) throw new ExportError('export_too_large');
    return snapshotPrivateJson(snapshot) as UsSalesOrderExportSnapshot;
  } catch (error) { if (error instanceof ExportError) throw error; return invalid(); }
}

const addressLines = (partyValue: PrintedParty): string[] => [partyValue.name, ...formatAddress(partyValue.address), ...(partyValue.contactEmail ? [partyValue.contactEmail] : []), ...(partyValue.contactPhone ? [partyValue.contactPhone] : [])];
const amount = (s: UsSalesOrderExportSnapshot, input: string): string => formatMoney(money('USD', input), `${s.language}-US`);
function quantity(row: UsSalesOrderExportRow): string {
  const digits = row.quantityUnits.padStart(row.quantityScale + 1, '0');
  return row.quantityScale === 0 ? digits : `${digits.slice(0, -row.quantityScale)}.${digits.slice(-row.quantityScale)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function facts(s: UsSalesOrderExportSnapshot): readonly (readonly [string, string])[] {
  const c = usSalesOrderExportCopy[s.language];
  return [[c.date, formatDateOnly(s.date, `${s.language}-US`)], [c.sourceEstimate, s.sourceEstimateNumber], [c.createdBy, s.createdBy], [c.createdAt, parseInstant(s.createdAt).toISOString()], [c.termsDays, String(s.paymentTermsDays)], ...(s.customerReference ? [[c.customerReference, s.customerReference] as const] : []), ...(s.contactName ? [[c.contact, s.contactName] as const] : []), ...(s.confirmation ? [[c.internalConfirmation, `${c.confirmedBy}: ${s.confirmation.userId}`] as const, [c.confirmedAt, parseInstant(s.confirmation.at).toISOString()] as const, [c.confirmationReference, s.confirmation.reference] as const] : []), ...(s.cancellation ? [[c.cancellation, `${c.cancelledBy}: ${s.cancellation.userId}`] as const, [c.cancelledAt, parseInstant(s.cancellation.at).toISOString()] as const, [c.reason, s.cancellation.reason] as const] : []), ...(s.invoice ? [[c.relatedInvoice, s.invoice.number] as const] : [])];
}
const trace = (s: UsSalesOrderExportSnapshot): string => { const c = usSalesOrderExportCopy[s.language]; return `${c.orderRevision}: ${s.orderRevision} | ${c.sourceEstimateRevision}: ${s.sourceEstimateRevision} | ${c.sourceErpRevision}: ${s.sourceErpRevision}`; };
const esc = escapeDocumentHtml;

export function renderUsSalesOrderHtml(input: unknown): string {
  const s = validateUsSalesOrderExportSnapshot(input), c = usSalesOrderExportCopy[s.language];
  const partyBlock = (title: string, lines: readonly string[]) => `<section><h2>${esc(title)}</h2>${lines.map(line => `<p>${esc(line)}</p>`).join('')}</section>`;
  return `<!doctype html><html lang="${s.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)} - ${esc(s.number)}</title><style>@page{size:Letter;margin:.6in}*{box-sizing:border-box}body{margin:0 auto;padding:32px;max-width:980px;color:#17251e;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:28px;margin:0 0 6px}h2{font-size:13px;margin:0 0 8px}p{margin:0 0 4px}.status{font-size:13px;color:#475c50}.parties{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px;margin:28px 0}.notice{color:#475c50;font-size:12px;margin:18px 0}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px;margin:24px 0}dt{font-size:12px;color:#475c50}dd{margin:0}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{padding:10px 6px;border-bottom:1px solid #d8e1dc;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3ef;font-size:12px;text-align:left}th:first-child{width:46%}.right{text-align:right;font-variant-numeric:tabular-nums}.summary{max-width:340px;margin:24px 0 0 auto}.summary div{display:flex;justify-content:space-between;gap:20px;padding:4px 0}.summary dd{flex-shrink:0}.summary .total{border-top:1px solid #bfcfc5;margin-top:8px;padding-top:12px;font-weight:700}.pending{font-size:12px;color:#475c50;text-align:right}.notes{white-space:pre-wrap;margin:28px 0}footer{border-top:1px solid #d8e1dc;margin-top:28px;padding-top:12px;font-size:10px;color:#475c50}@media(max-width:520px){body{padding:16px}.parties,.facts{grid-template-columns:1fr;gap:16px}th,td{font-size:12px;padding:7px 3px}.summary{max-width:none}}@media print{body{padding:0}thead{display:table-header-group}tr,.summary{break-inside:avoid}}</style></head><body><h1>${esc(c.title)}</h1><p><strong>${esc(s.number)}</strong></p><p class="status">${esc(c[s.status])}</p><p class="notice">${esc(c.notice)}</p><div class="parties">${partyBlock(c.seller, addressLines(s.seller))}${partyBlock(c.customer, addressLines(s.customer))}${s.shippingAddress ? partyBlock(c.shippingAddress, formatAddress(s.shippingAddress)) : ''}</div><dl class="facts">${facts(s).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><table><thead><tr><th>${esc(c.description)}</th><th class="right">${esc(c.quantity)}</th><th class="right">${esc(c.unitPrice)}</th><th class="right">${esc(c.net)}</th></tr></thead><tbody>${s.rows.map(row => `<tr><td>${esc(row.description)}</td><td class="right">${esc(quantity(row))}</td><td class="right">${esc(amount(s, row.unitPriceMinor))}</td><td class="right">${esc(amount(s, row.netMinor))}</td></tr>`).join('')}</tbody></table><dl class="summary"><div><dt>${esc(c.subtotal)}</dt><dd>${esc(amount(s, s.subtotalMinor))}</dd></div><div><dt>${esc(c.discount)}</dt><dd>${esc(amount(s, s.discountMinor))}</dd></div><div class="total"><dt>${esc(c.netTotal)}</dt><dd>${esc(amount(s, s.netMinor))}</dd></div></dl><p class="pending">${esc(c.taxPending)}</p>${s.notes ? `<section class="notes"><h2>${esc(c.notes)}</h2>${esc(s.notes)}</section>` : ''}<footer>${esc(trace(s))}</footer></body></html>`;
}

/** CSV text is formula-neutralized; all monetary cells are exact USD decimals. */
export function renderUsSalesOrderCsv(input: unknown): string {
  const s = validateUsSalesOrderExportSnapshot(input), c = usSalesOrderExportCopy[s.language];
  const safe = (value: string) => /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const decimal = (value: string) => { const n = BigInt(value); return `${n / BigInt(100)}.${(n % BigInt(100)).toString().padStart(2, '0')}`; };
  const rows: string[][] = [[c.title, safe(s.number)], [safe(c[s.status])], [c.notice], [c.orderRevision, String(s.orderRevision)], [c.sourceEstimateRevision, String(s.sourceEstimateRevision)], [c.sourceErpRevision, String(s.sourceErpRevision)], ...addressLines(s.seller).map(value => [c.seller, safe(value)]), ...addressLines(s.customer).map(value => [c.customer, safe(value)]), ...(s.shippingAddress ? formatAddress(s.shippingAddress).map(value => [c.shippingAddress, safe(value)]) : []), ...facts(s).map(([label, value]) => [label, safe(value)]), [], [c.description, c.quantity, `${c.unitPrice} (USD)`, `${c.net} (USD)`], ...s.rows.map(row => [safe(row.description), quantity(row), decimal(row.unitPriceMinor), decimal(row.netMinor)]), [], [c.subtotal, decimal(s.subtotalMinor)], [c.discount, decimal(s.discountMinor)], [c.netTotal, decimal(s.netMinor)], [c.taxPending], ...(s.notes ? [[c.notes, safe(s.notes)]] : [])];
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

function fontBytes(input: UsExportFonts): UsExportFonts {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2) throw new ExportError('invalid_export_font');
  const copy = (key: string) => { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !(descriptor.value instanceof Uint8Array) || Object.getPrototypeOf(descriptor.value) !== Uint8Array.prototype) throw new ExportError('invalid_export_font'); const bytes = descriptor.value.slice(); if (bytes.byteLength < 1024 || bytes.byteLength > 6 * 1024 * 1024) throw new ExportError('invalid_export_font'); return bytes; };
  return { regular: copy('regular'), bold: copy('bold') };
}

/** Genuine Letter vector/text PDF using the existing licensed export font port.
 * Snapshot and font buffers are owned synchronously before any library await. */
export async function renderUsSalesOrderPdf(input: unknown, fontInput: UsExportFonts): Promise<Uint8Array> {
  const s = validateUsSalesOrderExportSnapshot(input), bytes = fontBytes(fontInput), c = usSalesOrderExportCopy[s.language];
  const [{ PDFDocument, rgb }, fontkit] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let regular: PDFFont, bold: PDFFont;
  try { pdf.registerFontkit(fontkit.default); regular = await pdf.embedFont(bytes.regular, { subset: true }); bold = await pdf.embedFont(bytes.bold, { subset: true }); } catch { throw new ExportError('invalid_export_font'); }
  const regularGlyphs = new Set(regular.getCharacterSet()), boldGlyphs = new Set(bold.getCharacterSet());
  const displayedRows = s.rows.map(row => [row.description, quantity(row), amount(s, row.unitPriceMinor), amount(s, row.netMinor)]);
  const allText = [c.title, s.number, c[s.status], c.notice, ...addressLines(s.seller), ...addressLines(s.customer), ...(s.shippingAddress ? formatAddress(s.shippingAddress) : []), ...facts(s).flat(), ...displayedRows.flat(), c.description, c.quantity, c.unitPrice, c.net, c.seller, c.customer, c.shippingAddress, c.subtotal, c.discount, c.netTotal, amount(s, s.subtotalMinor), amount(s, s.discountMinor), amount(s, s.netMinor), c.taxPending, c.notes, s.notes, trace(s), c.page, c.of];
  for (const value of allText) for (const character of value) { if ('\r\n\t'.includes(character)) continue; const point = character.codePointAt(0)!; if (!regularGlyphs.has(point) || !boldGlyphs.has(point)) throw new ExportError('unsupported_export_glyph'); }
  const margin = 42, pageWidth = 612, pageHeight = 792, width = pageWidth - margin * 2, bottom = 62;
  const ink = rgb(.09, .15, .11), muted = rgb(.28, .36, .31), rule = rgb(.82, .87, .84), tint = rgb(.93, .96, .94);
  let page!: PDFPage, y = 750;
  function newPage() { if (pdf.getPageCount() >= MAX_EXPORT_PDF_PAGES) throw new ExportError('export_too_large'); page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
  function wrap(raw: string, font: PDFFont, size: number, available: number): string[] {
    const lines: string[] = [];
    for (const paragraph of raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let current = '';
      for (const token of paragraph.split(/(\s+)/u)) {
        if (!token) continue;
        if (font.widthOfTextAtSize(current + token, size) <= available) { current += token; continue; }
        if (current) { lines.push(current.trimEnd()); current = ''; }
        for (const character of token.trimStart()) {
          if (font.widthOfTextAtSize(character, size) > available) throw new ExportError('export_too_large');
          if (current && font.widthOfTextAtSize(current + character, size) > available) { lines.push(current); current = ''; }
          current += character;
        }
      }
      if (current) lines.push(current.trimEnd());
    }
    return lines.length ? lines : [''];
  }
  function draw(raw: string, size = 10, strong = false, color = ink) {
    const font = strong ? bold : regular, leading = size * 1.45;
    for (const value of wrap(raw, font, size, width)) { if (y - leading < bottom) newPage(); page.drawText(value, { x: margin, y: y - size, size, font, color }); y -= leading; }
  }
  function partyBlock(label: string, lines: readonly string[]) { draw(label, 9, true); for (const value of lines) draw(value); y -= 12; }
  newPage();
  draw(c.title, 24, true); draw(s.number, 12, true); draw(c[s.status], 9, false, muted); y -= 12;
  draw(c.notice, 9, false, muted); y -= 18;
  const parties = [[c.seller, addressLines(s.seller)], [c.customer, addressLines(s.customer)]] as const;
  const partyWidth = (width - 24) / 2;
  const blocks = parties.map(([label, lines]) => [label, ...lines].map((value, index) => ({ strong: index === 0, size: index === 0 ? 9 : 10, lines: wrap(value, index === 0 ? bold : regular, index === 0 ? 9 : 10, partyWidth) })));
  const partyHeight = Math.max(...blocks.map(block => block.reduce((height, row) => height + row.lines.length * row.size * 1.45, 0)));
  if (partyHeight > pageHeight - margin - bottom) { for (const [label, lines] of parties) partyBlock(label, lines); }
  else { if (y - partyHeight < bottom) newPage(); const top = y; blocks.forEach((block, index) => { let baseline = top; for (const row of block) for (const value of row.lines) { page.drawText(value, { x: margin + index * (partyWidth + 24), y: baseline - row.size, size: row.size, font: row.strong ? bold : regular, color: ink }); baseline -= row.size * 1.45; } }); y = top - partyHeight - 18; }
  if (s.shippingAddress) partyBlock(c.shippingAddress, formatAddress(s.shippingAddress));
  for (const [label, value] of facts(s)) draw(`${label}: ${value}`, 9); y -= 18;
  const widths = [width * .46, width * .12, width * .21, width * .21], headers = [c.description, c.quantity, c.unitPrice, c.net], size = 9, leading = 13.5;
  const wrappedHeaders = headers.map((value, index) => wrap(value, bold, size, widths[index] - 12));
  const headerHeight = Math.max(...wrappedHeaders.map(lines => lines.length)) * leading + 12;
  function tableHeader() {
    if (y - headerHeight - leading - 12 < bottom) { newPage(); draw(c.title, 12, true); y -= 12; }
    page.drawRectangle({ x: margin, y: y - headerHeight, width, height: headerHeight, color: tint });
    let x = margin; wrappedHeaders.forEach((lines, index) => { lines.forEach((value, row) => { const measured = bold.widthOfTextAtSize(value, size); page.drawText(value, { x: index > 0 ? x + widths[index] - 6 - measured : x + 6, y: y - 6 - size - row * leading, size, font: bold, color: ink }); }); x += widths[index]; }); y -= headerHeight;
  }
  tableHeader();
  for (const row of displayedRows) {
    const cells = row.map((value, index) => wrap(value, regular, size, widths[index] - 12)), count = Math.max(...cells.map(lines => lines.length));
    let offset = 0;
    while (offset < count) {
      let available = Math.floor((y - bottom - 12) / leading);
      if (available < 1) { newPage(); draw(c.title, 12, true); y -= 12; tableHeader(); available = Math.floor((y - bottom - 12) / leading); }
      const chunk = Math.min(available, count - offset); let x = margin;
      cells.forEach((lines, index) => { for (let n = 0; n < chunk; n++) { const value = lines[offset + n]; if (value === undefined) continue; const measured = regular.widthOfTextAtSize(value, size); page.drawText(value, { x: index > 0 ? x + widths[index] - 6 - measured : x + 6, y: y - 6 - size - n * leading, size, font: regular, color: ink }); } x += widths[index]; });
      y -= chunk * leading + 12; page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: .5, color: rule }); offset += chunk;
    }
  }
  const totals = [[c.subtotal, amount(s, s.subtotalMinor)], [c.discount, amount(s, s.discountMinor)], [c.netTotal, amount(s, s.netMinor)]];
  const summaryLines = totals.map(([label, value]) => wrap(`${label}: ${value}`, bold, 11, width));
  const summaryHeight = summaryLines.reduce((sum, lines) => sum + lines.length * 16, 0) + wrap(c.taxPending, regular, 9, width).length * 13 + 24;
  if (y - summaryHeight < bottom) newPage(); y -= 18;
  for (const [label, value] of totals) draw(`${label}: ${value}`, 11, true);
  draw(c.taxPending, 9, false, muted);
  if (s.notes) { const firstLines = Math.min(wrap(s.notes, regular, 10, width).length, 3); if (y - 18 - (firstLines + 1) * 14.5 < bottom) newPage(); y -= 18; draw(c.notes, 10, true); draw(s.notes); }
  pdf.getPages().forEach((sheet, index) => {
    sheet.drawLine({ start: { x: margin, y: 49 }, end: { x: pageWidth - margin, y: 49 }, thickness: .5, color: rule });
    const footer = `${trace(s)} | ${c.page} ${index + 1} ${c.of} ${pdf.getPageCount()}`, lines = wrap(footer, regular, 7, width);
    if (lines.length > 3) throw new ExportError('export_too_large');
    lines.forEach((value, row) => sheet.drawText(value, { x: margin, y: 36 - row * 9, size: 7, font: regular, color: muted }));
  });
  return pdf.save({ useObjectStreams: false });
}
