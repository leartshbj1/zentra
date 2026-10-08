import {
  countryConfiguration,
  validateCompanyConfiguration,
} from './country-config';
import { validateAddress } from './addresses';
import { formatDateOnly } from './localization';
import { addMoney, formatMoney, money } from './money';
import { validDate, minorInteger, LedgerError } from './accounting/ledger';
import {
  buildTaxRequest,
  estimateTotals,
  invoiceBalance,
  lineTotals,
  validateEstimate,
  validateHistoricalTaxAssessment,
  validatePublicSellerSnapshot,
  type Contact,
  type Estimate,
  type IssuedInvoice,
  type SalesLine,
  type TaxAssessment,
  type PublicSellerSnapshot,
} from './invoicing';
import type {
  CompanyAddress,
  CompanyConfiguration,
  CompanyLanguage,
  CountryCode,
  Currency,
  Money,
} from './types';

export type DocumentType = 'estimate' | 'invoice' | 'credit_memo';
export type DocumentErrorCode =
  | 'invalid_document'
  | 'scope_mismatch'
  | 'currency_mismatch'
  | 'tax_mismatch'
  | 'idempotency_conflict'
  | 'numbering_conflict'
  | 'invalid_store_record';
export class DocumentContractError extends Error {
  constructor(public readonly code: DocumentErrorCode) {
    super(code);
    this.name = 'DocumentContractError';
  }
}
/** Whitelisted public details supplied by an authorized company loader. No credentials or tax IDs. */
export type PublicSellerDetails = PublicSellerSnapshot;
/** Projection input only. Issuing/posting a credit requires a separate authorized, persisted business operation. */
export interface CreditMemoDocument {
  readonly id: string;
  readonly organizationId: string;
  readonly revision: number;
  readonly currency: Currency;
  readonly number: string;
  readonly referencedInvoiceId: string;
  readonly referencedInvoiceNumber: string;
  readonly date: string;
  readonly customer: Contact;
  readonly lines: readonly SalesLine[];
  readonly notes: string;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly taxAssessment: TaxAssessment;
  readonly issuedAt: string;
}
export type PrintableDocumentInput =
  | { readonly type: 'estimate'; readonly document: Estimate }
  | { readonly type: 'invoice'; readonly document: IssuedInvoice }
  | { readonly type: 'credit_memo'; readonly document: CreditMemoDocument };
export interface PrintedParty {
  readonly name: string;
  readonly address: CompanyAddress;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
}
export interface PrintableDocumentSnapshot {
  readonly type: DocumentType;
  readonly country: CountryCode;
  readonly currency: Currency;
  readonly language: CompanyLanguage;
  readonly paper: 'A4' | 'Letter';
  readonly number: string;
  readonly date: string;
  readonly dueDate: string | null;
  readonly expiresAt: string | null;
  readonly referencedInvoiceNumber: string | null;
  readonly seller: PrintedParty;
  readonly customer: PrintedParty;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: Money;
    readonly net: Money;
  }[];
  readonly notes: string;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money | null;
  readonly total: Money;
  readonly balance: Money | null;
  readonly termsDays: number | null;
}

