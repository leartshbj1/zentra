import type { AutopilotCustomer } from './autopilotQuote';
import type { InboxItem } from './openApi';
import type { CatalogItem, DocumentLine, Invoice, SalesOrderFulfillmentMode } from './types';

/**
 * Boîte d'entrée du lot 5 : commandes Shopify et WooCommerce, brouillons
 * déposés par l'API ou MCP. Les montants de boutique sont repris tels quels
 * (le client les a payés) et ramenés hors taxe par la règle de l'app ; pour
 * l'API, le catalogue de l'entreprise fait foi. Rien n'est créé sans clic.
 */

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const int = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : 0);
const optionalInt = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

export type DraftParty = Readonly<{ id: string | null; name: string; company: string; email: string; phone: string; addressLine1: string; postalCode: string; city: string; country: string }>;

export function partyFrom(value: unknown): DraftParty {
  const party = record(value);
  return {
    id: text(party.id) || null, name: text(party.name), company: text(party.company), email: text(party.email).toLowerCase(), phone: text(party.phone),
    addressLine1: text(party.addressLine1), postalCode: text(party.postalCode), city: text(party.city), country: text(party.country),
  };
}

/** Coordonnées dans la forme des clients préparés par Autopilote. */
export function partyCustomer(party: DraftParty): AutopilotCustomer {
  return { name: party.name || undefined, company: party.company || undefined, email: party.email || undefined, phone: party.phone || undefined,
    street: party.addressLine1 || undefined, postcode: party.postalCode || undefined, city: party.city || undefined };
}

export type OrderLineDraft = Readonly<{
  catalogItemId: string | null; position: number; description: string; quantityMilli: number; unit: string;
  unitPriceCents: number; discountBp: number; vatBp: number; fulfillmentMode: SalesOrderFulfillmentMode;
}>;

const fulfillment = (article: CatalogItem | undefined): SalesOrderFulfillmentMode =>
  !article ? 'direct' : article.trackStock ? 'stocked_delivery' : article.kind === 'service' ? 'direct' : 'untracked_delivery';

/** Prix hors taxe d'un prix TTC, arrondi au centime. */
export const netFromGross = (gross: number, vatBp: number) => Math.round((gross * 10_000) / (10_000 + vatBp));

const findArticle = (catalog: readonly CatalogItem[], id: string, sku: string) => {
  const active = catalog.filter((item) => !item.archivedAt);
  return (id && active.find((item) => item.id === id)) || (sku ? active.find((item) => (item.sku ?? '').trim().toLowerCase() === sku.toLowerCase()) : undefined);
};

/** Lignes d'une commande de boutique. Une remise de la boutique devient une remise de ligne. */
export function shopOrderLines(payload: Raw, catalog: readonly CatalogItem[], defaultVatBp: number): OrderLineDraft[] {
  const includesTax = payload.pricesIncludeTax === true;
  const lines = (Array.isArray(payload.lines) ? payload.lines : []).map(record).map((line, position): OrderLineDraft => {
    const article = findArticle(catalog, '', text(line.sku));
    const vatBp = optionalInt(line.taxRateBp) ?? article?.vatBp ?? defaultVatBp;
    const quantityMilli = Math.max(1, int(line.quantityMilli));
    const unit = int(line.unitPriceCents), total = int(line.lineTotalCents);
    const gross = Math.round((quantityMilli / 1000) * unit);
    const discountBp = gross > 0 && total >= 0 && total < gross ? Math.round(((gross - total) * 10_000) / gross) : 0;
    return {
      catalogItemId: article?.id ?? null, position, description: text(line.description) || article?.name || 'Article', quantityMilli,
      unit: article?.unit || 'pce', unitPriceCents: includesTax ? netFromGross(unit, vatBp) : unit, discountBp, vatBp, fulfillmentMode: fulfillment(article),
    };
  });
  const shipping = int(payload.shippingCents);
  if (shipping > 0) {
    lines.push({ catalogItemId: null, position: lines.length, description: text(payload.shippingDescription) || 'Frais de port', quantityMilli: 1000, unit: 'forfait',
      unitPriceCents: includesTax ? netFromGross(shipping, defaultVatBp) : shipping, discountBp: 0, vatBp: defaultVatBp, fulfillmentMode: 'direct' });
  }
  return lines;
}