const types: readonly DocumentType[] = ['estimate', 'invoice', 'credit_memo'];
const fail = (code: DocumentErrorCode): never => {
  throw new DocumentContractError(code);
};
const key = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function publicText(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    value.includes('\0')
  )
    return fail('invalid_document');
  return value;
}
function exactMoney(value: Money, currency: Currency): Money {
  if (!value || value.currency !== currency) return fail('currency_mismatch');
  minorInteger(value.minorUnits);
  return money(currency, value.minorUnits);
}
function equalAmount(actual: Money, expected: Money): void {
  if (
    actual.currency !== expected.currency ||
    actual.minorUnits !== expected.minorUnits
  )
    return fail('tax_mismatch');
}
function party(
  name: string,
  address: CompanyAddress,
  contact?: Pick<PublicSellerDetails, 'contactEmail' | 'contactPhone'>,
): PrintedParty {
  return Object.freeze({
    name: publicText(name, 256),
    address: validateAddress(address, address.country),
    ...(contact?.contactEmail === undefined
      ? {}
      : { contactEmail: publicText(contact.contactEmail, 256) }),
    ...(contact?.contactPhone === undefined
      ? {}
      : { contactPhone: publicText(contact.contactPhone, 80) }),
  });
}
function quantity(line: SalesLine): string {
  const units = minorInteger(line.quantityUnits),
    scale = BigInt(10) ** BigInt(line.quantityScale);
  const fraction = (units % scale)
    .toString()
    .padStart(line.quantityScale, '0')
    .replace(/0+$/, '');
  return (units / scale).toString() + (fraction ? `.${fraction}` : '');
}
function invoiceEstimate(document: IssuedInvoice): Estimate {
  return {
    id: document.sourceEstimateId,
    organizationId: document.organizationId,
    revision: document.sourceEstimateRevision,
    currency: document.currency,
    number: document.number,
    customer: document.customer,
    projectId: document.projectId,
    date: document.date,
    expiresAt: document.date,
    paymentTermsDays: 0,
    lines: document.lines,
    notes: document.notes,
    status: 'accepted',
  };
}
function creditEstimate(document: CreditMemoDocument): Estimate {
  return {
    id: document.id,
    organizationId: document.organizationId,
    revision: document.revision,
    currency: document.currency,
    number: document.number,
    customer: document.customer,
    date: document.date,
    expiresAt: document.date,
    paymentTermsDays: 0,
    lines: document.lines,
    notes: document.notes,
    status: 'accepted',
  };
}