/** Lignes d'un devis ou d'une commande déposés par l'API : le catalogue fixe le prix. */
export function apiDraftLines(payload: Raw, catalog: readonly CatalogItem[], defaultVatBp: number): OrderLineDraft[] {
  return (Array.isArray(payload.lines) ? payload.lines : []).map(record).map((line, position) => {
    const article = findArticle(catalog, text(line.articleId), text(line.sku));
    return {
      catalogItemId: article?.id ?? null, position, description: text(line.description) || article?.name || 'Article',
      quantityMilli: Math.max(1, int(line.quantityMilli)), unit: article?.unit || 'pce',
      unitPriceCents: article ? article.salesPriceCents : Math.max(0, optionalInt(line.unitPriceCents) ?? 0),
      discountBp: 0, vatBp: article?.vatBp ?? defaultVatBp, fulfillmentMode: fulfillment(article),
    };
  });
}

export function quoteLines(lines: readonly OrderLineDraft[], newId: () => string): DocumentLine[] {
  return lines.map((line) => ({ id: newId(), catalogItemId: line.catalogItemId, description: line.description, quantity: line.quantityMilli / 1000,
    unit: line.unit, unitPriceCents: line.unitPriceCents, discountBp: line.discountBp, vatRateBp: line.vatBp }));
}

/** Repère écrit dans les notes du document : relie une commande de boutique à sa facture. */
export function shopMarker(payload: Raw): string {
  return `[${text(payload.platform)}:${text(payload.shop)}:${text(payload.externalId)}]`;
}

/** Facture ouverte qui reprend la commande de boutique (repère dans ses notes). */
export function invoiceForShopPayment(payload: Raw, invoices: readonly Invoice[]): Invoice | undefined {
  const marker = shopMarker(payload);
  return invoices.find((invoice) => invoice.type !== 'credit_note' && ['issued', 'partially_paid'].includes(invoice.status) && (invoice.notes ?? '').includes(marker));
}

export const PLATFORM_LABEL: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', api: 'API', mcp: 'MCP' };

/** Titre et détail d'une carte, en français ; l'appelant les traduit. */
export function inboxCardSource(item: InboxItem): { titleKey: string; values: Record<string, string | number>; detail: string } {
  const payload = item.payload, platform = PLATFORM_LABEL[item.source] ?? item.source;
  const party = partyFrom(payload.customer);
  const who = party.company || party.name || party.email;
  const number = text(payload.number);
  switch (item.kind) {
    case 'order':
      return item.source === 'shopify' || item.source === 'woocommerce'
        ? { titleKey: 'Commande {platform} {number} à valider', values: { platform, number }, detail: who }
        : { titleKey: 'Commande reçue par {platform} à valider', values: { platform }, detail: who };
    case 'quote':
      return { titleKey: 'Devis demandé par {platform} à préparer', values: { platform }, detail: who };
    case 'customer':
      return { titleKey: 'Nouveau client reçu par {platform}', values: { platform }, detail: who };
    case 'payment':
      return { titleKey: 'Commande {platform} {number} payée', values: { platform, number }, detail: text(payload.gateway) };
    case 'order_cancelled':
      return { titleKey: 'Commande {platform} {number} annulée', values: { platform, number }, detail: '' };
  }
}

export type ShopPayout = Readonly<{ platform: string; grossCents: number; feeCents: number; count: number }>;

/**
 * Versement d'une boutique sur le compte : le libellé cite la plateforme et le
 * montant correspond à des paiements encore ouverts, frais de 0 à 5 % déduits.
 * Les frais sont alors comptabilisés par l'outil de rapprochement des frais.
 */
export function matchShopPayout(movement: Readonly<{ amountCents: number; text: string }>, payments: readonly Readonly<{ platform: string; amountCents: number }>[]): ShopPayout | null {
  const label = movement.text.toLowerCase();
  const platform = label.includes('shopify') ? 'shopify' : label.includes('woocommerce') || label.includes('woopayments') ? 'woocommerce' : '';
  if (!platform || movement.amountCents <= 0) return null;
  const open = payments.filter((payment) => payment.platform === platform && payment.amountCents > 0);
  // Les paiements les plus anciens partent en premier dans un versement.
  let gross = 0;
  for (let index = 0; index < open.length; index += 1) {
    gross += open[index].amountCents;
    const fee = gross - movement.amountCents;
    if (fee >= 0 && fee <= Math.ceil(gross * 0.05)) return { platform, grossCents: gross, feeCents: fee, count: index + 1 };
    if (fee > Math.ceil(gross * 0.05)) break;
  }
  return null;
}