/** Safe print projection. It grants neither read permission, invoice issuance nor payment authority. */
export function buildPrintableDocument(
  configuration: CompanyConfiguration,
  seller: PublicSellerDetails,
  input: PrintableDocumentInput,
  options: { readonly paper?: 'A4' | 'Letter' } = {},
): PrintableDocumentSnapshot {
  const currentCompany = validateCompanyConfiguration(configuration),
    document = input.document;
  if (
    !types.includes(input.type) ||
    document.organizationId !== currentCompany.organizationId ||
    seller.organizationId !== currentCompany.organizationId ||
    document.customer.organizationId !== currentCompany.organizationId
  )
    return fail('scope_mismatch');
  if (document.currency !== currentCompany.currency)
    return fail('currency_mismatch');
  // Issued invoices use their historical identity. Current seller data is only used for unissued estimates/credit projections.
  let documentSeller = seller;
  if (input.type === 'invoice') {
    try {
      documentSeller = validatePublicSellerSnapshot(input.document.sellerSnapshot, currentCompany.organizationId);
    } catch (error) {
      return fail(error instanceof LedgerError && error.message === 'TENANT_MISMATCH' ? 'scope_mismatch' : 'invalid_document');
    }
  }
  // Invoice context was frozen at issuance. Current preferences cannot rewrite its tax identity or printed address.
  const company =
    input.type === 'invoice'
      ? validateCompanyConfiguration(input.document.companyConfiguration)
      : currentCompany;
  if (
    company.organizationId !== currentCompany.organizationId ||
    company.country !== currentCompany.country
  )
    return fail('scope_mismatch');
  if (company.currency !== currentCompany.currency)
    return fail('currency_mismatch');
  const paper = options.paper ?? (company.country === 'US' ? 'Letter' : 'A4');
  if (paper !== 'A4' && paper !== 'Letter') return fail('invalid_document');
  publicText(document.id, 160);
  publicText(document.number, 160);
  if (!validDate(document.date)) return fail('invalid_document');
  const estimate =
    input.type === 'estimate'
      ? input.document
      : input.type === 'invoice'
        ? invoiceEstimate(input.document)
        : creditEstimate(input.document);
  validateEstimate(company, estimate);
  const calculated = estimateTotals(estimate);
  let tax: Money | null = null,
    total = calculated.net,
    balance: Money | null = null;
  let dueDate: string | null = null,
    expiresAt: string | null = null,
    referencedInvoiceNumber: string | null = null,
    termsDays: number | null = null;
  if (input.type === 'estimate') {
    expiresAt = input.document.expiresAt;
    termsDays = input.document.paymentTermsDays;
  } else {
    const issued = input.document;
    if (company.taxConfiguration.status !== 'configured')
      return fail('tax_mismatch');
    // Historical print uses issuance time; rendering a valid old invoice does not renew a tax decision.
    tax = validateHistoricalTaxAssessment(
      buildTaxRequest(company, estimate, document.date),
      issued.taxAssessment,
      issued.issuedAt,
    );
    equalAmount(
      exactMoney(issued.subtotal, company.currency),
      calculated.subtotal,
    );
    equalAmount(
      exactMoney(issued.discount, company.currency),
      calculated.discount,
    );
    equalAmount(exactMoney(issued.tax, company.currency), tax);
    total = addMoney(calculated.net, tax);
    equalAmount(exactMoney(issued.total, company.currency), total);
    if (input.type === 'invoice') {
      const invoice = input.document;
      if (
        !validDate(invoice.dueDate) ||
        invoice.dueDate < invoice.date ||
        !Array.isArray(invoice.payments)
      )
        return fail('invalid_document');
      const ids = new Set<string>(),
        requests = new Set<string>();
      for (const payment of invoice.payments) {
        if (
          payment.organizationId !== company.organizationId ||
          payment.invoiceId !== invoice.id
        )
          return fail('scope_mismatch');
        publicText(payment.id, 160);
        publicText(payment.idempotencyKey, 240);
        if (
          ids.has(payment.id) ||
          requests.has(payment.idempotencyKey) ||
          minorInteger(
            exactMoney(payment.amount, company.currency).minorUnits,
          ) <= BigInt(0)
        )
          return fail('invalid_document');
        ids.add(payment.id);
        requests.add(payment.idempotencyKey);
      }
      balance = invoiceBalance(invoice);
      if (BigInt(balance.minorUnits) < BigInt(0))
        return fail('invalid_document');
      dueDate = invoice.dueDate;
      termsDays =
        (Date.parse(`${invoice.dueDate}T00:00:00Z`) -
          Date.parse(`${invoice.date}T00:00:00Z`)) /
        86_400_000;
    } else {
      publicText(input.document.referencedInvoiceId, 160);
      referencedInvoiceNumber = publicText(
        input.document.referencedInvoiceNumber,
        160,
      );
    }
  }
  const lines = Object.freeze(
    document.lines.map((line) =>
      Object.freeze({
        description: publicText(line.description, 4000),
        quantity: quantity(line),
        unitPrice: exactMoney(line.unitPrice, company.currency),
        net: lineTotals(line, company.currency).net,
      }),
    ),
  );
  return Object.freeze({
    type: input.type,
    country: company.country,
    currency: company.currency,
    language: company.language,
    paper,
    number: document.number,
    date: document.date,
    dueDate,
    expiresAt,
    referencedInvoiceNumber,
    seller: party(documentSeller.displayName, company.address, documentSeller),
    customer: party(document.customer.name, document.customer.billingAddress),
    lines,
    notes: publicText(document.notes, 20_000, true),
    subtotal: calculated.subtotal,
    discount: calculated.discount,
    tax,
    total,
    balance,
    termsDays,
  });
}

const labels = {
  en: {
    estimate: 'Estimate',
    invoice: 'Invoice',
    credit_memo: 'Credit memo',
    to: 'Bill to',
    date: 'Date',
    due: 'Due date',
    expires: 'Valid until',
    reference: 'Referenced invoice',
    description: 'Description',
    quantity: 'Qty',
    unit: 'Unit price',
    amount: 'Amount',
    subtotal: 'Subtotal',
    discount: 'Discount',
    total: 'Total',
    credit: 'Credit total',
    balance: 'Balance due',
    taxPending: 'Tax not determined',
    estimateTotal: 'Estimated subtotal',
    notes: 'Notes',
    terms: 'Payment terms',
    dueNow: 'Due on receipt',
    creditTerms: 'Credit for the referenced invoice',
    madeWith: 'Prepared with Zentra',
  },
  fr: {
    estimate: 'Devis',
    invoice: 'Facture',
    credit_memo: 'Avoir',
    to: 'Destinataire',
    date: 'Date',
    due: 'Échéance',
    expires: 'Valable jusqu’au',
    reference: 'Facture de référence',
    description: 'Description',
    quantity: 'Qté',
    unit: 'Prix unitaire',
    amount: 'Montant',
    subtotal: 'Sous-total',
    discount: 'Remise',
    total: 'Total',
    credit: 'Total de l’avoir',
    balance: 'Solde à payer',
    taxPending: 'Taxe non déterminée',
    estimateTotal: 'Sous-total estimé',
    notes: 'Notes',
    terms: 'Conditions de paiement',
    dueNow: 'Payable à réception',
    creditTerms: 'Crédit pour la facture de référence',
    madeWith: 'Préparé avec Zentra',
  },
  de: {
    estimate: 'Offerte',
    invoice: 'Rechnung',
    credit_memo: 'Gutschrift',
    to: 'Empfänger',
    date: 'Datum',
    due: 'Fällig am',
    expires: 'Gültig bis',
    reference: 'Referenzrechnung',
    description: 'Beschreibung',
    quantity: 'Menge',
    unit: 'Einzelpreis',
    amount: 'Betrag',
    subtotal: 'Zwischensumme',
    discount: 'Rabatt',
    total: 'Gesamt',
    credit: 'Gutschrift gesamt',
    balance: 'Offener Betrag',
    taxPending: 'Steuer noch nicht bestimmt',
    estimateTotal: 'Geschätzte Zwischensumme',
    notes: 'Notizen',
    terms: 'Zahlungsbedingungen',
    dueNow: 'Bei Erhalt fällig',
    creditTerms: 'Gutschrift für die Referenzrechnung',
    madeWith: 'Erstellt mit Zentra',
  },
  it: {
    estimate: 'Preventivo',
    invoice: 'Fattura',
    credit_memo: 'Nota di credito',
    to: 'Destinatario',
    date: 'Data',
    due: 'Scadenza',
    expires: 'Valido fino al',
    reference: 'Fattura di riferimento',
    description: 'Descrizione',
    quantity: 'Qtà',
    unit: 'Prezzo unitario',
    amount: 'Importo',
    subtotal: 'Subtotale',
    discount: 'Sconto',
    total: 'Totale',
    credit: 'Totale credito',
    balance: 'Saldo dovuto',
    taxPending: 'Imposta non determinata',
    estimateTotal: 'Subtotale stimato',
    notes: 'Note',
    terms: 'Condizioni di pagamento',
    dueNow: 'Pagabile al ricevimento',
    creditTerms: 'Credito per la fattura di riferimento',
    madeWith: 'Preparato con Zentra',
  },
} satisfies Record<CompanyLanguage, Record<string, string>>;
/** Every dynamic value is text, never markup, URL, CSS or JavaScript. */
export function escapeDocumentHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}

/** Standalone offline HTML. Use the browser's Print / Save as PDF; no script or remote assets. */
export function renderPrintableDocumentHtml(
  snapshot: PrintableDocumentSnapshot,
): string {
  if (
    !types.includes(snapshot.type) ||
    !['fr', 'de', 'it', 'en'].includes(snapshot.language) ||
    !['A4', 'Letter'].includes(snapshot.paper) ||
    snapshot.currency !== (snapshot.country === 'US' ? 'USD' : 'CHF')
  )
    return fail('invalid_document');
  const e = escapeDocumentHtml,
    copy = labels[snapshot.language],
    locale = countryConfiguration(snapshot.country).locales[snapshot.language];
  const amount = (value: Money) => e(formatMoney(value, locale));
  const date = (value: string) => e(formatDateOnly(value, locale));
  const address = (value: CompanyAddress) =>
    [
      value.line1,
      value.line2,
      value.country === 'US'
        ? `${value.city}, ${value.subdivision} ${value.postalCode}`
        : `${value.postalCode} ${value.city}`,
      ...(value.country === 'CH' ? [value.subdivision] : []),
      value.country,
    ]
      .filter((line): line is string => typeof line === 'string' && !!line)
      .map(e)
      .join('<br>');
  const taxLabel =
    snapshot.country === 'US'
      ? 'Sales tax'
      : snapshot.language === 'de'
        ? 'MWST'
        : snapshot.language === 'it'
          ? 'IVA'
          : snapshot.language === 'en'
            ? 'VAT'
            : 'TVA';
  const terms =
    snapshot.type === 'credit_memo'
      ? copy.creditTerms
      : snapshot.termsDays === 0
        ? copy.dueNow
        : `Net ${snapshot.termsDays}`;
  return `<!doctype html><html lang="${e(snapshot.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>${e(copy[snapshot.type])} ${e(snapshot.number)}</title><style>
@page{size:${snapshot.paper};margin:18mm}*{box-sizing:border-box}body{margin:0;color:#172d26;background:white;font:11pt Arial,sans-serif;line-height:1.45}
article{max-width:190mm;margin:auto}header{display:flex;justify-content:space-between;gap:20mm;align-items:flex-start;border-bottom:2px solid #235c45;padding-bottom:8mm;margin-bottom:9mm}
h1{font-size:28pt;line-height:1.1;letter-spacing:-1px;margin:0 0 3mm}h2{font-size:10pt;text-transform:uppercase;letter-spacing:1px;margin:0 0 3mm;color:#466453}.seller{font-weight:bold;font-size:14pt}.muted{color:#4a6258}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:16mm;margin-bottom:9mm}.meta{text-align:right}.meta p{margin:0 0 2mm}.number{font-weight:bold;font-size:13pt}.party{overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;table-layout:fixed}thead{display:table-header-group}th{text-align:left;background:#edf4ef;padding:3mm 2mm;font-size:9pt;color:#315041}td{padding:4mm 2mm;vertical-align:top;border-bottom:1px solid #dbe5de;overflow-wrap:anywhere}
th:first-child{width:49%}th:nth-child(2){width:11%}th:nth-child(3){width:20%}th:nth-child(4){width:20%}.numeric{text-align:right;font-variant-numeric:tabular-nums}.description,.notes{white-space:pre-line}
tr{break-inside:avoid}.summary{width:76mm;margin:7mm 0 0 auto;break-inside:avoid}.summary div{display:flex;justify-content:space-between;gap:5mm;padding:1.5mm 0}.summary .total{font-weight:bold;font-size:14pt;border-top:1px solid #b3c9bc;margin-top:2mm;padding-top:3mm}
.bottom{margin-top:9mm;border-top:1px solid #dbe5de;padding-top:5mm}.notes{overflow-wrap:anywhere}footer{font-size:8pt;color:#466453;margin-top:6mm;text-align:right}@media screen{body{background:#eff3f0;padding:20px}article{background:white;padding:18mm;max-width:${snapshot.paper === 'Letter' ? '216mm' : '210mm'};box-shadow:0 5px 28px #17342614}}
@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}article{max-width:none}.bottom{break-inside:avoid}}
</style></head><body><article><header><div><h1>${e(copy[snapshot.type])}</h1><div class="number">${e(snapshot.number)}</div><div class="muted">${e(snapshot.currency)}</div></div><div class="meta"><p>${e(copy.date)}: ${date(snapshot.date)}</p>${snapshot.dueDate ? `<p>${e(copy.due)}: ${date(snapshot.dueDate)}</p>` : ''}${snapshot.expiresAt ? `<p>${e(copy.expires)}: ${date(snapshot.expiresAt)}</p>` : ''}${snapshot.referencedInvoiceNumber ? `<p>${e(copy.reference)}: ${e(snapshot.referencedInvoiceNumber)}</p>` : ''}</div></header>
<section class="parties"><div class="party"><div class="seller">${e(snapshot.seller.name)}</div>${address(snapshot.seller.address)}${snapshot.seller.contactEmail ? `<br>${e(snapshot.seller.contactEmail)}` : ''}${snapshot.seller.contactPhone ? `<br>${e(snapshot.seller.contactPhone)}` : ''}</div><div class="party"><h2>${e(copy.to)}</h2><strong>${e(snapshot.customer.name)}</strong><br>${address(snapshot.customer.address)}</div></section>
<table><thead><tr><th>${e(copy.description)}</th><th class="numeric">${e(copy.quantity)}</th><th class="numeric">${e(copy.unit)}</th><th class="numeric">${e(copy.amount)}</th></tr></thead><tbody>${snapshot.lines.map((line) => `<tr><td class="description">${e(line.description)}</td><td class="numeric">${e(line.quantity)}</td><td class="numeric">${amount(line.unitPrice)}</td><td class="numeric">${amount(line.net)}</td></tr>`).join('')}</tbody></table>
<section class="summary"><div><span>${e(copy.subtotal)}</span><span>${amount(snapshot.subtotal)}</span></div>${BigInt(snapshot.discount.minorUnits) > BigInt(0) ? `<div><span>${e(copy.discount)}</span><span>-${amount(snapshot.discount)}</span></div>` : ''}<div><span>${e(taxLabel)}</span><span>${snapshot.tax ? amount(snapshot.tax) : e(copy.taxPending)}</span></div><div class="total"><span>${e(snapshot.type === 'estimate' ? copy.estimateTotal : snapshot.type === 'credit_memo' ? copy.credit : copy.total)}</span><span>${amount(snapshot.total)}</span></div>${snapshot.balance ? `<div><span>${e(copy.balance)}</span><span>${amount(snapshot.balance)}</span></div>` : ''}</section>
<section class="bottom"><h2>${e(copy.terms)}</h2><p>${e(terms)}</p>${snapshot.notes ? `<h2>${e(copy.notes)}</h2><div class="notes">${e(snapshot.notes)}</div>` : ''}</section><footer>${e(copy.madeWith)}</footer></article></body></html>`;
}

export interface NumberCounter {
  readonly organizationId: string;
  readonly documentType: DocumentType;
  readonly revision: number;
  readonly nextSequence: string;
}
export interface NumberReservation {
  readonly organizationId: string;
  readonly documentType: DocumentType;
  readonly documentId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly sequence: string;
  readonly number: string;
  readonly conversion: {
    readonly estimateId: string;
    readonly revision: number;
  } | null;
}
export interface DocumentNumberingStore {
  readCounter(
    organizationId: string,
    documentType: DocumentType,
  ): Promise<NumberCounter | null>;
  readReservation(
    organizationId: string,
    documentType: DocumentType,
    idempotencyKey: string,
  ): Promise<NumberReservation | null>;
  readConversion(
    organizationId: string,
    estimateId: string,
    revision: number,
  ): Promise<NumberReservation | null>;
  /** One persistent transaction: CAS counter + unique request + unique (org,sourceEstimate,revision), or no writes. */
  compareAndSwap(input: {
    readonly expectedRevision: number | null;
    readonly counter: NumberCounter;
    readonly reservation: NumberReservation;
  }): Promise<NumberReservation | null>;
}
export interface NumberReservationRequest {
  readonly documentType: DocumentType;
  readonly documentId: string;
  readonly idempotencyKey: string;
  /** Hash of the authorized frozen business document; not an authentication credential. */
  readonly documentFingerprint: string;
  readonly conversion?: {
    readonly estimateId: string;
    readonly revision: number;
  };
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function validateReservation(
  row: NumberReservation,
  company: CompanyConfiguration,
  request: NumberReservationRequest,
  expectedFingerprint: string,
  conversionWinner = false,
): NumberReservation {
  if (
    row.organizationId !== company.organizationId ||
    row.documentType !== request.documentType ||
    !key(row.documentId) ||
    !key(row.idempotencyKey) ||
    !/^[1-9][0-9]{0,29}$/.test(row.sequence) ||
    typeof row.number !== 'string' ||
    row.number.length > 100 ||
    row.conversion?.estimateId !== request.conversion?.estimateId ||
    row.conversion?.revision !== request.conversion?.revision
  )
    return fail('invalid_store_record');
  if (
    row.fingerprint !== expectedFingerprint ||
    (!conversionWinner &&
      (row.idempotencyKey !== request.idempotencyKey ||
        row.documentId !== request.documentId))
  )
    return fail('idempotency_conflict');
  const code =
    request.documentType === 'estimate'
      ? 'EST'
      : request.documentType === 'invoice'
        ? 'INV'
        : 'CM';
  if (
    row.number !==
    `${company.invoiceNumberPrefix}-${code}-${row.sequence.padStart(6, '0')}`
  )
    return fail('invalid_store_record');
  return Object.freeze({
    ...row,
    conversion: row.conversion ? Object.freeze({ ...row.conversion }) : null,
  });
}

/** Org/type counter only; never recycles a reserved number or releases it because of a timeout. */
export async function reserveDocumentNumber(
  configuration: CompanyConfiguration,
  submitted: NumberReservationRequest,
  store: DocumentNumberingStore,
): Promise<NumberReservation> {
  const company = validateCompanyConfiguration(configuration);
  const request = Object.freeze({
    ...submitted,
    conversion: submitted.conversion
      ? Object.freeze({ ...submitted.conversion })
      : undefined,
  });
  if (
    !types.includes(request.documentType) ||
    !key(request.documentId) ||
    !key(request.idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(request.documentFingerprint) ||
    (request.conversion &&
      (request.documentType !== 'invoice' ||
        !key(request.conversion.estimateId) ||
        !Number.isSafeInteger(request.conversion.revision) ||
        request.conversion.revision < 1))
  )
    return fail('invalid_document');
  const identity = await fingerprint([
    company.organizationId,
    company.country,
    company.currency,
    company.invoiceNumberPrefix,
    request.documentType,
    request.documentFingerprint,
    request.conversion?.estimateId ?? null,
    request.conversion?.revision ?? null,
  ]);
  for (let attempt = 0; attempt < 16; attempt++) {
    const previous = await store.readReservation(
      company.organizationId,
      request.documentType,
      request.idempotencyKey,
    );
    if (previous)
      return validateReservation(previous, company, request, identity);
    if (request.conversion) {
      const converted = await store.readConversion(
        company.organizationId,
        request.conversion.estimateId,
        request.conversion.revision,
      );
      if (converted)
        return validateReservation(converted, company, request, identity, true);
    }
    const old = await store.readCounter(
      company.organizationId,
      request.documentType,
    );
    if (
      old &&
      (old.organizationId !== company.organizationId ||
        old.documentType !== request.documentType ||
        !Number.isSafeInteger(old.revision) ||
        old.revision < 0 ||
        old.revision >= Number.MAX_SAFE_INTEGER ||
        !/^[1-9][0-9]{0,29}$/.test(old.nextSequence))
    )
      return fail('invalid_store_record');
    const sequence = old?.nextSequence ?? '1',
      next = (BigInt(sequence) + BigInt(1)).toString();
    if (next.length > 30) return fail('numbering_conflict');
    const code =
      request.documentType === 'estimate'
        ? 'EST'
        : request.documentType === 'invoice'
          ? 'INV'
          : 'CM';
    const reservation: NumberReservation = Object.freeze({
      organizationId: company.organizationId,
      documentType: request.documentType,
      documentId: request.documentId,
      idempotencyKey: request.idempotencyKey,
      fingerprint: identity,
      sequence,
      number: `${company.invoiceNumberPrefix}-${code}-${sequence.padStart(6, '0')}`,
      conversion: request.conversion
        ? Object.freeze({ ...request.conversion })
        : null,
    });
    const committed = await store.compareAndSwap({
      expectedRevision: old?.revision ?? null,
      counter: {
        organizationId: company.organizationId,
        documentType: request.documentType,
        revision: (old?.revision ?? 0) + 1,
        nextSequence: next,
      },
      reservation,
    });
    if (committed)
      return validateReservation(committed, company, request, identity);
  }
  // High contention needs an explicit retry with the SAME request, not a new identity or global fallback.
  return fail('numbering_conflict');
}
